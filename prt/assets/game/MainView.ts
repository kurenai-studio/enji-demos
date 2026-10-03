import {
    _decorator, Camera, Color, Component, director, EffectAsset, KeyCode, Layers, Material, MeshRenderer, Node, Texture2D, Vec3, Vec4,
} from 'cc';
import type { IView } from '../enji/IView';
import { createDataTexture, ensureCanvas, loadEffect } from '../enji/helpers';
import { Bake, RGB_STRIDE } from './prt/Bake';
import { LAMP_SIZES, lampRadiance, MAX_LAMPS, posed, presets, projectEnv, projectSky, withGroundBounce, type Env } from './prt/Env';
import { sceneMesh, skyMesh } from './prt/Meshes';
import { packLight, packTransfer, TEXELS_PER_VERTEX, TRANSFER_WIDTH, transferRows } from './prt/Pack';
import { prtRadiance, Reference, relativeRms } from './prt/Reference';
import { GROUND, SCENES, type SceneGeo } from './prt/Scenes';
import { BANDS, COEFFS, hannWindow, truncate } from './prt/SH';
import { Hud } from './ui/Hud';
import { Interaction } from './ui/Interaction';
import { OrbitCamera } from './ui/OrbitCamera';

const { ccclass } = _decorator;

const MODE_NAMES = ['Unshadowed', 'Shadowed', 'Interreflected', 'Reference'];
const MODE_HINTS = [
    'Transfer = clamped cosine only: SH irradiance, no shadows (as in pbr-probes)',
    'Transfer includes visibility: self-shadowing and shadows on the ground',
    'Shadowed plus three bounces between the surfaces (colour bleeding)',
    'Ray-traced: the true lamps and sky with shadow rays, same bounces, no SH',
];
const SCENE_NAMES = ['Knot', 'Colonnade', 'Armillary'];
const RAY_COUNTS = [256, 1024, 64];
const BOUNCES = 3;
const BAKE_BUDGET_MS = 12;
const UPLOAD_INTERVAL_MS = 250;
const SPIN_SPEED = 0.35;

/**
 * Precomputed radiance transfer: each vertex of a static scene stores how
 * it responds to distant light (25 SH coefficients per colour), baked at start
 * with ray-traced visibility and bounces. At run time the lighting is
 * projected to SH and shading is a dot product per vertex, so lamps can move,
 * resize and recolour freely at no extra cost.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: Interaction | null = null;
    private world: Node | null = null;
    private objectEffect: EffectAsset | null = null;
    private skyMaterial: Material | null = null;
    private objectMaterial: Material | null = null;
    private sceneNode: Node | null = null;
    private transferTex: Texture2D | null = null;
    private readonly lightTex = createDataTexture(TEXELS_PER_VERTEX, 1, { float: true });
    private readonly lightData = new Float32Array(TEXELS_PER_VERTEX * 4);
    private transferData = new Float32Array(0);
    private rgb = new Float32Array(0);
    private geo: SceneGeo | null = null;
    private bake: Bake | null = null;
    private reference: Reference | null = null;
    private readonly presets = presets().map((e) => withGroundBounce(e, GROUND));
    private readonly skies = this.presets.map((e) => projectSky(e));
    private readonly light = new Float64Array(COEFFS * 3);
    private env: Env = this.presets[0];
    private sceneIndex = 0;
    private mode = 1;
    private bands = BANDS;
    private windowed = false;
    private presetIndex = 0;
    private sizeIndex = 0;
    private spin = true;
    private angle = 0;
    private skySh = false;
    private rayIndex = 0;
    private lastUpload = 0;
    private errors: number[] | null = null;
    private frames = 0;
    private frameTime = 0;
    private fps = 0;
    private lightMs = 0;

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }
        // The effects tone-map themselves; HDR would apply the physical exposure.
        scene.globals.skybox.useHDR = false;
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
        camera.near = 0.05;
        camera.far = 200;
        this.orbit = new OrbitCamera(camera, new Vec3(4.2, 2.6, 4.6));
        this.orbit.minDistance = 1.5;
        this.orbit.maxDistance = 14;
        this.lightTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);

        const actions = {
            scene: () => this.setScene((this.sceneIndex + 1) % SCENES.length),
            mode: () => this.setMode((this.mode + 1) % MODE_NAMES.length),
            bands: () => { this.bands = this.bands === 1 ? BANDS : this.bands - 1; this.lightChanged(); },
            window: () => { this.windowed = !this.windowed; this.lightChanged(); },
            light: () => { this.presetIndex = (this.presetIndex + 1) % this.presets.length; this.lightChanged(); },
            size: () => { this.sizeIndex = (this.sizeIndex + 1) % LAMP_SIZES.length; this.lightChanged(); },
            spin: () => { this.spin = !this.spin; this.apply(); },
            sky: () => { this.skySh = !this.skySh; this.apply(); },
            rays: () => { this.rayIndex = (this.rayIndex + 1) % RAY_COUNTS.length; this.setScene(this.sceneIndex); },
        };
        this.hud = new Hud(ensureCanvas(root).node, Object.entries(actions).map(([id, onTap]) => ({ id, onTap })));
        this.interaction = new Interaction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, [
            [KeyCode.DIGIT_1, () => this.setScene(0)], [KeyCode.DIGIT_2, () => this.setScene(1)], [KeyCode.DIGIT_3, () => this.setScene(2)],
            [KeyCode.KEY_M, actions.mode], [KeyCode.KEY_B, actions.bands], [KeyCode.KEY_W, actions.window],
            [KeyCode.KEY_L, actions.light], [KeyCode.KEY_Z, actions.size], [KeyCode.SPACE, actions.spin],
            [KeyCode.KEY_K, actions.sky], [KeyCode.KEY_R, actions.rays],
            [KeyCode.KEY_U, () => this.setMode(0)], [KeyCode.KEY_S, () => this.setMode(1)],
            [KeyCode.KEY_I, () => this.setMode(2)], [KeyCode.KEY_T, () => this.setMode(3)],
        ]);
        this.interaction.enable();
        this.apply();

        void Promise.all([loadEffect('effects/prt-object'), loadEffect('effects/prt-sky')]).then(([object, sky]) => {
            this.objectEffect = object;
            const skyMaterial = new Material();
            skyMaterial.initialize({ effectAsset: sky });
            skyMaterial.setProperty('lightTex', this.lightTex);
            this.skyMaterial = skyMaterial;
            const skyNode = new Node('Sky');
            world.addChild(skyNode);
            const r = skyNode.addComponent(MeshRenderer);
            r.mesh = skyMesh(50);
            r.setSharedMaterial(skyMaterial, 0);
            this.setScene(this.sceneIndex);
        });
        (globalThis as { __prt?: MainView }).__prt = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    setScene(index: number): void {
        this.sceneIndex = index;
        if (!this.world || !this.objectEffect) { this.apply(); return; }
        this.sceneNode?.destroy();
        this.transferTex?.destroy();
        const geo = SCENES[index]();
        this.geo = geo;
        this.bake = new Bake(geo, RAY_COUNTS[this.rayIndex], BOUNCES);
        this.reference = null;
        this.errors = null;
        const rows = transferRows(geo.vertexCount);
        this.transferTex = createDataTexture(TRANSFER_WIDTH, rows, { float: true });
        this.transferTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
        this.transferData = new Float32Array(rows * TRANSFER_WIDTH * 4);
        this.rgb = new Float32Array(geo.vertexCount * RGB_STRIDE);
        const material = new Material();
        material.initialize({ effectAsset: this.objectEffect });
        material.setProperty('transferTex', this.transferTex);
        material.setProperty('lightTex', this.lightTex);
        material.setProperty('dims', new Vec4(rows, 0, 0, 0));
        this.objectMaterial = material;
        const node = new Node(geo.name);
        this.world.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = sceneMesh(geo);
        r.setSharedMaterial(material, 0);
        this.sceneNode = node;
        this.orbit!.target.set(0, geo.focusY, 0);
        this.uploadTransfer();
        this.apply();
    }

    setMode(mode: number): void {
        this.mode = mode;
        this.uploadTransfer();
        this.apply();
    }

    /** Writes the current mode's transfer (or the reference radiance) into the texture. */
    private uploadTransfer(): void {
        const bake = this.bake, tex = this.transferTex;
        if (!bake || !tex) return;
        const nv = bake.vertexCount;
        if (this.mode === 3) {
            const ref = this.reference?.done ? this.reference.total : null;
            this.rgb.fill(0);
            if (ref) for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) this.rgb[v * RGB_STRIDE + c] = ref[v * 3 + c];
        } else {
            bake.transfer(this.mode, this.rgb);
        }
        packTransfer(this.rgb, nv, this.transferData);
        tex.uploadData(this.transferData);
        this.lastUpload = performance.now();
    }

    private lightChanged(): void {
        this.errors = null;
        this.apply();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        const bake = this.bake;
        if (bake && bake.phase !== 'done') {
            const finished = bake.step(BAKE_BUDGET_MS);
            if (finished || performance.now() - this.lastUpload > UPLOAD_INTERVAL_MS) this.uploadTransfer();
        }
        if (this.spin) this.angle += dt * SPIN_SPEED;
        this.updateLight();
        this.updateReference();
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime >= 0.5) {
            this.fps = this.frames / this.frameTime;
            this.frames = 0;
            this.frameTime = 0;
            this.writeStatus();
        }
    }

    /** Projects the posed lighting to SH, keeps the chosen bands and uploads it. */
    private updateLight(): void {
        const t0 = performance.now();
        const base = this.presets[this.presetIndex];
        this.env = posed(base, this.angle, LAMP_SIZES[this.sizeIndex]);
        projectEnv(this.env, this.skies[this.presetIndex], this.light);
        truncate(this.light, this.bands, this.windowed ? hannWindow(this.bands) : null);
        if (this.mode === 3) {
            // The texture holds radiance in coefficient 0: a unit light passes it through.
            this.lightData.fill(0);
            for (let c = 0; c < 3; c++) this.lightData[c * 7 * 4] = 1;
        } else {
            packLight(this.light, this.lightData);
        }
        this.lightTex.uploadData(this.lightData);
        const sky = this.skyMaterial;
        if (sky) {
            const env = this.env;
            sky.setProperty('zenith', new Vec4(...env.zenith, 0));
            sky.setProperty('horizon', new Vec4(...env.horizon, 0));
            sky.setProperty('below', new Vec4(...env.below, 0));
            for (let i = 0; i < MAX_LAMPS; i++) {
                const l = env.lamps[i];
                sky.setProperty(`lamp${i}`, l ? new Vec4(...l.dir, Math.cos(l.alpha)) : new Vec4(0, 1, 0, 2));
                sky.setProperty(`glow${i}`, l ? new Vec4(lampRadiance(l, 0), lampRadiance(l, 1), lampRadiance(l, 2), 0) : new Vec4());
            }
            sky.setProperty('params', new Vec4(this.skySh && this.mode !== 3 ? 1 : 0, 0, 0, 0));
        }
        this.lightMs = this.lightMs * 0.9 + (performance.now() - t0) * 0.1;
    }

    /** Ray-traces the reference for the current still lighting, then measures each mode against it. */
    private updateReference(): void {
        const bake = this.bake;
        if (!bake || bake.phase !== 'done' || this.spin) return;
        const ref = this.reference;
        if (!ref || !sameEnv(ref.env, this.env)) {
            this.reference = new Reference(bake, this.env, BOUNCES);
            this.errors = null;
            if (this.mode === 3) this.uploadTransfer();
            return;
        }
        if (!ref.done) {
            if (ref.step(BAKE_BUDGET_MS) && this.mode === 3) this.uploadTransfer();
            return;
        }
        if (!this.errors) this.errors = this.measure(ref);
    }

    private measure(ref: Reference): number[] {
        const bake = this.bake!, nv = bake.vertexCount;
        const rgb = new Float32Array(nv * RGB_STRIDE), out = new Float32Array(nv * 3);
        return [0, 1, 2].map((mode) => {
            bake.transfer(mode, rgb);
            prtRadiance(rgb, this.light, nv, out);
            return relativeRms(out, mode === 2 ? ref.total : ref.direct);
        });
    }

    private apply(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('scene', SCENE_NAMES[this.sceneIndex], true);
        hud.setButton('mode', MODE_NAMES[this.mode], true);
        hud.setButton('bands', `${this.bands} bands`, this.bands !== BANDS);
        hud.setButton('window', 'Hann window', this.windowed);
        hud.setButton('light', this.presets[this.presetIndex].name, true);
        hud.setButton('size', `Lamps ×${LAMP_SIZES[this.sizeIndex]}`, this.sizeIndex !== 0);
        hud.setButton('spin', this.spin ? 'Spinning' : 'Still', this.spin);
        hud.setButton('sky', this.skySh ? 'Sky: SH' : 'Sky: exact', this.skySh);
        hud.setButton('rays', `${RAY_COUNTS[this.rayIndex]} rays`, this.rayIndex !== 0);
        this.writeStatus();
    }

    private writeStatus(): void {
        const hud = this.hud;
        if (!hud) return;
        const device = director.root!.device;
        const bake = this.bake, geo = this.geo;
        const lines = [`FPS ${this.fps.toFixed(0)} · ${device.numDrawCalls} draws · light projection + upload ${this.lightMs.toFixed(2)} ms`];
        if (bake && geo) {
            const texMb = (this.transferData.byteLength / 1e6).toFixed(1);
            const rate = bake.rayMs > 0 ? (bake.raysTraced / bake.rayMs / 1000).toFixed(1) : '–';
            lines.push(bake.phase === 'done'
                ? `${geo.name}: ${geo.vertexCount} vertices · baked: rays ${(bake.rayMs / 1000).toFixed(1)} s (${rate} M/s), ` +
                    `${BOUNCES} bounces ${(bake.bounceMs / 1000).toFixed(1)} s · ${(bake.bytes / 1e6).toFixed(0)} + ${texMb} MB`
                : `${geo.name}: baking ${(bake.progress * 100).toFixed(0)}% (${bake.phase === 'rays' ? `${bake.rays} rays per vertex, ${rate} M/s` : `bounce ${bake.bouncesDone + 1}`})`);
        } else {
            lines.push('Loading…');
        }
        lines.push(`${MODE_NAMES[this.mode]}: ${MODE_HINTS[this.mode]}`);
        const e = this.errors;
        const refState = !bake || bake.phase !== 'done' ? 'after the bake'
            : this.spin ? 'when the light is still (Space)' : this.reference?.done ? 'measuring…' : 'tracing…';
        lines.push(e
            ? `Error vs reference (${this.bands} bands${this.windowed ? ', Hann' : ''}): unshadowed ${pct(e[0])} · shadowed ${pct(e[1])} · interreflected ${pct(e[2])}`
            : `Error vs reference: ${refState}`);
        lines.push('1-3 scene · U/S/I/T mode · B bands · W window · L light · Z lamp size · Space spin · K sky · R rays');
        hud.setStatus(lines);
    }
}

function sameEnv(a: Env, b: Env): boolean {
    if (a.name !== b.name || a.lamps.length !== b.lamps.length) return false;
    return a.lamps.every((l, i) => l.alpha === b.lamps[i].alpha && l.dir.every((x, k) => Math.abs(x - b.lamps[i].dir[k]) < 1e-9));
}

function pct(x: number): string {
    return `${(x * 100).toFixed(1)}%`;
}
