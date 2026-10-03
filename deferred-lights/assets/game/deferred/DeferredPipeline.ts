import { Camera, Color, Material, Node, RenderTexture, screen, Texture2D, toRadian, Vec4 } from 'cc';
import { DEPTH_FAR, GLOSS, LIGHT_SCALE } from './Shading';

/** User layer of the G-buffer copies of every mesh. */
export const GBUFFER_LAYER = 1 << 19;
/** User layer of the light volumes. */
export const LIGHT_LAYER = 1 << 18;

/**
 * The light pre-pass before the scene camera, both cameras parented to it
 * with its projection:
 * 1. G-buffer camera: the GBUFFER_LAYER copies into `gbuffer` (packed depth +
 *    view normal).
 * 2. Light camera: the light volumes into `light`, additively (diffuse rgb,
 *    specular a).
 * Then the scene camera draws the lit meshes, which read `light`.
 * Both textures are 8-bit RGBA at screen size.
 */
export class DeferredPipeline {
    readonly gbuffer = makeTarget(Texture2D.Filter.NEAREST);
    readonly light = makeTarget(Texture2D.Filter.NEAREST);
    readonly gCamera: Camera;
    readonly lCamera: Camera;
    width = 0;
    height = 0;
    dither = true;
    overdraw = false;
    private readonly v4 = new Vec4();

    constructor(private readonly camera: Camera, private readonly gbufferMaterial: Material, private readonly lightMaterial: Material) {
        this.gCamera = this.child('GBufferCamera', GBUFFER_LAYER, -300, new Color(255, 255, 128, 128));
        this.lCamera = this.child('LightCamera', LIGHT_LAYER, -200, new Color(0, 0, 0, 0));
        gbufferMaterial.setProperty('depthFar', new Vec4(DEPTH_FAR, 0, 0, 0));
        lightMaterial.setProperty('gbuffer', this.gbuffer);
    }

    /** Off in pure forward mode, where nothing reads the buffers. */
    set enabled(on: boolean) {
        this.gCamera.enabled = on;
        this.lCamera.enabled = on;
    }

    /** Once per frame after the scene camera has moved: follows its FOV, resizes with the screen, pushes uniforms. */
    update(): void {
        const size = screen.windowSize;
        const w = Math.max(1, Math.round(size.width));
        const h = Math.max(1, Math.round(size.height));
        if (w !== this.width || h !== this.height) this.resize(w, h);
        const cam = this.camera;
        for (const c of [this.gCamera, this.lCamera]) {
            c.fov = cam.fov;
            c.fovAxis = cam.fovAxis;
        }
        const tanY = Math.tan(toRadian(cam.fov) / 2);
        this.lightMaterial.setProperty('proj', this.v4.set(tanY * (w / h), tanY, DEPTH_FAR, 0));
        this.lightMaterial.setProperty('params', this.v4.set(LIGHT_SCALE, GLOSS, this.dither ? 1 : 0, this.overdraw ? 1 : 0));
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
        for (const [c, t] of [[this.gCamera, this.gbuffer], [this.lCamera, this.light]] as const) {
            t.resize(w, h);
            // Re-attach so the camera picks up the new target size and aspect.
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
