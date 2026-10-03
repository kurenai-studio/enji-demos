import {
    _decorator, Camera, Color, Component, director, DirectionalLight, geometry, Layers, Material, MeshRenderer, Node,
    primitives, renderer, resources, utils, Vec3,
} from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './rigid/Hud';
import { OrbitCamera } from './rigid/OrbitCamera';
import { RigidInteraction } from './rigid/RigidInteraction';
import { RigidView } from './rigid/RigidView';
import { buildScene, SCENES } from './rigid/Scenes';
import type { SceneInfo } from './rigid/Scenes';
import { Solver, SOLVER_NAMES, SOLVER_SHORT, World } from './rigid/World';

const { ccclass } = _decorator;

/** Side-by-side pairs first; single worlds get the whole screen. */
const MODES: Solver[][] = [
    [Solver.Naive, Solver.Sequential],
    [Solver.Sequential, Solver.Soft],
    [Solver.Sequential],
    [Solver.Soft],
];
/** Velocity iterations for the PGS solvers, substeps for the soft step. */
const EFFORT = [
    { iterations: 4, substeps: 2 },
    { iterations: 10, substeps: 4 },
    { iterations: 20, substeps: 8 },
];
const H = 1 / 60;
const MAX_STEPS_PER_FRAME = 2;
const BALL_SPEED = 14;
const SIDE_LABELS = ['Left', 'Right'];

function loadMaterial(name: string): Promise<Material> {
    return new Promise((resolve, reject) =>
        resources.load(`materials/${name}`, Material, (err, mat) => (err ? reject(err) : resolve(mat))));
}

/**
 * Rigid boxes and balls with persistent contact manifolds, solved three ways
 * side by side: naive per-iteration clamping, sequential impulses with warm
 * starting, and Box2D v3's soft step.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: RigidInteraction | null = null;
    private view: RigidView | null = null;
    private world: Node | null = null;
    private groundMaterial: Material | null = null;
    private grounds: Node[] = [];
    private worlds: World[] = [];
    private offsets: number[] = [];
    private info: SceneInfo | null = null;
    private sceneIndex = 0;
    private modeIndex = 0;
    private effortIndex = 1;
    private paused = false;
    private accumulator = 0;
    private frames = 0;
    private frameTime = 0;
    private stepMs: number[] = [];
    private stepSamples = 0;

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
        this.world = world;
        const cameraNode = new Node('MainCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(178, 192, 212, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.1;
        camera.far = 200;
        this.orbit = new OrbitCamera(camera, new Vec3(0, 4, 10));

        const sun = new Node('Sun');
        world.addChild(sun);
        sun.setRotationFromEuler(-52, 28, 0);
        const light = sun.addComponent(DirectionalLight);
        light.shadowEnabled = true;
        light.shadowPcf = 2;
        light.shadowFixedArea = false;
        light.shadowDistance = 30;
        light.shadowBias = 0.001;
        light.shadowNormalBias = 0.01;
        light.shadowSaturation = 0.7;
        const shadows = scene.globals.shadows;
        shadows.enabled = true;
        shadows.type = renderer.scene.ShadowType.ShadowMap;
        shadows.shadowMapSize = 2048;
        // The template scene's HDR ambient is black, which leaves unlit faces pitch black.
        scene.globals.ambient.skyLightingColor = new Color(120, 138, 168, 255);
        scene.globals.ambient.groundLightingColor = new Color(60, 58, 56, 255);

        const actions = {
            togglePause: () => { this.paused = !this.paused; this.refreshButtons(); },
            reset: () => this.rebuild(),
            cycleScene: () => { this.sceneIndex = (this.sceneIndex + 1) % SCENES.length; this.rebuild(true); },
            cycleMode: () => { this.modeIndex = (this.modeIndex + 1) % MODES.length; this.rebuild(true); },
            cycleIterations: () => { this.effortIndex = (this.effortIndex + 1) % EFFORT.length; this.rebuild(); },
            shoot: (ray: geometry.Ray) => this.shoot(ray),
        };
        this.hud = new Hud(ensureCanvas(root).node, [
            { id: 'scene', onTap: actions.cycleScene },
            { id: 'mode', onTap: actions.cycleMode },
            { id: 'effort', onTap: actions.cycleIterations },
            { id: 'reset', onTap: actions.reset },
            { id: 'pause', onTap: actions.togglePause },
        ]);
        this.hud.setButton('reset', 'Reset');
        this.interaction = new RigidInteraction(camera, this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();

        void Promise.all([loadMaterial('bodies'), loadMaterial('ground')]).then(([bodies, ground]) => {
            this.view = new RigidView(world, bodies);
            this.groundMaterial = ground;
            this.rebuild(true);
        });
        (globalThis as { __rigid?: MainView }).__rigid = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    /** Fresh worlds for the current scene and mode; `frame` also re-aims the camera. */
    private rebuild(frame = false): void {
        if (!this.view || !this.world) return;
        const name = SCENES[this.sceneIndex];
        const effort = EFFORT[this.effortIndex];
        this.worlds = MODES[this.modeIndex].map((solver) => {
            const w = new World();
            w.solver = solver;
            w.iterations = effort.iterations;
            w.substeps = effort.substeps;
            this.info = buildScene(w, name);
            return w;
        });
        const info = this.info!;
        const spacing = 2 * info.radius + 2;
        const n = this.worlds.length;
        this.offsets = this.worlds.map((_, i) => (i - (n - 1) / 2) * spacing);
        this.view.rebuild(this.worlds, this.offsets);

        for (const g of this.grounds) g.destroy();
        this.grounds = this.offsets.map((ox, i) => {
            const node = new Node(`Ground${i}`);
            this.world!.addChild(node);
            node.setPosition(ox + info.center.x, 0, info.center.z);
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = utils.MeshUtils.createMesh(primitives.plane({ width: spacing - 0.25, length: 2 * info.radius + 4, widthSegments: 1, lengthSegments: 1 }));
            if (this.groundMaterial) mr.setSharedMaterial(this.groundMaterial, 0);
            mr.receiveShadow = MeshRenderer.ShadowReceivingMode.ON;
            mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            return node;
        });

        if (frame && this.orbit) {
            const target = new Vec3(info.center.x, info.center.y, info.center.z);
            const halfWidth = (n * spacing) / 2;
            // OrbitCamera keeps at least 42 degrees horizontally, so this fits both copies on portrait screens too.
            const distance = Math.max(info.radius * 2.4, (halfWidth / Math.tan((21 * Math.PI) / 180)) * 1.05);
            const dir = new Vec3(0.25, 0.42, 1).normalize();
            this.orbit.minDistance = info.radius;
            this.orbit.maxDistance = distance * 2.5;
            this.orbit.setView(Vec3.scaleAndAdd(new Vec3(), target, dir, distance), target);
        }
        this.accumulator = 0;
        this.stepMs = this.worlds.map(() => 0);
        this.stepSamples = 0;
        this.refreshButtons();
    }

    /** Throws a ball along a ballistic arc that passes through the tapped point, in every world at once. */
    private shoot(ray: geometry.Ray): void {
        const info = this.info;
        if (!info || this.worlds.length === 0) return;
        // Aim at the copy whose centre is nearest to the ray.
        let best = 0, bestD = Infinity, bestT = 0;
        this.offsets.forEach((ox, i) => {
            const cx = ox + info.center.x - ray.o.x, cy = info.center.y - ray.o.y, cz = info.center.z - ray.o.z;
            const t = cx * ray.d.x + cy * ray.d.y + cz * ray.d.z;
            const dx = cx - ray.d.x * t, dy = cy - ray.d.y * t, dz = cz - ray.d.z * t;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = i; bestT = t; }
        });
        const ox = this.offsets[best];
        const start = 1.0;
        const o = { x: ray.o.x + ray.d.x * start - ox, y: ray.o.y + ray.d.y * start, z: ray.o.z + ray.d.z * start };
        const t = Math.max(bestT, start + 0.5);
        const target = { x: ray.o.x + ray.d.x * t - ox, y: Math.max(0.2, ray.o.y + ray.d.y * t), z: ray.o.z + ray.d.z * t };
        const dx = target.x - o.x, dy = target.y - o.y, dz = target.z - o.z;
        const time = Math.sqrt(dx * dx + dy * dy + dz * dz) / BALL_SPEED;
        const v = { x: dx / time, y: dy / time + 0.5 * 9.81 * time, z: dz / time };
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        const dir = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
        for (const w of this.worlds) w.shoot(o, dir, speed);
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        if (!this.paused && this.worlds.length) {
            this.accumulator += dt;
            let steps = 0;
            while (this.accumulator >= H && steps < MAX_STEPS_PER_FRAME) {
                this.worlds.forEach((w, i) => {
                    w.step(H);
                    this.stepMs[i] += w.stats.stepMs;
                });
                this.stepSamples++;
                this.accumulator -= H;
                steps++;
            }
            // Fall behind gracefully on slow devices instead of spiralling.
            if (this.accumulator > H) this.accumulator = 0;
        }
        this.view?.update();
        this.updateHud(dt);
    }

    private refreshButtons(): void {
        const hud = this.hud;
        if (!hud) return;
        const effort = EFFORT[this.effortIndex];
        hud.setButton('scene', `Scene: ${SCENES[this.sceneIndex]}`);
        hud.setButton('mode', MODES[this.modeIndex].map((s) => SOLVER_SHORT[s]).join(' | '));
        hud.setButton('effort', `Iter ${effort.iterations} · Sub ${effort.substeps}`);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud || !this.info) return;
        const info = this.info;
        const samples = Math.max(1, this.stepSamples);
        const ms = this.stepMs.map((t) => (t / samples).toFixed(2)).join(' + ');
        const contacts = this.worlds.reduce((sum, w) => sum + w.stats.contacts, 0);
        const lines = [`FPS ${(this.frames / this.frameTime).toFixed(0)} · step ${ms} ms · ${contacts} contacts`];
        this.worlds.forEach((w, i) => {
            const st = w.stats;
            const side = this.worlds.length > 1 ? `${SIDE_LABELS[i]} ` : '';
            const groups = info.groups
                .map((label, g) => (label ? `${label} ${st.groupMoved[g]}/${st.groupTotal[g]}` : ''))
                .filter(Boolean)
                .join(' · ');
            const verb = SCENES[this.sceneIndex] === 'domino' ? 'down' : 'moved';
            const name = this.worlds.length > 1 ? SOLVER_SHORT[w.solver] : SOLVER_NAMES[w.solver];
            const depth = `${(st.maxPenetration * 1000).toFixed(1)} mm deep`;
            lines.push(`${side}${name}: ${groups ? `${groups} ${verb} · ` : ''}${depth}`);
        });
        lines.push('Tap: throw a ball · drag: orbit · pinch: zoom');
        this.hud.setStatus(lines);
        this.frames = 0;
        this.frameTime = 0;
        this.stepMs.fill(0);
        this.stepSamples = 0;
    }
}
