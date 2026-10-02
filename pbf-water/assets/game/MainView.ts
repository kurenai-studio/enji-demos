import {
    _decorator,
    Camera,
    Color,
    Component,
    director,
    DirectionalLight,
    EventKeyboard,
    EventMouse,
    EventTouch,
    Graphics,
    input,
    Input,
    KeyCode,
    Label,
    Layers,
    Material,
    Mesh,
    MeshRenderer,
    Node,
    primitives,
    renderer,
    resources,
    UITransform,
    utils,
    Vec3,
    view,
} from 'cc';
import type { IView } from '../enji/IView';
import { addLabel } from '../enji/helpers';
import { PBFSolver } from './water/PBFSolver';
import { SurfaceMesher } from './water/SurfaceMesher';
import { ParticleMesh } from './water/ParticleMesh';

const { ccclass } = _decorator;

// Tank interior in tank-local metres. The tank node pivots at its floor centre.
const TANK_MIN: [number, number, number] = [-1, 0, -0.45];
const TANK_MAX: [number, number, number] = [1, 1.3, 0.45];
const KERNEL_H = 0.1;
const SPACING = 0.05;
const DAM = { x1: -0.2, y1: 0.95 };
const DROP_SIDE = 8;
const EXTRA_BLOCKS = 3;
const SHAKE_AMPLITUDE = 0.12;
const SHAKE_HZ = 1.1;
const TILTS = [0, 12, -12];
const ITERATION_LEVELS = [2, 3, 4, 6];
const MATERIALS = ['water', 'glass', 'tank-base', 'ground', 'particles'] as const;
type MaterialName = (typeof MATERIALS)[number];

enum ViewMode {
    Surface = 0,
    Particles = 1,
    Both = 2,
}
const VIEW_NAMES = ['Surface', 'Particles', 'Both'];

interface HudButton {
    label: Label;
    text: () => string;
}

@ccclass('MainView')
export class MainView extends Component implements IView {
    private solver!: PBFSolver;
    private mesher!: SurfaceMesher;
    private particles!: ParticleMesh;
    private materials: Partial<Record<MaterialName, Material>> = {};

    private world!: Node;
    private tank!: Node;
    private walls!: Node;
    private cameraNode!: Node;
    private waterRenderer!: MeshRenderer;
    private particleRenderer!: MeshRenderer;
    private waterMesh: Mesh | null = null;
    private particleMesh: Mesh | null = null;
    private ready = false;

    private yaw = -28;
    private pitch = 24;
    private distance = 4.2;
    private readonly target = new Vec3(0, 0.45, 0);

    private paused = false;
    private viewMode = ViewMode.Surface;
    private shaking = false;
    private shakeAmp = 0;
    private shakePhase = 0;
    private tiltIndex = 0;
    private tilt = 0;
    private iterationIndex = 1;
    private vorticityOn = false;
    private simTime = 0;

    private hud!: Label;
    private buttons: HudButton[] = [];
    private fps = 60;
    private simMs = 0;
    private meshMs = 0;
    private uploadMs = 0;
    private hudTimer = 0;
    private frame = 0;

    bind(root: Node): void {
        const scene = root.scene!;
        // The template Canvas camera clears colour; the 3D camera must own the clear.
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
        }

        this.solver = new PBFSolver(this.initialCount() + EXTRA_BLOCKS * DROP_SIDE ** 3, KERNEL_H, SPACING, { min: TANK_MIN, max: TANK_MAX });
        this.solver.iterations = ITERATION_LEVELS[this.iterationIndex];
        this.solver.vorticity = 0;
        this.resetDam();
        this.mesher = new SurfaceMesher(
            [TANK_MIN[0] - SHAKE_AMPLITUDE, TANK_MIN[1], TANK_MIN[2]],
            [TANK_MAX[0] + SHAKE_AMPLITUDE, TANK_MAX[1] + 0.35, TANK_MAX[2]],
            0.045,
            0.09,
        );
        this.particles = new ParticleMesh(this.solver.capacity, SPACING * 0.45);

        this.buildUi(root);
        input.on(Input.EventType.KEY_DOWN, this.onKey, this);
        input.on(Input.EventType.MOUSE_WHEEL, this.onWheel, this);

        let pending = MATERIALS.length;
        for (const name of MATERIALS) {
            resources.load(`materials/${name}`, Material, (err, mat) => {
                if (err) console.error(`material ${name} failed to load: ${err.message}`);
                else this.materials[name] = mat;
                if (--pending === 0) this.buildWorld(scene);
            });
        }
    }

    onDestroy(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKey, this);
        input.off(Input.EventType.MOUSE_WHEEL, this.onWheel, this);
    }

    private initialCount(): number {
        const s = SPACING;
        const nx = Math.floor((DAM.x1 - TANK_MIN[0]) / s);
        const ny = Math.floor((DAM.y1 - TANK_MIN[1]) / s);
        const nz = Math.floor((TANK_MAX[2] - TANK_MIN[2]) / s);
        return nx * ny * nz;
    }

    // ------------------------------------------------------------------ world

    private buildWorld(scene: Node): void {
        const world = new Node('World');
        world.layer = Layers.Enum.DEFAULT;
        scene.addChild(world);
        this.world = world;

        const camNode = new Node('MainCamera');
        world.addChild(camNode);
        const cam = camNode.addComponent(Camera);
        cam.projection = Camera.ProjectionType.PERSPECTIVE;
        cam.fov = 45;
        cam.near = 0.05;
        cam.far = 100;
        cam.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        cam.clearColor = new Color(24, 28, 38, 255);
        cam.visibility = Layers.Enum.DEFAULT;
        cam.priority = 0;
        this.cameraNode = camNode;
        const size = view.getVisibleSize();
        const halfFovTan = Math.tan((cam.fov * Math.PI) / 360);
        // Keep the 2.6 m wide tank in view on portrait viewports as well.
        this.distance = Math.max(4.2, 1.55 / (halfFovTan * (size.width / size.height)));
        this.applyOrbit();

        const sunNode = new Node('Sun');
        world.addChild(sunNode);
        sunNode.setRotationFromEuler(-42, -40, 0);
        const sun = sunNode.addComponent(DirectionalLight);
        sun.illuminance = 65000;
        sun.shadowEnabled = true;
        sun.shadowPcf = 2;
        sun.shadowFixedArea = false;
        sun.shadowDistance = 12;
        sun.shadowBias = 0.002;
        sun.shadowNormalBias = 0.01;
        const shadows = director.getScene()!.globals.shadows;
        shadows.enabled = true;
        shadows.type = renderer.scene.ShadowType.ShadowMap;
        shadows.shadowMapSize = 2048;

        this.box(world, 'Ground', [0, -0.36, 0], [14, 0.02, 14], 'ground', false, true);

        const tank = new Node('Tank');
        world.addChild(tank);
        this.tank = tank;
        const w = TANK_MAX[0] - TANK_MIN[0];
        const h = TANK_MAX[1] - TANK_MIN[1];
        const d = TANK_MAX[2] - TANK_MIN[2];
        const t = 0.02;
        this.box(tank, 'Base', [0, -0.175, 0], [w + 2 * SHAKE_AMPLITUDE + 0.3, 0.35, d + 0.3], 'tank-base', true, true);

        const walls = new Node('Walls');
        tank.addChild(walls);
        this.walls = walls;
        this.box(walls, 'WallLeft', [TANK_MIN[0] - t / 2, h / 2, 0], [t, h, d + 2 * t], 'glass', false, false);
        this.box(walls, 'WallRight', [TANK_MAX[0] + t / 2, h / 2, 0], [t, h, d + 2 * t], 'glass', false, false);
        this.box(walls, 'WallBack', [0, h / 2, TANK_MIN[2] - t / 2], [w, h, t], 'glass', false, false);
        this.box(walls, 'WallFront', [0, h / 2, TANK_MAX[2] + t / 2], [w, h, t], 'glass', false, false);

        const lo = { x: TANK_MIN[0] - SHAKE_AMPLITUDE - 0.2, y: -0.1, z: TANK_MIN[2] - 0.2 };
        const hi = { x: TANK_MAX[0] + SHAKE_AMPLITUDE + 0.2, y: TANK_MAX[1] + 0.6, z: TANK_MAX[2] + 0.2 };

        const waterNode = new Node('WaterSurface');
        tank.addChild(waterNode);
        this.waterRenderer = waterNode.addComponent(MeshRenderer);
        this.waterMesh = utils.MeshUtils.createDynamicMesh(0, this.placeholderGeometry(false, lo, hi), undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: this.mesher.maxVertices,
            maxSubMeshIndices: this.mesher.maxIndices,
        });
        this.waterRenderer.mesh = this.waterMesh;
        this.setMaterial(this.waterRenderer, 'water');
        // Its bottom is coplanar with the tank base, so a water shadow shows as acne streaks there.
        this.waterRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        this.waterRenderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;

        const particleNode = new Node('Particles');
        tank.addChild(particleNode);
        this.particleRenderer = particleNode.addComponent(MeshRenderer);
        this.particleMesh = utils.MeshUtils.createDynamicMesh(0, this.placeholderGeometry(true, lo, hi), undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: this.particles.capacity * 6,
            maxSubMeshIndices: this.particles.capacity * 24,
        });
        this.particleRenderer.mesh = this.particleMesh;
        this.setMaterial(this.particleRenderer, 'particles');
        this.particleRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;

        this.bounds = { lo, hi };
        this.applyViewMode();
        this.ready = true;
        (globalThis as any).__waterView = this;
    }

    private bounds!: { lo: { x: number; y: number; z: number }; hi: { x: number; y: number; z: number } };

    private placeholderGeometry(withColors: boolean, lo: Vec3Like, hi: Vec3Like): primitives.IDynamicGeometry {
        const geometry: primitives.IDynamicGeometry = {
            positions: new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0]),
            normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
            indices32: new Uint32Array([0, 1, 2]),
            minPos: lo,
            maxPos: hi,
        };
        if (withColors) geometry.colors = new Float32Array(12).fill(1);
        return geometry;
    }

    private box(parent: Node, name: string, pos: number[], size: number[], material: MaterialName, cast: boolean, receive: boolean): MeshRenderer {
        const node = new Node(name);
        parent.addChild(node);
        node.setPosition(pos[0], pos[1], pos[2]);
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = utils.MeshUtils.createMesh(primitives.box({ width: size[0], height: size[1], length: size[2] }));
        this.setMaterial(mr, material);
        mr.shadowCastingMode = cast ? MeshRenderer.ShadowCastingMode.ON : MeshRenderer.ShadowCastingMode.OFF;
        mr.receiveShadow = receive ? MeshRenderer.ShadowReceivingMode.ON : MeshRenderer.ShadowReceivingMode.OFF;
        return mr;
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
        this.waterRenderer.node.active = this.viewMode !== ViewMode.Particles;
        this.particleRenderer.node.active = this.viewMode !== ViewMode.Surface;
    }

    // ------------------------------------------------------------------ loop

    update(dt: number): void {
        if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
        if (!this.ready) return;
        this.frame++;
        const step = Math.min(dt, 1 / 45);
        const s = this.solver;

        if (!this.paused) {
            this.simTime += step;
            // Shake: the x walls oscillate; amplitude eases in/out when toggled.
            const targetAmp = this.shaking ? SHAKE_AMPLITUDE : 0;
            this.shakeAmp += (targetAmp - this.shakeAmp) * Math.min(1, step * 3);
            this.shakePhase += step * SHAKE_HZ * Math.PI * 2;
            s.wallOffsetX = this.shakeAmp * Math.sin(this.shakePhase);
            // Tilt: rotate the tank; gravity expressed in tank space follows.
            const targetTilt = TILTS[this.tiltIndex];
            this.tilt += (targetTilt - this.tilt) * Math.min(1, step * 2.5);
            const rad = (this.tilt * Math.PI) / 180;
            s.gravityX = -9.8 * Math.sin(rad);
            s.gravityY = -9.8 * Math.cos(rad);

            const t0 = performance.now();
            s.step(step);
            this.simMs += (performance.now() - t0 - this.simMs) * 0.1;
        }
        this.tank.setRotationFromEuler(0, 0, this.tilt);
        this.walls.setPosition(s.wallOffsetX, 0, 0);

        const t1 = performance.now();
        if (this.viewMode !== ViewMode.Particles) {
            const m = this.mesher;
            m.splat(s.x, s.y, s.z, s.count,
                TANK_MIN[0] + s.wallOffsetX, TANK_MIN[1], TANK_MIN[2],
                TANK_MAX[0] + s.wallOffsetX, TANK_MAX[1] + 0.35, TANK_MAX[2]);
            m.blur();
            m.extract();
        }
        if (this.viewMode !== ViewMode.Surface) {
            this.particles.update(s.x, s.y, s.z, s.vx, s.vy, s.vz, s.count);
        }
        const t2 = performance.now();
        this.meshMs += (t2 - t1 - this.meshMs) * 0.1;
        this.upload();
        this.uploadMs += (performance.now() - t2 - this.uploadMs) * 0.1;

        this.hudTimer -= dt;
        if (this.hudTimer <= 0) {
            this.hudTimer = 0.25;
            this.updateHud();
        }
    }

    private upload(): void {
        const { lo, hi } = this.bounds;
        if (this.viewMode !== ViewMode.Particles && this.waterMesh) {
            const m = this.mesher;
            if (m.indexCount > 0) {
                const uploadCount = this.clearStaleIndices(m.indices, m.indexCount);
                this.waterMesh.updateSubMesh(0, {
                    positions: m.positions.subarray(0, m.vertexCount * 3),
                    normals: m.normals.subarray(0, m.vertexCount * 3),
                    indices32: m.indices.subarray(0, uploadCount),
                    minPos: lo,
                    maxPos: hi,
                });
                this.syncDrawRange(this.waterRenderer, m.indexCount);
            }
        }
        if (this.viewMode !== ViewMode.Surface && this.particleMesh) {
            const p = this.particles;
            this.particleMesh.updateSubMesh(0, {
                positions: p.positions.subarray(0, p.vertexCount * 3),
                normals: p.normals.subarray(0, p.vertexCount * 3),
                colors: p.colors.subarray(0, p.vertexCount * 4),
                indices32: p.indices.subarray(0, p.indexCount),
                minPos: lo,
                maxPos: hi,
            });
            this.syncDrawRange(this.particleRenderer, p.indexCount);
        }
    }

    private uploadedWaterIndices = 0;

    /**
     * Enji's preview runtime draws the whole preallocated index buffer of a dynamic mesh
     * (the sub-model input assembler ignores the updated draw range), so indices left from a
     * larger earlier frame would render as streaks. Zero that stale tail and upload it too;
     * returns how many indices to upload.
     */
    private clearStaleIndices(indices: Uint32Array, count: number): number {
        const previous = this.uploadedWaterIndices;
        this.uploadedWaterIndices = count;
        if (previous <= count) return count;
        indices.fill(0, count, previous);
        return previous;
    }

    private syncDrawRange(mr: MeshRenderer, indexCount: number): void {
        const ia = mr.model?.subModels[0]?.inputAssembler;
        if (ia && ia.indexCount !== indexCount) ia.indexCount = indexCount;
    }

    // ------------------------------------------------------------------ actions

    private resetDam(): void {
        const s = this.solver;
        s.count = 0;
        s.addBlock(TANK_MIN[0], TANK_MIN[1], TANK_MIN[2], DAM.x1, DAM.y1, TANK_MAX[2]);
    }

    private dropBlock(): void {
        const side = DROP_SIDE * SPACING;
        const x0 = 0.25 + (Math.random() - 0.5) * 0.4;
        const z0 = -side / 2 + (Math.random() - 0.5) * 0.2;
        this.solver.dropBlock(DROP_SIDE, x0, 0.95, z0, -1.5);
    }

    private toggleShake(): void {
        this.shaking = !this.shaking;
    }

    private cycleTilt(): void {
        this.tiltIndex = (this.tiltIndex + 1) % TILTS.length;
    }

    private cycleView(): void {
        this.viewMode = (this.viewMode + 1) % VIEW_NAMES.length;
        if (this.ready) this.applyViewMode();
    }

    private cycleIterations(): void {
        this.iterationIndex = (this.iterationIndex + 1) % ITERATION_LEVELS.length;
        this.solver.iterations = ITERATION_LEVELS[this.iterationIndex];
    }

    private toggleVorticity(): void {
        this.vorticityOn = !this.vorticityOn;
        this.solver.vorticity = this.vorticityOn ? 0.0004 : 0;
    }

    private onKey(event: EventKeyboard): void {
        switch (event.keyCode) {
            case KeyCode.KEY_R: this.resetDam(); break;
            case KeyCode.KEY_S: this.toggleShake(); break;
            case KeyCode.KEY_T: this.cycleTilt(); break;
            case KeyCode.KEY_D: this.dropBlock(); break;
            case KeyCode.KEY_V: this.cycleView(); break;
            case KeyCode.KEY_P:
            case KeyCode.SPACE: this.paused = !this.paused; break;
            case KeyCode.KEY_I: this.cycleIterations(); break;
            case KeyCode.KEY_O: this.toggleVorticity(); break;
            default: return;
        }
        this.refreshButtons();
        this.updateHud();
    }

    private onWheel(event: EventMouse): void {
        this.distance = Math.min(12, Math.max(1.8, this.distance * (event.getScrollY() > 0 ? 0.92 : 1.08)));
        if (this.ready) this.applyOrbit();
    }

    // ------------------------------------------------------------------ UI

    private buildUi(root: Node): void {
        const size = view.getVisibleSize();
        const halfW = size.width / 2;
        const halfH = size.height / 2;

        // Full-screen pad behind the HUD: dragging it orbits the camera.
        const pad = new Node('OrbitPad');
        pad.layer = root.layer;
        root.addChild(pad);
        pad.addComponent(UITransform).setContentSize(size.width, size.height);
        pad.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
            const delta = event.getUIDelta();
            this.yaw -= delta.x * 0.3;
            this.pitch = Math.min(80, Math.max(-5, this.pitch - delta.y * 0.3));
            if (this.ready) this.applyOrbit();
        });

        const panel = new Node('HudPanel');
        panel.layer = root.layer;
        root.addChild(panel);
        panel.addComponent(UITransform);
        const g = panel.addComponent(Graphics);
        g.fillColor = new Color(0, 0, 0, 130);
        g.roundRect(-halfW + 8, halfH - 8 - 208, 390, 208, 8);
        g.fill();

        this.hud = addLabel(root, '', { name: 'Hud', fontSize: 17, color: new Color(230, 240, 255, 255) });
        this.hud.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.hud.verticalAlign = Label.VerticalAlign.TOP;
        this.hud.lineHeight = 21;
        this.hud.node.getComponent(UITransform)!.setAnchorPoint(0, 1);
        this.hud.node.setPosition(-halfW + 18, halfH - 14, 0);

        const bar = new Node('ButtonBar');
        bar.layer = root.layer;
        root.addChild(bar);
        bar.setPosition(0, -halfH + 34, 0);
        const defs: [string, () => string, () => void][] = [
            ['R', () => 'Dam break', () => this.resetDam()],
            ['S', () => (this.shaking ? 'Shake on' : 'Shake off'), () => this.toggleShake()],
            ['T', () => `Tilt ${TILTS[this.tiltIndex]}\u00b0`, () => this.cycleTilt()],
            ['D', () => 'Drop block', () => this.dropBlock()],
            ['V', () => VIEW_NAMES[this.viewMode], () => this.cycleView()],
            ['I', () => `Iter ${ITERATION_LEVELS[this.iterationIndex]}`, () => this.cycleIterations()],
            ['O', () => (this.vorticityOn ? 'Vort on' : 'Vort off'), () => this.toggleVorticity()],
            ['P', () => (this.paused ? 'Resume' : 'Pause'), () => { this.paused = !this.paused; }],
        ];
        const width = Math.min(112, (size.width - 20) / defs.length - 6);
        const total = defs.length * (width + 6) - 6;
        defs.forEach(([key, text, action], index) => {
            const node = new Node(`Btn${key}`);
            node.layer = root.layer;
            bar.addChild(node);
            node.setPosition(-total / 2 + width / 2 + index * (width + 6), 0, 0);
            node.addComponent(UITransform).setContentSize(width, 42);
            const bg = node.addComponent(Graphics);
            bg.fillColor = new Color(18, 26, 44, 220);
            bg.strokeColor = new Color(110, 170, 255, 210);
            bg.lineWidth = 2;
            bg.roundRect(-width / 2, -21, width, 42, 9);
            bg.fill();
            bg.stroke();
            const label = addLabel(node, '', { name: 'Text', fontSize: 15 });
            label.lineHeight = 17;
            const button: HudButton = { label, text: () => `${text()} [${key}]` };
            node.on(Node.EventType.TOUCH_END, () => {
                action();
                this.refreshButtons();
                this.updateHud();
            });
            this.buttons.push(button);
        });
        this.refreshButtons();
    }

    private refreshButtons(): void {
        for (const b of this.buttons) b.label.string = b.text();
    }

    private updateHud(): void {
        const s = this.solver;
        const m = this.mesher;
        const tris = this.viewMode === ViewMode.Particles ? this.particles.indexCount / 3 : m.indexCount / 3;
        this.hud.string = [
            `PBF water 3D   ${this.paused ? '[PAUSED]' : ''}`,
            `FPS ${this.fps.toFixed(1)}   particles ${s.count}`,
            `solver iters ${s.iterations}  substeps ${s.substeps}  vorticity ${this.vorticityOn ? 'on' : 'off'}`,
            `sim ${this.simMs.toFixed(1)} ms   mesh ${this.meshMs.toFixed(1)} ms   upload ${this.uploadMs.toFixed(1)} ms`,
            `neighbours ${s.avgNeighbors.toFixed(1)}   density err avg ${(s.avgDensityError * 100).toFixed(1)}% max ${(s.densityError * 100).toFixed(0)}%`,
            `surface nets grid ${m.resolution}   tris ${tris | 0}`,
            `view ${VIEW_NAMES[this.viewMode]}   tilt ${this.tilt.toFixed(0)}\u00b0   shake ${this.shaking ? 'on' : 'off'}`,
            `drag: orbit   wheel: zoom`,
        ].join('\n');
        (globalThis as any).__water = {
            fps: this.fps,
            particles: s.count,
            iterations: s.iterations,
            simMs: this.simMs,
            meshMs: this.meshMs,
            uploadMs: this.uploadMs,
            grid: m.resolution,
            vertices: m.vertexCount,
            triangles: m.indexCount / 3,
            densityError: s.densityError,
            avgDensityError: s.avgDensityError,
            neighbors: s.avgNeighbors,
            view: VIEW_NAMES[this.viewMode],
            shaking: this.shaking,
            tilt: this.tilt,
            paused: this.paused,
            ready: this.ready,
            frame: this.frame,
        };
    }
}

type Vec3Like = { x: number; y: number; z: number };
