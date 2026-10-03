import { _decorator, Camera, Color, Component, director, KeyCode, Layers, Material, Mesh, MeshRenderer, Node, utils, Vec3, Vec4 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadEffect } from '../enji/helpers';
import { AnimInteraction } from './anim/AnimInteraction';
import { buildBody, buildBones } from './anim/Body';
import { Character, createAnimSet, type AnimSet, type SpeedMode } from './anim/Character';
import { blobMeshAsset, CharacterView, orbMeshAsset, skinnedMeshAsset, type SkinMode, type ViewAssets, type ViewMode } from './anim/CharacterView';
import { Hud } from './anim/Hud';
import { vec } from './anim/Math3';
import { OrbitCamera } from './anim/OrbitCamera';
import { buildTerrain } from './anim/Terrain';

const { ccclass } = _decorator;

const SPEEDS: SpeedMode[] = ['auto', 'idle', 'walk', 'run', 'exercise'];
const SPEED_NAMES = ['Auto', 'Idle', 'Walk', 'Run', 'Exercise'];
const SKINS: SkinMode[] = ['dqs', 'lbs', 'split'];
const SKIN_NAMES = ['Dual quat', 'Linear blend', 'Split LBS|DQS'];
const VIEWS: ViewMode[] = ['skin', 'weights', 'bones'];
const VIEW_NAMES = ['Skin', 'Weights', 'Bones'];
const CROWDS = [1, 9, 25];
/** Characters per ring for each crowd size; ring k has radius 3 + 1.2·k. */
const RINGS: Record<number, number[]> = { 1: [1], 9: [2, 3, 4], 25: [3, 4, 5, 6, 7] };
const TINTS = [[0.2, 0.55, 0.62], [0.75, 0.32, 0.28], [0.36, 0.6, 0.3], [0.58, 0.4, 0.7], [0.85, 0.66, 0.25], [0.3, 0.42, 0.75]];
const TERRAIN_HALF = 14;
const TERRAIN_CELLS = 112;
const SUN = new Vec4(0.45, 0.8, 0.35, 0);

/**
 * Skeletal animation with two-bone IK: baked idle / walk / run clips
 * blended by speed on a shared phase, root motion, foot and pelvis IK on
 * rolling ground with planted feet pinned, a reaching arm, and GPU skinning
 * by linear blend or dual quaternions.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: AnimInteraction | null = null;
    private set: AnimSet | null = null;
    private assets: ViewAssets | null = null;
    private world: Node | null = null;
    private terrain: MeshRenderer | null = null;
    private readonly terrainMeshes: (Mesh | null)[] = [null, null];
    private characters: Character[] = [];
    private views: CharacterView[] = [];
    private speedIndex = 0;
    private skinIndex = 0;
    private viewIndex = 0;
    private crowdIndex = 0;
    private footIk = true;
    private reach = false;
    private hills = true;
    private paused = false;
    private frames = 0;
    private frameTime = 0;
    private animMs = 0;
    private bakeMs = 0;

    bind(root: Node): void {
        const scene = director.getScene()!;
        // The template Canvas camera draws only the UI, on top of the 3D camera. Its
        // default visibility also includes DEFAULT, which would draw the world twice.
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }
        const world = (this.world = new Node('World'));
        scene.addChild(world);
        const cameraNode = new Node('MainCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(158, 168, 189, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.1;
        camera.far = 60;
        const eye = new Vec3(6.4, 2.4, 3.2);
        this.orbit = new OrbitCamera(camera, eye);
        this.orbit.setView(eye, new Vec3(3, 1, 0));
        this.orbit.minDistance = 1.2;
        this.orbit.maxDistance = 18;

        const actions = {
            speed: () => { this.speedIndex = (this.speedIndex + 1) % SPEEDS.length; this.apply(); },
            footIk: () => { this.footIk = !this.footIk; this.apply(); },
            reach: () => { this.reach = !this.reach; this.apply(); },
            skin: () => { this.skinIndex = (this.skinIndex + 1) % SKINS.length; this.apply(); },
            view: () => { this.viewIndex = (this.viewIndex + 1) % VIEWS.length; this.apply(); },
            crowd: () => { this.crowdIndex = (this.crowdIndex + 1) % CROWDS.length; this.spawn(); },
            hills: () => { this.hills = !this.hills; this.applyTerrain(); this.apply(); },
            pause: () => { this.paused = !this.paused; this.apply(); },
        };
        this.hud = new Hud(ensureCanvas(root).node, Object.entries(actions).map(([id, onTap]) => ({ id, onTap })));
        this.interaction = new AnimInteraction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, [
            [KeyCode.KEY_S, actions.speed], [KeyCode.KEY_F, actions.footIk], [KeyCode.KEY_R, actions.reach], [KeyCode.KEY_K, actions.skin],
            [KeyCode.KEY_V, actions.view], [KeyCode.KEY_C, actions.crowd], [KeyCode.KEY_H, actions.hills], [KeyCode.SPACE, actions.pause],
        ]);
        this.interaction.enable();
        this.apply();

        const t0 = performance.now();
        this.set = createAnimSet();
        this.bakeMs = performance.now() - t0;

        void Promise.all([loadEffect('effects/anim-skin'), loadEffect('effects/anim-lit')]).then(([skinFx, litFx]) => {
            const make = (effectAsset: typeof skinFx, technique: number, defines: Record<string, boolean> = {}): Material => {
                const m = new Material();
                m.initialize({ effectAsset, technique, defines });
                m.setProperty('sunDir', SUN);
                return m;
            };
            const set = this.set!;
            this.assets = {
                body: skinnedMeshAsset(buildBody(set.skel)),
                bones: skinnedMeshAsset(buildBones(set.skel)),
                blob: blobMeshAsset(0.42),
                orb: orbMeshAsset(0.07),
                skinLbs: make(skinFx, 0),
                skinDqs: make(skinFx, 0, { SKIN_DQS: true }),
                boneOverlay: make(skinFx, 1),
                blobMaterial: make(litFx, 1),
                lit: make(litFx, 0),
            };
            const node = new Node('Terrain');
            world.addChild(node);
            this.terrain = node.addComponent(MeshRenderer);
            this.terrain.setSharedMaterial(this.assets.lit, 0);
            this.terrain.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            this.terrain.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
            this.applyTerrain();
            this.spawn();
        });
        (globalThis as { __anim?: MainView }).__anim = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    private applyTerrain(): void {
        if (!this.terrain) return;
        const k = this.hills ? 1 : 0;
        if (!this.terrainMeshes[k]) {
            const t = buildTerrain(TERRAIN_HALF, TERRAIN_CELLS, k);
            this.terrainMeshes[k] = utils.MeshUtils.createMesh({ ...t, minPos: new Vec3(-TERRAIN_HALF, -1, -TERRAIN_HALF), maxPos: new Vec3(TERRAIN_HALF, 1, TERRAIN_HALF) });
        }
        this.terrain.mesh = this.terrainMeshes[k];
    }

    private spawn(): void {
        if (!this.set || !this.assets || !this.world) return;
        for (const v of this.views) v.destroy();
        this.characters = [];
        this.views = [];
        const rings = RINGS[CROWDS[this.crowdIndex]];
        let i = 0;
        rings.forEach((count, ring) => {
            const radius = 3 + 1.2 * ring;
            const direction = ring % 2 ? -1 : 1;
            for (let k = 0; k < count; k++) {
                // Everyone on a ring shares a clock, so they keep their spacing.
                const c = new Character(this.set!, vec(), radius, (2 * Math.PI * k) / count + ring * 0.7, direction, ring * 2.3);
                const tint = TINTS[i % TINTS.length];
                this.characters.push(c);
                this.views.push(new CharacterView(this.world!, c, this.assets!, new Vec4(tint[0], tint[1], tint[2], 1)));
                i++;
            }
        });
        this.apply();
    }

    update(dt: number): void {
        const step = this.paused ? 0 : Math.min(dt, 1 / 20);
        const t0 = performance.now();
        if (step > 0) for (const c of this.characters) c.update(step);
        for (const v of this.views) v.sync();
        this.animMs += performance.now() - t0;
        const lead = this.characters[0];
        if (lead && this.orbit) {
            const target = this.orbit.target;
            const k = 1 - Math.exp(-dt * 4);
            target.x += (lead.rootPos.x - target.x) * k;
            target.y += (lead.rootPos.y + 1 - target.y) * k;
            target.z += (lead.rootPos.z - target.z) * k;
        }
        this.orbit?.update(dt);
        this.updateHud(dt);
    }

    private apply(): void {
        const mode = SPEEDS[this.speedIndex];
        for (const c of this.characters) {
            c.mode = mode;
            c.footIk = this.footIk;
            c.reach = this.reach;
            c.terrainAmplitude = this.hills ? 1 : 0;
        }
        for (const v of this.views) v.setModes(SKINS[this.skinIndex], VIEWS[this.viewIndex]);
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('speed', SPEED_NAMES[this.speedIndex]);
        hud.setButton('footIk', this.footIk ? 'Foot IK on' : 'Foot IK off', this.footIk);
        hud.setButton('reach', this.reach ? 'Reach on' : 'Reach off', this.reach);
        hud.setButton('skin', SKIN_NAMES[this.skinIndex]);
        hud.setButton('view', VIEW_NAMES[this.viewIndex]);
        hud.setButton('crowd', `${CROWDS[this.crowdIndex]} ${CROWDS[this.crowdIndex] === 1 ? 'character' : 'characters'}`);
        hud.setButton('hills', this.hills ? 'Hills' : 'Flat', this.hills);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    private updateHud(dt: number): void {
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud) return;
        const lead = this.characters[0];
        const n = this.characters.length;
        const lines = [
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · frame ${((this.frameTime / this.frames) * 1000).toFixed(1)} ms · anim ${(this.animMs / this.frames).toFixed(2)} ms for ${n}`,
        ];
        if (lead) {
            const w = lead.weights;
            const s = lead.stats;
            lines.push(`${lead.speed.toFixed(2)} m/s · idle ${w[0].toFixed(2)} walk ${w[1].toFixed(2)} run ${w[2].toFixed(2)} ex ${w[3].toFixed(2)}`);
            lines.push(s.samples > 0
                ? `planted ball: ${((s.error / s.samples) * 1000).toFixed(1)} mm off ground · slide ${((s.skate / s.samples) * 1000).toFixed(1)} mm/s · pelvis ${(lead.pelvisOffset * 100).toFixed(1)} cm`
                : `no planted foot · pelvis ${(lead.pelvisOffset * 100).toFixed(1)} cm`);
            for (const c of this.characters) c.resetStats();
        }
        lines.push(`clips baked in ${this.bakeMs.toFixed(0)} ms · drag: orbit · pinch / wheel: zoom`);
        this.hud.setStatus(lines);
        this.frames = 0;
        this.frameTime = 0;
        this.animMs = 0;
    }
}
