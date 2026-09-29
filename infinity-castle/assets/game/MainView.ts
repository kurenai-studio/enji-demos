import {
    _decorator, Camera, Color, Component, director, EventKeyboard, EventTouch, Input, input, JsonAsset, KeyCode,
    Layers, Material, Mesh, MeshRenderer, Node, Prefab, primitives, resources, utils,
} from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadEffect, preloadModel } from '../enji/helpers';
import { CastleHud } from './castle/CastleHud';
import type { BlockInfo } from './castle/CastleLayout';
import { CastleShaft } from './castle/CastleShaft';
import { FallCamera } from './castle/FallCamera';

const { ccclass } = _decorator;

const SEED = 7;
const LAMP_INTENSITY = 3.2;
const FRAME_SAMPLES = 1200;

function loadJson(path: string): Promise<JsonAsset> {
    return new Promise((resolve, reject) =>
        resources.load(path, JsonAsset, (err, asset) => (err ? reject(err) : resolve(asset))));
}

function meshOf(prefab: Prefab): Mesh {
    const renderer = prefab.data.getComponentsInChildren(MeshRenderer)[0];
    if (!renderer?.mesh) throw new Error(`prefab ${prefab.name} has no mesh`);
    return renderer.mesh;
}

function countNodes(node: Node): number {
    let n = 1;
    for (const child of node.children) n += countNodes(child);
    return n;
}

/**
 * Endless fall into the Infinity Castle (無限城). Castle blocks are built by the
 * reference Blender generator (tools/export_blocks.py), imported as .glb and
 * placed chunk by chunk around a vertical shaft; see castle/CastleShaft.ts.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private fall: FallCamera | null = null;
    private shaft: CastleShaft | null = null;
    private hud: CastleHud | null = null;
    private sky: Node | null = null;
    private readonly frameTimes = new Float32Array(FRAME_SAMPLES);
    private frameIndex = 0;
    private frameCount = 0;
    private hudTimer = 0;
    private hudFrames = 0;
    private lastNow = 0;

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }

        const world = new Node('World');
        scene.addChild(world);
        const cameraNode = new Node('FallCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(9, 8, 12, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.fovAxis = Camera.FOVAxis.VERTICAL;
        camera.fov = 62;
        camera.near = 0.1;
        camera.far = 480;
        this.fall = new FallCamera(camera);
        this.fall.apply();

        this.hud = new CastleHud(ensureCanvas(root).node);
        this.bindInput();
        this.exposeDebug();

        void this.load(world).catch((err) => {
            console.error('infinity-castle: load failed', err);
            this.hud?.set([`load failed: ${err?.message ?? err}`]);
        });
    }

    private async load(world: Node): Promise<void> {
        const [info, castleFx, glowFx, skyFx] = await Promise.all([
            loadJson('models/blocks'),
            loadEffect('effects/castle'),
            loadEffect('effects/lantern-glow'),
            loadEffect('effects/haze-sky'),
        ]);
        const blocks = info.json as Record<string, BlockInfo>;
        const names = Object.keys(blocks);
        const prefabs = await Promise.all(names.map((name) => preloadModel(`models/${name}`)));
        const meshes: Record<string, Mesh> = {};
        names.forEach((name, i) => { meshes[name] = meshOf(prefabs[i]); });

        const castle = new Material();
        castle.initialize({ effectAsset: castleFx });
        const glow = new Material();
        glow.initialize({ effectAsset: glowFx });
        const skyMat = new Material();
        skyMat.initialize({ effectAsset: skyFx });

        this.sky = new Node('HazeSky');
        world.addChild(this.sky);
        const skyRenderer = this.sky.addComponent(MeshRenderer);
        skyRenderer.mesh = utils.MeshUtils.createMesh(primitives.sphere(400, { segments: 24 }));
        skyRenderer.setSharedMaterial(skyMat, 0);
        skyRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;

        this.shaft = new CastleShaft(world, meshes, blocks, castle, glow, SEED);
        // fill the view before the first frame; later chunks stream in one per frame
        this.shaft.update(this.fall!.depth, 4);
    }

    private bindInput(): void {
        input.on(Input.EventType.KEY_DOWN, (e: EventKeyboard) => {
            const fall = this.fall!;
            switch (e.keyCode) {
                case KeyCode.KEY_W:
                case KeyCode.ARROW_UP:
                    fall.speed = Math.min(fall.speed * 1.4, 120);
                    break;
                case KeyCode.KEY_S:
                case KeyCode.ARROW_DOWN:
                    fall.speed = Math.max(fall.speed / 1.4, 1);
                    break;
                case KeyCode.SPACE:
                    fall.paused = !fall.paused;
                    break;
                case KeyCode.KEY_R:
                    fall.yawOffset = fall.pitchOffset = 0;
                    break;
                default:
            }
        });
        input.on(Input.EventType.TOUCH_MOVE, (e: EventTouch) => {
            const d = e.getDelta();
            const fall = this.fall!;
            fall.yawOffset -= d.x * 0.15;
            fall.pitchOffset = Math.max(-60, Math.min(100, fall.pitchOffset + d.y * 0.15));
        });
    }

    /** `window.__ic` for measuring from the browser console / CDP. */
    private exposeDebug(): void {
        (globalThis as Record<string, unknown>).__ic = {
            stats: () => this.stats(),
            resetFrames: () => { this.frameCount = 0; this.frameIndex = 0; },
            setSpeed: (v: number) => { this.fall!.speed = v; },
            setDepth: (d: number) => { this.fall!.depth = d; },
            setPaused: (p: boolean) => { this.fall!.paused = p; },
            look: (yaw: number, pitch: number) => { this.fall!.yawOffset = yaw; this.fall!.pitchOffset = pitch; },
        };
    }

    private stats(): Record<string, unknown> {
        const n = Math.min(this.frameCount, FRAME_SAMPLES);
        const times = Array.from(this.frameTimes.subarray(0, n)).sort((a, b) => a - b);
        const pct = (p: number) => (n ? times[Math.min(n - 1, Math.floor(n * p))] : 0);
        const scene = director.getScene()!;
        const renderers = scene.getComponentsInChildren(MeshRenderer);
        const device = director.root?.device as unknown as { numDrawCalls?: number; numTris?: number } | undefined;
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return {
            depth: Math.round(this.fall!.depth),
            speed: this.fall!.speed,
            frames: n,
            frameMsMedian: +pct(0.5).toFixed(2),
            frameMsP95: +pct(0.95).toFixed(2),
            fpsFromMedian: n ? +(1000 / pct(0.5)).toFixed(1) : 0,
            sceneNodes: countNodes(scene),
            meshRenderers: renderers.length,
            activeMeshRenderers: renderers.filter((r) => r.node.activeInHierarchy).length,
            drawCalls: device?.numDrawCalls,
            triangles: device?.numTris,
            jsHeapMB: memory ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : undefined,
            shaft: this.shaft?.stats(),
        };
    }

    update(dt: number): void {
        const now = performance.now();
        if (this.lastNow) {
            this.frameTimes[this.frameIndex] = now - this.lastNow;
            this.frameIndex = (this.frameIndex + 1) % FRAME_SAMPLES;
            this.frameCount += 1;
        }
        this.lastNow = now;

        const fall = this.fall!;
        fall.update(Math.min(dt, 0.1));
        this.sky?.setPosition(fall.position);
        if (this.shaft) {
            this.shaft.update(fall.depth);
            this.shaft.updateLamps(fall.position, LAMP_INTENSITY);
        }
        this.updateHud(dt);
    }

    private updateHud(dt: number): void {
        this.hudFrames += 1;
        this.hudTimer += dt;
        if (this.hudTimer < 0.5 || !this.hud || !this.shaft) return;
        const s = this.shaft.stats();
        const fall = this.fall!;
        this.hud.set([
            `FPS ${(this.hudFrames / this.hudTimer).toFixed(0)}   depth ${fall.depth.toFixed(0)} m`,
            `speed ${fall.speed.toFixed(1)} m/s${fall.paused ? '   PAUSED' : ''}`,
            `chunks ${s.chunks}   blocks ${s.activeBlocks} (+${s.pooledBlocks} pooled)`,
            `nodes created ${s.createdBlocks + s.createdGlowMeshes}   lanterns ${s.lanterns}`,
        ]);
        this.hudTimer = 0;
        this.hudFrames = 0;
    }
}
