import { _decorator, Camera, Color, Component, director, Label, Layers, Node, screen, UITransform, view as ccView } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './xpbi/Hud';
import { Interaction } from './xpbi/Interaction';
import { SCENE_NAMES } from './xpbi/Scenes';
import { Sim } from './xpbi/Sim';
import { ParticleView } from './xpbi/View';
import { type SolverKind } from './xpbi/World';

const { ccclass } = _decorator;

type Mode = 'compare' | 'xpbi' | 'semi' | 'vanilla';
const MODES: Mode[] = ['compare', 'xpbi', 'semi', 'vanilla'];
const MODE_NAMES: Record<Mode, string> = {
    compare: 'XPBI vs spheres',
    xpbi: 'XPBI',
    semi: 'Semi-implicit',
    vanilla: 'XPBD spheres',
};
const BUDGETS = [
    { iterations: 3, substeps: 4 },
    { iterations: 5, substeps: 8 },
    { iterations: 8, substeps: 12 },
];
const SPACING = { full: 0.026, lite: 0.034 };
const DOMAIN = { w: 1.15, h: 1.55 };
const AUTO_WARMUP = 30;
const AUTO_SAMPLES = 60;
const AUTO_MIN_FPS = 50;
const AUTO_MAX_MS = 14;
const STIFF = 4;

@ccclass('MainView')
export class MainView extends Component implements IView {
    private camera: Camera | null = null;
    private hud: Hud | null = null;
    private view: ParticleView | null = null;
    private interaction: Interaction | null = null;
    private readonly sim = new Sim();
    private mode: Mode = 'compare';
    private budget = 1;
    private stiff = false;
    private lite = false;
    private autoFrames = 0;
    private autoTime = 0;
    private autoSolverMs = 0;
    private tool: 'grab' | 'push' = 'grab';
    private labels: Label[] = [];
    private canvas: Node | null = null;
    private readonly pointerLast = { x: 0, y: 0, valid: false };
    private frames = 0;
    private frameTime = 0;
    private layoutKey = '';

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }
        const world = new Node('World');
        scene.addChild(world);
        const cameraNode = new Node('XpbiCamera');
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
            cycleSolver: () => { this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]; this.reconfigure(); },
            cycleScene: () => { this.sim.scene = (this.sim.scene + 1) % SCENE_NAMES.length; this.sim.reset(); this.refreshButtons(); },
            cycleBudget: () => { this.budget = (this.budget + 1) % BUDGETS.length; this.reconfigure(); },
            toggleStiff: () => { this.stiff = !this.stiff; this.reconfigure(); },
            toggleTool: () => { this.tool = this.tool === 'grab' ? 'push' : 'grab'; this.refreshButtons(); },
            reset: () => this.sim.reset(),
            toggleLite: () => { this.autoFrames = -1; this.lite = !this.lite; this.reconfigure(); },
        };
        this.canvas = ensureCanvas(root).node;
        this.hud = new Hud(this.canvas, [
            { id: 'solver', onTap: actions.cycleSolver },
            { id: 'scene', onTap: actions.cycleScene },
            { id: 'budget', onTap: actions.cycleBudget },
            { id: 'stiff', onTap: actions.toggleStiff },
            { id: 'tool', onTap: actions.toggleTool },
            { id: 'reset', onTap: actions.reset },
        ]);
        this.hud.setButton('reset', 'Reset');
        for (let i = 0; i < 2; i++) this.labels.push(this.makeLabel(i));
        this.interaction = new Interaction(camera, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();
        void ParticleView.create(world).then((v) => { this.view = v; this.reconfigure(); });
        (globalThis as { __xpbi?: MainView }).__xpbi = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        if (!this.view) return;
        this.layout();
        this.applyPointer();
        this.sim.step();
        this.view.update(this.sim);
        this.updateHud(dt);
        this.autoQuality(dt);
    }

    private autoQuality(dt: number): void {
        if (this.autoFrames < 0) return;
        this.autoFrames += 1;
        if (this.autoFrames <= AUTO_WARMUP) return;
        this.autoTime += dt;
        this.autoSolverMs += this.sim.stepMs.reduce((a, b) => a + b, 0);
        if (this.autoFrames < AUTO_WARMUP + AUTO_SAMPLES) return;
        const fps = AUTO_SAMPLES / this.autoTime;
        const solverMs = this.autoSolverMs / AUTO_SAMPLES;
        this.autoFrames = -1;
        if ((fps < AUTO_MIN_FPS || solverMs > AUTO_MAX_MS) && !this.lite) {
            this.lite = true;
            this.reconfigure();
        }
    }

    private reconfigure(): void {
        const b = BUDGETS[this.budget];
        this.sim.params.iterations = b.iterations;
        this.sim.params.substeps = b.substeps;
        this.sim.params.young = 2500 * (this.stiff ? STIFF : 1);
        const kinds: SolverKind[] = this.mode === 'compare' ? ['xpbi', 'vanilla'] : [this.mode === 'semi' ? 'semi' : this.mode === 'vanilla' ? 'vanilla' : 'xpbi'];
        const spacing = this.lite ? SPACING.lite : SPACING.full;
        this.sim.configure(kinds, DOMAIN.w, DOMAIN.h, spacing);
        for (const w of this.sim.worlds) w.pointer.radius = 0.14;
        this.view?.rebuild(this.sim);
        this.layoutKey = '';
        this.refreshButtons();
    }

    private layout(): void {
        const camera = this.camera, view = this.view, hud = this.hud;
        if (!camera || !view || !hud) return;
        const win = screen.windowSize;
        const key = `${win.width}x${win.height}:${view.extent.width}`;
        if (key === this.layoutKey) return;
        this.layoutKey = key;
        const dpr = screen.devicePixelRatio || 1;
        const cssW = win.width / dpr, cssH = win.height / dpr;
        const top = hud.insets.top + 24, bottom = hud.insets.bottom + 6;
        const ext = view.extent;
        const scale = Math.max(0.1, Math.min((cssW - 12) / (ext.width + 0.08), (cssH - top - bottom) / (ext.height + 0.08)));
        camera.orthoHeight = cssH / scale / 2;
        const below = top + (cssH - top - bottom) / 2 - cssH / 2;
        camera.node.setPosition(ext.width / 2, ext.height / 2 - below / scale, 10);
        view.setPointSize(Math.max(2, scale * dpr * this.sim.spacing * 1.35));
        this.placeLabels(scale, cssW);
    }

    private applyPointer(): void {
        const p = this.interaction?.pointer;
        for (const w of this.sim.worlds) w.pointer.active = false;
        if (!p?.down || !this.view) { this.pointerLast.valid = false; return; }
        const vx = this.pointerLast.valid ? (p.x - this.pointerLast.x) * 60 : 0;
        const vy = this.pointerLast.valid ? (p.y - this.pointerLast.y) * 60 : 0;
        this.pointerLast.x = p.x; this.pointerLast.y = p.y; this.pointerLast.valid = true;
        this.sim.worlds.forEach((w, i) => {
            const ox = this.view!.offset(i);
            w.pointer.active = true;
            w.pointer.x = p.x - ox;
            w.pointer.y = p.y;
            w.pointer.vx = vx;
            w.pointer.vy = vy;
            w.pointer.mode = this.tool;
        });
    }

    private refreshButtons(): void {
        const hud = this.hud; if (!hud) return;
        hud.setButton('solver', MODE_NAMES[this.mode], this.mode !== 'xpbi');
        hud.setButton('scene', SCENE_NAMES[this.sim.scene]);
        const b = BUDGETS[this.budget];
        hud.setButton('budget', `${b.iterations}×${b.substeps}`, this.budget !== 1);
        hud.setButton('stiff', this.stiff ? 'Stiff ×4' : 'Stiff ×1', this.stiff);
        hud.setButton('tool', this.tool === 'grab' ? 'Grab' : 'Push', this.tool === 'push');
        this.labels.forEach((l, i) => {
            const w = this.sim.worlds[i];
            l.string = w ? (w.kind === 'vanilla' ? 'XPBD spheres' : w.kind === 'semi' ? 'Semi-implicit' : 'XPBI') : '';
        });
    }

    private updateHud(dt: number): void {
        this.frames++; this.frameTime += dt;
        if (this.frameTime < 0.5) return;
        const fps = this.frames / this.frameTime;
        this.frames = 0; this.frameTime = 0;
        const n = this.sim.worlds.reduce((s, w) => s + w.count, 0);
        const ms = this.sim.stepMs.reduce((a, b) => a + b, 0);
        const b = BUDGETS[this.budget];
        this.hud?.setStatus([
            `FPS ${fps.toFixed(0)} · ${n} particles · solve ${ms.toFixed(1)} ms`,
            `${MODE_NAMES[this.mode]} · ${b.iterations} GS × ${b.substeps} substeps · E=${this.sim.params.young}`,
            this.mode === 'compare' ? 'Left: continuum XPBI (yield in the loop). Right: colliding spheres with friction.' : 'S scene · B budget · K stiff · T grab/push · R reset',
            this.lite ? 'Lite spacing (auto)' : 'S scene · B budget · K stiff · T grab/push · R reset',
        ]);
    }

    private makeLabel(i: number): Label {
        const node = new Node(`Caption${i}`);
        this.canvas!.addChild(node);
        node.layer = Layers.Enum.UI_2D;
        node.addComponent(UITransform).setContentSize(180, 22);
        const label = node.addComponent(Label);
        label.fontSize = 16;
        label.color = new Color(255, 236, 170, 255);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        return label;
    }

    private placeLabels(scale: number, cssW: number): void {
        const view = this.view, hud = this.hud, canvas = this.canvas;
        if (!view || !hud || !canvas) return;
        const ui = canvas.getComponent(UITransform)!;
        const dpr = screen.devicePixelRatio || 1;
        const cssH = screen.windowSize.height / dpr;
        const visible = ccView.getVisibleSize();
        const k = visible.width / Math.max(1, cssW);
        this.sim.worlds.forEach((w, i) => {
            const label = this.labels[i];
            if (!label) return;
            const cx = (view.offset(i) + w.width / 2) * scale;
            const cssX = cx - (view.extent.width * scale) / 2 + cssW / 2;
            const cssY = cssH - hud.insets.top - 4;
            label.node.setPosition((cssX - cssW / 2) * k, (cssY - cssH / 2) * k, 0);
            label.node.getComponent(UITransform)!.setContentSize(w.width * scale * k, 22 * k);
            void ui;
        });
    }
}
