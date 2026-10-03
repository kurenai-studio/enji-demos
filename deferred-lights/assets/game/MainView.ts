import {
    _decorator, Camera, Color, Component, director, gfx, KeyCode, Layers, Material, Mesh, MeshRenderer, Node, Texture2D,
    toRadian, utils, Vec3, Vec4,
} from 'cc';
import type { IView } from '../enji/IView';
import { createDataTexture, ensureCanvas, loadEffect } from '../enji/helpers';
import { volumePixels } from './deferred/Cost';
import { DeferredPipeline, GBUFFER_LAYER, LIGHT_LAYER } from './deferred/DeferredPipeline';
import { buildHall } from './deferred/Hall';
import { Hud } from './deferred/Hud';
import { Interaction } from './deferred/Interaction';
import { FIELD_HALF, LIGHT_TEX_HEIGHT, LIGHT_TEX_WIDTH, LightField } from './deferred/Lights';
import { OrbitCamera } from './deferred/OrbitCamera';
import { DEPTH_FAR, EXPOSURE, GLOSS, LIGHT_SCALE } from './deferred/Shading';
import { icosphere, inradius, volumeBatch } from './deferred/Volume';

const { ccclass } = _decorator;

const MODES = ['Deferred', 'Forward', 'Split', 'Light buffer', 'Overdraw', 'Normals'];
const MODE_HINTS = [
    'Light pre-pass: every light drawn as a volume',
    'Forward: every pixel loops over every light',
    'Left: forward · right: deferred',
    'Accumulated diffuse light (8-bit)',
    'Light volumes per pixel: blue 0 → white 32+',
    'G-buffer view-space normals',
];
const COUNTS = [256, 1024, 64];
const AMBIENT = 0.06;

/**
 * Hundreds of moving point lights through a light pre-pass on 8-bit render
 * targets: depth + normal G-buffer, light volumes accumulated additively,
 * then a forward pass that applies the light; next to a brute-force forward
 * loop over the same lights.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: Interaction | null = null;
    private pipeline: DeferredPipeline | null = null;
    private camera: Camera | null = null;
    private lit: Material | null = null;
    private volumes: MeshRenderer | null = null;
    private bulbs: MeshRenderer | null = null;
    private readonly volumeMeshes = new Map<number, Mesh>();
    private readonly field = new LightField();
    private lightTex: Texture2D | null = null;
    private volumeScale = 1;
    private modeIndex = 0;
    private countIndex = 0;
    private showBulbs = true;
    private paused = false;
    private time = 0;
    private frames = 0;
    private frameTime = 0;
    private coverage = 0;

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
        camera.clearColor = new Color(8, 9, 14, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.1;
        camera.far = DEPTH_FAR;
        this.camera = camera;
        const eye = new Vec3(13, 9, 15);
        this.orbit = new OrbitCamera(camera, eye);
        this.orbit.setView(eye, new Vec3(0, 0.5, 0));
        this.orbit.minDistance = 3;
        this.orbit.maxDistance = 40;

        const actions = {
            mode: () => { this.modeIndex = (this.modeIndex + 1) % MODES.length; this.apply(); },
            count: () => { this.countIndex = (this.countIndex + 1) % COUNTS.length; this.apply(); },
            dither: () => { if (this.pipeline) this.pipeline.dither = !this.pipeline.dither; this.apply(); },
            bulbs: () => { this.showBulbs = !this.showBulbs; this.apply(); },
            pause: () => { this.paused = !this.paused; this.apply(); },
        };
        this.hud = new Hud(ensureCanvas(root).node, [
            { id: 'mode', onTap: actions.mode },
            { id: 'count', onTap: actions.count },
            { id: 'dither', onTap: actions.dither },
            { id: 'bulbs', onTap: actions.bulbs },
            { id: 'pause', onTap: actions.pause },
        ]);
        this.interaction = new Interaction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, [
            [KeyCode.KEY_M, actions.mode], [KeyCode.KEY_L, actions.count], [KeyCode.KEY_D, actions.dither],
            [KeyCode.KEY_B, actions.bulbs], [KeyCode.SPACE, actions.pause],
        ]);
        this.interaction.enable();

        const lightTex = createDataTexture(LIGHT_TEX_WIDTH, LIGHT_TEX_HEIGHT, { float: true });
        lightTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
        this.lightTex = lightTex;

        void Promise.all(['gbuffer', 'light', 'lit', 'bulb'].map((name) => loadEffect(`effects/dl-${name}`))).then(([g, l, lit, bulb]) => {
            const make = (effectAsset: typeof g): Material => {
                const m = new Material();
                m.initialize({ effectAsset });
                return m;
            };
            const gbuffer = make(g);
            const light = make(l);
            this.lit = make(lit);
            const bulbMaterial = make(bulb);
            light.setProperty('lightTex', lightTex);
            this.lit.setProperty('lightTex', lightTex);
            bulbMaterial.setProperty('lightTex', lightTex);
            this.pipeline = new DeferredPipeline(camera, gbuffer, light);
            this.lit.setProperty('lightBuf', this.pipeline.light);
            this.lit.setProperty('gbuffer', this.pipeline.gbuffer);

            const hall = utils.MeshUtils.createMesh(buildHall());
            addRenderer(world, 'Hall', hall, this.lit, Layers.Enum.DEFAULT);
            addRenderer(world, 'HallGBuffer', hall, gbuffer, GBUFFER_LAYER);

            const shape = icosphere(1);
            this.volumeScale = 1 / inradius(shape);
            for (const n of COUNTS) this.volumeMeshes.set(n, volumeMesh(shape, n));
            const first = this.volumeMeshes.get(COUNTS[0])!;
            this.volumes = addRenderer(world, 'LightVolumes', first, light, LIGHT_LAYER);
            this.bulbs = addRenderer(world, 'Bulbs', first, bulbMaterial, Layers.Enum.DEFAULT);
            this.apply();
        });
        (globalThis as { __dl?: MainView }).__dl = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        if (!this.paused) this.time += dt;
        const count = COUNTS[this.countIndex];
        this.field.update(this.time, count);
        this.lightTex?.uploadData(this.field.texture);
        this.pipeline?.update();
        this.updateHud(dt);
    }

    private apply(): void {
        const count = COUNTS[this.countIndex];
        const mode = this.modeIndex;
        const p = this.pipeline;
        if (p) {
            p.enabled = mode !== 1;
            p.overdraw = mode === 4;
        }
        this.lit?.setProperty('params', new Vec4(mode, count, LIGHT_SCALE, GLOSS));
        this.lit?.setProperty('look', new Vec4(AMBIENT, EXPOSURE, 0, 0));
        const mesh = this.volumeMeshes.get(count);
        if (mesh && this.volumes && this.bulbs) {
            this.volumes.mesh = mesh;
            this.bulbs.mesh = mesh;
            this.bulbs.node.active = this.showBulbs && mode < 3;
        }
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('mode', MODES[mode]);
        hud.setButton('count', `${count} lights`);
        hud.setButton('dither', p?.dither === false ? 'Dither off' : 'Dither on', p?.dither !== false);
        hud.setButton('bulbs', this.showBulbs ? 'Bulbs on' : 'Bulbs off', this.showBulbs);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    /** In overdraw mode: light-volume fragments per pixel read back from the light buffer (mean, max). */
    measureOverdraw(): { mean: number; max: number } | null {
        const p = this.pipeline;
        if (!p || this.modeIndex !== 4) return null;
        const pixels = p.light.readPixels(0, 0, p.width, p.height);
        if (!pixels) return null;
        let sum = 0, max = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            sum += pixels[i];
            max = Math.max(max, pixels[i]);
        }
        return { mean: sum / (pixels.length / 4), max };
    }

    /** Light-volume pixels per screen pixel, estimated on the CPU (see Cost.ts). */
    private estimateCoverage(): number {
        const cam = this.camera;
        const p = this.pipeline;
        if (!cam || !p || p.width === 0) return 0;
        const n = cam.node;
        const toV3 = (v: Vec3): [number, number, number] => [v.x, v.y, v.z];
        const tanY = Math.tan(toRadian(cam.fov) / 2);
        const pixels = volumePixels({
            eye: toV3(n.worldPosition), right: toV3(n.right), up: toV3(n.up), forward: toV3(n.forward),
            tanX: tanY * (p.width / p.height), tanY, near: cam.near, width: p.width, height: p.height,
        }, this.field.position, this.field.count, this.volumeScale);
        return pixels / (p.width * p.height);
    }

    private updateHud(dt: number): void {
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const p = this.pipeline;
        const count = COUNTS[this.countIndex];
        this.coverage = this.estimateCoverage();
        this.hud.setStatus([
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · frame ${((this.frameTime / this.frames) * 1000).toFixed(1)} ms`,
            `${count} lights · ${MODES[this.modeIndex]} · ${p ? `${p.width}×${p.height}` : '-'}`,
            `Light evaluations per pixel: deferred ≈ ${this.coverage.toFixed(1)}, forward ${count}`,
            MODE_HINTS[this.modeIndex],
        ]);
        this.frames = 0;
        this.frameTime = 0;
    }
}

function volumeMesh(shape: ReturnType<typeof icosphere>, lights: number): Mesh {
    const batch = volumeBatch(shape, lights);
    const margin = 6;
    return utils.MeshUtils.createMesh({
        positions: batch.positions,
        indices: batch.indices,
        minPos: new Vec3(-FIELD_HALF - margin, -margin, -FIELD_HALF - margin),
        maxPos: new Vec3(FIELD_HALF + margin, margin + 3, FIELD_HALF + margin),
        customAttributes: [{ attr: new gfx.Attribute('a_lightIndex', gfx.Format.R32F), values: batch.lightIndex }],
    });
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
