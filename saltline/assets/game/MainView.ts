import {
    _decorator, assetManager, Camera, Color, Component, director, DirectionalLight, EffectAsset, instantiate,
    Layers, Material, Mat4, MeshRenderer, Node, PointLight, postProcess, Prefab, renderer,
    RenderTexture, resources, Texture2D, Vec3, Vec4,
} from 'cc';
import type { IView } from '../enji/IView';
import { loadEffect, loadModel } from '../enji/helpers';
import { Enemies } from './enemies';
import { Rain } from './rain';
import { makeHarborSky } from './sky';
import { Surface } from './surface';
import { VIEW_LAYER, Viewmodel } from './viewmodel';
import { Walker } from './walk';

const { ccclass } = _decorator;

/** Title-path frame 0: daytime, west of the yard, looking across the harbor. */
const EYE = new Vec3(-30, 1.6, 5.8);
const LOOK = new Vec3(-8, 2.6, 6.0);
const LAMPS: Array<[number, number, number]> = [
    [-8.5, 5.75, -15.4],
    [2.6, 5.75, -15.4],
    [-3.5, 5.75, -23.6],
    [8.6, 5.75, -23.6],
];
const HARBOR_PREFAB = '870cc366-3cd3-45a6-821a-b1fbda635ad9@fe526';
const KEEP_DEFINES = [
    'USE_ALBEDO_MAP', 'USE_NORMAL_MAP', 'USE_PBR_MAP', 'USE_OCCLUSION_MAP',
    'USE_EMISSIVE_MAP', 'USE_VERTEX_COLOR', 'USE_ALPHA_TEST', 'USE_TWOSIDE',
    'HAS_SECOND_UV', 'ALPHA_TEST_CHANNEL', 'ALBEDO_UV', 'NORMAL_UV', 'DEFAULT_UV', 'EMISSIVE_UV',
];
const COPY_PROPS = [
    'tilingOffset', 'mainColor', 'albedoScale', 'alphaThreshold',
    'occlusion', 'roughness', 'metallic', 'specularIntensity',
    'emissive', 'emissiveScale', 'normalStrength',
    'mainTexture', 'normalMap', 'pbrMap', 'occlusionMap', 'emissiveMap',
];

/**
 * The dumped Saltline terminal, with the game's wet-surface term, a mirrored
 * ground reflection, bloom / AO / a highlight shoulder, and first-person walking.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private cameraNode: Node | null = null;
    private mainCamera: Camera | null = null;
    private rain: Rain | null = null;
    private walker: Walker | null = null;
    private reflectNode: Node | null = null;
    private reflectCamera: Camera | null = null;
    private readonly wetMaterials: Material[] = [];
    private harborNode: Node | null = null;
    private visiblePass = 0;
    private gradeMat: Material | null = null;
    private apronMask: Texture2D | null = null;
    private apronDetail: Texture2D | null = null;
    private apronNormal: Texture2D | null = null;
    private apronMarks: Texture2D | null = null;
    private viewmodel: Viewmodel | null = null;
    private enemies: Enemies | null = null;
    private readonly sunPoint = new Vec4();
    private readonly sunClip = new Vec4();
    private readonly sunUv = new Vec4();
    private readonly camEye = new Vec4();
    private readonly camForward = new Vec4();
    private readonly camRight = new Vec4();
    private readonly camUp = new Vec4();
    private readonly view = new Mat4();
    private readonly vp = new Mat4();
    private readonly eye = new Vec3();
    private readonly col0 = new Vec4();
    private readonly col1 = new Vec4();
    private readonly col2 = new Vec4();
    private readonly col3 = new Vec4();
    private readonly lit0 = new Vec4();
    private readonly lit1 = new Vec4();
    private readonly lit2 = new Vec4();
    private readonly lit3 = new Vec4();

    bind(root: Node): void {
        this.showSplash();
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }

        const world = new Node('World');
        scene.addChild(world);

        this.cameraNode = new Node('MainCamera');
        world.addChild(this.cameraNode);
        const camera = this.cameraNode.addComponent(Camera);
        this.mainCamera = camera;
        camera.clearFlags = Camera.ClearFlag.SKYBOX;
        camera.visibility = Layers.Enum.DEFAULT | VIEW_LAYER;
        camera.priority = 0;
        camera.fov = 74;
        camera.near = 0.08;
        camera.far = 900;
        this.cameraNode.setPosition(EYE);
        this.cameraNode.lookAt(LOOK);
        this.walker = new Walker(this.cameraNode);
        this.walker.capture();
        this.walker.bindInput();

        const sunNode = new Node('Sun');
        world.addChild(sunNode);
        sunNode.setPosition(181.27, 60.92, 65.23);
        sunNode.lookAt(new Vec3(-2, 15.9, -1));
        const sun = sunNode.addComponent(DirectionalLight);
        sun.color = new Color(255, 184, 107, 255);
        sun.illuminance = 68000;
        sun.shadowEnabled = true;
        sun.shadowPcf = 2;
        // Cascades were shading the open lane. One fixed map around the harbor
        // lets the low sun reach the ground and still catch the containers.
        sun.enableCSM = false;
        sun.shadowFixedArea = true;
        // The light sits ~200 m out. A far of 220 ended in the lane, so the
        // ground under the camera was outside the map and stayed fully lit.
        sun.shadowOrthoSize = 84;
        sun.shadowNear = 80;
        sun.shadowFar = 340;
        sun.shadowBias = 0.04;
        sun.shadowNormalBias = 0.06;
        sun.shadowSaturation = 0.72;
        sun.visibility = Layers.Enum.DEFAULT | VIEW_LAYER;
        const shadows = scene.globals.shadows;
        shadows.enabled = true;
        shadows.type = renderer.scene.ShadowType.ShadowMap;
        shadows.shadowMapSize = 2048;

        for (const lamp of LAMPS) {
            const node = new Node('Lamp');
            world.addChild(node);
            node.setPosition(lamp[0], lamp[1], lamp[2]);
            const light = node.addComponent(PointLight);
            light.color = new Color(255, 196, 138, 255);
            light.range = 13;
            light.luminance = 1800;
            light.visibility = Layers.Enum.DEFAULT | VIEW_LAYER;
        }

        scene.globals.ambient.skyLightingColor = new Color(148, 156, 168, 255);
        scene.globals.ambient.groundLightingColor = new Color(102, 72, 48, 255);
        scene.globals.ambient.skyIllum = 18000;

        const sky = scene.globals.skybox;
        sky.enabled = true;
        sky.envmap = makeHarborSky(false);
        sky.envLightingType = renderer.scene.EnvironmentLightingType.AUTOGEN_HEMISPHERE_DIFFUSE_WITH_REFLECTION;

        const fog = scene.globals.fog;
        fog.enabled = true;
        fog.accurate = true;
        fog.type = renderer.scene.FogType.EXP;
        fog.fogColor = new Color(176, 142, 118, 255);
        fog.fogDensity = 0.00115;
        fog.fogStart = 8;

        this.bindVolumeDepth();
        void this.build(world).finally(() => this.dismissSplash());
    }

    /** Cover the canvas until the harbor finishes loading. The preview page may already have this plate. */
    private showSplash(): void {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc || doc.getElementById('cocos-splash')) return;
        const settings = (globalThis as { _CCSettings?: { splashScreen?: { logo?: { type?: string; base64?: string } } } })._CCSettings;
        const logo = settings?.splashScreen?.logo;
        if (!logo?.base64 || logo.type === 'none') return;
        const plate = doc.createElement('div');
        plate.id = 'cocos-splash';
        plate.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:#04090a;pointer-events:none;';
        const img = doc.createElement('img');
        img.alt = 'Cocos';
        img.src = logo.base64;
        img.style.cssText = 'height:18.5vh;width:auto;max-width:70vw;';
        plate.appendChild(img);
        doc.body.appendChild(plate);
    }

    private dismissSplash(): void {
        (globalThis as { __saltlineReady?: boolean }).__saltlineReady = true;
        const plate = (globalThis as { document?: Document }).document?.getElementById('cocos-splash');
        if (!plate) return;
        plate.style.transition = 'opacity .4s ease';
        plate.style.opacity = '0';
        setTimeout(() => plate.remove(), 420);
    }

    /**
     * The blit pass only receives the color target. The volume march needs the
     * forward depth, so when that pass samples color it also receives the depth.
     */
    private bindVolumeDepth(): void {
        const pipeline = director.root?.pipeline as {
            addRenderPass?: (width: number, height: number, layoutName?: string) => {
                name?: string;
                addTexture?: (inputName: string, shaderName: string) => unknown;
            };
            containsResource?: (name: string) => boolean;
            __saltlineDepth?: boolean;
        } | null;
        if (!pipeline?.addRenderPass || pipeline.__saltlineDepth) return;
        pipeline.__saltlineDepth = true;
        const original = pipeline.addRenderPass.bind(pipeline);
        pipeline.addRenderPass = (width, height, layoutName) => {
            const pass = original(width, height, layoutName);
            const tagged = pass as { __saltlineDepth?: boolean; addTexture?: (inputName: string, shaderName: string) => unknown };
            if (tagged.__saltlineDepth) return pass;
            const addTexture = pass?.addTexture?.bind(pass);
            if (!addTexture) return pass;
            tagged.__saltlineDepth = true;
            pass.addTexture = (inputName, shaderName) => {
                const bound = addTexture(inputName, shaderName);
                if (shaderName === 'inputTexture' && pass.name && pass.name.indexOf('BlitScreen') >= 0) {
                    const id = /_(\d+)$/.exec(inputName);
                    const depth = id ? `ForwardDSForwardPass_0_${id[1]}` : '';
                    if (depth && pipeline.containsResource?.(depth)) addTexture(depth, 'depthTex');
                    const shadow = id ? `MainLightShadowCamera${id[1]}` : '';
                    if (shadow && pipeline.containsResource?.(shadow)) addTexture(shadow, 'sunShadow');
                }
                return bound;
            };
            return pass;
        };
    }

    update(dt: number): void {
        this.walker?.step(dt);
        this.enemies?.step(dt);
        this.viewmodel?.step(dt, this.walker);
        this.keepVisible();
        this.updateReflection();
        this.updateShafts();
        if (this.cameraNode) this.rain?.step(dt, this.cameraNode);
    }

    private async build(world: Node): Promise<void> {
        const harbor = await this.loadHarbor();
        this.harborNode = harbor;
        world.addChild(harbor);
        for (const mesh of harbor.getComponentsInChildren(MeshRenderer)) {
            mesh.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
        }
        this.walker?.build(harbor);
        let surface: Surface | null = null;
        try {
            surface = Surface.collect(harbor);
        } catch (err) {
            console.warn('[saltline-enji] hit surfaces skipped', err);
        }

        let wet: EffectAsset | null = null;
        try {
            const [effect, mask, detail, marks, normal] = await Promise.all([
                loadEffect('effects/wet-standard'),
                this.loadTex('ground/apron-mask/texture', false),
                this.loadTex('ground/apron-detail/texture', true),
                this.loadTex('ground/apron-marks/texture', false),
                this.loadTex('ground/apron-normal/texture', true),
            ]);
            wet = effect;
            this.apronMask = mask;
            this.apronDetail = detail;
            this.apronMarks = marks;
            this.apronNormal = normal;
            this.applyWet(harbor, wet);
        } catch (err) {
            console.warn('[saltline-enji] wet shader skipped', err);
        }
        if (wet && this.wetMaterials.length) this.mountReflection(world);

        let grade: EffectAsset | null = null;
        try {
            grade = await loadEffect('effects/grade');
        } catch (err) {
            console.warn('[saltline-enji] grade skipped', err);
        }
        if (this.mainCamera) this.enablePost(this.mainCamera, grade);

        try {
            const skyFx = await loadEffect('effects/saltline-sky');
            const skyMat = new Material();
            skyMat.initialize({ effectAsset: skyFx });
            director.getScene()!.globals.skybox.skyboxMaterial = skyMat;
            console.log('[saltline-enji] sky shader on');
        } catch (err) {
            console.warn('[saltline-enji] sky shader skipped', err);
        }

        try {
            this.viewmodel = await Viewmodel.mount(this.cameraNode!);
            console.log('[saltline-enji] viewmodel', this.viewmodel ? 'on' : 'off');
        } catch (err) {
            console.warn('[saltline-enji] viewmodel skipped', err);
        }
        if (this.walker) {
            try {
                this.enemies = await Enemies.mount(world, this.walker, wet);
                const mirror = this.reflectCamera?.targetTexture;
                if (this.enemies && mirror) {
                    for (const mat of this.enemies.coats) {
                        mat.setProperty('reflectMap', mirror);
                        this.wetMaterials.push(mat);
                    }
                }
            } catch (err) {
                console.warn('[saltline-enji] enemies skipped', err);
            }
        }
        this.viewmodel?.bindCombat(surface, this.enemies);
        if (this.enemies && this.viewmodel) {
            const gun = this.viewmodel;
            this.enemies.onStrike = (x, y, z, nx, ny, nz, dx, dy, dz, concrete) => {
                gun.strike(x, y, z, nx, ny, nz, dx, dy, dz, concrete);
            };
        }

        try {
            const rainFx = await loadEffect('effects/rain');
            this.rain = new Rain(world, rainFx);
        } catch (err) {
            console.warn('[saltline-enji] rain skipped', err);
        }
        console.log('[saltline-enji] harbor ready', harbor.children.length, 'wet', this.wetMaterials.length);
    }

    private loadHarbor(): Promise<Node> {
        return loadModel('harbor/saltline').catch((err) => {
            console.warn('[saltline-enji] loadModel failed, using the imported prefab', err);
            return new Promise<Node>((resolve, reject) => {
                assetManager.loadAny({ uuid: HARBOR_PREFAB }, (loadErr: Error | null, prefab: Prefab) => {
                    if (loadErr) reject(loadErr);
                    else resolve(instantiate(prefab));
                });
            });
        });
    }

    private applyWet(harbor: Node, effect: EffectAsset): void {
        const shared = new Map<Material, Material>();
        const names = new Set<string>();
        let aprons = 0;
        let seas = 0;
        for (const mesh of harbor.getComponentsInChildren(MeshRenderer)) {
            const slots = mesh.sharedMaterials.length;
            for (let i = 0; i < slots; i++) {
                const src = mesh.getSharedMaterial(i);
                if (!src) continue;
                names.add(src.effectAsset?.name ?? '');
                if (!this.isLitStandard(src)) continue;
                let wet = shared.get(src);
                if (!wet) {
                    wet = this.cloneWet(src, effect);
                    shared.set(src, wet);
                    this.wetMaterials.push(wet);
                    const kind = (wet.getProperty('surfaceKind', 0) as Vec4 | null)?.x ?? 0;
                    if (kind > 1.5) seas += 1;
                    else if (kind > 0.5) aprons += 1;
                }
                mesh.setSharedMaterial(wet, i);
            }
            if (mesh.node.layer !== 0) mesh.visibility = mesh.node.layer;
        }
        console.log('[saltline-enji] effects', [...names].join(', '), 'apron', aprons, 'sea', seas);
    }

    private isLitStandard(mat: Material): boolean {
        const name = mat.effectAsset?.name ?? '';
        return name === 'builtin-standard' || name.endsWith('/builtin-standard');
    }

    private cloneWet(src: Material, effect: EffectAsset): Material {
        const defines: Record<string, boolean | number | string> = {};
        const srcDefines = src.passes[0]?.defines ?? {};
        for (const key of KEEP_DEFINES) {
            const value = srcDefines[key];
            if (value !== undefined && value !== false && value !== 0) defines[key] = value;
        }
        const next = new Material();
        next.initialize({ effectAsset: effect, defines });
        for (const name of COPY_PROPS) {
            try {
                const value = src.getProperty(name, 0);
                if (value == null || Array.isArray(value)) continue;
                next.setProperty(name, cloneProp(value) as typeof value, 0);
            } catch {
                // The define that owns this property is off.
            }
        }
        next.setProperty('wetParams', new Vec4(0.5, 0.85, 0.4, 0.0));
        next.setProperty('wetMacro', new Vec4(0.14, 0.12, 0.4, 0.28));
        const kind = this.surfaceKind(src);
        next.setProperty('surfaceKind', new Vec4(kind, 0, 0, 0));
        if (kind > 0.5 && kind < 1.5 && this.apronMask && this.apronDetail && this.apronMarks) {
            next.setProperty('apronMask', this.apronMask);
            next.setProperty('apronDetail', this.apronDetail);
            next.setProperty('apronMarks', this.apronMarks);
            if (this.apronNormal) next.setProperty('apronNormal', this.apronNormal);
            // Direct sun stays a soft glint. The puddle reads through the flat normal and the blurred reflection.
            next.setProperty('specularIntensity', 0.14);
        }
        return next;
    }

    private loadTex(path: string, repeat: boolean): Promise<Texture2D | null> {
        return new Promise((resolve) => {
            resources.load(path, Texture2D, (err: Error | null, tex: Texture2D) => {
                if (err || !tex) {
                    console.warn('[saltline-enji] ground texture skipped', path, err);
                    resolve(null);
                    return;
                }
                if (repeat) tex.setWrapMode(Texture2D.WrapMode.REPEAT, Texture2D.WrapMode.REPEAT);
                resolve(tex);
            });
        });
    }

    /** 1 = untextured wet apron, 2 = untextured sea. Textured meshes stay 0. */
    private surfaceKind(src: Material): number {
        const defines = src.passes[0]?.defines ?? {};
        if (defines.USE_ALBEDO_MAP) return 0;
        let rough = 1;
        try {
            rough = Number(src.getProperty('roughness', 0) ?? 1);
        } catch {
            return 0;
        }
        if (rough < 0.3) return 2;
        if (rough > 0.75) return 1;
        return 0;
    }

    private mountReflection(world: Node): void {
        const target = new RenderTexture();
        target.reset({ width: 512, height: 256 });
        const node = new Node('ReflectCamera');
        world.addChild(node);
        const camera = node.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SKYBOX;
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = -8;
        camera.fov = 74;
        camera.near = 0.08;
        camera.far = 500;
        camera.usePostProcess = false;
        camera.targetTexture = target;
        this.reflectNode = node;
        this.reflectCamera = camera;
        for (const mat of this.wetMaterials) mat.setProperty('reflectMap', target);
    }

    /** Material rebuilds recreate models with a zero visibility flag, which culls the whole harbor. */
    private keepVisible(): void {
        if (this.visiblePass >= 150) return;
        this.visiblePass++;
        this.stampVisibility(this.harborNode);
        this.stampVisibility(this.cameraNode);
    }

    private stampVisibility(root: Node | null): void {
        if (!root) return;
        const pending: Node[] = [root];
        while (pending.length) {
            const node = pending.pop()!;
            for (const child of node.children) pending.push(child);
            const mesh = node.getComponent(MeshRenderer);
            if (mesh && node.layer !== 0 && mesh.visibility !== node.layer) mesh.visibility = node.layer;
        }
    }

    private updateShafts(): void {
        const cam = this.mainCamera?.camera;
        const node = this.cameraNode;
        const mat = this.gradeMat;
        if (!cam || !node || !mat) return;
        const origin = node.worldPosition;
        this.sunPoint.set(origin.x + 73.28, origin.y + 18.0, origin.z + 26.48, 1);
        Vec4.transformMat4(this.sunClip, this.sunPoint, cam.matViewProj);
        if (this.sunClip.w <= 0.05) {
            this.sunUv.set(0.5, 0.5, 0, 0);
        } else {
            const x = this.sunClip.x / this.sunClip.w * 0.5 + 0.5;
            const y = this.sunClip.y / this.sunClip.w * 0.5 + 0.5;
            this.sunUv.set(x, y, 1, 1);
        }
        mat.setProperty('sunScreen', this.sunUv);
        const fwd = node.forward;
        const right = node.right;
        const up = node.up;
        const proj = cam.matProj;
        const ty = proj && Math.abs(proj.m05) > 1e-4 ? 1 / proj.m05 : 0.7536;
        const tx = proj && Math.abs(proj.m00) > 1e-4 ? 1 / proj.m00 : ty;
        this.camEye.set(origin.x, origin.y, origin.z, 1);
        this.camForward.set(fwd.x, fwd.y, fwd.z, 0);
        this.camRight.set(right.x, right.y, right.z, tx);
        this.camUp.set(up.x, up.y, up.z, ty);
        mat.setProperty('camEye', this.camEye);
        mat.setProperty('camForward', this.camForward);
        mat.setProperty('camRight', this.camRight);
        mat.setProperty('camUp', this.camUp);
        this.uploadSunMatrix(mat);
    }

    /** Light view-projection for the volume's sun occlusion. A zero matrix leaves the shaft unshadowed. */
    private uploadSunMatrix(mat: Material): void {
        const root = director.root as unknown as {
            pipeline?: { pipelineSceneData?: { csmLayers?: { specialLayer?: { matShadowViewProj?: Mat4 } } } };
        };
        const light = root.pipeline?.pipelineSceneData?.csmLayers?.specialLayer?.matShadowViewProj;
        if (!light) {
            this.lit0.set(0, 0, 0, 0);
            this.lit1.set(0, 0, 0, 0);
            this.lit2.set(0, 0, 0, 0);
            this.lit3.set(0, 0, 0, 0);
        } else {
            this.lit0.set(light.m00, light.m01, light.m02, light.m03);
            this.lit1.set(light.m04, light.m05, light.m06, light.m07);
            this.lit2.set(light.m08, light.m09, light.m10, light.m11);
            this.lit3.set(light.m12, light.m13, light.m14, light.m15);
        }
        mat.setProperty('lightCol0', this.lit0);
        mat.setProperty('lightCol1', this.lit1);
        mat.setProperty('lightCol2', this.lit2);
        mat.setProperty('lightCol3', this.lit3);
    }

    private updateReflection(): void {
        const node = this.cameraNode;
        const reflect = this.reflectNode;
        const camera = this.reflectCamera;
        const walker = this.walker;
        if (!node || !reflect || !camera || !walker || this.wetMaterials.length === 0) return;
        this.eye.set(node.worldPosition);
        reflect.setPosition(this.eye.x, -this.eye.y, this.eye.z);
        reflect.setRotationFromEuler(-walker.pitch, walker.yaw, 0);
        reflect.updateWorldTransform();
        const proj = camera.camera?.matProj;
        if (!proj) return;
        Mat4.invert(this.view, reflect.worldMatrix);
        Mat4.multiply(this.vp, proj, this.view);
        const m = this.vp;
        this.col0.set(m.m00, m.m01, m.m02, m.m03);
        this.col1.set(m.m04, m.m05, m.m06, m.m07);
        this.col2.set(m.m08, m.m09, m.m10, m.m11);
        this.col3.set(m.m12, m.m13, m.m14, m.m15);
        for (const mat of this.wetMaterials) {
            mat.setProperty('reflectCol0', this.col0);
            mat.setProperty('reflectCol1', this.col1);
            mat.setProperty('reflectCol2', this.col2);
            mat.setProperty('reflectCol3', this.col3);
        }
    }

    private enablePost(camera: Camera, grade: EffectAsset | null): void {
        try {
            const pp = camera.node.addComponent(postProcess.PostProcess);
            pp.global = false;
            const bloom = camera.node.addComponent(postProcess.Bloom);
            bloom.threshold = 0.68;
            bloom.iterations = 3;
            bloom.intensity = 0.42;
            bloom.useHdrIlluminance = false;
            const ao = camera.node.addComponent(postProcess.HBAO);
            ao.radiusScale = 0.4;
            ao.angleBiasDegree = 12;
            ao.blurSharpness = 6;
            ao.aoSaturation = 0.55;
            ao.needBlur = true;
            pp.addSetting(bloom);
            pp.addSetting(ao);
            if (grade) {
                const blit = camera.node.addComponent(postProcess.BlitScreen);
                const mat = new Material();
                mat.initialize({ effectAsset: grade });
                blit.activeMaterials = [mat];
                pp.addSetting(blit);
                this.gradeMat = mat;
            }
            const post = (director.getScene()?.globals as { postSettings?: { toneMappingType: number } } | null)?.postSettings;
            if (post) post.toneMappingType = 1;
            camera.postProcess = pp;
            camera.usePostProcess = true;
            console.log('[saltline-enji] post process on');
        } catch (err) {
            console.warn('[saltline-enji] post process skipped', err);
        }
    }
}

function cloneProp(value: unknown): unknown {
    if (value instanceof Color) return value.clone();
    if (value instanceof Vec4) return value.clone();
    if (value instanceof Vec3) return value.clone();
    return value;
}
