import { _decorator, Camera, Component, director, Layers, Node, screen, view } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './net/Hud';
import { NetInput } from './net/NetInput';
import { HISTORY_TICKS, NetView, type PanelRect, scoreText, type TickRecord } from './net/NetView';
import { MAX_PREDICTION, type SyncMode } from './net/Peer';
import { Session, type SessionSettings, TICK_MS } from './net/Session';

const { ccclass } = _decorator;

const MODES: SyncMode[] = ['rollback', 'lockstep'];
const MODE_NAMES: Record<SyncMode, string> = { rollback: 'Rollback', lockstep: 'Lockstep' };
/** One-way latency and jitter, ms. */
const LINKS = [[100, 20], [150, 30], [60, 15], [30, 10], [0, 0]];
const DELAYS = [1, 2, 3, 7, 0];
const LOSSES = [0.05, 0.2, 0];
/** At most this many ticks per frame when catching up. */
const MAX_TICKS_PER_FRAME = 4;

/**
 * Rollback netcode next to lockstep, on one screen: two peers (A, red; B,
 * blue) each run the same fixed-point air hockey and exchange only inputs
 * over simulated links with latency, jitter and loss. Bots play both sides
 * unless the human takes red.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private session: Session | null = null;
    private hud: Hud | null = null;
    private netView: NetView | null = null;
    private input: NetInput | null = null;
    private modeIndex = 0;
    private linkIndex = 0;
    private delayIndex = 0;
    private lossIndex = 0;
    private human = false;
    private desync = false;
    private paused = false;
    private accumulator = 0;
    private readonly history: TickRecord[][] = [[], []];
    private frames = 0;
    private frameTime = 0;
    /** Stats one second ago, for per-second rates. */
    private window = { ticks: 0, rollbacks: 0, resimulated: 0, stalls: 0, frames: 0 };
    private rates = { rollbacks: 0, depth: 0, stalls: 0, fps: 60 };

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
            cam.visibility = Layers.Enum.UI_2D;
        }
        const actions = {
            cycleMode: () => { this.modeIndex = (this.modeIndex + 1) % MODES.length; this.reset(); },
            cycleLatency: () => { this.linkIndex = (this.linkIndex + 1) % LINKS.length; this.applyLink(); },
            cycleDelay: () => { this.delayIndex = (this.delayIndex + 1) % DELAYS.length; this.reset(); },
            cycleLoss: () => { this.lossIndex = (this.lossIndex + 1) % LOSSES.length; this.applyLink(); },
            toggleHuman: () => { this.human = !this.human; this.refresh(); },
            toggleDesync: () => { this.desync = !this.desync; this.reset(); },
            togglePause: () => { this.paused = !this.paused; this.refresh(); },
            reset: () => this.reset(),
        };
        const canvas = ensureCanvas(root).node;
        this.netView = new NetView(canvas);
        this.hud = new Hud(canvas, [
            { id: 'mode', onTap: actions.cycleMode },
            { id: 'link', onTap: actions.cycleLatency },
            { id: 'loss', onTap: actions.cycleLoss },
            { id: 'delay', onTap: actions.cycleDelay },
            { id: 'human', onTap: actions.toggleHuman },
            { id: 'desync', onTap: actions.toggleDesync },
            { id: 'pause', onTap: actions.togglePause },
            { id: 'reset', onTap: actions.reset },
        ]);
        this.hud.setButton('reset', 'Reset');
        this.input = new NetInput((x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.input.enable();
        this.reset();
        (globalThis as { __net?: MainView }).__net = this;
    }

    onDestroy(): void {
        this.input?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        const session = this.session;
        if (!session) return;
        if (!this.paused) {
            this.accumulator = Math.min(this.accumulator + dt * 1000, TICK_MS * MAX_TICKS_PER_FRAME);
            while (this.accumulator >= TICK_MS) {
                this.accumulator -= TICK_MS;
                session.tick(this.human ? this.input!.sample() : null);
                session.peers.forEach((p, i) => {
                    const h = this.history[i];
                    h.push({ depth: p.lastDepth, stalled: p.lastStalled });
                    if (h.length > HISTORY_TICKS) h.shift();
                });
            }
        }
        this.draw();
        this.updateHud(dt);
    }

    private settings(): SessionSettings {
        const [latencyMs, jitterMs] = LINKS[this.linkIndex];
        return {
            mode: MODES[this.modeIndex], inputDelay: DELAYS[this.delayIndex], seed: 7,
            latencyMs, jitterMs, loss: LOSSES[this.lossIndex], floatDrag: this.desync,
        };
    }

    private reset(): void {
        this.session = new Session(this.settings());
        this.history[0].length = 0;
        this.history[1].length = 0;
        this.window = { ticks: 0, rollbacks: 0, resimulated: 0, stalls: 0, frames: 0 };
        this.refresh();
    }

    /** Network settings apply live: the links read the session's settings object. */
    private applyLink(): void {
        const s = this.session?.settings;
        if (s) {
            const n = this.settings();
            s.latencyMs = n.latencyMs;
            s.jitterMs = n.jitterMs;
            s.loss = n.loss;
        }
        this.refresh();
    }

    private refresh(): void {
        const hud = this.hud;
        if (!hud) return;
        const [latency, jitter] = LINKS[this.linkIndex];
        const delay = DELAYS[this.delayIndex];
        hud.setButton('mode', MODE_NAMES[MODES[this.modeIndex]], MODES[this.modeIndex] === 'rollback');
        hud.setButton('link', latency === 0 ? 'Link 0 ms' : `${latency} ±${jitter} ms`);
        hud.setButton('loss', `Loss ${Math.round(LOSSES[this.lossIndex] * 100)}%`);
        hud.setButton('delay', `Delay ${delay} f`);
        hud.setButton('human', this.human ? 'Red: you' : 'Red: bot', this.human);
        hud.setButton('desync', this.desync ? 'B float: on' : 'B float: off', this.desync);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    private draw(): void {
        const session = this.session!;
        const hud = this.hud!;
        const size = view.getVisibleSize();
        // HUD insets are CSS pixels; the canvas works in design units (same scale as Hud.layout).
        const k = size.width / Math.max(1, screen.windowSize.width / (screen.devicePixelRatio || 1));
        const top = hud.insets.top * k, bottom = hud.insets.bottom * k;
        const gap = 8;
        const area = { x: -size.width / 2 + gap, y: -size.height / 2 + bottom, w: size.width - 2 * gap, h: size.height - top - bottom };
        const rects: PanelRect[] = [];
        if (area.w > area.h * 1.3) {
            const w = (area.w - gap) / 2;
            rects.push({ x: area.x, y: area.y, w, h: area.h }, { x: area.x + w + gap, y: area.y, w, h: area.h });
        } else {
            const h = (area.h - gap) / 2;
            rects.push({ x: area.x, y: area.y + h + gap, w: area.w, h }, { x: area.x, y: area.y, w: area.w, h });
        }
        const peers = session.peers;
        const ghosts = peers.map((p) => session.referenceAt(p.frame));
        const titles = peers.map((p, i) => {
            const who = i === 0 ? `A · red (${this.human ? 'you' : 'bot'})` : 'B · blue (bot)';
            const lead = p.options.mode === 'rollback' ? `predicting ${p.predictedFrames} f` : p.lastStalled ? 'waiting' : 'in step';
            return `${who} · ${scoreText(p.state)} · frame ${p.frame} · ${lead}${p.lastDepth ? ` · rolled back ${p.lastDepth} f` : ''}`;
        });
        this.netView!.draw(peers, ghosts, this.history, rects, titles);
    }

    private updateHud(dt: number): void {
        this.frames++;
        this.frameTime += dt;
        const session = this.session!;
        if (this.frameTime >= 1) {
            const st = session.peers[0].stats;
            const w = this.window;
            const ticks = session.ticks - w.ticks;
            const rollbacks = st.rollbacks - w.rollbacks;
            this.rates = ticks === 0 ? { ...this.rates, fps: this.frames / this.frameTime } : {
                rollbacks: (rollbacks * 60) / ticks,
                depth: rollbacks ? (st.resimulated - w.resimulated) / rollbacks : 0,
                stalls: (st.stalls - w.stalls) / ticks,
                fps: this.frames / this.frameTime,
            };
            this.window = { ticks: session.ticks, rollbacks: st.rollbacks, resimulated: st.resimulated, stalls: st.stalls, frames: session.peers[0].frame };
            this.frames = 0;
            this.frameTime = 0;
        }
        const s = session.settings;
        const a = session.peers[0].stats, b = session.peers[1].stats;
        const r = this.rates;
        const wrong = (100 * (a.mispredicted + b.mispredicted)) / Math.max(1, a.predicted + b.predicted);
        const desync = Math.max(a.desyncFrame, b.desyncFrame);
        const sync = desync >= 0
            ? `DESYNC: checksums differ at frame ${desync}${s.floatDrag ? ' (B: float drag)' : ''}`
            : `In sync: checksums agree to frame ${Math.min(a.checkedFrame, b.checkedFrame)}`;
        const game = s.mode === 'rollback'
            ? `Rollbacks ${r.rollbacks.toFixed(1)}/s × ${r.depth.toFixed(1)} f (max ${Math.max(a.maxDepth, b.maxDepth)}) · stalls ${(r.stalls * 100).toFixed(0)}% · miss ${wrong.toFixed(1)}%`
            : `Stalled ${(r.stalls * 100).toFixed(0)}%: game at ${((1 - r.stalls) * 60).toFixed(0)} frames/s`;
        this.hud!.setStatus([
            `FPS ${r.fps.toFixed(0)} · ${MODE_NAMES[s.mode]} · delay ${s.inputDelay} f · ${s.latencyMs} ±${s.jitterMs} ms · loss ${Math.round(s.loss * 100)}%`,
            game,
            sync,
            this.human ? 'Red: WASD / arrows + Space, or drag + tap' : 'White rings: where the other side really is',
        ]);
    }
}
