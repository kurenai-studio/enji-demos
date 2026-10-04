import {
    _decorator, Camera, Color, Component, director, DirectionalLight, EffectAsset, EventKeyboard, EventMouse, EventTouch,
    geometry, input, Input, KeyCode, Layers, Material, Mesh, MeshRenderer, Node, primitives, Quat, renderer,
    resources, UITransform, utils, Vec3, Vec4, view,
} from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadModel } from '../enji/helpers';
import { BUDGET, stepFrame } from './snow/Frame';
import { placeGauntlet } from './snow/GauntletNode';
import { Hand, PARTS, type HandPose } from './snow/Hand';
import { Hud } from './snow/Hud';
import { BEDS, bedCapacity, bedHeight, fillBed } from './snow/Scenes';
import { SCENE, simSize } from './snow/Setup';
import { BORDER, SnowSim } from './snow/SnowSim';
import { SurfaceMesher } from './snow/SurfaceMesher';

const { ccclass } = _decorator;

const DX = SCENE.dx;
const PER_CELL = 1.25;
const RIM = 0.08;
const RIM_H = 0.34;
const FRAME_DT = 1 / 60;
const SETTLE_FRAMES = SCENE.settleFrames;
const DIG_Y = SCENE.digY;
const LIFT_Y = SCENE.liftY;
/** Height of the plane the pointer is projected on, about the snow surface. */
const PICK_Y = 0.22;
const HAND_SPEED = 1.6;
const MESH_CELL = 0.02;
const MESH_RADIUS = 0.05;
const MESH_TOP = 0.5;
/** The settled bed sits a little under its fill height; tint starts below that and saturates TINT_DEPTH further down. */
const TINT_START = 0.02;
const TINT_DEPTH = 0.12;
const MATERIALS = ['snow', 'steel', 'stone'] as const;
type MaterialName = (typeof MATERIALS)[number];

enum ViewMode { Surface, Particles, Both }
const VIEW_NAMES = ['Surface', 'Particles', 'Both'];

function loadMaterial(name: string): Promise<Material> {
    return new Promise((resolve, reject) =>
        resources.load(`materials/${name}`, Material, (err, mat) => (err ? reject(err) : resolve(mat))));
}

function loadEffect(path: string): Promise<EffectAsset> {
    return new Promise((resolve, reject) =>
        resources.load(path, EffectAsset, (err, effect) => (err ? reject(err) : resolve(effect))));
}

@ccclass('MainView')
export class MainView extends Component implements IView {
    private sim!: SnowSim;
    private hand = new Hand();
    private mesher!: SurfaceMesher;
    private materials: Partial<Record<MaterialName, Material>> = {};
    private ready = false;

    private cameraNode!: Node;
    private camera!: Camera;
    private root!: Node;
    private surfaceRenderer!: MeshRenderer;
    private surfaceMesh: Mesh | null = null;
    private pointRenderer!: MeshRenderer;
    private pointMesh: Mesh | null = null;
    private pointPositions = new Float32Array(0);
    private pointColors = new Float32Array(0);
    private handNodes: Node[] = [];
    private gauntlet: Node | null = null;
    private surfaceColors = new Float32Array(0);
    private uploadedIndices = 0;

    private yaw = 20;
    private pitch = 36;
    private distance = 2.2;
    private readonly target = new Vec3(0, 0.15, 0);
    private pinchDistance = 0;

    private pose: HandPose = { x: 0, y: 0, z: 0, yaw: 0, lean: 0.5 };
    private handTarget = new Vec3();
    private pressing = false;
    private sweepTime = -1;
    private settleLeft = SETTLE_FRAMES;
    private paused = false;
    private viewMode = ViewMode.Surface;

    private hud: Hud | null = null;
    private fps = 60;
    private simMs = 0;
    private meshMs = 0;
    private uploadMs = 0;
    private hudTimer = 0;
    private frame = 0;

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
        input.on(Input.EventType.MOUSE_WHEEL, this.onWheel, this);
        input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        void Promise.all([
            ...MATERIALS.map((name) => loadMaterial(name).then((m) => { this.materials[name] = m; })),
            loadEffect('effects/snow-points'),
        ]).then(([, , , points]) => this.buildWorld(scene, points as EffectAsset));
    }

    onDestroy(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKey, this);
        input.off(Input.EventType.MOUSE_WHEEL, this.onWheel, this);
        input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        this.hud?.destroy();
    }

    // ------------------------------------------------------------------ setup

    private buildSim(): void {
        const { nx, ny, nz } = simSize();
        const bed = BEDS[SCENE.bed];
        this.sim = new SnowSim(nx, ny, nz, DX, bedCapacity({ dx: DX, nx, nz }, bed, PER_CELL, BORDER));
        Object.assign(this.sim.params, SCENE.params);
        this.hand.scale = SCENE.handScale;
        const s = this.sim;
        this.mesher = new SurfaceMesher([s.lo, s.lo, s.lo], [s.hiX, s.lo + MESH_TOP, s.hiZ], MESH_CELL, MESH_RADIUS, 60000);
        this.mesher.setClip(s.lo, s.lo, s.lo, s.hiX, s.lo + MESH_TOP, s.hiZ);
        // Field inside uniform snow is n·∫(1 − r²/R²)³ dV = (32π/105) R³ / spacing³; the surface sits at 40% of it.
        const spacing = DX / PER_CELL;
        this.mesher.iso = 0.4 * ((32 * Math.PI) / 105) * MESH_RADIUS ** 3 / spacing ** 3;
        s.onSleep = (p, asleep) => this.mesher.addToBase(s.x[p], s.y[p], s.z[p], asleep ? 1 : -1);
        s.colliders.push(...this.hand.capsules);
        this.reset();
    }

    private reset(): void {
        const s = this.sim;
        this.mesher.resetBase();
        fillBed(s, BEDS[SCENE.bed], PER_CELL);
        this.settleLeft = SETTLE_FRAMES;
        this.sweepTime = -1;
        s.blewUp = false;
        this.pose = { x: (s.lo + s.hiX) / 2, y: s.lo + LIFT_Y, z: (s.lo + s.hiZ) / 2, yaw: 0, lean: 0.5 };
        this.handTarget.set(this.pose.x, this.pose.y, this.pose.z);
        this.hand.place(this.pose);
        this.hand.at(1);
    }

    private buildWorld(scene: Node, pointEffect: EffectAsset): void {
        const world = new Node('World');
        scene.addChild(world);

        const camNode = new Node('MainCamera');
        world.addChild(camNode);
        const cam = camNode.addComponent(Camera);
        cam.projection = Camera.ProjectionType.PERSPECTIVE;
        cam.fov = 45;
        cam.near = 0.03;
        cam.far = 50;
        cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        cam.clearColor = new Color(14, 20, 34, 255);
        cam.visibility = Layers.Enum.DEFAULT;
        cam.priority = 0;
        this.cameraNode = camNode;
        this.camera = cam;
        const size = view.getVisibleSize();
        const halfFovTan = Math.tan((cam.fov * Math.PI) / 360);
        this.distance = Math.max(2.2, 0.8 / (halfFovTan * (size.width / size.height)));
        this.applyOrbit();

        const sunNode = new Node('Moon');
        world.addChild(sunNode);
        sunNode.setRotationFromEuler(-48, -35, 0);
        const sun = sunNode.addComponent(DirectionalLight);
        sun.illuminance = 60000;
        sun.color = new Color(220, 232, 255, 255);
        sun.shadowEnabled = true;
        sun.shadowPcf = 2;
        sun.shadowFixedArea = true;
        sun.shadowNear = 0.1;
        sun.shadowFar = 6;
        sun.shadowOrthoSize = 1.0;
        sun.shadowBias = 0.0005;
        sun.shadowNormalBias = 0.002;
        const globals = director.getScene()!.globals;
        globals.shadows.enabled = true;
        globals.shadows.type = renderer.scene.ShadowType.ShadowMap;
        globals.shadows.shadowMapSize = 2048;
        globals.ambient.skyLightingColor = new Color(120, 145, 190, 255);
        globals.ambient.groundLightingColor = new Color(60, 66, 80, 255);

        const s = this.sim;
        const root = new Node('SnowRoot');
        world.addChild(root);
        root.setPosition(-(s.lo + s.hiX) / 2, -s.lo, -(s.lo + s.hiZ) / 2);
        this.root = root;
        const cx = (s.lo + s.hiX) / 2, cz = (s.lo + s.hiZ) / 2;
        const w = s.hiX - s.lo, l = s.hiZ - s.lo;

        this.box(world, 'Ground', [0, -0.2, 0], [12, 0.02, 12], 'stone', false, true);
        this.box(root, 'Floor', [cx, s.lo - 0.1 - 0.002, cz], [w + 2 * RIM, 0.2, l + 2 * RIM], 'stone', true, true);
        this.box(root, 'RimLeft', [s.lo - RIM / 2, s.lo + RIM_H / 2 - 0.002, cz], [RIM, RIM_H, l + 2 * RIM], 'stone', true, true);
        this.box(root, 'RimRight', [s.hiX + RIM / 2, s.lo + RIM_H / 2 - 0.002, cz], [RIM, RIM_H, l + 2 * RIM], 'stone', true, true);
        this.box(root, 'RimBack', [cx, s.lo + RIM_H / 2 - 0.002, s.lo - RIM / 2], [w, RIM_H, RIM], 'stone', true, true);
        this.box(root, 'RimFront', [cx, s.lo + RIM_H / 2 - 0.002, s.hiZ + RIM / 2], [w, RIM_H, RIM], 'stone', true, true);

        const lo = { x: s.lo, y: s.lo - 0.05, z: s.lo };
        const hi = { x: s.hiX, y: s.hiY, z: s.hiZ };
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
        this.setMaterial(this.surfaceRenderer, 'snow');
        this.surfaceRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
        this.surfaceRenderer.receiveShadow = MeshRenderer.ShadowReceivingMode.ON;

        const pointNode = new Node('SnowParticles');
        root.addChild(pointNode);
        this.pointRenderer = pointNode.addComponent(MeshRenderer);
        this.pointPositions = new Float32Array(s.capacity * 3);
        this.pointColors = new Float32Array(s.capacity * 4);
        this.pointMesh = utils.MeshUtils.createDynamicMesh(0, {
            positions: this.pointPositions, colors: this.pointColors, minPos: lo, maxPos: hi,
        }, undefined, { maxSubMeshes: 1, maxSubMeshVertices: s.capacity, maxSubMeshIndices: 0 });
        this.pointRenderer.mesh = this.pointMesh;
        const pointMaterial = new Material();
        pointMaterial.initialize({ effectAsset: pointEffect });
        pointMaterial.setProperty('pointParams', new Vec4((DX / PER_CELL) * 0.55, 0, 0, 0));
        this.pointRenderer.setSharedMaterial(pointMaterial, 0);

        for (const part of PARTS) {
            const node = new Node('HandPart');
            root.addChild(node);
            const k = SCENE.handScale;
            const len = k * Math.hypot(part.b[0] - part.a[0], part.b[1] - part.a[1], part.b[2] - part.a[2]);
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = utils.MeshUtils.createMesh(primitives.capsule(k * part.r, k * part.r, len + 2 * k * part.r, { sides: 16, heightSegments: 12 }));
            this.setMaterial(mr, 'steel');
            mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
            this.handNodes.push(node);
        }
        // The modelled gauntlet (tools/gauntlet.py) is laid out in the same hand space as PARTS.
        void loadModel('models/gauntlet').then((node) => {
            root.addChild(node);
            node.setScale(SCENE.handScale, SCENE.handScale, SCENE.handScale);
            for (const mr of node.getComponentsInChildren(MeshRenderer)) mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
            this.gauntlet = node;
            this.applyViewMode();
            this.placeHand();
        }).catch((err) => console.warn('gauntlet model missing, showing capsules', err));
        this.applyViewMode();
        this.ready = true;
        (globalThis as any).__snowView = this;
    }

    private bounds!: { lo: { x: number; y: number; z: number }; hi: { x: number; y: number; z: number } };

    private box(parent: Node, name: string, pos: number[], size: number[], material: MaterialName, cast: boolean, receive: boolean): void {
        const node = new Node(name);
        parent.addChild(node);
        node.setPosition(pos[0], pos[1], pos[2]);
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.MeshUtils.createMesh(primitives.box({ width: size[0], height: size[1], length: size[2] }));
        this.setMaterial(mr, material);
        mr.shadowCastingMode = cast ? MeshRenderer.ShadowCastingMode.ON : MeshRenderer.ShadowCastingMode.OFF;
        mr.receiveShadow = receive ? MeshRenderer.ShadowReceivingMode.ON : MeshRenderer.ShadowReceivingMode.OFF;
    }

    private setMaterial(mr: MeshRenderer, name: MaterialName): void {
        const mat = this.materials[name];
        if (mat) mr.setSharedMaterial(mat, 0);
    }

    private applyOrbit(): void {
        const yaw = (this.yaw * Math.PI) / 180;
        const pitch = (this.pitch * Math.PI) / 180;
        const c = Math.cos(pitch);
        this.cameraNode.setPosition(
            this.target.x + this.distance * c * Math.sin(yaw),
            this.target.y + this.distance * Math.sin(pitch),
            this.target.z + this.distance * c * Math.cos(yaw),
        );
        this.cameraNode.lookAt(this.target);
    }

    private applyViewMode(): void {
        this.surfaceRenderer.node.active = this.viewMode !== ViewMode.Particles;
        this.pointRenderer.node.active = this.viewMode !== ViewMode.Surface;
        // Particles view shows the collision capsules instead of the model.
        const capsules = !this.gauntlet || this.viewMode === ViewMode.Particles;
        for (const node of this.handNodes) node.active = capsules;
        if (this.gauntlet) this.gauntlet.active = !capsules;
    }

    // ------------------------------------------------------------------ loop

    update(dt: number): void {
        if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
        if (!this.ready) return;
        this.frame++;
        const s = this.sim;
        const t0 = performance.now();
        if (!this.paused) {
            if (this.settleLeft > 0) {
                // A fresh bed settles under gravity with everything awake, then goes to sleep.
                if (this.settleLeft === SETTLE_FRAMES) { s.colliders.length = 0; s.wakeAll(); }
                for (let k = 0; k < BUDGET.substeps; k++) s.step(FRAME_DT / BUDGET.substeps);
                if (--this.settleLeft === 0) {
                    s.sleepAll();
                    s.colliders.push(...this.hand.capsules);
                }
            } else {
                this.driveHand(FRAME_DT);
                stepFrame(s, this.hand, this.pose, FRAME_DT);
            }
        }
        const t1 = performance.now();
        this.simMs += (t1 - t0 - this.simMs) * 0.1;
        if (this.viewMode !== ViewMode.Particles) {
            this.mesher.splatActive(s.x, s.y, s.z, s.active, s.activeCount);
            this.mesher.extract();
        }
        const t2 = performance.now();
        this.meshMs += (t2 - t1 - this.meshMs) * 0.1;
        this.upload();
        this.placeHand();
        this.uploadMs += (performance.now() - t2 - this.uploadMs) * 0.1;

        this.hudTimer -= dt;
        if (this.hudTimer <= 0) {
            this.hudTimer = 0.25;
            this.updateHud();
        }
    }

    /** Moves the wrist toward its target with a speed limit, turning the palm toward the motion. */
    private driveHand(dt: number): void {
        const s = this.sim;
        const p = this.pose;
        if (this.sweepTime >= 0) this.scriptedSweep(dt);
        else this.handTarget.y = s.lo + (this.pressing ? DIG_Y : LIFT_Y);
        const tx = Math.min(Math.max(this.handTarget.x, s.lo + 0.02), s.hiX - 0.02);
        const tz = Math.min(Math.max(this.handTarget.z, s.lo + 0.02), s.hiZ - 0.02);
        let dx = tx - p.x, dy = this.handTarget.y - p.y, dz = tz - p.z;
        const k = Math.min(1, dt * 14);
        dx *= k; dy *= k; dz *= k;
        const d = Math.hypot(dx, dy, dz);
        const max = HAND_SPEED * dt;
        if (d > max) { dx *= max / d; dy *= max / d; dz *= max / d; }
        p.x += dx; p.y += dy; p.z += dz;
        const speed = Math.hypot(dx, dz) / dt;
        // Only turn while digging, so a lifted hand keeps its heading instead of swinging the forearm around.
        if (speed > 0.15 && p.y < s.lo + (DIG_Y + LIFT_Y) / 2) {
            const want = Math.atan2(dz, dx);
            let diff = want - p.yaw;
            diff = Math.atan2(Math.sin(diff), Math.cos(diff));
            p.yaw += diff * Math.min(1, dt * 10);
        }
    }

    /** A Lich King sweep: down into the snow at the back left, an arc to the front right, up and out. */
    private scriptedSweep(dt: number): void {
        const s = this.sim;
        const t = (this.sweepTime += dt);
        const cx = (s.lo + s.hiX) / 2, cz = (s.lo + s.hiZ) / 2;
        const start = { x: cx - 0.36, z: cz - 0.1 };
        const end = { x: cx + 0.36, z: cz + 0.1 };
        if (t < 0.6) {
            this.handTarget.set(start.x, s.lo + (t < 0.3 ? LIFT_Y : DIG_Y), start.z);
        } else if (t < 1.9) {
            const u = (t - 0.6) / 1.3;
            const e = u * u * (3 - 2 * u);
            this.handTarget.set(start.x + (end.x - start.x) * e, s.lo + DIG_Y, start.z + (end.z - start.z) * e + 0.1 * Math.sin(Math.PI * e));
        } else if (t < 2.3) {
            this.handTarget.y = s.lo + LIFT_Y;
        } else if (t < 2.9) {
            // Once clear of the snow, move back, away from the camera.
            this.handTarget.set(end.x - 0.1, s.lo + LIFT_Y, s.lo + 0.05);
        } else {
            this.sweepTime = -1;
        }
    }

    private upload(): void {
        const { lo, hi } = this.bounds;
        const s = this.sim;
        if (this.viewMode !== ViewMode.Particles && this.surfaceMesh) {
            const m = this.mesher;
            if (m.indexCount > 0) {
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
        }
        if (this.viewMode !== ViewMode.Surface && this.pointMesh) {
            const pos = this.pointPositions, col = this.pointColors;
            for (let p = 0; p < s.count; p++) {
                pos[p * 3] = s.x[p]; pos[p * 3 + 1] = s.y[p]; pos[p * 3 + 2] = s.z[p];
                // Packed snow (Jp < 1) turns blue-grey; awake snow is a little warmer so sleeping can be seen.
                const packed = Math.min(Math.max((1 - s.jp[p]) * 8, 0), 1);
                const g = 0.92 + 0.08 * ((Math.imul(p, 0x9e3779b1) >>> 24) / 255);
                const a = s.awake[p] ? 1 : 0.86;
                col[p * 4] = (0.95 - 0.3 * packed) * g * a;
                col[p * 4 + 1] = (0.97 - 0.2 * packed) * g * a;
                col[p * 4 + 2] = 1.0 * g * (s.awake[p] ? 0.88 : 1);
                col[p * 4 + 3] = 1;
            }
            this.pointMesh.updateSubMesh(0, { positions: pos, colors: col, minPos: lo, maxPos: hi });
        }
    }

    /**
     * Snow below the untouched bed top turns blue-grey with depth, so a furrow
     * reads from any angle; berms and fresh snow stay white.
     */
    private tintSurface(): Float32Array {
        const m = this.mesher, s = this.sim, bed = BEDS[SCENE.bed];
        if (this.surfaceColors.length < m.maxVertices * 4) this.surfaceColors = new Float32Array(m.maxVertices * 4);
        const col = this.surfaceColors, pos = m.positions;
        const width = s.hiX - s.lo, length = s.hiZ - s.lo;
        for (let v = 0; v < m.vertexCount; v++) {
            const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
            const top = s.lo + bedHeight(bed, (x - s.lo) / width, (z - s.lo) / length, width, length);
            const d = Math.min(Math.max((top - y - TINT_START) / TINT_DEPTH, 0), 1);
            const k = d * d * (3 - 2 * d);
            col[v * 4] = 1 - 0.42 * k;
            col[v * 4 + 1] = 1 - 0.28 * k;
            col[v * 4 + 2] = 1 - 0.06 * k;
            col[v * 4 + 3] = 1;
        }
        return col.subarray(0, m.vertexCount * 4);
    }

    private placeHand(): void {
        const q = new Quat();
        const dir = new Vec3();
        this.hand.capsules.forEach((c, i) => {
            const node = this.handNodes[i];
            if (!node) return;
            node.setPosition((c.ax + c.bx) / 2, (c.ay + c.by) / 2, (c.az + c.bz) / 2);
            dir.set(c.bx - c.ax, c.by - c.ay, c.bz - c.az).normalize();
            Quat.rotationTo(q, Vec3.UNIT_Y, dir);
            node.setRotation(q);
        });
        if (this.gauntlet) placeGauntlet(this.gauntlet, this.pose);
    }

    // ------------------------------------------------------------------ input

    private ray = new geometry.Ray();

    /** Screen point to the hand target on the picking plane just above the snow. */
    private aim(x: number, y: number): void {
        if (!this.ready) return;
        this.camera.screenPointToRay(x, y, this.ray);
        const r = this.ray;
        const planeY = PICK_Y;
        if (Math.abs(r.d.y) < 1e-4) return;
        const t = (planeY - r.o.y) / r.d.y;
        if (t <= 0) return;
        const rp = this.root.position;
        this.handTarget.x = r.o.x + r.d.x * t - rp.x;
        this.handTarget.z = r.o.z + r.d.z * t - rp.z;
    }

    private onMouseMove(event: EventMouse): void {
        if (event.getButton() === EventMouse.BUTTON_RIGHT) {
            const d = event.getDelta();
            this.yaw -= d.x * 0.3;
            this.pitch = Math.min(80, Math.max(8, this.pitch - d.y * 0.3));
            if (this.ready) this.applyOrbit();
            return;
        }
        if (!this.pressing && this.sweepTime < 0) this.aim(event.getLocationX(), event.getLocationY());
    }

    private onKey(event: EventKeyboard): void {
        switch (event.keyCode) {
            case KeyCode.KEY_R: this.reset(); break;
            case KeyCode.KEY_S: this.startSweep(); break;
            case KeyCode.KEY_V: this.cycleView(); break;
            case KeyCode.KEY_P:
            case KeyCode.SPACE: this.paused = !this.paused; break;
            case KeyCode.ARROW_LEFT: this.yaw += 8; this.applyOrbit(); break;
            case KeyCode.ARROW_RIGHT: this.yaw -= 8; this.applyOrbit(); break;
            case KeyCode.ARROW_UP: this.pitch = Math.min(80, this.pitch + 5); this.applyOrbit(); break;
            case KeyCode.ARROW_DOWN: this.pitch = Math.max(8, this.pitch - 5); this.applyOrbit(); break;
            default: return;
        }
        this.refreshButtons();
    }

    private onWheel(event: EventMouse): void {
        this.distance = Math.min(5, Math.max(0.6, this.distance * (event.getScrollY() > 0 ? 0.92 : 1.08)));
        if (this.ready) this.applyOrbit();
    }

    private startSweep(): void {
        if (this.settleLeft > 0) return;
        this.sweepTime = 0;
        this.pressing = false;
    }

    private cycleView(): void {
        this.viewMode = (this.viewMode + 1) % VIEW_NAMES.length;
        if (this.ready) this.applyViewMode();
    }

    private buildUi(root: Node): void {
        const canvas = ensureCanvas(root).node;
        const size = view.getVisibleSize();
        // Full-screen pad behind the HUD: one finger drives the hand, two fingers orbit and pinch.
        const pad = new Node('HandPad');
        pad.layer = canvas.layer;
        canvas.addChild(pad);
        pad.addComponent(UITransform).setContentSize(size.width * 4, size.height * 4);
        pad.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
            if (event.getAllTouches().length > 1 || this.sweepTime >= 0) return;
            this.pressing = true;
            this.aim(event.getLocationX(), event.getLocationY());
        });
        pad.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
            const touches = event.getAllTouches();
            if (touches.length >= 2) {
                this.pressing = false;
                const a = touches[0].getLocation();
                const b = touches[1].getLocation();
                const spread = Math.hypot(a.x - b.x, a.y - b.y);
                if (this.pinchDistance > 1 && spread > 1) {
                    this.distance = Math.min(5, Math.max(0.6, this.distance * (this.pinchDistance / spread)));
                }
                this.pinchDistance = spread;
                const d = event.getUIDelta();
                this.yaw -= d.x * 0.2;
                this.pitch = Math.min(80, Math.max(8, this.pitch - d.y * 0.2));
                if (this.ready) this.applyOrbit();
                return;
            }
            if (this.pressing) this.aim(event.getLocationX(), event.getLocationY());
        });
        const end = () => { this.pressing = false; this.pinchDistance = 0; };
        pad.on(Node.EventType.TOUCH_END, end);
        pad.on(Node.EventType.TOUCH_CANCEL, end);

        const tap = (action: () => void) => () => { action(); this.refreshButtons(); this.updateHud(); };
        this.hud = new Hud(canvas, [
            { id: 'reset', onTap: tap(() => this.reset()) },
            { id: 'sweep', onTap: tap(() => this.startSweep()) },
            { id: 'view', onTap: tap(() => this.cycleView()) },
            { id: 'pause', onTap: tap(() => { this.paused = !this.paused; }) },
        ]);
        this.refreshButtons();
    }

    private refreshButtons(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('reset', 'New snow');
        hud.setButton('sweep', 'Sweep', this.sweepTime >= 0);
        hud.setButton('view', VIEW_NAMES[this.viewMode]);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    private updateHud(): void {
        const s = this.sim;
        const m = this.mesher;
        this.hud?.setStatus([
            `FPS ${this.fps.toFixed(0)} · sim ${this.simMs.toFixed(1)} ms · surface ${this.meshMs.toFixed(1)} ms${this.paused ? ' · paused' : ''}`,
            `${s.count} snow particles · ${s.activeCount} awake · ${BUDGET.substeps} substeps`,
            `MPM grid ${s.nx}×${s.ny}×${s.nz} (${(s.dx * 100).toFixed(0)} cm) · surface ${m.resolution}, ${(m.indexCount / 3) | 0} tris`,
            this.settleLeft > 0 ? `settling the snow… ${this.settleLeft}` : s.blewUp ? 'step hit the speed cap' : 'drag on the snow to dig · right drag / two fingers orbit',
            'S sweep · R new snow · V view',
        ]);
        (globalThis as any).__snow = {
            fps: this.fps, simMs: this.simMs, meshMs: this.meshMs, uploadMs: this.uploadMs,
            particles: s.count, awake: s.activeCount, triangles: m.indexCount / 3,
            settling: this.settleLeft, sweeping: this.sweepTime >= 0, blewUp: s.blewUp, frame: this.frame,
            hand: { ...this.pose },
        };
    }
}
