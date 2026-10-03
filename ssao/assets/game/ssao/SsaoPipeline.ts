import { Camera, Color, Material, Node, RenderTexture, screen, Texture2D, toRadian, Vec3, Vec4 } from 'cc';
import { createTexturePass, type TexturePass } from '../../enji/helpers';
import type { AoSettings } from './AoMath';
import type { SsrSettings } from './SsrMath';

/** User layer of the G-buffer copies of every mesh; the texture passes take layers from bit 0 up. */
export const GBUFFER_LAYER = 1 << 19;
/** User layer of the copies the colour pass draws (lit, reflections off) for SSR to read back. */
export const COLOR_LAYER = 1 << 18;
/** The scene camera's clear colour; the colour pass clears to it too. */
export const SKY = new Color(158, 168, 189, 255);
/** Linear depth is stored as a fraction of this distance; keep it at the camera's far plane. */
export const DEPTH_FAR = 40;

/** The estimator's settings (see AoMath) plus resolution and blur. */
export interface SsaoSettings extends AoSettings {
    /** AO resolution as a fraction of the screen (1, 0.5, 0.25). */
    scale: number;
    blur: boolean;
    /** Relative depth difference per unit that zeroes a blur tap. */
    blurFalloff: number;
    /** Screen-space reflections: the tracer's settings (see SsrMath) and whether the passes run. */
    ssr: SsrSettings & { enabled: boolean };
}

export interface SsaoMaterials {
    gbuffer: Material;
    ao: Material;
    blurX: Material;
    blurY: Material;
    ssr: Material;
}

/**
 * The render passes, in camera priority order:
 * 1. G-buffer camera (a child of the scene camera, same projection) draws the
 *    GBUFFER_LAYER copies into `gbuffer`: packed depth + octahedral world normal.
 * 2. AO pass: full-screen quad, hemisphere SSAO into `raw` (r: AO, gb: the
 *    packed depth, copied so later passes read one texture).
 * 3. Blur x into `temp`, blur y into `blurred` (skipped when blur is off).
 * 4. Colour camera (child of the scene camera) draws the COLOR_LAYER copies,
 *    lit with AO but no reflections, into `sceneColor`.
 * 5. SSR pass: full-screen quad, traces each texel's reflection through the
 *    G-buffer into `ssr` (rgb: sceneColor at the hit × confidence, a: confidence).
 * Steps 4 and 5 are skipped when SSR is off.
 * Then the scene camera draws the lit meshes, which sample `output` and `ssr`.
 * All textures are 8-bit RGBA at `scale` of the screen.
 */
export class SsaoPipeline {
    readonly gbuffer = makeTarget(Texture2D.Filter.NEAREST);
    readonly raw = makeTarget(Texture2D.Filter.LINEAR);
    readonly temp = makeTarget(Texture2D.Filter.LINEAR);
    readonly blurred = makeTarget(Texture2D.Filter.LINEAR);
    readonly sceneColor = makeTarget(Texture2D.Filter.LINEAR);
    readonly ssr = makeTarget(Texture2D.Filter.LINEAR);
    readonly gCamera: Camera;
    readonly colorCamera: Camera;
    width = 0;
    height = 0;
    private readonly aoPass: TexturePass;
    private readonly blurXPass: TexturePass;
    private readonly blurYPass: TexturePass;
    private readonly ssrPass: TexturePass;
    private readonly v4 = new Vec4();
    private readonly axis = new Vec3();

    constructor(scene: Node, private readonly camera: Camera, private readonly materials: SsaoMaterials, readonly settings: SsaoSettings) {
        const node = new Node('GBufferCamera');
        camera.node.addChild(node);
        const g = node.addComponent(Camera);
        g.visibility = GBUFFER_LAYER;
        g.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        // Depth 1 + 1/255 (beyond far: sky); the normal bytes are unused there.
        g.clearColor = new Color(255, 255, 127, 127);
        g.priority = -300;
        g.near = camera.near;
        g.far = camera.far;
        this.gCamera = g;

        const colorNode = new Node('ColorCamera');
        camera.node.addChild(colorNode);
        const c = colorNode.addComponent(Camera);
        c.visibility = COLOR_LAYER;
        c.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        c.clearColor = SKY;
        c.priority = -100;
        c.near = camera.near;
        c.far = camera.far;
        this.colorCamera = c;

        this.aoPass = createTexturePass(scene, materials.ao, this.raw, { priority: -200 });
        this.blurXPass = createTexturePass(scene, materials.blurX, this.temp, { priority: -150 });
        this.blurYPass = createTexturePass(scene, materials.blurY, this.blurred, { priority: -140 });
        this.ssrPass = createTexturePass(scene, materials.ssr, this.ssr, { priority: -80 });
        materials.ao.setProperty('gbuffer', this.gbuffer);
        materials.blurX.setProperty('aoTex', this.raw);
        materials.blurY.setProperty('aoTex', this.temp);
        materials.ssr.setProperty('gbuffer', this.gbuffer);
        materials.ssr.setProperty('sceneColor', this.sceneColor);
        materials.gbuffer.setProperty('depthFar', new Vec4(DEPTH_FAR, 0, 0, 0));
    }

    /** What the lit material should sample. */
    get output(): RenderTexture {
        return this.settings.blur ? this.blurred : this.raw;
    }

    /** Call once per frame after the scene camera has moved: follows its FOV, resizes on screen changes, pushes uniforms. */
    update(): void {
        const s = this.settings;
        const size = screen.windowSize;
        const w = Math.max(1, Math.round(size.width * s.scale));
        const h = Math.max(1, Math.round(size.height * s.scale));
        if (w !== this.width || h !== this.height) this.resize(w, h);

        const cam = this.camera;
        for (const c of [this.gCamera, this.colorCamera]) {
            c.fov = cam.fov;
            c.fovAxis = cam.fovAxis;
        }
        const tanY = Math.tan(toRadian(cam.fov) / 2);
        const tanX = tanY * (w / h);
        this.materials.ao.setProperty('proj', this.v4.set(tanX, tanY, DEPTH_FAR, (s.slopeScale * 2 * tanY) / h));
        this.materials.ao.setProperty('params', this.v4.set(s.radius, s.bias, s.samples, s.intensity));
        this.materials.blurX.setProperty('blur', this.v4.set(1 / w, 0, DEPTH_FAR, s.blurFalloff));
        this.materials.blurY.setProperty('blur', this.v4.set(0, 1 / h, DEPTH_FAR, s.blurFalloff));
        this.blurXPass.camera.enabled = s.blur;
        this.blurYPass.camera.enabled = s.blur;

        // View rotation rows are the camera's axes in world space (view z points backwards).
        const q = cam.node.worldRotation;
        const rows = [Vec3.UNIT_X, Vec3.UNIT_Y, Vec3.UNIT_Z];
        (['viewX', 'viewY', 'viewZ'] as const).forEach((name, i) => {
            Vec3.transformQuat(this.axis, rows[i], q);
            this.v4.set(this.axis.x, this.axis.y, this.axis.z, 0);
            this.materials.ao.setProperty(name, this.v4);
            this.materials.ssr.setProperty(name, this.v4);
        });
        const r = s.ssr;
        this.colorCamera.enabled = r.enabled;
        this.ssrPass.camera.enabled = r.enabled;
        this.materials.ssr.setProperty('proj', this.v4.set(tanX, tanY, DEPTH_FAR, 0));
        this.materials.ssr.setProperty('size', this.v4.set(w, h, 0, 0));
        this.materials.ssr.setProperty('ssr', this.v4.set(r.steps, r.refine, r.thickness, r.maxDistance));
    }

    private resize(w: number, h: number): void {
        this.width = w;
        this.height = h;
        for (const t of [this.gbuffer, this.raw, this.temp, this.blurred, this.sceneColor, this.ssr]) t.resize(w, h);
        // Re-attach so each camera picks up the new target size and aspect.
        for (const [c, t] of [[this.gCamera, this.gbuffer], [this.aoPass.camera, this.raw], [this.blurXPass.camera, this.temp], [this.blurYPass.camera, this.blurred], [this.colorCamera, this.sceneColor], [this.ssrPass.camera, this.ssr]] as const) {
            c.targetTexture = null;
            c.targetTexture = t;
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
