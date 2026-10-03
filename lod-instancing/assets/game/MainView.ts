import {
    _decorator, Camera, Color, Component, director, EffectAsset, KeyCode, Layers, Mat4, Material, MeshRenderer, Node, Texture2D, Vec3,
} from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadEffect } from '../enji/helpers';
import { bakeImpostors } from './lod/Baker';
import { frustumPlanes } from './lod/Culling';
import { makeForest, terrainHeight, type Forest } from './lod/Forest';
import { GpuPath } from './lod/GpuPath';
import { DEFAULT_LOD, screenSize, type LodSettings } from './lod/Lod';
import { MergedPath } from './lod/MergedPath';
import { groundMesh } from './lod/Meshes';
import { NodePath } from './lod/NodePath';
import { v4, type FrameInput, type RenderPath, type Shared } from './lod/Paths';
import { FOG_COLOR, toDisplay } from './lod/Shading';
import { buildSpecies, type SpeciesAssets } from './lod/Species';
import { Hud } from './ui/Hud';
import { Interaction } from './ui/Interaction';
import { OrbitCamera } from './ui/OrbitCamera';

const { ccclass } = _decorator;

const COUNTS = [16384, 65536, 4096];
const PATH_NAMES = ['Nodes', 'LODGroup', 'Merged', 'GPU list'];
const PATH_HINTS = [
    'A node per tree, level 0 only: a draw call per visible tree',
    'A node per tree with an engine LODGroup over 3 levels, engine instancing',
    'Static batches per 32 m cell and level, built lazily; whole cells switch',
    'No nodes: script culls and picks levels, chunk meshes read a list texture',
];
const FADES = [0.4, 0];
const BIASES = [1, 0.5, 2];
const FLY_SPEED = 7;
/** Node paths stop here: 64K LODGroups take about 20 s to build. */
const NODE_LIMIT = 16384;

/**
 * Forest of up to 64K trees and rocks drawn four ways, to compare draw calls,
 * triangles and script cost of the scene graph, engine LOD and instancing,
 * static batching, and data-texture instancing with per-instance LOD,
 * cross-fades and billboard impostors.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private camera: Camera | null = null;
    private hud: Hud | null = null;
    private interaction: Interaction | null = null;
    private world: Node | null = null;
    private species: SpeciesAssets[] = [];
    private treeEffect: EffectAsset | null = null;
    private impostorEffect: EffectAsset | null = null;
    private atlas: Texture2D | null = null;
    private groundMaterial: Material | null = null;
    private ground: Node | null = null;
    private forest: Forest | null = null;
    private path: RenderPath | null = null;
    private pathIndex = 3;
    private countIndex = 0;
    private readonly lod: LodSettings = { ...DEFAULT_LOD, thresholds: [...DEFAULT_LOD.thresholds] };
    private fadeIndex = 0;
    private biasIndex = 0;
    private tint = false;
    private fly = true;
    private spy = false;
    private flyAngle = 0.3;
    private frozen: FrameInput | null = null;
    private readonly frame: FrameInput = {
        planes: new Float64Array(24), eye: [0, 0, 0], projScale: 1, dt: 0, lod: this.lod, tint: false, fog: 1,
    };
    private frames = 0;
    private frameTime = 0;
    private fps = 0;
    private cpuSum = 0;
    private cpuMs = 0;
    private status = 'Loading…';

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }
        // The effects write display-ready colour themselves; HDR would apply the physical exposure.
        scene.globals.skybox.useHDR = false;
        const world = new Node('World');
        scene.addChild(world);
        this.world = world;
        const cameraNode = new Node('MainCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        const fog = FOG_COLOR.map((c) => Math.round(toDisplay(c) * 255));
        camera.clearColor = new Color(fog[0], fog[1], fog[2], 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.3;
        camera.far = 1500;
        this.camera = camera;
        this.orbit = new OrbitCamera(camera, new Vec3(0, 20, 40));
        this.orbit.minDistance = 3;
        this.orbit.maxDistance = 200;

        const actions = {
            path: () => this.setPath((this.pathIndex + 1) % PATH_NAMES.length),
            count: () => { this.countIndex = (this.countIndex + 1) % COUNTS.length; this.rebuild(); },
            lod: () => { this.lod.enabled = !this.lod.enabled; this.apply(); },
            fade: () => { this.fadeIndex = (this.fadeIndex + 1) % FADES.length; this.lod.fadeSeconds = FADES[this.fadeIndex]; this.apply(); },
            impostor: () => { this.lod.impostors = !this.lod.impostors; this.apply(); },
            bias: () => { this.biasIndex = (this.biasIndex + 1) % BIASES.length; this.lod.bias = BIASES[this.biasIndex]; this.apply(); },
            tint: () => { this.tint = !this.tint; this.apply(); },
            fly: () => { this.fly = !this.fly; this.apply(); },
            spy: () => this.setSpy(!this.spy),
        };
        this.hud = new Hud(ensureCanvas(root).node, Object.entries(actions).map(([id, onTap]) => ({ id, onTap })));
        this.interaction = new Interaction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, [
            [KeyCode.DIGIT_1, () => this.setPath(0)], [KeyCode.DIGIT_2, () => this.setPath(1)],
            [KeyCode.DIGIT_3, () => this.setPath(2)], [KeyCode.DIGIT_4, () => this.setPath(3)],
            [KeyCode.KEY_N, actions.count], [KeyCode.KEY_L, actions.lod], [KeyCode.KEY_F, actions.fade],
            [KeyCode.KEY_I, actions.impostor], [KeyCode.KEY_B, actions.bias], [KeyCode.KEY_T, actions.tint],
            [KeyCode.KEY_A, actions.fly], [KeyCode.KEY_V, actions.spy],
        ]);
        this.interaction.enable();
        this.apply();

        const t0 = performance.now();
        this.species = buildSpecies();
        const simplifyMs = performance.now() - t0;
        void Promise.all([loadEffect('effects/lod-tree'), loadEffect('effects/lod-impostor')]).then(async ([tree, impostor]) => {
            this.treeEffect = tree;
            this.impostorEffect = impostor;
            const albedo = this.makeMaterial(tree, { BAKE_ALBEDO: true });
            const normal = this.makeMaterial(tree, { BAKE_NORMAL: true });
            const t1 = performance.now();
            const baked = await bakeImpostors(scene, this.species, albedo, normal);
            this.atlas = baked.texture;
            console.log(`LOD meshes ${simplifyMs.toFixed(0)} ms, impostor bake ${(performance.now() - t1).toFixed(0)} ms`);
            this.groundMaterial = this.makeMaterial(tree);
            this.groundMaterial.setProperty('look', v4(0, -1, 0, 0));
            this.rebuild();
        });
        (globalThis as { __lod?: MainView }).__lod = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    private makeMaterial(effectAsset: EffectAsset, defines: Record<string, boolean | number> = {}): Material {
        const m = new Material();
        m.initialize({ effectAsset, defines });
        return m;
    }

    private shared(): Shared {
        return {
            forest: this.forest!, species: this.species, treeEffect: this.treeEffect!, impostorEffect: this.impostorEffect!,
            atlas: this.atlas!, makeMaterial: (e, d) => this.makeMaterial(e, d),
        };
    }

    /** New forest for the current count, new ground, and the current path rebuilt. */
    private rebuild(): void {
        if (!this.world || !this.atlas) return;
        this.path?.destroy();
        this.path = null;
        this.forest = makeForest(COUNTS[this.countIndex], 7, this.species);
        this.ground?.destroy();
        const ground = new Node('Ground');
        this.world.addChild(ground);
        const r = ground.addComponent(MeshRenderer);
        r.mesh = groundMesh(this.forest.size + 1000);
        r.setSharedMaterial(this.groundMaterial!, 0);
        this.ground = ground;
        this.setPath(this.pathIndex);
    }

    setPath(index: number): void {
        this.pathIndex = index;
        if (!this.forest || !this.world) { this.apply(); return; }
        this.path?.destroy();
        const shared = this.shared();
        const t = this.lod.thresholds;
        // The engine LODGroup culls below its last level: the size at the far distance.
        const far = screenSize(Math.min(...this.species.map((s) => s.radius)), this.lod.maxDistance, 2.4);
        this.path = index === 0 ? new NodePath(this.world, shared, false, false, t, far, NODE_LIMIT)
            : index === 1 ? new NodePath(this.world, shared, true, true, t, far, NODE_LIMIT)
                : index === 2 ? new MergedPath(this.world, shared) : new GpuPath(this.world, shared);
        this.apply();
    }

    private setSpy(on: boolean): void {
        this.spy = on;
        if (on) {
            const f = this.frame;
            this.frozen = { ...f, planes: Float64Array.from(f.planes), eye: [...f.eye] as [number, number, number] };
        } else {
            this.frozen = null;
        }
        this.apply();
    }

    update(dt: number): void {
        const camera = this.camera;
        const orbit = this.orbit;
        if (!camera || !orbit) return;
        if (this.spy && this.frozen) {
            const [x, y, z] = this.frozen.eye;
            const fwd = camera.node.forward;
            const h = Math.hypot(fwd.x, fwd.z) || 1;
            if (!this.spyPlaced) {
                this.spyPlaced = true;
                this.spyForward = [fwd.x / h, fwd.z / h];
            }
            const [fx, fz] = this.spyForward;
            orbit.setView(new Vec3(x - fx * 140, y + 330, z - fz * 140), new Vec3(x + fx * 150, y, z + fz * 150));
        } else {
            this.spyPlaced = false;
            if (this.fly && this.forest) this.flyStep(dt);
            else orbit.update(dt);
        }
        camera.camera.update(true);
        const f = this.frame;
        f.dt = dt;
        f.tint = this.tint;
        f.fog = this.spy ? 0 : 1;
        if (!this.spy) {
            frustumPlanes(Mat4.toArray(this.matrix, camera.camera.matViewProj), f.planes);
            const p = camera.node.worldPosition;
            f.eye[0] = p.x; f.eye[1] = p.y; f.eye[2] = p.z;
            f.projScale = camera.camera.matProj.m05;
        }
        const input = this.spy && this.frozen ? { ...this.frozen, dt, tint: this.tint, fog: 0, lod: this.lod } : f;
        if (this.path) {
            this.path.update(input);
            this.cpuSum += this.path.cpuMs;
        }
        this.groundMaterial?.setProperty('dims', v4(1, 1, f.fog, 0));
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime >= 0.5) {
            this.fps = this.frames / this.frameTime;
            this.cpuMs = this.cpuSum / this.frames;
            this.frames = 0;
            this.frameTime = 0;
            this.cpuSum = 0;
            this.writeStatus();
        }
    }

    private spyPlaced = false;
    private spyForward: [number, number] = [0, -1];
    private readonly matrix = new Float64Array(16);

    /** Circles the forest at canopy height, looking a little ahead and down. */
    private flyStep(dt: number): void {
        const f = this.forest!;
        const radius = f.size * 0.28;
        this.flyAngle += (FLY_SPEED * dt) / radius;
        const a = this.flyAngle;
        const ex = Math.cos(a) * radius, ez = Math.sin(a) * radius;
        const b = a + 50 / radius;
        const tx = Math.cos(b) * radius * 0.92, tz = Math.sin(b) * radius * 0.92;
        this.orbit!.setView(new Vec3(ex, terrainHeight(ex, ez) + 16, ez), new Vec3(tx, terrainHeight(tx, tz) + 4, tz));
    }

    private apply(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('path', PATH_NAMES[this.pathIndex], true);
        hud.setButton('count', formatCount(COUNTS[this.countIndex]));
        hud.setButton('lod', this.lod.enabled ? 'LOD on' : 'LOD off', this.lod.enabled);
        hud.setButton('fade', this.lod.fadeSeconds > 0 ? 'Cross-fade' : 'Pop', this.lod.fadeSeconds > 0);
        hud.setButton('impostor', this.lod.impostors ? 'Impostors' : 'No impostors', this.lod.impostors);
        hud.setButton('bias', `Bias ×${this.lod.bias}`, this.lod.bias !== 1);
        hud.setButton('tint', 'LOD colours', this.tint);
        hud.setButton('fly', this.fly ? 'Flying' : 'Orbit', this.fly);
        hud.setButton('spy', 'Overhead', this.spy);
        this.writeStatus();
    }

    private writeStatus(): void {
        if (!this.hud) return;
        const device = director.root!.device;
        const engineOnly = this.pathIndex < 2 && (this.spy || this.lod.fadeSeconds > 0 || this.lod.impostors);
        this.status = this.path ? this.path.describe() : 'Loading…';
        this.hud.setStatus([
            `FPS ${this.fps.toFixed(0)} · ${formatCount(COUNTS[this.countIndex])} trees · ${device.numDrawCalls} draws · ` +
                `${(device.numTris / 1e6).toFixed(2)} M tris · ${device.numInstances} instances · script ${this.cpuMs.toFixed(2)} ms`,
            `${PATH_NAMES[this.pathIndex]}: ${PATH_HINTS[this.pathIndex]}`,
            this.status,
            engineOnly ? 'Engine paths ignore fade, impostors and the frozen overhead culling' : this.spy ? 'Culling frozen at the last camera; fog off' : '',
            '1-4 path · N count · L lod · F fade · I impostors · B bias · T colours · A fly · V overhead',
        ]);
    }
}

function formatCount(n: number): string {
    return n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}`;
}
