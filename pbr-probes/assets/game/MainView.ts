import { _decorator, Camera, Color, Component, director, Layers, Node, Vec3 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas } from '../enji/helpers';
import { Hud } from './pbr/Hud';
import { HERO_MATERIALS, PbrScene } from './pbr/PbrScene';
import { PbrInteraction } from './pbr/PbrInteraction';
import { OrbitCamera } from './pbr/OrbitCamera';

const { ccclass } = _decorator;

const VIEW = { eye: new Vec3(0, 1.7, 6.6), target: new Vec3(0, 1.25, 0) };
const BAND_NAMES = ['L0 (1)', 'L1 (4)', 'L2 (9)'];

/**
 * PBR with baked light probes in a Cornell box: the room's direct and
 * multi-bounce light is baked offline (tools/bake.mts) into vertex colours and
 * an L2 SH probe grid; dynamic GGX spheres take diffuse light from the probes
 * and reflections from a box-projected probe prefiltered at startup.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private scene: PbrScene | null = null;
    private interaction: PbrInteraction | null = null;
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
        camera.clearColor = new Color(14, 15, 18, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.05;
        camera.far = 100;
        this.orbit = new OrbitCamera(camera, VIEW.eye);
        this.orbit.target.set(VIEW.target);
        this.orbit.setView(VIEW.eye, VIEW.target);
        this.orbit.minDistance = 1.5;
        this.orbit.maxDistance = 14;

        const toggle = (apply: (s: PbrScene) => void, probes = false) => () => {
            if (!this.scene) return;
            apply(this.scene);
            this.scene.invalidate(probes);
            this.refreshButtons();
        };
        const actions = {
            toggleDirect: toggle((s) => { s.direct = !s.direct; }),
            toggleIndirect: toggle((s) => { s.indirect = !s.indirect; }),
            toggleSpecular: toggle((s) => { s.specular = !s.specular; }),
            toggleBox: toggle((s) => { s.boxProjection = !s.boxProjection; }),
            toggleProbes: toggle((s) => { s.showProbes = !s.showProbes; }),
            cycleBands: toggle((s) => { s.bands = (s.bands + 1) % BAND_NAMES.length; }, true),
            cycleProbeMode: toggle((s) => { s.probeMode = s.probeMode === 'grid' ? 'one' : 'grid'; }, true),
            cycleMaterial: toggle((s) => s.cycleHeroMaterial()),
            reset: toggle((s) => {
                s.resetHero();
                this.orbit?.setView(VIEW.eye, VIEW.target);
            }),
        };

        this.hud = new Hud(ensureCanvas(root).node, [
            { id: 'direct', onTap: actions.toggleDirect },
            { id: 'indirect', onTap: actions.toggleIndirect },
            { id: 'specular', onTap: actions.toggleSpecular },
            { id: 'box', onTap: actions.toggleBox },
            { id: 'bands', onTap: actions.cycleBands },
            { id: 'mode', onTap: actions.cycleProbeMode },
            { id: 'probes', onTap: actions.toggleProbes },
            { id: 'material', onTap: actions.cycleMaterial },
            { id: 'reset', onTap: actions.reset },
        ]);
        this.hud.setButton('reset', 'Reset');

        this.interaction = new PbrInteraction(
            camera,
            this.orbit,
            () => this.scene,
            (x, y) => this.hud?.contains(x, y) ?? false,
            actions,
        );
        this.interaction.enable();

        void PbrScene.create(world).then((pbr) => {
            this.scene = pbr;
            this.refreshButtons();
        });
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        this.scene?.update();
        this.updateHud(dt);
    }

    private refreshButtons(): void {
        const s = this.scene;
        const hud = this.hud;
        if (!s || !hud) return;
        hud.setButton('direct', 'Direct', s.direct);
        hud.setButton('indirect', 'Indirect', s.indirect);
        hud.setButton('specular', 'Reflections', s.specular);
        hud.setButton('box', 'Box project', s.boxProjection);
        hud.setButton('bands', `SH ${BAND_NAMES[s.bands]}`);
        hud.setButton('mode', s.probeMode === 'grid' ? 'Probe grid' : 'One probe');
        hud.setButton('probes', 'Show probes', s.showProbes);
        hud.setButton('material', HERO_MATERIALS[s.heroMaterial].name);
    }

    private updateHud(dt: number): void {
        this.frames += 1;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud || !this.scene) return;
        const s = this.scene;
        const [nx, ny, nz] = s.baked.dims;
        const t = s.envTimings;
        const prefilterMs = t.slice(1).reduce((a, b) => a + b, 0);
        const h = s.hero;
        this.hud.setStatus([
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · room ${s.roomVertices} verts · 11 spheres`,
            `${nx}×${ny}×${nz} SH probes, ${BAND_NAMES[s.bands]} · ${s.probeMode === 'grid' ? 'trilinear over 8' : 'single probe'}`,
            s.envReady
                ? `Startup: room ${s.roomBuildMs.toFixed(0)} ms · probe capture ${t[0].toFixed(0)} + GGX ${prefilterMs.toFixed(0)} ms`
                : `Reflection probe: prefiltering ${s.envLevelCount}/5…`,
            `${HERO_MATERIALS[s.heroMaterial].name} at (${h.x.toFixed(2)}, ${h.y.toFixed(2)}, ${h.z.toFixed(2)}) · sees ${(s.heroVisibility * 100).toFixed(0)}% of light`,
        ]);
        this.frames = 0;
        this.frameTime = 0;
    }
}
