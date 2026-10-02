import { _decorator, Camera, Color, Component, director, Layers, Node, Vec3 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { ClothHud } from './xpbd/ClothHud';
import { ClothInteraction } from './xpbd/ClothInteraction';
import { ClothScene, QUALITY, STIFFNESS } from './xpbd/ClothScene';
import { OrbitCamera } from './xpbd/OrbitCamera';

const { ccclass } = _decorator;

const VIEW = { eye: new Vec3(2.0, 1.9, 2.7), target: new Vec3(0, 0.75, 0) };
const COMPARE_VIEW = { eye: new Vec3(0.5, 1.75, 3.4), target: new Vec3(0, 1.3, 0) };

/**
 * XPBD cloth playground: a CPU solver in typed arrays streamed into a dynamic
 * mesh every frame, sized to run on phones (auto quality, no shadow maps). The
 * compare scene hangs a PBD sheet next to an XPBD one.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: ClothHud | null = null;
    private cloth: ClothScene | null = null;
    private interaction: ClothInteraction | null = null;
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
        camera.clearColor = new Color(184, 199, 219, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.05;
        camera.far = 100;
        this.orbit = new OrbitCamera(camera, VIEW.eye);

        const actions = {
            togglePause: () => { if (this.cloth) this.cloth.paused = !this.cloth.paused; this.refreshButtons(); },
            reset: () => { this.cloth?.rebuild(); this.refreshButtons(); },
            cyclePreset: () => {
                if (!this.cloth) return;
                this.cloth.cyclePreset();
                const view = this.cloth.preset === 'compare' ? COMPARE_VIEW : VIEW;
                this.orbit?.setView(view.eye, view.target);
                this.refreshButtons();
            },
            cycleQuality: () => { this.cloth?.cycleQuality(); this.refreshButtons(); },
            cycleStiffness: () => { this.cloth?.cycleStiffness(); this.refreshButtons(); },
            cycleSubsteps: () => { this.cloth?.cycleSubsteps(); this.refreshButtons(); },
            toggleSelfCollision: () => { this.cloth?.toggleSelfCollision(); this.refreshButtons(); },
            unpin: () => { this.cloth?.unpinAll(); },
            toggleWind: () => { if (this.cloth) this.cloth.wind = !this.cloth.wind; this.refreshButtons(); },
        };

        this.hud = new ClothHud(ensureCanvas(root).node, [
            { id: 'preset', onTap: actions.cyclePreset },
            { id: 'reset', onTap: actions.reset },
            { id: 'pause', onTap: actions.togglePause },
            { id: 'stiffness', onTap: actions.cycleStiffness },
            { id: 'substeps', onTap: actions.cycleSubsteps },
            { id: 'self', onTap: actions.toggleSelfCollision },
            { id: 'wind', onTap: actions.toggleWind },
            { id: 'unpin', onTap: actions.unpin },
            { id: 'quality', onTap: actions.cycleQuality },
        ]);
        this.hud.setButton('unpin', 'Unpin');
        this.hud.setButton('reset', 'Reset');

        this.interaction = new ClothInteraction(
            camera,
            this.orbit,
            () => this.cloth,
            (x, y) => this.hud?.contains(x, y) ?? false,
            actions,
        );
        this.interaction.enable();

        void ClothScene.create(world).then((cloth) => {
            this.cloth = cloth;
            this.refreshButtons();
        });
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        this.cloth?.update(dt);
        this.updateHud(dt);
    }

    private refreshButtons(): void {
        const cloth = this.cloth;
        const hud = this.hud;
        if (!cloth || !hud) return;
        hud.setButton('preset', `Scene: ${cloth.preset}`);
        hud.setButton('pause', cloth.paused ? 'Resume' : 'Pause', cloth.paused);
        hud.setButton('wind', 'Wind', cloth.wind);
        hud.setButton('stiffness', STIFFNESS[cloth.stiffness].name);
        hud.setButton('substeps', `${cloth.substeps} substeps`);
        hud.setButton('self', 'Self collide', cloth.selfCollision);
        hud.setButton('quality', `${QUALITY[cloth.quality].name}${cloth.autoQuality ? ' (auto)' : ''}`);
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud || !this.cloth) return;
        const cloth = this.cloth;
        const n = cloth.level.segments;
        const sag = cloth.sag;
        const cm = (m: number) => `${(m * 100).toFixed(1)} cm`;
        this.hud.setStatus([
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · solver ${cloth.simMs.toFixed(2)} ms`,
            `${n}×${n} · ${cloth.particleCount} particles · ${cloth.constraintCount} constraints`,
            `${cloth.substeps} substeps · self collision ${cloth.selfCollision ? 'on' : 'off'}`,
            sag ? `Sag: PBD (blue) ${cm(sag.pbd)} · XPBD (red) ${cm(sag.xpbd)}` : '',
        ]);
        // Auto quality may have changed the level since the last refresh.
        this.refreshButtons();
        this.frames = 0;
        this.frameTime = 0;
    }
}
