import { _decorator, Camera, Color, Component, director, Layers, Node, Vec3 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './fem/Hud';
import { OrbitCamera } from './fem/OrbitCamera';
import { SoftInteraction } from './fem/SoftInteraction';
import { CG_ITERATIONS, Preset, SoftScene, STIFFNESS } from './fem/SoftScene';

const { ccclass } = _decorator;

const VIEWS: Record<Preset, { eye: Vec3; target: Vec3 }> = {
    beams: { eye: new Vec3(1.1, 1.75, 2.9), target: new Vec3(0, 0.9, 0) },
    spin: { eye: new Vec3(0, 1.7, 3.4), target: new Vec3(0, 1.0, 0) },
    jelly: { eye: new Vec3(0.9, 1.4, 2.6), target: new Vec3(0, 0.35, 0) },
};
/** Start-up check: skip the first frames, then average over a window and drop to lite grids if the device is slow. */
const AUTO_WARMUP = 30;
const AUTO_SAMPLES = 60;
const AUTO_MIN_FPS = 50;
const AUTO_MAX_SOLVER_MS = 8;

/**
 * Co-rotated FEM soft bodies: an implicit CPU solver in typed arrays streamed
 * into dynamic meshes every frame, sized to run on phones (lite meshes chosen
 * automatically at start-up, no shadow maps).
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private soft: SoftScene | null = null;
    private interaction: SoftInteraction | null = null;
    private frames = 0;
    private frameTime = 0;
    private autoFrames = 0;
    private autoTime = 0;
    private autoSolverMs = 0;

    bind(root: Node): void {
        const scene = director.getScene()!;
        // The template Canvas camera draws only the UI, on top of the 3D camera. Its
        // default visibility also includes DEFAULT, which would draw the world twice.
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }

        const world = new Node('World');
        scene.addChild(world);
        const cameraNode = new Node('MainCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(184, 199, 219, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.05;
        camera.far = 100;
        this.orbit = new OrbitCamera(camera, VIEWS.beams.eye);
        this.orbit.setView(VIEWS.beams.eye, VIEWS.beams.target);

        const actions = {
            togglePause: () => { if (this.soft) this.soft.paused = !this.soft.paused; this.refreshButtons(); },
            reset: () => { this.soft?.rebuild(); this.refreshButtons(); },
            cyclePreset: () => {
                if (!this.soft) return;
                this.soft.cyclePreset();
                const view = VIEWS[this.soft.preset];
                this.orbit?.setView(view.eye, view.target);
                this.refreshButtons();
            },
            cycleStiffness: () => { this.soft?.cycleStiffness(); this.refreshButtons(); },
            cycleCg: () => { this.soft?.cycleCg(); this.refreshButtons(); },
            toggleMethod: () => { this.soft?.toggleMethod(); this.refreshButtons(); },
            toggleLite: () => {
                if (!this.soft) return;
                this.autoFrames = -1;
                this.soft.setLite(!this.soft.lite);
                this.refreshButtons();
            },
        };

        this.hud = new Hud(ensureCanvas(root).node, [
            { id: 'preset', onTap: actions.cyclePreset },
            { id: 'reset', onTap: actions.reset },
            { id: 'pause', onTap: actions.togglePause },
            { id: 'method', onTap: actions.toggleMethod },
            { id: 'stiffness', onTap: actions.cycleStiffness },
            { id: 'cg', onTap: actions.cycleCg },
            { id: 'quality', onTap: actions.toggleLite },
        ]);
        this.hud.setButton('reset', 'Reset');

        this.interaction = new SoftInteraction(camera, this.orbit, () => this.soft, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();

        void SoftScene.create(world).then((soft) => {
            this.soft = soft;
            this.refreshButtons();
        });
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        this.soft?.update(dt);
        this.autoQuality(dt);
        this.updateHud(dt);
    }

    /** One-off start-up check; a manual quality toggle turns it off. */
    private autoQuality(dt: number): void {
        const soft = this.soft;
        if (!soft || soft.lite || this.autoFrames < 0) return;
        this.autoFrames += 1;
        if (this.autoFrames <= AUTO_WARMUP) return;
        this.autoTime += dt;
        this.autoSolverMs += soft.simMs;
        if (this.autoFrames < AUTO_WARMUP + AUTO_SAMPLES) return;
        const fps = AUTO_SAMPLES / this.autoTime;
        const solverMs = this.autoSolverMs / AUTO_SAMPLES;
        this.autoFrames = -1;
        if (fps < AUTO_MIN_FPS || solverMs > AUTO_MAX_SOLVER_MS) {
            soft.setLite(true);
            this.refreshButtons();
        }
    }

    private refreshButtons(): void {
        const soft = this.soft;
        const hud = this.hud;
        if (!soft || !hud) return;
        hud.setButton('preset', `Scene: ${soft.preset}`);
        hud.setButton('pause', soft.paused ? 'Resume' : 'Pause', soft.paused);
        hud.setButton('method', soft.preset === 'jelly' ? (soft.corotated ? 'Co-rotated' : 'Linear') : 'Both', soft.preset === 'jelly' && !soft.corotated);
        hud.setButton('stiffness', STIFFNESS[soft.stiffness].name);
        hud.setButton('cg', `CG ${CG_ITERATIONS[soft.cgLevel]}`);
        hud.setButton('quality', soft.lite ? 'Lite' : 'Full', soft.lite);
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud || !this.soft) return;
        const soft = this.soft;
        const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
        const lines = [
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · solver ${soft.simMs.toFixed(2)} ms · CG ${soft.cgUsed}/${CG_ITERATIONS[soft.cgLevel]}`,
            `${soft.tetCount} tets · ${soft.nodeCount} nodes · ${soft.lite ? 'lite' : 'full'} meshes`,
        ];
        if (soft.preset === 'jelly') {
            lines.push(`${soft.corotated ? 'Co-rotated' : 'Linear'} FEM · volume ${soft.bodies.map((b) => pct(b.fem.volumeRatio)).join(' ')}`);
            lines.push('Drag a block or the ball');
        } else {
            for (const b of soft.bodies) {
                const extra = soft.preset === 'beams' ? ` · tip drop ${(soft.tipDrop(b) * 100).toFixed(0)} cm` : '';
                lines.push(`${b.label}: volume ${pct(b.fem.volumeRatio)}${extra}`);
            }
        }
        this.hud.setStatus(lines);
        this.frames = 0;
        this.frameTime = 0;
    }
}
