import {
    _decorator, Camera, Color, Component, DirectionalLight, Director, Layers, Node,
    director, renderer,
} from 'cc';
import type { IView } from '../enji/IView';
import { Curtain } from './Curtain';
import { GameAudio } from './GameAudio';
import { Hud } from './Hud';
import { LEVELS, LevelId } from './levels';
import { LibrarySlice } from './LibrarySlice';
import { SettingsScreen } from './SettingsScreen';
import { TitleScreen } from './TitleScreen';
import { loadUiPack } from './uiArt';

/** Wait until N frames have been drawn (GPU upload / first layout). */
function waitFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
        let left = Math.max(1, count);
        const tick = () => {
            left -= 1;
            if (left <= 0) resolve();
            else director.once(Director.EVENT_AFTER_DRAW, tick);
        };
        director.once(Director.EVENT_AFTER_DRAW, tick);
    });
}

const { ccclass } = _decorator;

@ccclass('MainView')
export class MainView extends Component implements IView {
    private slice: LibrarySlice | null = null;
    private hud: Hud | null = null;
    private title: TitleScreen | null = null;
    private settings: SettingsScreen | null = null;
    private audio: GameAudio | null = null;
    private curtain: Curtain | null = null;
    private world: Node | null = null;
    private cameraNode: Node | null = null;
    private camera: Camera | null = null;
    private loading = false;

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }

        this.world = new Node('World');
        scene.addChild(this.world);

        this.cameraNode = new Node('MainCamera');
        this.world.addChild(this.cameraNode);
        this.cameraNode.setPosition(0, 1.7, 7.2);
        this.camera = this.cameraNode.addComponent(Camera);
        this.camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        this.camera.clearColor = new Color(42, 26, 16, 255);
        this.camera.visibility = Layers.Enum.DEFAULT;
        this.camera.priority = 0;
        this.camera.fov = 58;
        this.camera.near = 0.05;
        this.camera.far = 80;

        const sun = new Node('Sun');
        this.world.addChild(sun);
        sun.setRotationFromEuler(-48, 35, 0);
        const light = sun.addComponent(DirectionalLight);
        light.illuminance = 65000;
        light.shadowEnabled = true;
        light.shadowPcf = 2;
        light.shadowDistance = 40;
        light.shadowSaturation = 0.5;
        const shadows = scene.globals.shadows;
        shadows.enabled = true;
        shadows.type = renderer.scene.ShadowType.ShadowMap;
        shadows.shadowMapSize = 2048;
        scene.globals.ambient.skyLightingColor = new Color(90, 100, 120, 255);
        scene.globals.ambient.groundLightingColor = new Color(35, 28, 24, 255);

        void this.bootUi(root);
    }

    private async bootUi(root: Node): Promise<void> {
        try {
            this.audio = new GameAudio(root);
            void this.audio.load();
            const art = await loadUiPack();
            this.curtain = new Curtain(root, art);
            this.curtain.setStatus('点亮藏书阁…');
            this.hud = new Hud(root, art);
            this.title = new TitleScreen(root, art);
            this.settings = new SettingsScreen(root, art, this.audio);
            this.settings.bind({
                onClose: () => this.slice?.setPaused(false),
                onLeave: () => void this.backToTitle(),
                onFeel: () => this.slice?.applyEye(),
                onCandles: () => { void this.slice?.applyCandles(); },
            });
            this.title.bind({
                onPlay: (id) => {
                    this.audio?.play('ui_click', 0.45);
                    void this.play(id);
                },
                onSettings: () => this.openSettings(false),
            });
            this.title.presentBackdrop();
            this.curtain.bringToFront();
            await waitFrames(4);
            await this.curtain.open(0.85);
            await this.title.show();
        } catch (err) {
            console.error(err);
            const fallback = new Node('UiFail');
            fallback.layer = root.layer;
            root.addChild(fallback);
        }
    }

    private poseTitleCam(): void {
        if (!this.cameraNode) return;
        this.cameraNode.setPosition(0.6, 1.75, 7.4);
        this.cameraNode.setRotationFromEuler(-6, 12, 0);
        if (this.camera) this.camera.clearColor = new Color(42, 26, 16, 255);
    }

    private async play(id: LevelId): Promise<void> {
        if (this.loading || !this.hud || !this.title || !this.audio || !this.curtain || !this.world || !this.cameraNode || !this.camera) return;
        if (this.settings?.isOpen) this.settings.close();
        this.loading = true;
        const level = LEVELS[id];
        try {
            // 1) Cover first — never load while the curtain is open.
            this.curtain.bringToFront();
            await this.curtain.close(0.35, `加载${level.title}…`);
            await this.title.hide();

            // 2) Build the whole scene behind the closed curtain.
            this.slice?.dispose();
            this.slice = null;
            const slice = new LibrarySlice(level, this.world, this.cameraNode, this.camera, this.hud, this.audio);
            slice.setMenu(() => this.openSettings(true));
            this.slice = slice;
            await slice.start((msg) => this.curtain?.setStatus(msg));

            // 3) Only then part the curtains (start() already settled GPU draws).
            this.curtain.setStatus('即将拉开帷幕…');
            await waitFrames(2);
            await this.curtain.open(0.8);
            await this.hud.show();
        } catch (err) {
            console.error(err);
            this.hud.toast('加载失败: ' + String(err), 8);
            await this.backToTitle();
        } finally {
            this.loading = false;
        }
    }

    private openSettings(inGame: boolean): void {
        if (this.loading || !this.settings || this.settings.isOpen) return;
        if (inGame) this.slice?.setPaused(true);
        this.settings.open(inGame);
    }

    private async backToTitle(): Promise<void> {
        if (!this.hud || !this.title || !this.curtain) return;
        await this.hud.hide();
        await this.curtain.close(0.35, '回到藏书阁…');
        this.slice?.dispose();
        this.slice = null;
        this.poseTitleCam();
        // Title flies in behind the closed curtain, then part.
        const showing = this.title.show();
        await waitFrames(1);
        await this.curtain.open(0.7);
        await showing;
    }

    update(dt: number): void {
        this.audio?.update(dt);
        this.slice?.update(dt);
    }

    onDestroy(): void {
        this.slice?.dispose();
        this.slice = null;
        this.audio?.dispose();
        this.audio = null;
    }
}
