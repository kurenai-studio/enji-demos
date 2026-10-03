import { Camera, Color, Material, Node, RenderTexture, screen, Texture2D, Vec4 } from 'cc';
import { createTexturePass, type TexturePass } from '../../enji/helpers';

/** User layers of the scene cameras; the texture passes take layers from bit 0 up (17 of them). */
export const STAGE_LAYER = 1 << 17;
export const LOW_LAYER = 1 << 18;
export const HIGH_LAYER = 1 << 19;
export const BLOOM_LEVELS = 6;

export interface FxMaterials {
    /** Six simulation passes: set s writes output j with material [s * 3 + j]. */
    sim: Material[];
    /** Prefilter, BLOOM_LEVELS − 1 downsamples, BLOOM_LEVELS − 1 upsamples. */
    bloom: Material[];
    composite: Material;
}

/**
 * The render passes, in camera priority order:
 * 1. Simulation: three passes into one of two sets of state textures
 *    (RGBA8, one texel per particle), reading the other set.
 * 2. Scene cameras (children of the main camera, same projection): the
 *    stage into `stage`; the particles into `low` (× 1) and `high` (× 1/16),
 *    over black copies of the stage that only provide depth.
 * 3. Bloom: prefilter to half resolution, downsamples to 1/64, upsamples back.
 * Then the main camera draws the composite quad.
 * Every target is 8-bit RGBA: the engine has no float render targets.
 */
export class FxPipeline {
    readonly stage = makeTarget(Texture2D.Filter.NEAREST);
    readonly low = makeTarget(Texture2D.Filter.NEAREST);
    readonly high = makeTarget(Texture2D.Filter.NEAREST);
    readonly mips: RenderTexture[] = [];
    readonly ups: RenderTexture[] = [];
    /** state[set][j], j = 0 (A), 1 (B), 2 (C). */
    readonly state: RenderTexture[][] = [[], []];
    readonly stageCam: Camera;
    readonly lowCam: Camera;
    readonly highCam: Camera;
    readonly simPasses: TexturePass[] = [];
    readonly bloomPasses: TexturePass[] = [];
    width = 0;
    height = 0;
    stateWidth = 0;
    /** Bloom level sizes, [level] = [w, h]. */
    readonly levelSizes: [number, number][] = [];
    private readonly v4 = new Vec4();

    constructor(scene: Node, private readonly camera: Camera, readonly materials: FxMaterials, shellTex: Texture2D) {
        this.stageCam = this.child('StageCamera', STAGE_LAYER, -500, new Color(0, 0, 0, 255));
        this.lowCam = this.child('ParticleLowCamera', LOW_LAYER, -490, new Color(0, 0, 0, 0));
        this.highCam = this.child('ParticleHighCamera', HIGH_LAYER, -480, new Color(0, 0, 0, 0));

        for (let s = 0; s < 2; s++) for (let j = 0; j < 3; j++) this.state[s].push(makeTarget(Texture2D.Filter.NEAREST));
        for (let s = 0; s < 2; s++) {
            for (let j = 0; j < 3; j++) {
                const m = materials.sim[s * 3 + j];
                m.setProperty('stateA', this.state[1 - s][0]);
                m.setProperty('stateB', this.state[1 - s][1]);
                m.setProperty('stateC', this.state[1 - s][2]);
                m.setProperty('shellTex', shellTex);
                const pass = createTexturePass(scene, m, this.state[s][j], { priority: -1000 + j });
                pass.camera.enabled = false;
                this.simPasses.push(pass);
            }
        }

        // NEAREST: the levels are encoded, so the shaders decode texels before they filter.
        for (let l = 0; l < BLOOM_LEVELS; l++) this.mips.push(makeTarget(Texture2D.Filter.NEAREST));
        for (let l = 0; l < BLOOM_LEVELS - 1; l++) this.ups.push(makeTarget(Texture2D.Filter.NEAREST));
        const bm = materials.bloom;
        bm[0].setProperty('srcTex', this.stage);
        bm[0].setProperty('lowTex', this.low);
        bm[0].setProperty('highTex', this.high);
        this.bloomPasses.push(createTexturePass(scene, bm[0], this.mips[0], { priority: -400 }));
        for (let l = 1; l < BLOOM_LEVELS; l++) {
            bm[l].setProperty('srcTex', this.mips[l - 1]);
            this.bloomPasses.push(createTexturePass(scene, bm[l], this.mips[l], { priority: -400 + l }));
        }
        // Upsample into level l from level l + 1 (the last downsample, then the previous upsample).
        for (let l = BLOOM_LEVELS - 2; l >= 0; l--) {
            const m = bm[BLOOM_LEVELS + (BLOOM_LEVELS - 2 - l)];
            m.setProperty('srcTex', l === BLOOM_LEVELS - 2 ? this.mips[l + 1] : this.ups[l + 1]);
            m.setProperty('lowTex', this.mips[l]);
            this.bloomPasses.push(createTexturePass(scene, m, this.ups[l], { priority: -300 - l }));
        }
        materials.composite.setProperty('stageTex', this.stage);
        materials.composite.setProperty('lowTex', this.low);
        materials.composite.setProperty('highTex', this.high);
        materials.composite.setProperty('bloomTex', this.ups[0]);
    }

    /** The bloom result the composite reads. */
    get bloom(): RenderTexture {
        return this.ups[0];
    }

    set bloomEnabled(on: boolean) {
        for (const p of this.bloomPasses) p.camera.enabled = on;
    }

    /** Enables the simulation passes of `set` (or none, for −1). */
    runSimulation(set: number): void {
        this.simPasses.forEach((p, i) => { p.camera.enabled = Math.floor(i / 3) === set; });
    }

    /** Sizes the state textures for width × width particles. */
    setStateWidth(w: number): void {
        if (w === this.stateWidth) return;
        this.stateWidth = w;
        for (let s = 0; s < 2; s++) {
            for (let j = 0; j < 3; j++) {
                this.state[s][j].resize(w, w);
                const c = this.simPasses[s * 3 + j].camera;
                c.targetTexture = null;
                c.targetTexture = this.state[s][j];
            }
        }
    }

    /** Once per frame after the main camera has moved: follows its FOV, resizes with the screen. */
    update(): void {
        const size = screen.windowSize;
        const w = Math.max(2, Math.round(size.width));
        const h = Math.max(2, Math.round(size.height));
        if (w !== this.width || h !== this.height) this.resize(w, h);
        const cam = this.camera;
        for (const c of [this.stageCam, this.lowCam, this.highCam]) {
            c.fov = cam.fov;
            c.fovAxis = cam.fovAxis;
        }
    }

    private child(name: string, layer: number, priority: number, clear: Color): Camera {
        const node = new Node(name);
        this.camera.node.addChild(node);
        const c = node.addComponent(Camera);
        c.visibility = layer;
        c.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        c.clearColor = clear;
        c.priority = priority;
        c.near = this.camera.near;
        c.far = this.camera.far;
        return c;
    }

    private resize(w: number, h: number): void {
        this.width = w;
        this.height = h;
        for (const [c, t] of [[this.stageCam, this.stage], [this.lowCam, this.low], [this.highCam, this.high]] as const) {
            t.resize(w, h);
            c.targetTexture = null;
            c.targetTexture = t;
        }
        this.levelSizes.length = 0;
        let lw = w, lh = h;
        for (let l = 0; l < BLOOM_LEVELS; l++) {
            lw = Math.max(1, Math.ceil(lw / 2));
            lh = Math.max(1, Math.ceil(lh / 2));
            this.levelSizes.push([lw, lh]);
            this.mips[l].resize(lw, lh);
            if (l < BLOOM_LEVELS - 1) this.ups[l].resize(lw, lh);
        }
        const bm = this.materials.bloom;
        // Each pass's texel size is that of the texture it filters.
        bm[0].setProperty('texel', this.v4.set(1 / w, 1 / h, 0, 1));
        for (let l = 1; l < BLOOM_LEVELS; l++) {
            const [sw, sh] = this.levelSizes[l - 1];
            bm[l].setProperty('texel', this.v4.set(1 / sw, 1 / sh, 0, 1));
        }
        for (let l = BLOOM_LEVELS - 2; l >= 0; l--) {
            const [sw, sh] = this.levelSizes[l + 1];
            bm[BLOOM_LEVELS + (BLOOM_LEVELS - 2 - l)].setProperty('texel', this.v4.set(1 / sw, 1 / sh, 0, 1));
        }
        const [bw, bh] = this.levelSizes[0];
        this.materials.composite.setProperty('bloomTexel', this.v4.set(1 / bw, 1 / bh, 0, 0));
        const targets: [TexturePass, RenderTexture][] = [];
        for (let l = 0; l < BLOOM_LEVELS; l++) targets.push([this.bloomPasses[l], this.mips[l]]);
        for (let l = BLOOM_LEVELS - 2; l >= 0; l--) targets.push([this.bloomPasses[BLOOM_LEVELS + (BLOOM_LEVELS - 2 - l)], this.ups[l]]);
        for (const [p, t] of targets) {
            p.camera.targetTexture = null;
            p.camera.targetTexture = t;
        }
    }
}

function makeTarget(filter: number): RenderTexture {
    const t = new RenderTexture();
    t.reset({ width: 4, height: 4 });
    t.setFilters(filter, filter);
    t.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
    return t;
}
