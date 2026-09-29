import { _decorator, Camera, Color, Component, director, Layers, Node, Vec3 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { OrbitCamera } from './water/OrbitCamera';
import { PoolHud } from './water/PoolHud';
import { PoolInteraction } from './water/PoolInteraction';
import { PoolScene } from './water/PoolScene';

const { ccclass } = _decorator;

/**
 * Real-time pool water (port of Evan Wallace's WebGL Water): CPU heightfield
 * simulation, ray-traced water surface, caustics, floating sphere.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: PoolHud | null = null;
    private pool: PoolScene | null = null;
    private interaction: PoolInteraction | null = null;
    private frames = 0;
    private frameTime = 0;

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
        camera.clearColor = new Color(184, 214, 242, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.01;
        camera.far = 400;
        this.orbit = new OrbitCamera(camera, new Vec3(2.3, 1.9, 2.8));

        this.hud = new PoolHud(ensureCanvas(root).node);

        void PoolScene.create(world).then((pool) => {
            this.pool = pool;
            this.interaction = new PoolInteraction(camera, this.orbit!, pool.sphere, pool.simulation, {
                toggleGravity: () => { pool.sphere.gravity = !pool.sphere.gravity; },
                toggleRain: () => { pool.settings.rain = !pool.settings.rain; },
                togglePause: () => { pool.settings.paused = !pool.settings.paused; },
                randomDrops: () => pool.randomDrops(),
                dropSphere: () => pool.sphere.dropFromAbove(),
                flatten: () => pool.flatten(),
            });
            this.interaction.enable();
        });
    }

    onDestroy(): void {
        this.interaction?.disable();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        this.pool?.update(dt);
        this.updateHud(dt);
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const pool = this.pool;
        this.hud.setStatus({
            fps: this.frames / this.frameTime,
            simMs: pool?.simMs ?? 0,
            gravity: pool?.sphere.gravity ?? false,
            rain: pool?.settings.rain ?? false,
            paused: pool?.settings.paused ?? false,
        });
        this.frames = 0;
        this.frameTime = 0;
    }
}
