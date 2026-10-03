import { _decorator, Camera, Color, Component, director, Label, Layers, Node, screen, UITransform, view as ccView } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './ipc/Hud';
import { IpcInteraction } from './ipc/IpcInteraction';
import { IpcView } from './ipc/IpcView';
import { DEFAULT_PARAMS, IpcWorld, type ContactModel } from './ipc/IpcWorld';
import { buildScene, SCENE_NAMES, type SceneDef } from './ipc/Scenes';

const { ccclass } = _decorator;

type Mode = 'compare' | 'ipc' | 'penalty';
const MODES: Mode[] = ['compare', 'ipc', 'penalty'];
const MODE_NAMES: Record<Mode, string> = { compare: 'IPC vs penalty', ipc: 'IPC', penalty: 'Penalty' };
const MODEL_NAMES: Record<ContactModel, string> = { ipc: 'IPC', penalty: 'Penalty' };
/** Newton time budget per world and step (ms); 0 runs Newton to convergence. */
const BUDGETS = [6, 3, 0];
/** Frames skipped, then frames averaged, before the start-up quality check. */
const AUTO_WARMUP = 30;
const AUTO_SAMPLES = 60;
const AUTO_MIN_FPS = 50;
/** Below this after the smaller budget, compare mode falls back to IPC alone. */
const AUTO_SINGLE_FPS = 40;
const GRAB_RADIUS = 0.08;
const LABEL_COLOR = new Color(235, 240, 255, 255);
const LABEL_BAD = new Color(255, 120, 110, 255);

interface Meter {
    steps: number;
    ms: number;
    newton: number;
    cut: number;
    contacts: number;
    minGap: number;
    crossings: number;
    crossingSteps: number;
}

function meter(): Meter {
    return { steps: 0, ms: 0, newton: 0, cut: 0, contacts: 0, minGap: Infinity, crossings: 0, crossingSteps: 0 };
}

/**
 * Small-scale IPC (Li et al. 2020) in 2D: implicit Neo-Hookean bodies with a
 * log-barrier contact potential, CCD-filtered Newton steps and lagged
 * friction, next to the same solver with a penalty spring instead of the
 * barrier. Red outlines are boundary edges that cross another edge.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private camera: Camera | null = null;
    private hud: Hud | null = null;
    private view: IpcView | null = null;
    private interaction: IpcInteraction | null = null;
    private worlds: IpcWorld[] = [];
    private scene: SceneDef | null = null;
    private sceneIndex = 0;
    private mode: Mode = 'compare';
    private budget = 0;
    private paused = false;
    private grabbing = false;
    private meters: Meter[] = [];
    private labels: Label[] = [];
    private canvas: Node | null = null;
    private autoFrames = 0;
    private autoTime = 0;
    private frames = 0;
    private frameTime = 0;
    private layoutKey = '';
    private metresPerPixel = 0.003;

    bind(root: Node): void {
        const scene = director.getScene()!;
        // The template Canvas camera draws only the UI, on top of the world camera.
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }

        const world = new Node('World');
        scene.addChild(world);
        const cameraNode = new Node('IpcCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.projection = Camera.ProjectionType.ORTHO;
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(14, 15, 18, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.1;
        camera.far = 100;
        this.camera = camera;

        const actions = {
            cycleMode: () => {
                this.autoFrames = -1;
                this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
                this.reset();
            },
            cycleScene: () => {
                this.sceneIndex = (this.sceneIndex + 1) % SCENE_NAMES.length;
                this.reset();
            },
            cycleBudget: () => {
                this.autoFrames = -1;
                this.budget = (this.budget + 1) % BUDGETS.length;
                this.applyBudget();
            },
            togglePause: () => {
                this.paused = !this.paused;
                this.refreshButtons();
            },
            reset: () => this.reset(),
        };

        this.canvas = ensureCanvas(root).node;
        this.hud = new Hud(this.canvas, [
            { id: 'mode', onTap: actions.cycleMode },
            { id: 'scene', onTap: actions.cycleScene },
            { id: 'budget', onTap: actions.cycleBudget },
            { id: 'pause', onTap: actions.togglePause },
            { id: 'reset', onTap: actions.reset },
        ]);
        this.hud.setButton('reset', 'Reset');
        for (let i = 0; i < 2; i++) this.labels.push(this.makeLabel(i));

        this.interaction = new IpcInteraction(camera, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();

        void IpcView.create(world).then((v) => {
            this.view = v;
            this.reset();
        });
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        if (!this.view) return;
        this.layout();
        this.applyPointer();
        this.worlds.forEach((w, i) => {
            if (!this.paused) w.step();
            const crossings = w.countCrossings();
            if (this.paused) return;
            const m = this.meters[i];
            const s = w.stats;
            m.steps++;
            m.ms += s.ms;
            m.newton += s.newton;
            if (!s.converged) m.cut++;
            m.contacts = Math.max(m.contacts, s.contacts);
            m.minGap = Math.min(m.minGap, s.minDistance);
            m.crossings = Math.max(m.crossings, crossings);
            if (crossings > 0) m.crossingSteps++;
        });
        this.view.update(this.metresPerPixel);
        this.updateHud(dt);
        this.autoQuality(dt);
    }

    /**
     * At start-up: halve the Newton budget if the default can't hold 50 FPS;
     * if that still can't hold 40, show IPC alone (one tap brings the
     * comparison back). Stops at the first choice the user makes.
     */
    private autoQuality(dt: number): void {
        if (this.autoFrames < 0 || this.paused) return;
        this.autoFrames += 1;
        if (this.autoFrames <= AUTO_WARMUP) return;
        this.autoTime += dt;
        if (this.autoFrames < AUTO_WARMUP + AUTO_SAMPLES) return;
        const fps = AUTO_SAMPLES / this.autoTime;
        this.autoFrames = -1;
        if (this.budget === 0 && fps < AUTO_MIN_FPS) {
            this.budget = 1;
            this.applyBudget();
            this.autoFrames = 0;
            this.autoTime = 0;
        } else if (this.budget === 1 && this.mode === 'compare' && fps < AUTO_SINGLE_FPS) {
            this.mode = 'ipc';
            this.reset();
        }
    }

    private reset(): void {
        this.scene = buildScene(this.sceneIndex);
        const models: ContactModel[] = this.mode === 'compare' ? ['ipc', 'penalty'] : [this.mode];
        this.worlds = models.map((m) => new IpcWorld(this.scene!.bodies, m, { ...DEFAULT_PARAMS }));
        this.meters = this.worlds.map(meter);
        this.grabbing = false;
        this.applyBudget();
        this.view?.rebuild(this.worlds, this.scene.view);
        this.layoutKey = '';
        this.frames = 0;
        this.frameTime = 0;
    }

    private applyBudget(): void {
        for (const w of this.worlds) w.params.budgetMs = BUDGETS[this.budget];
        this.refreshButtons();
    }

    /** Fits the worlds between the status panel and the buttons; refits on resize. */
    private layout(): void {
        const camera = this.camera;
        const view = this.view;
        const hud = this.hud;
        if (!camera || !view || !hud) return;
        const win = screen.windowSize;
        const ext = view.extent;
        const key = `${win.width}x${win.height}:${ext.width}`;
        if (key === this.layoutKey) return;
        this.layoutKey = key;
        const dpr = screen.devicePixelRatio || 1;
        const cssW = win.width / dpr;
        const cssH = win.height / dpr;
        const labelSpace = this.worlds.length > 1 ? 24 : 0;
        const top = hud.insets.top + labelSpace;
        const bottom = hud.insets.bottom + 6;
        const margin = 0.05;
        const scale = Math.max(1, Math.min((cssW - 12) / (ext.width + margin), (cssH - top - bottom) / (ext.height + margin)));
        camera.orthoHeight = cssH / scale / 2;
        // Centre of the free band, measured from the screen centre (positive = below).
        const below = top + (cssH - top - bottom) / 2 - cssH / 2;
        camera.node.setPosition(ext.minX + ext.width / 2, ext.minY + ext.height / 2 - below / scale, 10);
        this.metresPerPixel = 1 / scale;
        this.placeLabels(scale, cssW);
    }

    /** Puts a model label above each world in compare mode (canvas units are CSS pixels × k, as in Hud). */
    private placeLabels(cssPerMetre: number, cssWidth: number): void {
        const camera = this.camera;
        const view = this.view;
        const scene = this.scene;
        if (!camera || !view || !scene) return;
        const k = ccView.getVisibleSize().width / Math.max(1, cssWidth);
        const c = camera.node.position;
        const [minX, , maxX, maxY] = scene.view;
        this.labels.forEach((label, i) => {
            label.node.active = this.worlds.length > 1 && i < this.worlds.length;
            if (!label.node.active) return;
            const x = (view.offset(i) + (minX + maxX) / 2 - c.x) * cssPerMetre;
            const y = (maxY - c.y) * cssPerMetre + 14;
            label.node.setPosition(x * k, y * k, 0);
            label.node.setScale(k, k, 1);
            label.node.getComponent(UITransform)!.setContentSize((maxX - minX) * cssPerMetre, 22);
        });
    }

    private makeLabel(i: number): Label {
        const node = new Node(`WorldLabel${i}`);
        node.layer = Layers.Enum.UI_2D;
        this.canvas!.addChild(node);
        node.addComponent(UITransform).setContentSize(260, 24);
        const label = node.addComponent(Label);
        label.fontSize = 15;
        label.lineHeight = 22;
        label.color = LABEL_COLOR;
        label.overflow = Label.Overflow.SHRINK;
        node.active = false;
        return label;
    }

    /** Grabs the nearest vertex under the finger; in compare mode both worlds get the same hand. */
    private applyPointer(): void {
        const p = this.interaction?.pointer;
        const view = this.view;
        if (!p || !view || this.worlds.length === 0) return;
        if (!p.down) {
            if (this.grabbing) for (const w of this.worlds) w.releaseGrab();
            this.grabbing = false;
            return;
        }
        let index = 0;
        for (let i = 1; i < this.worlds.length; i++) if (p.x >= view.offset(i) - 0.1) index = i;
        const x = p.x - view.offset(index);
        if (!this.grabbing) {
            this.grabbing = true;
            for (const w of this.worlds) w.grab(x, p.y, GRAB_RADIUS);
        } else {
            for (const w of this.worlds) w.moveGrab(x, p.y);
        }
    }

    private refreshButtons(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('mode', MODE_NAMES[this.mode]);
        hud.setButton('scene', SCENE_NAMES[this.sceneIndex]);
        const b = BUDGETS[this.budget];
        hud.setButton('budget', b > 0 ? `Newton ${b} ms` : 'Newton full');
        hud.setButton('pause', this.paused ? 'Play' : 'Pause', this.paused);
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const worlds = this.worlds;
        const w0 = worlds[0];
        const side = (i: number) => (worlds.length > 1 ? (i === 0 ? 'L ' : 'R ') : '');
        const lines = [
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · ${SCENE_NAMES[this.sceneIndex]} · ${worlds.length > 1 ? '2 × ' : ''}${w0.vertexCount} vertices · dt 1/60 s`,
            ...worlds.map((w, i) => `${side(i)}${MODEL_NAMES[w.model]} ${describe(this.meters[i])}`),
        ];
        if (worlds.length === 1) lines.push(`${describeContacts(this.meters[0])}`);
        lines.push('drag a body · red outline = edges crossing');
        this.hud.setStatus(lines);
        this.labels.forEach((label, i) => {
            const w = worlds[i];
            if (!w) return;
            const m = this.meters[i];
            const lost = escaped(w, this.scene!.view);
            const problems: string[] = [];
            if (m.crossings > 0) problems.push(`${m.crossings} crossings`);
            if (lost > 0) problems.push(`${lost} ${lost > 1 ? 'bodies' : 'body'} escaped`);
            const name = w.model === 'ipc' ? 'IPC barrier' : 'Penalty spring';
            label.string = problems.length ? `${name} · ${problems.join(' · ')}` : `${name}${w.model === 'ipc' ? ' · never crosses' : ''}`;
            label.color = problems.length ? LABEL_BAD : LABEL_COLOR;
        });
        this.meters = this.meters.map((m) => (m.steps > 0 ? meter() : m));
        this.frames = 0;
        this.frameTime = 0;
    }
}

/** Soft bodies whose centre has left the scene: what tunnelling through a wall looks like. */
function escaped(w: IpcWorld, view: readonly number[]): number {
    let count = 0;
    for (const b of w.bodies) {
        if (b.kinematic) continue;
        let x = 0;
        let y = 0;
        for (let i = b.start; i < b.start + b.count; i++) {
            x += w.x[2 * i];
            y += w.x[2 * i + 1];
        }
        x /= b.count;
        y /= b.count;
        if (x < view[0] || x > view[2] || y < view[1] || y > view[3]) count++;
    }
    return count;
}

/** Step cost and Newton work over the last half second. */
function describe(m: Meter): string {
    if (m.steps === 0) return 'paused';
    const cut = m.cut > 0 ? ` (${m.cut} cut)` : '';
    return `${(m.ms / m.steps).toFixed(1)} ms · ${(m.newton / m.steps).toFixed(1)} Newton${cut} · ${m.crossings} crossings`;
}

function describeContacts(m: Meter): string {
    const gap = Number.isFinite(m.minGap) ? `${(m.minGap * 1000).toFixed(2)} mm` : '—';
    return `${m.contacts} contacts · closest gap ${gap} · crossing in ${m.crossingSteps} of ${m.steps} steps`;
}
