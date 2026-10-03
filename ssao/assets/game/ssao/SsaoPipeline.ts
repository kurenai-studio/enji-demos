import { Camera, Color, Material, Node, RenderTexture, screen, Texture2D, toRadian, Vec4 } from 'cc';
import { createTexturePass, type TexturePass } from '../../enji/helpers';
import type { AoSettings } from './AoMath';

/** User layer of the G-buffer copies of every mesh; the texture passes take layers from bit 0 up. */
export const GBUFFER_LAYER = 1 << 19;
/** Linear depth is stored as a fraction of this distance; keep it at the camera's far plane. */
export const DEPTH_FAR = 40;

/** The estimator's settings (see AoMath) plus resolution and blur. */
export interface SsaoSettings extends AoSettings {
    /** AO resolution as a fraction of the screen (1, 0.5, 0.25). */
    scale: number;
    blur: boolean;
    /** Relative depth difference per unit that zeroes a blur tap. */
    blurFalloff: number;
}

export interface SsaoMaterials {
    gbuffer: Material;
    ao: Material;
    blurX: Material;
    blurY: Material;
}

/**
 * The render passes, in camera priority order:
 * 1. G-buffer camera (a child of the scene camera, same projection) draws the
 *    GBUFFER_LAYER copies into `gbuffer`: packed depth + view normal.
 * 2. AO pass: full-screen quad, hemisphere SSAO into `raw` (r: AO, gb: the
 *    packed depth, copied so later passes read one texture).
 * 3. Blur x into `temp`, blur y into `blurred` (skipped when blur is off).
 * Then the scene camera draws the lit meshes, which sample `output`.
 * All four textures are 8-bit RGBA at `scale` of the screen.
 */
export class SsaoPipeline {
    readonly gbuffer = makeTarget(Texture2D.Filter.NEAREST);
    readonly raw = makeTarget(Texture2D.Filter.LINEAR);
    readonly temp = makeTarget(Texture2D.Filter.LINEAR);
    readonly blurred = makeTarget(Texture2D.Filter.LINEAR);
    readonly gCamera: Camera;
    width = 0;
    height = 0;
    private readonly aoPass: TexturePass;
    private readonly blurXPass: TexturePass;
    private readonly blurYPass: TexturePass;
    private readonly v4 = new Vec4();

    constructor(scene: Node, private readonly camera: Camera, private readonly materials: SsaoMaterials, readonly settings: SsaoSettings) {
        const node = new Node('GBufferCamera');
        camera.node.addChild(node);
        const g = node.addComponent(Camera);
        g.visibility = GBUFFER_LAYER;
        g.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        // Depth 1 + 1/255 (beyond far: sky) and a normal facing the camera.
        g.clearColor = new Color(255, 255, 128, 128);
        g.priority = -300;
        g.near = camera.near;
        g.far = camera.far;
        this.gCamera = g;

        this.aoPass = createTexturePass(scene, materials.ao, this.raw, { priority: -200 });
        this.blurXPass = createTexturePass(scene, materials.blurX, this.temp, { priority: -150 });
        this.blurYPass = createTexturePass(scene, materials.blurY, this.blurred, { priority: -140 });
        materials.ao.setProperty('gbuffer', this.gbuffer);
        materials.blurX.setProperty('aoTex', this.raw);
        materials.blurY.setProperty('aoTex', this.temp);
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
        this.gCamera.fov = cam.fov;
        this.gCamera.fovAxis = cam.fovAxis;
        const tanY = Math.tan(toRadian(cam.fov) / 2);
        const tanX = tanY * (w / h);
        this.materials.ao.setProperty('proj', this.v4.set(tanX, tanY, DEPTH_FAR, (s.slopeScale * 2 * tanY) / h));
        this.materials.ao.setProperty('params', this.v4.set(s.radius, s.bias, s.samples, s.intensity));
        this.materials.blurX.setProperty('blur', this.v4.set(1 / w, 0, DEPTH_FAR, s.blurFalloff));
        this.materials.blurY.setProperty('blur', this.v4.set(0, 1 / h, DEPTH_FAR, s.blurFalloff));
        this.blurXPass.camera.enabled = s.blur;
        this.blurYPass.camera.enabled = s.blur;
    }

    private resize(w: number, h: number): void {
        this.width = w;
        this.height = h;
        for (const t of [this.gbuffer, this.raw, this.temp, this.blurred]) t.resize(w, h);
        // Re-attach so each camera picks up the new target size and aspect.
        for (const [c, t] of [[this.gCamera, this.gbuffer], [this.aoPass.camera, this.raw], [this.blurXPass.camera, this.temp], [this.blurYPass.camera, this.blurred]] as const) {
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
