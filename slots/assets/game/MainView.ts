import {
    _decorator,
    BitmapFont,
    Color,
    Component,
    EventKeyboard,
    Graphics,
    input,
    Input,
    KeyCode,
    Label,
    Mask,
    Node,
    sp,
    SpriteFrame,
    tween,
    UIOpacity,
    UITransform,
    Vec3,
} from 'cc';
import type { IView } from '../enji/IView';
import { useDesignResolution } from '../enji/helpers';
import type { EditorDoc } from './slot/editor-core/index.ts';
import { BoardDirector } from './slot/editor-app/BoardDirector.ts';
import { BoardView } from './slot/editor-app/BoardView.ts';
import type { BoardEvent } from './slot/editor-app/boardEvents.ts';
import { loadThorCatalog } from './ThorPack.ts';
import { FREE_SPINS_AWARD, SUPER_START_MULTIPLIER, makeRng, round2, spin, type Grid, type Rng, type SpinResult } from './math/ThorMath.ts';
import { buildSpinFrames, staticFrame, type FrameMark } from './math/SpirBuilder.ts';
import { GOLD, PALE, button, loadArt, pop, sprite, text, type ArtName } from './ui/Art.ts';
import { Sfx } from './ui/Sfx.ts';

const { ccclass } = _decorator;

const BETS = [0.2, 0.4, 0.6, 1, 2, 4, 10, 20];
const FRAME_Y = 70;
const FRAME_W = 720;
const FRAME_H = 551;
const HOLE_W = 594;
const HOLE_H = 409;
const BOARD_SCALE = 0.853;
const AUTO_SPINS = 20;

const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
const fmt = (v: number) => v.toFixed(2);

@ccclass('MainView')
export class MainView extends Component implements IView {
    private root!: Node;
    private view!: BoardView;
    private director!: BoardDirector;
    private doc: EditorDoc = { docVersion: 1, id: 'thor', name: 'thor', states: [] };
    private digitFont: BitmapFont | null = null;
    private winFx: sp.SkeletonData | null = null;
    private art!: Record<ArtName, SpriteFrame>;
    private sfx!: Sfx;
    private rng!: Rng;

    private balance = 1000;
    private betIdx = 3;
    private grid!: Grid;
    private busy = false;
    private auto = 0;
    private fsLeft = 0;
    private fsRunning = 0;
    private fsTotal = 0;
    private shownWin = 0;
    private collected = 0;
    private marks = new Map<number, FrameMark>();
    private lastResult: SpinResult | null = null;

    private fx!: Node;
    private balanceLabel!: Label;
    private betLabel!: Label;
    private winLabel!: Label;
    private winTitle!: Label;
    private msgLabel!: Label;
    private fsBadge!: Node;
    private fsLabel!: Label;
    private multBadge!: Node;
    private multLabel!: Label;
    private spinBtn!: Node;
    private autoLabel!: Label;
    private buttons: Record<string, Node> = {};

    bind(root: Node): void {
        this.root = root;
        void this.boot();
    }

    get bet(): number {
        return BETS[this.betIdx];
    }

    private async boot(): Promise<void> {
        useDesignResolution(720, 1280);
        const q = new URLSearchParams(globalThis.location?.search ?? '');
        this.rng = makeRng(Number(q.get('seed') ?? Date.now() % 1e9));

        this.sfx = new Sfx(this.root);
        const [{ catalog, digitFont }, art] = await Promise.all([loadThorCatalog(this.root), loadArt(), this.sfx.load()]);
        this.digitFont = digitFont;
        this.art = art;
        this.winFx = catalog.winCellFxFor(12)?.spine ?? null;

        sprite(this.root, art.bg, 0, 0, 720, 1280, 'bg');
        sprite(this.root, art.logo, 0, 505, 380, undefined, 'logo');

        const clip = new Node('board-clip');
        this.root.addChild(clip);
        clip.setPosition(0, FRAME_Y, 0);
        clip.addComponent(UITransform).setContentSize(HOLE_W, HOLE_H);
        const backdrop = clip.addComponent(Graphics);
        backdrop.fillColor = new Color(6, 10, 32, 190);
        backdrop.rect(-HOLE_W / 2, -HOLE_H / 2, HOLE_W, HOLE_H);
        backdrop.fill();
        const mask = new Node('mask');
        clip.addChild(mask);
        mask.addComponent(UITransform).setContentSize(HOLE_W, HOLE_H);
        mask.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;

        const boardNode = new Node('board');
        mask.addChild(boardNode);
        boardNode.setScale(BOARD_SCALE, BOARD_SCALE, 1);
        const view = boardNode.addComponent(BoardView);
        view.cellW = catalog.designW;
        view.cellH = catalog.designH;
        view.colGap = catalog.boardSpacing.colGap;
        view.rowGap = catalog.boardSpacing.rowGap;
        view.cellFill = 1;
        view.showGridBg = false;
        view.setCatalog(catalog);
        view.setColumnVAlign((catalog.boardSpacing as { columnVAlign?: string }).columnVAlign ?? 'top');
        view.setLayoutProfile(null);
        this.view = view;

        sprite(this.root, art.frame, 0, FRAME_Y, FRAME_W, FRAME_H, 'frame');

        this.director = new BoardDirector(view, () => this.doc);
        const ev = this.director.events;
        ev.on('transition-start', (e) => this.onTransition(e));
        ev.on('transition-end', (e) => this.onTransitionEnd(e));
        ev.on('symbol-win', () => this.sfx.play('symbol_win', 0.7));
        ev.on('symbol-vanish', () => this.sfx.play('symbol_vanish', 0.7));
        ev.on('multi-collect', (e) => this.onCollect(e));

        this.grid = this.quietGrid();
        view.render(staticFrame(this.grid));

        this.buildHud();
        this.fx = new Node('fx');
        this.root.addChild(this.fx);
        this.fx.addComponent(UITransform).setContentSize(720, 1280);
        this.refreshHud();
        input.on(Input.EventType.KEY_DOWN, (e: EventKeyboard) => {
            if (e.keyCode === KeyCode.SPACE) this.onSpinPressed();
        });
        (globalThis as Record<string, unknown>).__slots = this;
        console.log('[slots] ready');
    }

    /** A base-game board with nothing winning, for the first screen. */
    private quietGrid(): Grid {
        for (;;) {
            const r = spin(this.rng, 1, 'base');
            if (!r.tumbles.length && !r.orbs.length && r.scatterCount < 3) return r.initial;
        }
    }

    // ------------------------------------------------------------------ HUD

    private buildHud(): void {
        const art = this.art;
        const hud = new Node('hud');
        this.root.addChild(hud);

        this.fsBadge = sprite(hud, art.panel, -278, 505, 150, 96, 'fs-badge');
        text(this.fsBadge, 'FREE SPINS', 0, 20, 16, GOLD);
        this.fsLabel = text(this.fsBadge, '', 0, -12, 40, PALE, 'fs-left');
        this.multBadge = sprite(hud, art.panel, 278, 505, 150, 96, 'mult-badge');
        text(this.multBadge, 'MULTIPLIER', 0, 20, 16, GOLD);
        this.multLabel = text(this.multBadge, '', 0, -14, 40, GOLD, 'mult');
        if (this.digitFont) {
            this.multLabel.font = this.digitFont;
            this.multLabel.enableOutline = false;
            this.multLabel.fontSize = 52;
            this.multLabel.lineHeight = 60;
            this.multLabel.color = Color.WHITE;
        }

        const bar = sprite(hud, art.bar, 0, -268, 420, undefined, 'msg-bar');
        this.msgLabel = text(bar, '', 0, 2, 34, GOLD, 'msg');

        const bal = sprite(hud, art.panel, -182, -398, 232, 120, 'balance');
        text(bal, 'BALANCE', 0, 24, 20, GOLD);
        this.balanceLabel = text(bal, '', 0, -14, 32, PALE, 'balance-value');
        const win = sprite(hud, art.panel, 182, -398, 232, 120, 'win');
        this.winTitle = text(win, 'WIN', 0, 24, 20, GOLD);
        this.winLabel = text(win, '', 0, -14, 32, PALE, 'win-value');

        this.buttons.minus = button(hud, art.btn_minus, -296, -548, 78, () => this.changeBet(-1), 'minus');
        text(hud, 'BET', -203, -528, 18, GOLD);
        this.betLabel = text(hud, '', -203, -560, 30, PALE, 'bet-value');
        this.buttons.plus = button(hud, art.btn_plus, -110, -548, 78, () => this.changeBet(1), 'plus');
        this.spinBtn = this.buttons.spin = button(hud, art.btn_spin, 0, -548, 176, () => this.onSpinPressed(), 'spin');
        this.buttons.auto = button(hud, art.btn_auto, 196, -548, 92, () => this.toggleAuto(), 'auto');
        this.autoLabel = text(this.buttons.auto, '', 0, -62, 20, GOLD, 'auto-count');
    }

    private refreshHud(): void {
        this.balanceLabel.string = fmt(this.balance);
        this.betLabel.string = fmt(this.bet);
        const fsMode = this.fsLeft > 0 || this.fsRunning > 0 || this.fsTotal > 0;
        this.winTitle.string = fsMode ? 'FREE SPINS WIN' : 'WIN';
        this.winLabel.string = fmt(this.shownWin);
        this.fsBadge.active = this.fsLeft > 0 || (fsMode && this.busy);
        this.fsLabel.string = `${this.fsLeft}`;
        this.multBadge.active = this.fsRunning > 0 || this.collected > 0;
        this.multLabel.string = this.multText();
        this.autoLabel.string = this.auto > 0 ? `${this.auto}` : '';
        const idle = !this.busy && this.fsLeft === 0;
        for (const k of ['minus', 'plus']) this.buttons[k].getComponent(UIOpacity)!.opacity = idle ? 255 : 120;
    }

    private multText(): string {
        const m = this.fsRunning + this.collected;
        return m > 0 ? `x${m}` : '';
    }

    private rollWin(to: number, dur = 0.4): void {
        const from = this.shownWin;
        const box = { v: from };
        tween(box)
            .to(dur, { v: to }, { onUpdate: () => (this.winLabel.string = fmt(box.v)) })
            .call(() => (this.winLabel.string = fmt(to)))
            .start();
        this.shownWin = to;
    }

    private changeBet(d: number): void {
        if (this.busy || this.fsLeft > 0) return;
        this.sfx.startMusic();
        this.sfx.play('click');
        this.betIdx = Math.max(0, Math.min(BETS.length - 1, this.betIdx + d));
        this.refreshHud();
    }

    private toggleAuto(): void {
        this.sfx.startMusic();
        this.sfx.play('click');
        this.auto = this.auto > 0 ? 0 : AUTO_SPINS;
        this.refreshHud();
        if (this.auto > 0 && !this.busy && this.fsLeft === 0) void this.runSpin();
    }

    private onSpinPressed(): void {
        this.sfx.startMusic();
        if (!this.busy) void this.runSpin();
    }

    /** Screen-space centre of a HUD button (for the demo recorder). */
    point(name: string): { x: number; y: number } | null {
        const n = this.buttons[name];
        if (!n) return null;
        const w = n.worldPosition;
        return { x: w.x, y: w.y };
    }

    // ------------------------------------------------------------------ spin

    async runSpin(): Promise<void> {
        if (this.busy) return;
        const free = this.fsLeft > 0;
        if (!free && this.balance < this.bet) {
            this.msgLabel.string = 'NOT ENOUGH BALANCE';
            this.auto = 0;
            this.refreshHud();
            return;
        }
        this.busy = true;
        this.sfx.play('click');
        if (free) {
            this.fsLeft--;
        } else {
            this.balance = round2(this.balance - this.bet);
            this.fsTotal = 0;
            this.shownWin = 0;
        }
        this.collected = 0;
        this.msgLabel.string = free ? `FREE SPIN` : '';
        this.refreshHud();
        const spinTw = tween(this.spinBtn).by(0.6, { angle: -360 }).repeatForever().start();

        const r = spin(this.rng, this.bet, free ? 'free' : 'base', this.fsRunning);
        this.lastResult = r;
        const frames = buildSpinFrames(this.grid, r);
        this.marks = new Map(frames.marks.map((m) => [m.index, m]));
        this.doc = { docVersion: 1, id: 'spin', name: 'spin', states: frames.states };
        await this.director.playRange(0, frames.states.length - 1);
        this.grid = r.final;
        spinTw.stop();
        tween(this.spinBtn).to(0.2, { angle: 0 }).start();

        await this.presentResult(r, free);

        if (r.freeSpinsAwarded > 0) {
            this.fsLeft += r.freeSpinsAwarded;
            if (!free) {
                this.fsRunning = r.triggersSuper ? SUPER_START_MULTIPLIER : 0;
                this.refreshHud();
                await this.banner(
                    r.triggersSuper ? 'SUPER FREE SPINS' : 'FREE SPINS',
                    r.triggersSuper ? `${FREE_SPINS_AWARD} SPINS  ·  START x${SUPER_START_MULTIPLIER}` : `${FREE_SPINS_AWARD} SPINS`,
                    2.6,
                );
            } else {
                this.refreshHud();
                await this.banner('RETRIGGER', `+${r.freeSpinsAwarded} SPINS`, 1.8);
            }
        }
        if (free && this.fsLeft === 0) {
            await this.banner('FREE SPINS WIN', fmt(this.fsTotal), 3, true);
            this.msgLabel.string = `WIN  ${fmt(this.fsTotal)}`;
            this.shownWin = this.fsTotal;
            this.fsRunning = 0;
            this.fsTotal = 0;
        }
        this.busy = false;
        this.refreshHud();

        if (this.fsLeft > 0) {
            await sleep(0.6);
            void this.runSpin();
        } else if (this.auto > 0) {
            this.auto--;
            this.refreshHud();
            await sleep(0.45);
            if (this.auto > 0) void this.runSpin();
        }
    }

    private async presentResult(r: SpinResult, free: boolean): Promise<void> {
        if (r.tumbleWin > 0 && r.appliedMultiplier > 1) {
            this.msgLabel.string = `${fmt(r.tumbleWin)} × ${r.appliedMultiplier}`;
            pop(this.msgLabel.node, 1.3);
            this.sfx.play('multiplier_up_3');
            await sleep(0.9);
            if (free) this.fsRunning = r.appliedMultiplier;
            this.collected = 0;
        }
        if (r.scatterWin > 0) {
            this.msgLabel.string = `SCATTER  ${fmt(r.scatterWin)}`;
            pop(this.msgLabel.node);
            await sleep(0.7);
        }
        this.balance = round2(this.balance + r.totalWin);
        if (free || r.freeSpinsAwarded > 0) this.fsTotal = round2(this.fsTotal + r.totalWin);
        const shown = free ? this.fsTotal : r.totalWin;
        if (r.totalWin > 0) {
            this.msgLabel.string = `WIN  ${fmt(r.totalWin)}`;
            pop(this.msgLabel.node, 1.2);
            this.rollWin(shown, 0.5);
            this.sfx.play('score_num');
            if (r.totalWin >= this.bet * 20) {
                const tier = r.totalWin >= this.bet * 200 ? 'EPIC WIN' : r.totalWin >= this.bet * 60 ? 'MEGA WIN' : 'BIG WIN';
                await this.banner(tier, fmt(r.totalWin), 3, true);
            }
        } else if (!free) {
            this.msgLabel.string = '';
        }
        this.refreshHud();
    }

    // ------------------------------------------------------------------ board events

    private onTransition(e: BoardEvent): void {
        const m = this.marks.get(e.frameIndex);
        if (e.frameKind === 'postClear' && e.frameIndex === 1) this.sfx.play('btm_fall_auto_2', 0.6);
        if (!m || m.kind !== 'tumble-win' || !m.amount) return;
        const r = this.lastResult;
        const t = r && m.tumble !== undefined ? r.tumbles[m.tumble] : null;
        const shown = round2((r?.mode === 'free' ? this.fsTotal : 0) + this.tumbleSoFar(m));
        this.rollWin(shown);
        this.msgLabel.string = `+${fmt(m.amount)}`;
        pop(this.msgLabel.node);
        this.sfx.play('score_num');
        if (t) {
            for (const w of t.wins) this.floatAmount(w.cells, w.pay);
        }
    }

    private tumbleSoFar(m: FrameMark): number {
        const r = this.lastResult;
        if (!r || m.tumble === undefined) return 0;
        let s = 0;
        for (let i = 0; i <= m.tumble; i++) for (const w of r.tumbles[i].wins) s += w.pay;
        return s;
    }

    private onTransitionEnd(e: BoardEvent): void {
        if (e.frameKind === 'reveal' || e.frameKind === 'compact') this.sfx.play('btm_fall_auto_1', 0.6);
    }

    private toFx(world: Vec3): Vec3 {
        return this.fx.getComponent(UITransform)!.convertToNodeSpaceAR(world);
    }

    private floatAmount(cells: { col: number; row: number }[], amount: number): void {
        const c = new Vec3();
        for (const p of cells) {
            const n = this.view.getCellNode(p.col, p.row);
            if (n) c.add(n.worldPosition);
        }
        c.multiplyScalar(1 / Math.max(1, cells.length));
        const l = text(this.fx, fmt(amount), 0, 0, 40, GOLD, 'float');
        l.node.setPosition(this.toFx(c));
        l.node.setScale(0.4, 0.4, 1);
        const op = l.node.getComponent(UIOpacity)!;
        tween(l.node)
            .to(0.2, { scale: new Vec3(1.1, 1.1, 1) }, { easing: 'backOut' })
            .by(0.9, { position: new Vec3(0, 70, 0) })
            .call(() => l.node.destroy())
            .start();
        tween(op).delay(0.75).to(0.35, { opacity: 0 }).start();
    }

    private onCollect(e: BoardEvent): Promise<void> {
        const mult = e.multiplier ?? 0;
        if (!this.multBadge.active) {
            this.multBadge.active = true;
            this.multLabel.string = this.multText();
        }
        const node = this.view.getCellNode(e.col ?? 0, e.row ?? 0);
        const fly = text(this.fx, `x${mult}`, 0, 0, 44, GOLD, 'fly');
        if (this.digitFont) {
            fly.font = this.digitFont;
            fly.enableOutline = false;
            fly.fontSize = 70;
            fly.color = Color.WHITE;
        }
        fly.node.setPosition(this.toFx(node ? node.worldPosition : new Vec3()));
        const target = this.toFx(this.multLabel.node.worldPosition);
        this.sfx.play(mult >= 25 ? 'multiplier_up_3' : mult >= 6 ? 'multiplier_up_2' : 'multiplier_up_1');
        return new Promise((resolve) => {
            tween(fly.node)
                .to(0.16, { scale: new Vec3(1.35, 1.35, 1) }, { easing: 'backOut' })
                .to(0.42, { position: target, scale: new Vec3(0.6, 0.6, 1) }, { easing: 'quadIn' })
                .call(() => {
                    fly.node.destroy();
                    this.collected += mult;
                    this.multLabel.string = this.multText();
                    pop(this.multBadge, 1.2);
                    resolve();
                })
                .start();
        });
    }

    private async banner(title: string, sub: string, seconds: number, countUp = false): Promise<void> {
        this.sfx.play('cta_in');
        const n = new Node('banner');
        this.fx.addChild(n);
        n.addComponent(UITransform).setContentSize(720, 1280);
        const dim = n.addComponent(Graphics);
        dim.fillColor = new Color(0, 0, 10, 170);
        dim.rect(-360, -640, 720, 1280);
        dim.fill();
        n.addComponent(UIOpacity);

        if (this.winFx) {
            const fxNode = new Node('burst');
            n.addChild(fxNode);
            fxNode.setPosition(0, 60, 0);
            fxNode.setScale(3.2, 3.2, 1);
            const sk = fxNode.addComponent(sp.Skeleton);
            sk.skeletonData = this.winFx;
            sk.premultipliedAlpha = false;
            sk.setAnimation(0, 'play', true);
        }
        const panel = sprite(n, this.art.panel, 0, 40, 560, 330, 'panel');
        const t = text(panel, title, 0, 70, 64, GOLD, 'title');
        t.outlineWidth = 6;
        const s = text(panel, countUp ? fmt(0) : sub, 0, -40, countUp ? 72 : 40, PALE, 'sub');
        panel.setScale(0.3, 0.3, 1);
        tween(panel).to(0.35, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
        if (countUp) {
            const target = Number(sub);
            const box = { v: 0 };
            tween(box)
                .to(Math.min(2, seconds * 0.6), { v: target }, { onUpdate: () => (s.string = fmt(box.v)), easing: 'quadOut' })
                .call(() => {
                    s.string = fmt(target);
                    pop(s.node, 1.25);
                })
                .start();
        }
        await sleep(seconds);
        await new Promise<void>((res) => tween(n.getComponent(UIOpacity)!).to(0.25, { opacity: 0 }).call(() => res()).start());
        n.destroy();
    }
}
