import {
    _decorator, Camera, Color, Component, director, KeyCode, Layers, Material, Mesh, MeshRenderer, Node, primitives,
    Texture2D, utils, Vec3, Vec4,
} from 'cc';
import type { IView } from '../enji/IView';
import { createDataTexture, ensureCanvas, loadEffect } from '../enji/helpers';
import { BLOOM_LEVELS, FxPipeline, HIGH_LAYER, LOW_LAYER, STAGE_LAYER } from './fx/FxPipeline';
import { HDR_NAMES, HIGH_SCALE, TONE_NAMES } from './fx/Hdr';
import { Hud } from './fx/Hud';
import { Interaction } from './fx/Interaction';
import { OrbitCamera } from './fx/OrbitCamera';
import { CHUNK, particleChunk } from './fx/ParticleMesh';
import { CpuParticles, EMBERS, FIREWORKS, FOUNTAIN, SCENE_NAMES, SHELL_CYCLES, SHELLS } from './fx/Particles';
import { buildShellTable, shellLights } from './fx/Shells';
import { buildBowl, buildGround, buildNozzle, buildSky, FIRE_POS, LAMP_INTENSITY, LAMPS, NOZZLE_POS } from './fx/Stage';

const { ccclass } = _decorator;

/** State texture widths: particles = width². */
const WIDTHS = [256, 512, 128];
const EXPOSURES = [0, 1, -1, 2];
const BLOOM_STATES = ['Bloom on', 'Bloom off', 'Bloom only'];
const BLOOM_STRENGTH = 0.9;
const THRESHOLD = 1;
const KNEE = 0.5;
const STREAK_SECONDS = 1 / 30;
const MAX_STEP = 1 / 30;
const VIEWS: readonly [Vec3, Vec3][] = [
    [new Vec3(5.5, 2.6, 8.5), new Vec3(0, 1.7, 0)],
    [new Vec3(6, 2.6, 10.5), new Vec3(0, 3.2, 0)],
    [new Vec3(0, 2.5, 25), new Vec3(0, 8.5, -3)],
];
const SCENE_HINTS = [
    'Spark fountain: gravity, drag, bounces off the ground',
    'Embers: buoyancy and a curl-noise flow field',
    `Fireworks: ${SHELLS} shells (sphere, ring, willow), flashes light the ground`,
];
const HDR_HINTS = [
    'Particles ×1 and ×1/16 in two 8-bit targets; stage x/(1+x)',
    'Everything clamped at 1 before bloom and tone map',
    'One linear range, c/16 in 8 bits: darks band',
];

/**
 * GPU particles with HDR bloom and tone mapping, on 8-bit render targets:
 * the simulation state lives in RGBA8 textures (16 bits per value), the
 * particles accumulate in two linear ranges, and a Call of Duty–style bloom
 * chain and ACES / Reinhard tone mapping finish the frame.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: Interaction | null = null;
    private pipeline: FxPipeline | null = null;
    private camera: Camera | null = null;
    private stageMaterial: Material | null = null;
    private particleLow: Material | null = null;
    private particleHigh: Material | null = null;
    private bowl: Node[] = [];
    private nozzle: Node[] = [];
    private chunks: Node[] = [];
    private readonly chunkMeshes: Mesh[] = [];
    private world: Node | null = null;
    private readonly shells = buildShellTable();
    private shellTex: Texture2D | null = null;
    private lightTex: Texture2D | null = null;
    private readonly lightData = new Float32Array(8 * 2 * 4);
    private cpu: CpuParticles | null = null;
    private cpuTex: Texture2D[] = [];
    private sceneIndex = FOUNTAIN;
    private widthIndex = 0;
    private gpu = true;
    private hdrMode = 0;
    private tone = 0;
    private exposureIndex = 0;
    private bloomState = 0;
    private paused = false;
    private stochastic = true;
    private time = 0;
    private wall = 0;
    private parity = 0;
    private frame = 0;
    private frames = 0;
    private frameTime = 0;
    private fps = 0;
    private cpuMs = 0;
    private cpuMsSum = 0;
    private cpuSteps = 0;
    private readonly v4 = new Vec4();

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
        camera.clearColor = new Color(0, 0, 0, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.1;
        camera.far = 200;
        this.camera = camera;
        const [eye, target] = VIEWS[this.sceneIndex];
        this.orbit = new OrbitCamera(camera, eye);
        this.orbit.setView(eye, target);
        this.orbit.minDistance = 2;
        this.orbit.maxDistance = 40;

        const actions = {
            scene: () => { this.sceneIndex = (this.sceneIndex + 1) % SCENE_NAMES.length; this.setView(); this.reset(); },
            count: () => { this.widthIndex = (this.widthIndex + 1) % WIDTHS.length; this.reset(); },
            sim: () => { this.gpu = !this.gpu; this.reset(); },
            hdr: () => { this.hdrMode = (this.hdrMode + 1) % HDR_NAMES.length; this.apply(); },
            tone: () => { this.tone = (this.tone + 1) % TONE_NAMES.length; this.apply(); },
            bloom: () => { this.bloomState = (this.bloomState + 1) % BLOOM_STATES.length; this.apply(); },
            exposure: () => { this.exposureIndex = (this.exposureIndex + 1) % EXPOSURES.length; this.apply(); },
            pause: () => { this.paused = !this.paused; this.apply(); },
            rounding: () => { this.stochastic = !this.stochastic; this.apply(); },
        };
        this.hud = new Hud(ensureCanvas(root).node, [
            { id: 'scene', onTap: actions.scene },
            { id: 'count', onTap: actions.count },
            { id: 'sim', onTap: actions.sim },
            { id: 'hdr', onTap: actions.hdr },
            { id: 'tone', onTap: actions.tone },
            { id: 'bloom', onTap: actions.bloom },
            { id: 'exposure', onTap: actions.exposure },
            { id: 'pause', onTap: actions.pause },
        ]);
        this.interaction = new Interaction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, [
            [KeyCode.KEY_C, actions.scene], [KeyCode.KEY_N, actions.count], [KeyCode.KEY_G, actions.sim],
            [KeyCode.KEY_H, actions.hdr], [KeyCode.KEY_T, actions.tone], [KeyCode.KEY_B, actions.bloom],
            [KeyCode.KEY_E, actions.exposure], [KeyCode.SPACE, actions.pause], [KeyCode.KEY_Q, actions.rounding],
        ]);
        this.interaction.enable();

        const shellTex = createDataTexture(SHELLS * 3, SHELL_CYCLES, { float: true });
        shellTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
        shellTex.uploadData(this.shells);
        this.shellTex = shellTex;
        const lightTex = createDataTexture(8, 2, { float: true });
        lightTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
        this.lightTex = lightTex;

        const names = ['sim', 'particle', 'stage', 'bloom', 'composite'];
        void Promise.all(names.map((n) => loadEffect(`effects/hp-${n}`))).then(([simFx, particleFx, stageFx, bloomFx, compositeFx]) => {
            const make = (effectAsset: typeof simFx): Material => {
                const m = new Material();
                m.initialize({ effectAsset });
                return m;
            };
            const sim = Array.from({ length: 6 }, () => make(simFx));
            const bloom = Array.from({ length: BLOOM_LEVELS * 2 - 1 }, () => make(bloomFx));
            bloom.forEach((m, i) => m.setProperty('bloom', this.v4.set(i === 0 ? 0 : i < BLOOM_LEVELS ? 1 : 2, THRESHOLD, KNEE, 0)));
            const composite = make(compositeFx);
            this.pipeline = new FxPipeline(scene, camera, { sim, bloom, composite }, shellTex);

            const quad = new Node('Composite');
            quad.layer = Layers.Enum.DEFAULT;
            cameraNode.addChild(quad);
            quad.setPosition(0, 0, -1);
            const qr = quad.addComponent(MeshRenderer);
            qr.mesh = utils.MeshUtils.createMesh(primitives.quad());
            qr.setSharedMaterial(composite, 0);

            this.stageMaterial = make(stageFx);
            this.stageMaterial.setProperty('lightTex', lightTex);
            const black = make(stageFx);
            black.setProperty('stage', this.v4.set(3, 0, 0, 0));
            addRenderer(world, 'Sky', buildSky(), this.stageMaterial, STAGE_LAYER);
            addCopies(world, 'Ground', buildGround(), this.stageMaterial, black);
            this.bowl = addCopies(world, 'Bowl', buildBowl(), this.stageMaterial, black);
            this.nozzle = addCopies(world, 'Nozzle', buildNozzle(), this.stageMaterial, black);

            this.particleLow = make(particleFx);
            this.particleHigh = make(particleFx);
            for (const m of [this.particleLow, this.particleHigh]) m.setProperty('shellTex', shellTex);
            this.reset();
        });
        (globalThis as { __fx?: MainView }).__fx = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        const p = this.pipeline;
        if (!p || !this.particleLow || !this.particleHigh) return;
        p.update();
        this.wall += dt;
        const width = WIDTHS[this.widthIndex];
        const count = width * width;
        const step = Math.min(dt, MAX_STEP);
        if (!this.paused) {
            this.time += step;
            this.frame++;
            if (this.gpu) {
                this.parity = 1 - this.parity;
                p.runSimulation(this.parity);
                for (let j = 0; j < 3; j++) {
                    const m = p.materials.sim[this.parity * 3 + j];
                    m.setProperty('sim', this.v4.set(this.sceneIndex, this.time, step, j));
                    m.setProperty('grid', this.v4.set(width, (this.frame % 509) + 0.5, this.stochastic ? 1 : 0, 0));
                }
            } else {
                p.runSimulation(-1);
                const t0 = performance.now();
                const cpu = this.cpu!;
                cpu.stochastic = this.stochastic;
                cpu.step(this.sceneIndex, this.time, step, count, this.shells);
                this.cpuTex[0].uploadData(cpu.a);
                this.cpuTex[1].uploadData(cpu.b);
                this.cpuTex[2].uploadData(cpu.c);
                this.cpuMsSum += performance.now() - t0;
                this.cpuSteps++;
            }
        } else {
            p.runSimulation(-1);
        }
        const state = this.gpu ? p.state[this.parity] : this.cpuTex;
        for (const [m, scale] of [[this.particleLow, 1], [this.particleHigh, 1 / HIGH_SCALE]] as const) {
            m.setProperty('stateA', state[0]);
            m.setProperty('stateB', state[1]);
            m.setProperty('stateC', state[2]);
            m.setProperty('sim', this.v4.set(this.sceneIndex, this.time, width, count));
            m.setProperty('look', this.v4.set(scale, 1, STREAK_SECONDS, 1));
            m.setProperty('viewport', this.v4.set(p.width, p.height, 0, 0));
        }
        this.updateLights();
        this.stageMaterial?.setProperty('stage', this.v4.set(this.hdrMode, 1, this.wall, this.coalGlow()));
        p.materials.composite.setProperty('view', this.v4.set(this.bloomState === 2 ? 1 : 0, 1, this.frame % 251, 0));
        this.updateHud(dt);
    }

    private setView(): void {
        const [eye, target] = VIEWS[this.sceneIndex];
        this.orbit?.setView(eye, target);
    }

    /** Restarts the scene at time 0 (no particle is alive yet); resizes for the particle count. */
    private reset(): void {
        const p = this.pipeline;
        if (!p || !this.world || !this.particleLow || !this.particleHigh) return;
        const width = WIDTHS[this.widthIndex];
        p.setStateWidth(width);
        if (!this.gpu && this.cpu?.width !== width) {
            this.cpu = new CpuParticles(width);
            this.cpuTex = [0, 1, 2].map(() => {
                const t = createDataTexture(width, width);
                t.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
                return t;
            });
        }
        const chunksNeeded = (width * width) / CHUNK;
        while (this.chunkMeshes.length < chunksNeeded) this.chunkMeshes.push(particleChunk(this.chunkMeshes.length * CHUNK));
        while (this.chunks.length < chunksNeeded * 2) {
            const i = this.chunks.length >> 1;
            const low = (this.chunks.length & 1) === 0;
            this.chunks.push(addRenderer(this.world, `Particles${i}${low ? 'Low' : 'High'}`, this.chunkMeshes[i],
                low ? this.particleLow : this.particleHigh, low ? LOW_LAYER : HIGH_LAYER).node);
        }
        this.chunks.forEach((n, i) => { n.active = (i >> 1) < chunksNeeded; });
        this.time = 0;
        this.frame = 0;
        this.cpuMsSum = 0;
        this.cpuSteps = 0;
        this.apply();
    }

    private apply(): void {
        const p = this.pipeline;
        if (p) {
            p.bloomEnabled = this.bloomState !== 1;
            p.materials.bloom[0].setProperty('bloom', this.v4.set(0, THRESHOLD, KNEE, this.hdrMode));
            const exposure = Math.pow(2, EXPOSURES[this.exposureIndex]);
            const strength = this.bloomState === 1 ? 0 : BLOOM_STRENGTH / BLOOM_LEVELS;
            p.materials.composite.setProperty('mode', this.v4.set(this.hdrMode, this.tone, exposure, strength));
        }
        for (const n of this.bowl) n.active = this.sceneIndex === EMBERS;
        for (const n of this.nozzle) n.active = this.sceneIndex === FOUNTAIN;
        const hud = this.hud;
        if (!hud) return;
        const width = WIDTHS[this.widthIndex];
        const ev = EXPOSURES[this.exposureIndex];
        hud.setButton('scene', SCENE_NAMES[this.sceneIndex]);
        hud.setButton('count', `${formatCount(width * width)}`);
        hud.setButton('sim', this.gpu ? 'GPU sim' : 'CPU sim', this.gpu);
        hud.setButton('hdr', HDR_NAMES[this.hdrMode], this.hdrMode === 0);
        hud.setButton('tone', TONE_NAMES[this.tone], this.tone !== 2);
        hud.setButton('bloom', BLOOM_STATES[this.bloomState], this.bloomState !== 1);
        hud.setButton('exposure', `${ev >= 0 ? '+' : ''}${ev} EV`);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
        this.writeStatus();
    }

    private coalGlow(): number {
        const t = this.wall;
        return 3.5 * (0.85 + 0.1 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 17.1));
    }

    /** Lamps, then the scene's lights: the nozzle, the fire, or the brightest firework flashes. */
    private updateLights(): void {
        const d = this.lightData;
        d.fill(0);
        const set = (i: number, pos: readonly number[], r: number, g: number, b: number): void => {
            d.set([pos[0], pos[1], pos[2], 0], i * 4);
            d.set([r, g, b, 0], (8 + i) * 4);
        };
        LAMPS.forEach((l, i) => set(i, l.pos, l.color[0] * LAMP_INTENSITY, l.color[1] * LAMP_INTENSITY, l.color[2] * LAMP_INTENSITY));
        const t = this.wall;
        if (this.sceneIndex === FOUNTAIN) {
            const f = 2.5 * (0.8 + 0.2 * Math.sin(t * 31) * Math.sin(t * 13));
            set(2, NOZZLE_POS, f, f * 0.6, f * 0.2);
        } else if (this.sceneIndex === EMBERS) {
            const f = 9 * (0.85 + 0.1 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 17.1));
            set(2, FIRE_POS, f, f * 0.45, f * 0.12);
        } else {
            shellLights(this.shells, this.time, 4, 60).forEach((l, i) => set(2 + i, [l.x, l.y, l.z], l.r, l.g, l.b));
        }
        this.lightTex?.uploadData(d);
    }

    private updateHud(dt: number): void {
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime < 0.5) return;
        this.fps = this.frames / this.frameTime;
        if (this.cpuSteps > 0) this.cpuMs = this.cpuMsSum / this.cpuSteps;
        this.cpuMsSum = 0;
        this.cpuSteps = 0;
        this.frames = 0;
        this.frameTime = 0;
        this.writeStatus();
    }

    private writeStatus(): void {
        if (!this.hud) return;
        const width = WIDTHS[this.widthIndex];
        const sim = this.gpu ? 'GPU sim, 3 passes' : `CPU sim ${this.cpuMs.toFixed(1)} ms + upload`;
        const ev = EXPOSURES[this.exposureIndex];
        this.hud.setStatus([
            `FPS ${this.fps.toFixed(0)} · ${formatCount(width * width)} particles · ${sim}`,
            `${HDR_NAMES[this.hdrMode]}: ${HDR_HINTS[this.hdrMode]}`,
            `${TONE_NAMES[this.tone]} · ${ev >= 0 ? '+' : ''}${ev} EV · ${BLOOM_STATES[this.bloomState]}${this.stochastic ? '' : ' · nearest rounding'}`,
            SCENE_HINTS[this.sceneIndex],
        ]);
    }
}

function formatCount(n: number): string {
    return n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}`;
}

function addRenderer(parent: Node, name: string, mesh: Mesh, material: Material, layer: number): MeshRenderer {
    const node = new Node(name);
    node.layer = layer;
    parent.addChild(node);
    const r = node.addComponent(MeshRenderer);
    r.mesh = mesh;
    r.setSharedMaterial(material, 0);
    r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
    r.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
    return r;
}

/** The stage mesh in the stage camera, plus black depth-only copies for both particle cameras. */
function addCopies(parent: Node, name: string, mesh: Mesh, stage: Material, black: Material): Node[] {
    return [
        addRenderer(parent, name, mesh, stage, STAGE_LAYER).node,
        addRenderer(parent, `${name}DepthLow`, mesh, black, LOW_LAYER).node,
        addRenderer(parent, `${name}DepthHigh`, mesh, black, HIGH_LAYER).node,
    ];
}
