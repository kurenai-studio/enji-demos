import { _decorator, Camera, Component, director, Layers, Material, Mesh, MeshRenderer, Node, utils, Vec3, Vec4 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadEffect } from '../enji/helpers';
import { buildBall, buildCourt } from './ssao/Court';
import { Hud } from './ssao/Hud';
import { OrbitCamera } from './ssao/OrbitCamera';
import { COLOR_LAYER, DEPTH_FAR, GBUFFER_LAYER, SKY, SsaoPipeline, type SsaoSettings } from './ssao/SsaoPipeline';
import { SsaoInteraction } from './ssao/SsaoInteraction';

const { ccclass } = _decorator;

const VIEWS = ['Split', 'All on', 'All off', 'AO buffer', 'SSR buffer'];
const VIEW_HINTS = [
    'Left: no AO, sky reflections · right: AO + SSR',
    'Ambient × AO, reflections from SSR',
    'No AO, reflections of the sky gradient only',
    'The AO buffer, upsampled',
    'SSR hits × confidence (purple: no hit)',
];
/** SSR march steps per button press; 0 turns the passes off. */
const SSR_STEPS = [32, 64, 16, 0];
const SCALES = [0.5, 1, 0.25];
const SCALE_NAMES = ['Half res', 'Full res', 'Quarter res'];
const SAMPLES = [16, 32, 8];
const RADII = [0.5, 1, 0.25];
const BALL_RADIUS = 0.45;
const SUN = new Vec4(0.45, 0.8, 0.35, 0);

/**
 * Screen-space ambient occlusion on a phone budget: a depth + normal pre-pass
 * and the AO itself at half resolution, a depth-aware blur, and lit meshes
 * that darken only their ambient term with the result. On the same G-buffer,
 * screen-space reflections for the glossy floor and slab.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: SsaoInteraction | null = null;
    private pipeline: SsaoPipeline | null = null;
    private lit: Material | null = null;
    private litColor: Material | null = null;
    private balls: Node[] = [];
    private readonly settings: SsaoSettings = {
        scale: 0.5, samples: 16, radius: 0.5, bias: 0.025, intensity: 1.5, slopeScale: 0.5, blur: true, blurFalloff: 8,
        ssr: { enabled: true, steps: 32, refine: 4, thickness: 0.25, maxDistance: 12 },
    };
    private ssrIndex = 0;
    private viewIndex = 0;
    private scaleIndex = 0;
    private samplesIndex = 0;
    private radiusIndex = 0;
    private depthAwareUpsample = true;
    private paused = false;
    private time = 0;
    private frames = 0;
    private frameTime = 0;
    private readonly aoSize = new Vec4();

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
        camera.clearColor = SKY;
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.1;
        camera.far = DEPTH_FAR;
        const eye = new Vec3(5.4, 4.6, 6.8);
        this.orbit = new OrbitCamera(camera, eye);
        this.orbit.setView(eye, new Vec3(-0.3, 0.6, -0.9));
        this.orbit.minDistance = 2;
        this.orbit.maxDistance = 16;

        const actions = {
            cycleView: () => { this.viewIndex = (this.viewIndex + 1) % VIEWS.length; this.apply(); },
            cycleResolution: () => { this.scaleIndex = (this.scaleIndex + 1) % SCALES.length; this.apply(); },
            cycleSamples: () => { this.samplesIndex = (this.samplesIndex + 1) % SAMPLES.length; this.apply(); },
            cycleRadius: () => { this.radiusIndex = (this.radiusIndex + 1) % RADII.length; this.apply(); },
            toggleBlur: () => { this.settings.blur = !this.settings.blur; this.apply(); },
            toggleUpsample: () => { this.depthAwareUpsample = !this.depthAwareUpsample; this.apply(); },
            cycleSsr: () => { this.ssrIndex = (this.ssrIndex + 1) % SSR_STEPS.length; this.apply(); },
            toggleRefine: () => { this.settings.ssr.refine = this.settings.ssr.refine > 0 ? 0 : 4; this.apply(); },
            togglePause: () => { this.paused = !this.paused; this.apply(); },
        };
        this.hud = new Hud(ensureCanvas(root).node, [
            { id: 'view', onTap: actions.cycleView },
            { id: 'res', onTap: actions.cycleResolution },
            { id: 'samples', onTap: actions.cycleSamples },
            { id: 'radius', onTap: actions.cycleRadius },
            { id: 'blur', onTap: actions.toggleBlur },
            { id: 'upsample', onTap: actions.toggleUpsample },
            { id: 'ssr', onTap: actions.cycleSsr },
            { id: 'refine', onTap: actions.toggleRefine },
            { id: 'pause', onTap: actions.togglePause },
        ]);
        this.interaction = new SsaoInteraction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, actions);
        this.interaction.enable();

        void Promise.all(['gbuffer', 'ao', 'blur', 'lit', 'ssr'].map((name) => loadEffect(`effects/ssao-${name}`))).then(([g, ao, blur, lit, ssr]) => {
            const make = (effectAsset: typeof g): Material => {
                const m = new Material();
                m.initialize({ effectAsset });
                return m;
            };
            const materials = { gbuffer: make(g), ao: make(ao), blurX: make(blur), blurY: make(blur), ssr: make(ssr) };
            this.lit = make(lit);
            this.lit.setProperty('sunDir', SUN);
            // What reflections show: lit with AO, reflecting only the sky.
            this.litColor = make(lit);
            this.litColor.setProperty('sunDir', SUN);
            this.pipeline = new SsaoPipeline(scene, camera, materials, this.settings);
            const court = utils.MeshUtils.createMesh(buildCourt());
            const ball = utils.MeshUtils.createMesh(buildBall(BALL_RADIUS));
            addCopies(world, 'Court', court, this.lit, materials.gbuffer, this.litColor);
            this.balls = addCopies(world, 'Ball', ball, this.lit, materials.gbuffer, this.litColor);
            this.apply();
        });
        (globalThis as { __ssao?: MainView }).__ssao = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        if (!this.paused) this.time += dt;
        const t = this.time;
        const x = 0.2 + 1.1 * Math.cos(t * 0.5);
        const z = -0.3 + 1.1 * Math.sin(t * 0.5);
        const y = BALL_RADIUS + 0.7 * Math.abs(Math.sin(t * 1.6));
        for (const b of this.balls) b.setPosition(x, y, z);
        const p = this.pipeline;
        if (p && this.lit && this.litColor) {
            p.update();
            for (const m of [this.lit, this.litColor]) {
                m.setProperty('aoTex', p.output);
                m.setProperty('aoSize', this.aoSize.set(p.width, p.height, DEPTH_FAR, m === this.litColor ? 1 : 0));
            }
            this.lit.setProperty('ssrTex', p.ssr);
        }
        this.updateHud(dt);
    }

    private apply(): void {
        const s = this.settings;
        s.scale = SCALES[this.scaleIndex];
        s.samples = SAMPLES[this.samplesIndex];
        s.radius = RADII[this.radiusIndex];
        const steps = SSR_STEPS[this.ssrIndex];
        s.ssr.enabled = steps > 0;
        if (steps > 0) s.ssr.steps = steps;
        const upsample = this.depthAwareUpsample ? 1 : 0;
        this.lit?.setProperty('params', new Vec4(this.viewIndex, 1, upsample, s.ssr.enabled ? 1 : 0));
        this.litColor?.setProperty('params', new Vec4(1, 1, upsample, 0));
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('view', VIEWS[this.viewIndex]);
        hud.setButton('res', SCALE_NAMES[this.scaleIndex]);
        hud.setButton('samples', `${s.samples} samples`);
        hud.setButton('radius', `Radius ${s.radius} m`);
        hud.setButton('blur', s.blur ? 'Blur on' : 'Blur off', s.blur);
        hud.setButton('upsample', this.depthAwareUpsample ? 'Depth-aware' : 'Bilinear', this.depthAwareUpsample);
        hud.setButton('ssr', s.ssr.enabled ? `SSR ${s.ssr.steps} steps` : 'SSR off', s.ssr.enabled);
        hud.setButton('refine', s.ssr.refine > 0 ? `Refine ×${s.ssr.refine}` : 'No refine', s.ssr.refine > 0);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    private updateHud(dt: number): void {
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const p = this.pipeline;
        const s = this.settings;
        this.hud.setStatus([
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · frame ${((this.frameTime / this.frames) * 1000).toFixed(1)} ms`,
            `AO ${p ? `${p.width}×${p.height}` : '-'} · ${s.samples} samples · r ${s.radius} m · blur ${s.blur ? 'on' : 'off'}`,
            s.ssr.enabled ? `SSR ${s.ssr.steps} steps · refine ${s.ssr.refine} · thickness ${s.ssr.thickness} m` : 'SSR off: sky reflections only',
            `${VIEW_HINTS[this.viewIndex]} · drag: orbit`,
        ]);
        this.frames = 0;
        this.frameTime = 0;
    }
}

/** The lit mesh on the default layer, its G-buffer copy and its colour-pass copy; move all three together. */
function addCopies(parent: Node, name: string, mesh: Mesh, lit: Material, gbuffer: Material, litColor: Material): Node[] {
    const copies: [Material, number, string][] = [[lit, Layers.Enum.DEFAULT, ''], [gbuffer, GBUFFER_LAYER, 'GBuffer'], [litColor, COLOR_LAYER, 'Color']];
    return copies.map(([material, layer, suffix]) => {
        const node = new Node(name + suffix);
        node.layer = layer;
        parent.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = mesh;
        r.setSharedMaterial(material, 0);
        r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        r.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
        return node;
    });
}
