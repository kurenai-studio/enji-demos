import { _decorator, Camera, Color, Component, director, Label, Layers, Node, screen, UITransform, view as ccView } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './mpm/Hud';
import { MpmInteraction } from './mpm/MpmInteraction';
import { FRAME_TIME, MpmSim, passesPerFrame, type SolverSetting } from './mpm/MpmSim';
import { ELASTIC, LIQUID, type MpmWorld, type SolverKind } from './mpm/MpmWorld';
import { MpmView } from './mpm/MpmView';
import { SCENE_NAMES } from './mpm/Scenes';

const { ccclass } = _decorator;

type Mode = 'compare' | 'pb' | 'mls';
const MODES: Mode[] = ['compare', 'pb', 'mls'];
const MODE_NAMES: Record<Mode, string> = { compare: 'PB vs MLS', pb: 'PB-MPM', mls: 'MLS-MPM' };
/** Grid-to-particle + particle-to-grid passes per rendered frame. */
const BUDGETS = [5, 10, 20, 40];
const SINGLE_GRID = { width: 48, height: 64 };
const COMPARE_WIDTH = 32;
const STIFF_FACTOR = 4;
const BASE_YOUNG = 1.5e5;
const BASE_BULK = 1.2e5;
const POINTER_RADIUS = 5;

/** Same pass budget for both solvers: PB-MPM spends it on iterations, MLS-MPM on substeps. */
function settingFor(kind: SolverKind, passes: number): SolverSetting {
    if (kind === 'pb') {
        const iterations = passes >= 40 ? 10 : 5;
        return { kind, rate: (passes / iterations) / FRAME_TIME, iterations };
    }
    return { kind, rate: passes / FRAME_TIME, iterations: 1 };
}

function describe(s: SolverSetting): string {
    return s.kind === 'pb' ? `PB-MPM ${s.rate.toFixed(0)} Hz × ${s.iterations}` : `MLS-MPM ${s.rate.toFixed(0)} Hz`;
}

/**
 * 2D MPM on the CPU: Position Based MPM (EA SEED 2024) next to explicit
 * MLS-MPM (Hu et al. 2018) on the same scene and the same number of grid
 * passes per frame. PB-MPM gets softer when the budget drops; MLS-MPM blows
 * up once its substep exceeds the material's stability limit.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private camera: Camera | null = null;
    private hud: Hud | null = null;
    private view: MpmView | null = null;
    private interaction: MpmInteraction | null = null;
    private readonly sim = new MpmSim();
    private mode: Mode = 'compare';
    private budget = 1;
    private stiff = false;
    private tool: 'grab' | 'push' = 'grab';
    private labels: Label[] = [];
    private canvas: Node | null = null;
    private readonly pointerLast = { x: 0, y: 0, valid: false };
    private frames = 0;
    private frameTime = 0;
    private layoutKey = '';

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
        const cameraNode = new Node('MpmCamera');
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
            cycleSolver: () => {
                this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
                this.reconfigure();
            },
            cycleScene: () => {
                this.sim.scene = (this.sim.scene + 1) % SCENE_NAMES.length;
                this.sim.reset();
                this.refreshButtons();
            },
            cycleBudget: () => {
                this.budget = (this.budget + 1) % BUDGETS.length;
                this.reconfigure();
            },
            toggleStiff: () => {
                this.stiff = !this.stiff;
                this.reconfigure();
            },
            toggleTool: () => {
                this.tool = this.tool === 'grab' ? 'push' : 'grab';
                this.refreshButtons();
            },
            reset: () => this.sim.reset(),
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

        this.interaction = new MpmInteraction(camera, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();

        void MpmView.create(world).then((v) => {
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
        this.sim.step();
        this.view.update(this.sim);
        this.updateHud(dt);
    }

    private reconfigure(): void {
        const passes = BUDGETS[this.budget];
        this.sim.params.youngModulus = BASE_YOUNG * (this.stiff ? STIFF_FACTOR : 1);
        this.sim.params.bulkModulus = BASE_BULK * (this.stiff ? STIFF_FACTOR : 1);
        const kinds: SolverKind[] = this.mode === 'compare' ? ['pb', 'mls'] : [this.mode];
        const width = this.mode === 'compare' ? COMPARE_WIDTH : SINGLE_GRID.width;
        this.sim.configure(kinds.map((k) => settingFor(k, passes)), width, SINGLE_GRID.height);
        for (const w of this.sim.worlds) w.pointer.radius = POINTER_RADIUS;
        this.view?.rebuild(this.sim);
        this.layoutKey = '';
        this.refreshButtons();
    }

    /** Fits the worlds between the status panel and the buttons; refits on resize. */
    private layout(): void {
        const camera = this.camera;
        const view = this.view;
        const hud = this.hud;
        if (!camera || !view || !hud) return;
        const win = screen.windowSize;
        const key = `${win.width}x${win.height}:${view.extent.width}`;
        if (key === this.layoutKey) return;
        this.layoutKey = key;
        const dpr = screen.devicePixelRatio || 1;
        const cssW = win.width / dpr;
        const cssH = win.height / dpr;
        const labelSpace = 24;
        const top = hud.insets.top + labelSpace;
        const bottom = hud.insets.bottom + 6;
        const ext = view.extent;
        const margin = 2;
        const scale = Math.max(0.1, Math.min((cssW - 12) / (ext.width + margin), (cssH - top - bottom) / (ext.height + margin)));
        camera.orthoHeight = cssH / scale / 2;
        // Centre of the free band, measured from the screen centre (positive = below).
        const below = top + (cssH - top - bottom) / 2 - cssH / 2;
        camera.node.setPosition(ext.width / 2, ext.height / 2 - below / scale, 10);
        // Particles sit half a cell apart; overlap them a little so materials read as solid.
        view.setPointSize(Math.max(2, scale * dpr * 0.5 * 1.45));
        this.placeLabels(scale, cssW);
    }

    /** Puts a solver label above each world in compare mode (canvas units are CSS pixels × k, as in Hud). */
    private placeLabels(cssPerCell: number, cssWidth: number): void {
        const camera = this.camera;
        const view = this.view;
        if (!camera || !view) return;
        const k = getVisibleWidth() / Math.max(1, cssWidth);
        const c = camera.node.position;
        this.labels.forEach((label, i) => {
            const world = this.sim.worlds[i];
            label.node.active = this.mode === 'compare' && !!world;
            if (!world) return;
            const x = (view.offset(i) + world.width / 2 - c.x) * cssPerCell;
            const y = (world.height - 1 - c.y) * cssPerCell + 14;
            label.node.setPosition(x * k, y * k, 0);
            label.node.setScale(k, k, 1);
            label.node.getComponent(UITransform)!.setContentSize(world.width * cssPerCell, 22);
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
        label.color = new Color(235, 240, 255, 255);
        label.overflow = Label.Overflow.SHRINK;
        node.active = false;
        return label;
    }

    /** Maps the finger into world grid units; in compare mode both worlds get it at the same spot. */
    private applyPointer(): void {
        const p = this.interaction?.pointer;
        const view = this.view;
        if (!p || !view) return;
        const worlds = this.sim.worlds;
        if (!p.down || worlds.length === 0) {
            for (const w of worlds) w.pointer.active = false;
            this.pointerLast.valid = false;
            return;
        }
        let index = 0;
        for (let i = 1; i < worlds.length; i++) if (p.x >= view.offset(i) - 1.5) index = i;
        const x = p.x - view.offset(index);
        const y = p.y;
        const vx = this.pointerLast.valid ? (x - this.pointerLast.x) / FRAME_TIME : 0;
        const vy = this.pointerLast.valid ? (y - this.pointerLast.y) / FRAME_TIME : 0;
        this.pointerLast.x = x;
        this.pointerLast.y = y;
        this.pointerLast.valid = true;
        for (const w of worlds) {
            const ptr = w.pointer;
            ptr.active = true;
            ptr.mode = this.tool;
            ptr.x = x;
            ptr.y = y;
            ptr.vx = vx;
            ptr.vy = vy;
        }
    }

    private refreshButtons(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('solver', MODE_NAMES[this.mode]);
        hud.setButton('scene', SCENE_NAMES[this.sim.scene]);
        hud.setButton('budget', `${BUDGETS[this.budget]} passes`);
        hud.setButton('stiff', `Stiff ×${this.stiff ? STIFF_FACTOR : 1}`, this.stiff);
        hud.setButton('tool', this.tool === 'grab' ? 'Grab' : 'Push');
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const sim = this.sim;
        const worlds = sim.worlds;
        const w0 = worlds[0];
        const grid = `${worlds.length > 1 ? '2 × ' : ''}${w0.width}×${w0.height}`;
        const side = (i: number) => (worlds.length > 1 ? (i === 0 ? 'L ' : 'R ') : '');
        const lines = [
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · ${sim.particleCount} particles · grid ${grid}`,
            worlds.length > 1
                ? `${BUDGETS[this.budget]} passes/frame each · solver ${worlds.map((w, i) => `${side(i)}${sim.stepMs[i].toFixed(1)} ms`).join(' ')}`
                : `${describe(sim.settings[0])} = ${BUDGETS[this.budget]} passes · ${sim.stepMs[0].toFixed(1)} ms`,
            worlds.map((w, i) => `${side(i)}${health(w)}${worlds.length === 1 && w.blewUp ? ' · blew up' : ''}`).join(' · '),
            `MLS moduli E ${(sim.params.youngModulus / 1000).toFixed(0)}k K ${(sim.params.bulkModulus / 1000).toFixed(0)}k · drag to ${this.tool}`,
        ];
        this.hud.setStatus(lines);
        this.labels.forEach((label, i) => {
            const w = worlds[i];
            if (!w) return;
            label.string = `${describe(sim.settings[i])}${w.blewUp ? ' blew up' : ''}`;
            label.color = w.blewUp ? new Color(255, 120, 110, 255) : new Color(235, 240, 255, 255);
        });
        this.frames = 0;
        this.frameTime = 0;
    }
}

function getVisibleWidth(): number {
    return ccView.getVisibleSize().width;
}

/** Liquid volume (mean det F) and jelly area error: what an under-resolved step costs. */
function health(w: MpmWorld): string {
    let liquid = 0;
    let jSum = 0;
    let jelly = 0;
    let err = 0;
    for (let i = 0; i < w.count; i++) {
        if (w.material[i] === LIQUID) {
            liquid++;
            jSum += w.jac[i];
        } else if (w.material[i] === ELASTIC) {
            jelly++;
            err += Math.abs(w.f00[i] * w.f11[i] - w.f01[i] * w.f10[i] - 1);
        }
    }
    const parts: string[] = [];
    if (liquid) parts.push(`liquid ${((jSum / liquid) * 100).toFixed(0)}%`);
    if (jelly) parts.push(`jelly ±${Math.min(99, (err / jelly) * 100).toFixed(0)}%`);
    return parts.join(' ') || 'ok';
}
