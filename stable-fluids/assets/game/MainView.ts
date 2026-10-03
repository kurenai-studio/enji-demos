import { _decorator, Camera, Color, Component, director, Label, Layers, Node, screen, UITransform, Vec2, view as ccView } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Advection, type AdvectionKind, FluidGrid, type Obstacle } from './fluid/FluidGrid';
import { FluidInteraction } from './fluid/FluidInteraction';
import { FluidView, ViewMode } from './fluid/FluidView';
import { Hud } from './fluid/Hud';
import { PressureSolver, type PressureKind } from './fluid/Pressure';
import { buildScene, type Scene, SCENES, SCENE_TITLES } from './fluid/Scenes';

const { ccclass } = _decorator;

type Mode = 'compare' | 'mac' | 'sl';
const MODES: Mode[] = ['compare', 'mac', 'sl'];
const MODE_NAMES: Record<Mode, string> = { compare: 'SL vs MacC', mac: 'MacCormack', sl: 'Semi-Lagr.' };
const ADVECTION_NAMES = ['Semi-Lagrangian', 'MacCormack'];
const PRESSURES: { kind: PressureKind; iterations: number; name: string }[] = [
    { kind: PressureSolver.MGPCG, iterations: 0, name: 'MGPCG' },
    { kind: PressureSolver.Jacobi, iterations: 40, name: 'Jacobi 40' },
];
/** Grid sizes (cells); the lite grid keeps the 2:1 domain and still halves down to 8 × 4 for multigrid. */
const GRIDS = { full: { nx: 160, ny: 80 }, lite: { nx: 128, ny: 64 } };
const DT = 1 / 60;
const VORTICITY = 0.35;
const AUTO_WARMUP = 30;
const AUTO_SAMPLES = 60;
const AUTO_MAX_SOLVER_MS = 9;
const GRAB_MARGIN = 3;
const STIR_RADIUS = 0.035;
const STIR_GAIN = 0.7;

/**
 * Stable Fluids on the CPU (MAC grid, 2D): the same scene advected with
 * semi-Lagrangian (Stam 1999) and MacCormack (Selle et al. 2008), stacked
 * so a phone in portrait shows both. The pressure solve is multigrid-
 * preconditioned CG or plain Jacobi; the HUD shows what each leaves behind.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private camera: Camera | null = null;
    private hud: Hud | null = null;
    private view: FluidView | null = null;
    private interaction: FluidInteraction | null = null;
    private grids: FluidGrid[] = [];
    private scenes: Scene[] = [];
    private mode: Mode = 'compare';
    private sceneIndex = 0;
    private pressure = 0;
    private vorticity = false;
    private lite = false;
    private labels: Label[] = [];
    private canvas: Node | null = null;
    private readonly last = { x: 0, y: 0, valid: false };
    private grab = false;
    private hue = 0;
    private autoFrames = 0;
    private autoSolverMs = 0;
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
        const cameraNode = new Node('FluidCamera');
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
            cycleAdvection: () => {
                this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
                this.reconfigure();
            },
            cycleScene: () => {
                this.sceneIndex = (this.sceneIndex + 1) % SCENES.length;
                this.resetScene();
            },
            cyclePressure: () => {
                this.pressure = (this.pressure + 1) % PRESSURES.length;
                this.applyParams();
            },
            toggleVorticity: () => {
                this.vorticity = !this.vorticity;
                this.applyParams();
            },
            cycleView: () => {
                if (this.view) this.view.mode = this.view.mode === ViewMode.Dye ? ViewMode.Curl : ViewMode.Dye;
                this.refreshButtons();
            },
            reset: () => this.resetScene(),
            toggleLite: () => {
                this.autoFrames = -1;
                this.lite = !this.lite;
                this.reconfigure();
            },
        };

        this.canvas = ensureCanvas(root).node;
        this.hud = new Hud(this.canvas, [
            { id: 'advection', onTap: actions.cycleAdvection },
            { id: 'scene', onTap: actions.cycleScene },
            { id: 'pressure', onTap: actions.cyclePressure },
            { id: 'vorticity', onTap: actions.toggleVorticity },
            { id: 'view', onTap: actions.cycleView },
            { id: 'reset', onTap: actions.reset },
        ]);
        this.hud.setButton('reset', 'Reset');
        for (let i = 0; i < 2; i++) this.labels.push(this.makeLabel(i));
        this.interaction = new FluidInteraction(camera, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();
        (globalThis as Record<string, unknown>).__fluid = this;

        void FluidView.create(world).then((v) => {
            this.view = v;
            this.reconfigure();
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
        this.grids.forEach((g, i) => g.step((grid) => this.scenes[i].drive(grid)));
        this.view.update(this.grids);
        this.updateHud(dt);
        this.autoQuality();
    }

    /** Once, at start-up: drop to the lite grid if both solvers together take more than ~half a frame. */
    private autoQuality(): void {
        if (this.autoFrames < 0) return;
        this.autoFrames += 1;
        if (this.autoFrames <= AUTO_WARMUP) return;
        for (const g of this.grids) this.autoSolverMs += g.stats.stepMs;
        if (this.autoFrames < AUTO_WARMUP + AUTO_SAMPLES) return;
        const ms = this.autoSolverMs / AUTO_SAMPLES;
        this.autoFrames = -1;
        if (ms > AUTO_MAX_SOLVER_MS && !this.lite) {
            this.lite = true;
            this.reconfigure();
        }
    }

    private advections(): AdvectionKind[] {
        if (this.mode === 'compare') return [Advection.SemiLagrangian, Advection.MacCormack];
        return [this.mode === 'mac' ? Advection.MacCormack : Advection.SemiLagrangian];
    }

    private reconfigure(): void {
        const size = this.lite ? GRIDS.lite : GRIDS.full;
        this.grids = this.advections().map((kind) => {
            const g = new FluidGrid(size.nx, size.ny);
            g.params.advection = kind;
            g.params.dt = DT;
            return g;
        });
        this.resetScene();
        this.view?.rebuild(this.grids);
        this.layoutKey = '';
    }

    private resetScene(): void {
        this.scenes = this.grids.map((g) => buildScene(SCENES[this.sceneIndex], g));
        this.applyParams();
    }

    private applyParams(): void {
        const pr = PRESSURES[this.pressure];
        for (const g of this.grids) {
            g.params.pressure = pr.kind;
            g.params.jacobiIterations = pr.iterations;
            g.params.vorticity = this.vorticity ? VORTICITY : 0;
        }
        this.refreshButtons();
    }

    /** Fits the grids between the status panel and the buttons; refits on resize. */
    private layout(): void {
        const camera = this.camera;
        const view = this.view;
        const hud = this.hud;
        if (!camera || !view || !hud) return;
        const win = screen.windowSize;
        const ext = view.extent;
        const key = `${win.width}x${win.height}:${ext.width}x${ext.height}`;
        if (key === this.layoutKey) return;
        this.layoutKey = key;
        const dpr = screen.devicePixelRatio || 1;
        const cssW = win.width / dpr;
        const cssH = win.height / dpr;
        const top = hud.insets.top;
        const bottom = hud.insets.bottom + 6;
        const margin = 4;
        const scale = Math.max(0.1, Math.min((cssW - 12) / (ext.width + margin), (cssH - top - bottom) / (ext.height + margin)));
        camera.orthoHeight = cssH / scale / 2;
        const below = top + (cssH - top - bottom) / 2 - cssH / 2;
        camera.node.setPosition(ext.width / 2, ext.height / 2 - below / scale, 10);
        this.placeLabels(scale, cssW);
    }

    /** Names the advection scheme in the top-left corner of each grid (compare mode only). */
    private placeLabels(cssPerCell: number, cssWidth: number): void {
        const camera = this.camera;
        const view = this.view;
        if (!camera || !view) return;
        const k = ccView.getVisibleSize().width / Math.max(1, cssWidth);
        const c = camera.node.position;
        this.labels.forEach((label, i) => {
            const g = this.grids[i];
            label.node.active = this.mode === 'compare' && !!g;
            if (!g) return;
            label.string = ADVECTION_NAMES[g.params.advection];
            const x = (0 - c.x) * cssPerCell + 8;
            const y = (view.offset(i) + g.ny - c.y) * cssPerCell - 6;
            label.node.setPosition(x * k, y * k, 0);
            label.node.setScale(k, k, 1);
        });
    }

    private makeLabel(i: number): Label {
        const node = new Node(`GridLabel${i}`);
        node.layer = Layers.Enum.UI_2D;
        this.canvas!.addChild(node);
        const transform = node.addComponent(UITransform);
        transform.setContentSize(200, 22);
        transform.anchorPoint = new Vec2(0, 1);
        const label = node.addComponent(Label);
        label.fontSize = 15;
        label.lineHeight = 22;
        label.color = new Color(235, 240, 255, 230);
        label.horizontalAlign = Label.HorizontalAlign.LEFT;
        node.active = false;
        return label;
    }

    /** Maps the finger into grid cells; in compare mode both grids get the same stroke. */
    private applyPointer(): void {
        const p = this.interaction?.pointer;
        const view = this.view;
        const g0 = this.grids[0];
        if (!p || !view || !g0) return;
        if (!p.down) {
            if (this.grab) for (const g of this.grids) for (const o of g.obstacles) o.vx = o.vy = 0;
            this.grab = false;
            this.last.valid = false;
            return;
        }
        let index = 0;
        for (let i = 1; i < this.grids.length; i++) {
            if (p.y < view.offset(i - 1) - 2) index = i;
        }
        const x = p.x;
        const y = p.y - view.offset(index);
        if (p.started) {
            p.started = false;
            const o = g0.obstacles[0];
            this.grab = !!o && Math.hypot(x - o.x, y - o.y) < o.r + GRAB_MARGIN;
        }
        const vx = this.last.valid ? (x - this.last.x) / DT : 0;
        const vy = this.last.valid ? (y - this.last.y) / DT : 0;
        this.last.x = x;
        this.last.y = y;
        this.last.valid = true;
        if (this.grab) {
            for (const g of this.grids) for (const o of g.obstacles) moveObstacle(o, x, y, vx, vy, g);
            return;
        }
        this.hue = (this.hue + DT * 0.15) % 1;
        const [cr, cg, cb] = hueColor(this.hue);
        const moving = Math.min(1, Math.hypot(vx, vy) / 30);
        const amount = 0.08 + 0.5 * moving;
        for (const g of this.grids) {
            g.splat(x, y, STIR_RADIUS * g.ny, vx * STIR_GAIN, vy * STIR_GAIN, cr * amount, cg * amount, cb * amount);
        }
    }

    private refreshButtons(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('advection', MODE_NAMES[this.mode]);
        hud.setButton('scene', SCENE_TITLES[SCENES[this.sceneIndex]]);
        hud.setButton('pressure', PRESSURES[this.pressure].name);
        hud.setButton('vorticity', 'Vorticity', this.vorticity);
        hud.setButton('view', this.view?.mode === ViewMode.Curl ? 'View: curl' : 'View: dye');
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const grids = this.grids;
        const g0 = grids[0];
        const two = grids.length > 1;
        const side = (g: FluidGrid) => (two ? `${g.params.advection === Advection.MacCormack ? 'MC' : 'SL'} ` : '');
        const each = (f: (g: FluidGrid) => string) => grids.map((g) => `${side(g)}${f(g)}`).join(' · ');
        const pr = PRESSURES[this.pressure];
        const scene = SCENES[this.sceneIndex];
        this.hud.setStatus([
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · ${two ? '2×' : ''}${g0.nx}×${g0.ny}${this.lite ? ' lite' : ''} · step ${each((g) => g.stats.stepMs.toFixed(1))} ms`,
            `${pr.name} ${each((g) => `${g.stats.pressureIterations} it ${g.stats.pressureMs.toFixed(1)} ms`)}`,
            `left-over max|∇·u| ${each((g) => g.stats.maxDivergence.toExponential(0))}`,
            `swirl ${each((g) => `${(g.stats.enstrophy / 1000).toFixed(1)}k`)} · drag ${scene === 'tunnel' ? 'fluid or cylinder' : 'to stir'}`,
        ]);
        this.frames = 0;
        this.frameTime = 0;
    }
}

function moveObstacle(o: Obstacle, x: number, y: number, vx: number, vy: number, g: FluidGrid): void {
    const nx = Math.min(g.nx - o.r - 1, Math.max(o.r + 1, x));
    const ny = Math.min(g.ny - o.r - 1, Math.max(o.r + 1, y));
    o.vx = 0.5 * o.vx + 0.5 * vx;
    o.vy = 0.5 * o.vy + 0.5 * vy;
    o.x = nx;
    o.y = ny;
}

function hueColor(h: number): [number, number, number] {
    const k = (n: number) => {
        const t = (n + h * 6) % 6;
        return Math.max(0, Math.min(1, Math.abs(t - 3) - 1));
    };
    return [k(5), k(3), k(1)];
}
