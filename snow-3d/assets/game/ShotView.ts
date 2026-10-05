import {
    _decorator, Camera, Color, Component, director, DirectionalLight, EffectAsset, EventKeyboard, FogInfo, input, Input, KeyCode,
    Graphics, Layers, Material, Mesh, MeshRenderer, Node, primitives, renderer, resources, Sprite, SpriteFrame, Texture2D,
    UITransform, utils, Vec3, Vec4, view,
} from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadModel } from '../enji/helpers';
import { BUDGET, stepFrame } from './snow/Frame';
import { placeGauntlet } from './snow/GauntletNode';
import { Hand, type HandPose } from './snow/Hand';
import { Hud } from './snow/Hud';
import { bedCapacity, fillBed } from './snow/Scenes';
import { SHOT, shotPose, shotSize, TIMELINE } from './snow/Shot';
import { BORDER, SnowSim } from './snow/SnowSim';
import { SurfaceMesher } from './snow/SurfaceMesher';

const { ccclass } = _decorator;

const FRAME_DT = 1 / 60;
const MESH_CELL = 0.014;
const MESH_RADIUS = 0.042;
const MESH_TOP = 0.2;
const FLURRIES = 2500;
const SPRAY = 4000;
/** Awake snow faster than this is also drawn as loose powder. */
const SPRAY_SPEED = 0.25;
const SURROUND = 3;
const EDGE_COVER = 0.03;

function load<T>(path: string, type: new () => T): Promise<T> {
    return new Promise((resolve, reject) =>
        resources.load(path, type as never, (err: Error | null, asset: T) => (err ? reject(err) : resolve(asset))));
}

/** Smoothstep of u clamped to [0, 1]. */
function ease(u: number): number {
    const c = Math.min(Math.max(u, 0), 1);
    return c * c * (3 - 2 * c);
}

/**
 * The Lich King shot (Wrath of the Lich King, 2008): the gauntlet wipes a line
 * of fresh snow off a sheet of ice and the words frozen in it light up.
 * Everything the hand does to the snow is the MPM simulation of the sandbox.
 */
@ccclass('ShotView')
export class ShotView extends Component implements IView {
    private sim!: SnowSim;
    private hand = new Hand();
    private mesher!: SurfaceMesher;
    private ready = false;

    private root!: Node;
    private cameraNode!: Node;
    private camera!: Camera;
    private iceMaterial!: Material;
    private surfaceRenderer!: MeshRenderer;
    private surfaceMesh: Mesh | null = null;
    private surfaceColors = new Float32Array(0);
    private uploadedIndices = 0;
    private surround: Node[] = [];
    private gauntlet: Node | null = null;
    private flurryMesh: Mesh | null = null;
    private flurryPos = new Float32Array(FLURRIES * 3);
    private flurryCol = new Float32Array(FLURRIES * 4);
    private flurryVel = new Float32Array(FLURRIES * 3);
    private sprayMesh: Mesh | null = null;
    private sprayPos = new Float32Array(SPRAY * 3);
    private sprayCol = new Float32Array(SPRAY * 4);
    private bounds!: { lo: { x: number; y: number; z: number }; hi: { x: number; y: number; z: number } };

    private pose: HandPose = { x: 0, y: 0, z: 0, yaw: 0, lean: 0 };
    /** Shot time in seconds; negative while the fresh snow settles. */
    private t = 0;
    private settleLeft = 0;
    private paused = false;
    private snowTop = SHOT.bed.depth;
    private framing = 1.4;

    private hud: Hud | null = null;
    private info = false;
    private fps = 60;
    private simMs = 0;
    private hudTimer = 0;

    bind(root: Node): void {
        const scene = director.getScene()!;
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }
        this.buildSim();
        this.buildUi(root);
        input.on(Input.EventType.KEY_DOWN, this.onKey, this);
        void Promise.all([
            load('materials/snow', Material), load('materials/snow-flat', Material), load('materials/ice', Material),
            load('materials/stone', Material), load('effects/flurry', EffectAsset),
            load('textures/ice-albedo/texture', Texture2D), load('textures/ice-glow/texture', Texture2D),
        ]).then(([snow, flat, ice, stone, flurry, albedo, glow]) => {
            this.buildWorld(scene, { snow, flat, ice, stone }, flurry, albedo, glow);
        });
    }

    onDestroy(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKey, this);
        this.hud?.destroy();
    }

    // ------------------------------------------------------------------ setup

    private buildSim(): void {
        const { nx, ny, nz } = shotSize();
        this.sim = new SnowSim(nx, ny, nz, SHOT.dx, bedCapacity({ dx: SHOT.dx, nx, nz }, SHOT.bed, SHOT.perCell, BORDER));
        Object.assign(this.sim.params, SHOT.params);
        this.hand.scale = SHOT.handScale;
        const s = this.sim;
        this.mesher = new SurfaceMesher([s.lo, s.lo, s.lo], [s.hiX, s.lo + MESH_TOP, s.hiZ], MESH_CELL, MESH_RADIUS, 90000);
        this.mesher.setClip(s.lo, s.lo, s.lo, s.hiX, s.lo + MESH_TOP, s.hiZ);
        const spacing = SHOT.dx / SHOT.perCell;
        // Surface at 42% of full density. A single leftover layer of particles on the ice only reaches
        // (105/128)·spacing/R ≈ 33% of it, so a wiped line reads as bare ice; at 50% the loosened snow
        // along the stroke breaks up into holes, at 38% it creeps back over the letters.
        this.mesher.iso = 0.42 * ((32 * Math.PI) / 105) * MESH_RADIUS ** 3 / spacing ** 3;
        this.mesher.minY = s.lo + SHOT.dusting;
        s.onSleep = (p, asleep) => this.mesher.addToBase(s.x[p], s.y[p], s.z[p], asleep ? 1 : -1);
        this.replay();
    }

    /** Fresh snow, then the shot from the top once it has settled. */
    private replay(): void {
        const s = this.sim;
        this.mesher.resetBase();
        fillBed(s, SHOT.bed, SHOT.perCell);
        s.blewUp = false;
        s.colliders.length = 0;
        s.wakeAll();
        this.settleLeft = SHOT.settleFrames;
        this.t = 0;
        const cx = (s.lo + s.hiX) / 2, cz = (s.lo + s.hiZ) / 2;
        this.pose = shotPose(0, cx, cz, s.lo);
        this.hand.place(this.pose);
        this.hand.at(1);
        if (this.settleLeft === 0) this.finishSettle();
    }

    private buildWorld(
        scene: Node,
        mats: { snow: Material; flat: Material; ice: Material; stone: Material },
        flurryEffect: EffectAsset,
        albedo: Texture2D,
        glow: Texture2D,
    ): void {
        const world = new Node('World');
        scene.addChild(world);

        const camNode = new Node('MainCamera');
        world.addChild(camNode);
        const cam = camNode.addComponent(Camera);
        cam.projection = Camera.ProjectionType.PERSPECTIVE;
        cam.fov = 38;
        cam.near = 0.03;
        cam.far = 30;
        cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        cam.clearColor = new Color(6, 10, 20, 255);
        cam.visibility = Layers.Enum.DEFAULT;
        cam.priority = 0;
        this.cameraNode = camNode;
        this.camera = cam;
        this.fitFraming();
        view.on('canvas-resize', this.fitFraming, this);

        const moonNode = new Node('Moon');
        world.addChild(moonNode);
        moonNode.setRotationFromEuler(-42, -28, 0);
        const moon = moonNode.addComponent(DirectionalLight);
        moon.illuminance = 24000;
        moon.color = new Color(200, 218, 255, 255);
        moon.shadowEnabled = true;
        moon.shadowPcf = 2;
        moon.shadowFixedArea = true;
        moon.shadowNear = 0.1;
        moon.shadowFar = 6;
        moon.shadowOrthoSize = 1.0;
        moon.shadowBias = 0.0005;
        moon.shadowNormalBias = 0.002;
        const globals = director.getScene()!.globals;
        globals.shadows.enabled = true;
        globals.shadows.type = renderer.scene.ShadowType.ShadowMap;
        globals.shadows.shadowMapSize = 2048;
        globals.ambient.skyLightingColor = new Color(52, 72, 118, 255);
        globals.ambient.groundLightingColor = new Color(20, 28, 46, 255);
        // Night fog: the snowfield fades into the dark beyond the shot.
        globals.fog.enabled = true;
        globals.fog.type = FogInfo.FogType.LINEAR;
        // Per-pixel: the snowfield blocks are metres across with only corner vertices.
        globals.fog.accurate = true;
        globals.fog.fogColor = new Color(10, 16, 30, 255);
        const s = this.sim;
        const root = new Node('ShotRoot');
        world.addChild(root);
        root.setPosition(-(s.lo + s.hiX) / 2, -s.lo, -(s.lo + s.hiZ) / 2);
        this.root = root;
        const cx = (s.lo + s.hiX) / 2, cz = (s.lo + s.hiZ) / 2;
        const w = s.hiX - s.lo, l = s.hiZ - s.lo;

        // The ice sheet, textured across the whole tray floor, on a dark slab.
        this.iceMaterial = new Material();
        this.iceMaterial.copy(mats.ice);
        this.iceMaterial.setProperty('mainTexture', albedo);
        this.iceMaterial.setProperty('emissiveMap', glow);
        // primitives.plane runs v from far (−z) to near; the texture's top row is the far edge.
        this.iceMaterial.setProperty('tilingOffset', new Vec4(1, -1, 0, 1));
        const ice = new Node('Ice');
        root.addChild(ice);
        ice.setPosition(cx, s.lo, cz);
        const iceRenderer = ice.addComponent(MeshRenderer);
        iceRenderer.mesh = utils.MeshUtils.createMesh(primitives.plane({ width: w, length: l, widthSegments: 1, lengthSegments: 1 }));
        iceRenderer.setSharedMaterial(this.iceMaterial, 0);
        iceRenderer.receiveShadow = MeshRenderer.ShadowReceivingMode.ON;
        this.box(root, 'Slab', [cx, s.lo - 0.051, cz], [w, 0.1, l], mats.stone, false);

        // Untouched snowfield around the tray, flush with the settled snow, so the simulated patch has no edges.
        // It reaches EDGE_COVER in over the tray, where the simulated surface sags against the walls.
        const big = SURROUND + EDGE_COVER;
        const parts: [number, number, number, number][] = [
            [cx, s.lo - SURROUND / 2 + EDGE_COVER / 2, w + 2 * SURROUND, big], // back (−z)
            [cx, s.hiZ + SURROUND / 2 - EDGE_COVER / 2, w + 2 * SURROUND, big], // front (+z)
            [s.lo - SURROUND / 2 + EDGE_COVER / 2, cz, big, l], // left
            [s.hiX + SURROUND / 2 - EDGE_COVER / 2, cz, big, l], // right
        ];
        for (const [x, z, sw, sl] of parts) {
            const node = this.box(root, 'Snowfield', [x, 0, z], [sw, 1, sl], mats.flat, true);
            this.surround.push(node);
        }
        this.placeSurround();

        const lo = { x: s.lo, y: s.lo - 0.05, z: s.lo };
        const hi = { x: s.hiX, y: s.lo + MESH_TOP, z: s.hiZ };
        this.bounds = { lo, hi };
        const surfaceNode = new Node('SnowSurface');
        root.addChild(surfaceNode);
        this.surfaceRenderer = surfaceNode.addComponent(MeshRenderer);
        this.surfaceMesh = utils.MeshUtils.createDynamicMesh(0, {
            positions: new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0]),
            normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
            colors: new Float32Array(12).fill(1),
            indices32: new Uint32Array([0, 1, 2]),
            minPos: lo, maxPos: hi,
        }, undefined, { maxSubMeshes: 1, maxSubMeshVertices: this.mesher.maxVertices, maxSubMeshIndices: this.mesher.maxIndices });
        this.surfaceRenderer.mesh = this.surfaceMesh;
        this.surfaceRenderer.setSharedMaterial(mats.snow, 0);
        this.surfaceRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
        this.surfaceRenderer.receiveShadow = MeshRenderer.ShadowReceivingMode.ON;

        // Blowing snow in world space around the shot, and loose powder thrown by the hand.
        this.flurryMesh = this.pointCloud(world, 'Flurries', FLURRIES, this.flurryPos, this.flurryCol, flurryEffect, 0.0035,
            { x: -2, y: -0.5, z: -2 }, { x: 2, y: 2, z: 2 });
        this.seedFlurries();
        this.sprayMesh = this.pointCloud(root, 'Powder', SPRAY, this.sprayPos, this.sprayCol, flurryEffect, (SHOT.dx / SHOT.perCell) * 0.45, lo, hi);

        void loadModel('models/gauntlet').then((node) => {
            root.addChild(node);
            node.setScale(SHOT.handScale, SHOT.handScale, SHOT.handScale);
            for (const mr of node.getComponentsInChildren(MeshRenderer)) mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
            this.gauntlet = node;
            placeGauntlet(node, this.pose);
        });
        this.ready = true;
        (globalThis as any).__shotView = this;
    }

    private box(parent: Node, name: string, pos: number[], size: number[], mat: Material, receive: boolean): Node {
        const node = new Node(name);
        parent.addChild(node);
        node.setPosition(pos[0], pos[1], pos[2]);
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.MeshUtils.createMesh(primitives.box({ width: size[0], height: size[1], length: size[2] }));
        mr.setSharedMaterial(mat, 0);
        mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        mr.receiveShadow = receive ? MeshRenderer.ShadowReceivingMode.ON : MeshRenderer.ShadowReceivingMode.OFF;
        return node;
    }

    private pointCloud(
        parent: Node, name: string, n: number, pos: Float32Array, col: Float32Array, effect: EffectAsset, radius: number,
        lo: { x: number; y: number; z: number }, hi: { x: number; y: number; z: number },
    ): Mesh {
        const node = new Node(name);
        parent.addChild(node);
        const mr = node.addComponent(MeshRenderer);
        const mesh = utils.MeshUtils.createDynamicMesh(0, { positions: pos, colors: col, minPos: lo, maxPos: hi },
            undefined, { maxSubMeshes: 1, maxSubMeshVertices: n, maxSubMeshIndices: 0 });
        mr.mesh = mesh;
        mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        const mat = new Material();
        mat.initialize({ effectAsset: effect });
        mat.setProperty('pointParams', new Vec4(radius, 0, 0, 0));
        mr.setSharedMaterial(mat, 0);
        return mesh;
    }

    /** Snowfield blocks: top at the settled snow height, so they meet the simulated surface. */
    private placeSurround(): void {
        const s = this.sim;
        for (const node of this.surround) {
            const p = node.position;
            node.setPosition(p.x, s.lo + this.snowTop - 0.5, p.z);
        }
    }

    /** Distance that fits the text line and the hand's start (plus margin) across the screen, whatever the aspect. */
    private fitFraming(): void {
        if (!this.camera) return;
        const size = view.getVisibleSize();
        const aspect = size.width / size.height;
        const halfV = Math.tan((this.camera.fov * Math.PI) / 360);
        this.framing = Math.max(1.25, (SHOT.text.w / 2 + 0.14) / (halfV * aspect));
    }

    private seedFlurries(): void {
        let seed = 11;
        const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
        const pos = this.flurryPos, col = this.flurryCol, vel = this.flurryVel;
        for (let i = 0; i < FLURRIES; i++) {
            pos[i * 3] = (rand() - 0.5) * 4;
            pos[i * 3 + 1] = rand() * 2;
            pos[i * 3 + 2] = (rand() - 0.5) * 4;
            vel[i * 3] = 0.35 + rand() * 0.4;
            vel[i * 3 + 1] = -0.25 - rand() * 0.35;
            vel[i * 3 + 2] = (rand() - 0.5) * 0.2;
            const b = 0.75 + rand() * 0.25;
            col[i * 4] = 0.85 * b; col[i * 4 + 1] = 0.92 * b; col[i * 4 + 2] = b; col[i * 4 + 3] = 0.25 + rand() * 0.5;
        }
    }

    // ------------------------------------------------------------------ loop

    update(dt: number): void {
        if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
        if (!this.ready) return;
        const s = this.sim;
        const cx = (s.lo + s.hiX) / 2, cz = (s.lo + s.hiZ) / 2;
        const t0 = performance.now();
        if (!this.paused) {
            if (this.settleLeft > 0) {
                for (let k = 0; k < BUDGET.substeps; k++) s.step(FRAME_DT / BUDGET.substeps);
                if (--this.settleLeft === 0) this.finishSettle();
            } else {
                this.t += FRAME_DT;
                this.pose = shotPose(this.t, cx, cz, s.lo);
                stepFrame(s, this.hand, this.pose, FRAME_DT);
            }
            this.stepFlurries(FRAME_DT);
        }
        this.simMs += (performance.now() - t0 - this.simMs) * 0.1;
        this.mesher.splatActive(s.x, s.y, s.z, s.active, s.activeCount);
        this.mesher.extract();
        this.upload();
        if (this.gauntlet) placeGauntlet(this.gauntlet, this.pose);
        this.applyCamera();
        this.applyGlow();

        this.hudTimer -= dt;
        if (this.hudTimer <= 0) {
            this.hudTimer = 0.25;
            this.updateHud();
        }
    }

    private finishSettle(): void {
        const s = this.sim;
        s.sleepAll();
        s.colliders.push(...this.hand.capsules);
        // Mean height of the settled surface, from the highest particle in 5 cm columns away from the walls.
        const c = 0.05, bx = Math.floor((s.hiX - s.lo) / c), bz = Math.floor((s.hiZ - s.lo) / c);
        const top = new Float32Array(bx * bz);
        for (let p = 0; p < s.count; p++) {
            const i = Math.floor((s.x[p] - s.lo) / c), k = Math.floor((s.z[p] - s.lo) / c);
            if (i >= 0 && i < bx && k >= 0 && k < bz) top[i + k * bx] = Math.max(top[i + k * bx], s.y[p] - s.lo);
        }
        let sum = 0, n = 0;
        for (let i = 1; i < bx - 1; i++) for (let k = 1; k < bz - 1; k++) { sum += top[i + k * bx]; n++; }
        // The surface sits a little under the top particle centres.
        this.snowTop = sum / n - 0.004;
        this.placeSurround();
    }

    private stepFlurries(dt: number): void {
        const pos = this.flurryPos, vel = this.flurryVel;
        const time = this.t;
        for (let i = 0; i < FLURRIES; i++) {
            const o = i * 3;
            const gust = 1 + 0.6 * Math.sin(time * 0.9 + pos[o + 2] * 1.7);
            pos[o] += (vel[o] * gust + 0.08 * Math.sin(time * 2.3 + i)) * dt;
            pos[o + 1] += vel[o + 1] * dt;
            pos[o + 2] += (vel[o + 2] + 0.06 * Math.cos(time * 1.9 + i * 0.7)) * dt;
            if (pos[o + 1] < -0.05) { pos[o + 1] += 2; }
            if (pos[o] > 2) pos[o] -= 4;
            if (pos[o + 2] > 2) pos[o + 2] -= 4; else if (pos[o + 2] < -2) pos[o + 2] += 4;
        }
        this.flurryMesh?.updateSubMesh(0, { positions: pos, colors: this.flurryCol, minPos: { x: -2, y: -0.5, z: -2 }, maxPos: { x: 2, y: 2, z: 2 } });
    }

    private upload(): void {
        const { lo, hi } = this.bounds;
        const m = this.mesher;
        if (this.surfaceMesh && m.indexCount > 0) {
            let count = m.indexCount;
            // Enji draws the whole preallocated index buffer, so a shorter frame must zero the old tail.
            if (this.uploadedIndices > count) { m.indices.fill(0, count, this.uploadedIndices); count = this.uploadedIndices; }
            this.uploadedIndices = m.indexCount;
            this.surfaceMesh.updateSubMesh(0, {
                positions: m.positions.subarray(0, m.vertexCount * 3),
                normals: m.normals.subarray(0, m.vertexCount * 3),
                colors: this.tintSurface(),
                indices32: m.indices.subarray(0, count),
                minPos: lo, maxPos: hi,
            });
            const ia = this.surfaceRenderer.model?.subModels[0]?.inputAssembler;
            if (ia && ia.indexCount !== m.indexCount) ia.indexCount = m.indexCount;
        }
        // Powder: fast awake particles as soft points; unused slots are transparent.
        const s = this.sim;
        const pos = this.sprayPos, col = this.sprayCol;
        let n = 0;
        const v2 = SPRAY_SPEED * SPRAY_SPEED;
        for (let a = 0; a < s.activeCount && n < SPRAY; a++) {
            const p = s.active[a];
            const sp = s.vx[p] * s.vx[p] + s.vy[p] * s.vy[p] + s.vz[p] * s.vz[p];
            if (sp < v2) continue;
            pos[n * 3] = s.x[p]; pos[n * 3 + 1] = s.y[p]; pos[n * 3 + 2] = s.z[p];
            col[n * 4] = 0.9; col[n * 4 + 1] = 0.95; col[n * 4 + 2] = 1; col[n * 4 + 3] = Math.min(0.8, (Math.sqrt(sp) - SPRAY_SPEED) * 1.5);
            n++;
        }
        col.fill(0, n * 4);
        this.sprayMesh?.updateSubMesh(0, { positions: pos, colors: col, minPos: lo, maxPos: hi });
    }

    /** Thin snow (at the edges of the wiped line) shows the blue of the ice through it. */
    private tintSurface(): Float32Array {
        const m = this.mesher, floor = this.sim.lo, depth = this.snowTop;
        if (this.surfaceColors.length < m.maxVertices * 4) this.surfaceColors = new Float32Array(m.maxVertices * 4);
        const col = this.surfaceColors, pos = m.positions;
        for (let v = 0; v < m.vertexCount; v++) {
            const h = (pos[v * 3 + 1] - floor) / depth;
            const k = 1 - ease(h / 0.75);
            col[v * 4] = 1 - 0.4 * k;
            col[v * 4 + 1] = 1 - 0.25 * k;
            col[v * 4 + 2] = 1 - 0.04 * k;
            col[v * 4 + 3] = 1;
        }
        return col.subarray(0, m.vertexCount * 4);
    }

    /**
     * High and wide on the landing spot left of the words, following the brush across,
     * then a slow push in and down onto the words.
     */
    private applyCamera(): void {
        const T = TIMELINE;
        const u = ease((this.t - T.land) / (T.end - 1 - T.land));
        const follow = ease((this.t - T.brush) / (T.wipeEnd + 0.6 - T.brush));
        const pitch = (55 - 13 * u) * (Math.PI / 180);
        const dist = this.framing * (1.1 - 0.22 * u);
        const yaw = (-5 + 5 * u) * (Math.PI / 180);
        const target = new Vec3(-0.14 * (1 - follow), 0, -0.03 * u);
        this.cameraNode.setPosition(
            target.x + dist * Math.cos(pitch) * Math.sin(yaw),
            target.y + dist * Math.sin(pitch),
            target.z + dist * Math.cos(pitch) * Math.cos(yaw),
        );
        this.cameraNode.lookAt(target);
        // Fog measured from the shot, not the camera: a narrow screen pulls the camera back about 3×.
        const fog = director.getScene()!.globals.fog;
        fog.fogStart = dist + 0.6;
        fog.fogEnd = dist + 3.4;
    }

    /** The words are lit faintly under the snow, brighten as they are uncovered and then breathe. */
    private applyGlow(): void {
        const T = TIMELINE;
        const reveal = ease((this.t - T.brush) / (T.wipeEnd + 1 - T.brush));
        const breathe = this.t > T.exit ? 0.15 * Math.sin((this.t - T.exit) * 2.2) : 0;
        const g = 0.35 + 1.25 * reveal + breathe * reveal;
        this.iceMaterial.setProperty('emissiveScale', new Vec3(g, g, g));
    }

    // ------------------------------------------------------------------ ui

    private onKey(event: EventKeyboard): void {
        switch (event.keyCode) {
            case KeyCode.KEY_R: this.replay(); break;
            case KeyCode.KEY_I: this.toggleInfo(); break;
            case KeyCode.KEY_P:
            case KeyCode.SPACE: this.paused = !this.paused; break;
            default: return;
        }
        this.refreshButtons();
    }

    private toggleInfo(): void {
        this.info = !this.info;
        this.hud?.setStatusVisible(this.info);
    }

    private buildUi(root: Node): void {
        const canvas = ensureCanvas(root).node;
        this.buildFrame(canvas);
        const tap = (action: () => void) => () => { action(); this.refreshButtons(); this.updateHud(); };
        this.hud = new Hud(canvas, [
            { id: 'replay', onTap: tap(() => this.replay()) },
            { id: 'pause', onTap: tap(() => { this.paused = !this.paused; }) },
            { id: 'info', onTap: tap(() => this.toggleInfo()) },
            { id: 'sandbox', onTap: () => { (globalThis as any).location?.assign?.(`${location.pathname}${location.search.replace(/[?&]view=[^&]*/, '')}${location.search ? '&' : '?'}view=sandbox`); } },
        ]);
        this.hud.setStatusVisible(this.info);
        this.refreshButtons();
    }

    /** Vignette and thin cinema bars, under the HUD. */
    private buildFrame(canvas: Node): void {
        const frame = new Node('Frame');
        frame.layer = canvas.layer;
        canvas.addChild(frame);
        const vignette = new Node('Vignette');
        vignette.layer = canvas.layer;
        frame.addChild(vignette);
        vignette.addComponent(UITransform);
        const sprite = vignette.addComponent(Sprite);
        sprite.sizeMode = Sprite.SizeMode.CUSTOM;
        const bars = new Node('Bars');
        bars.layer = canvas.layer;
        frame.addChild(bars);
        bars.addComponent(UITransform);
        const g = bars.addComponent(Graphics);
        const layout = () => {
            const size = view.getVisibleSize();
            vignette.getComponent(UITransform)!.setContentSize(size.width, size.height);
            // Bars down to a 2.2:1 picture on landscape screens; portrait keeps the full height.
            const bar = size.width > size.height ? Math.max(0, (size.height - size.width / 2.2) / 2) : 0;
            g.clear();
            g.fillColor = new Color(0, 0, 0, 255);
            g.rect(-size.width / 2, size.height / 2 - bar, size.width, bar);
            g.rect(-size.width / 2, -size.height / 2, size.width, bar);
            g.fill();
        };
        layout();
        view.on('canvas-resize', layout);
        load('textures/vignette/spriteFrame', SpriteFrame).then((sf) => { sprite.spriteFrame = sf; layout(); });
    }

    private refreshButtons(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('replay', 'Replay');
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
        hud.setButton('info', 'Info', this.info);
        hud.setButton('sandbox', 'Sandbox');
    }

    private updateHud(): void {
        const s = this.sim;
        this.hud?.setStatus([
            `FPS ${this.fps.toFixed(0)} · sim ${this.simMs.toFixed(1)} ms · t ${Math.max(0, this.t).toFixed(1)} s${this.paused ? ' · paused' : ''}`,
            `${s.count} snow particles · ${s.activeCount} awake · grid ${s.nx}×${s.ny}×${s.nz} (${(s.dx * 100).toFixed(1)} cm)`,
            this.settleLeft > 0 ? `settling the snow… ${this.settleLeft}` : s.blewUp ? 'step hit the speed cap' : 'R replay · P pause · I info',
        ]);
        (globalThis as any).__shot = {
            fps: this.fps, simMs: this.simMs, t: this.t, settling: this.settleLeft, particles: s.count, awake: s.activeCount, blewUp: s.blewUp,
        };
    }
}
