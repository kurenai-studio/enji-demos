import { Material, Mesh, MeshRenderer, Node, primitives, sys, utils, Vec3, Vec4 } from 'cc';
import { loadEffect, updateDynamicMesh } from '../../enji/helpers';
import type { PdSolver } from './ProjectiveDynamics';
import { GROUP_BEND, GROUP_SHEAR, GROUP_STRETCH, XpbdCloth } from './XpbdCloth';

export interface QualityLevel {
    name: string;
    segments: number;
    substeps: number;
}

export const QUALITY: readonly QualityLevel[] = [
    { name: 'Low', segments: 20, substeps: 8 },
    { name: 'Medium', segments: 32, substeps: 10 },
    { name: 'High', segments: 48, substeps: 12 },
    { name: 'Ultra', segments: 64, substeps: 15 },
];

export interface Stiffness {
    name: string;
    stretch: number;
    shear: number;
    bend: number;
}

/** Compliance presets in m/N; larger is softer. */
export const STIFFNESS: readonly Stiffness[] = [
    { name: 'silk', stretch: 0, shear: 1e-3, bend: 5e-2 },
    { name: 'cotton', stretch: 0, shear: 1e-4, bend: 5e-3 },
    { name: 'leather', stretch: 0, shear: 1e-5, bend: 1e-4 },
    { name: 'rubber', stretch: 0.15, shear: 0.15, bend: 0.5 },
];
const COTTON = 1;
const RUBBER = 3;

/** Multipliers of the quality level's substep count. */
export const SUBSTEP_SCALES: readonly number[] = [0.5, 1, 2, 4];

export type Preset = 'drape' | 'curtain' | 'compare' | 'pd';
export const PRESETS: readonly Preset[] = ['drape', 'curtain', 'compare', 'pd'];

export interface PdSetting {
    name: string;
    solver: PdSolver;
    /** Implicit Euler steps per frame. */
    steps: number;
    iterations: number;
}

/** What the substep button cycles through in the PD scene; the XPBD flap keeps the quality level's substeps. */
export const PD_SETTINGS: readonly PdSetting[] = [
    { name: 'direct 1×5', solver: 'direct', steps: 1, iterations: 5 },
    { name: 'direct 5×2', solver: 'direct', steps: 5, iterations: 2 },
    { name: 'Chebyshev 1×10', solver: 'chebyshev', steps: 1, iterations: 10 },
    { name: 'Chebyshev 2×20', solver: 'chebyshev', steps: 2, iterations: 20 },
];

const CLOTH_SIZE = 1.6;
const CLOTH_MASS = 0.4;
const COMPARE_SIZE = 1.1;
const COMPARE_HEIGHT = 2.0;
const COMPARE_OFFSET = 0.65;
/** PD scene: flaps held along their back edge, starting flat, PD above XPBD (portrait screens stack better than they sit side by side). */
const FLAP_HEIGHTS = [2.75, 1.45];
const PD_MAX_SEGMENTS = 32;
const SPHERE_RADIUS = 0.45;
const LIGHT = new Vec4(0.45, 0.8, 0.4, 0);
/** Auto quality drops a level when the solver averages more than this per frame. */
const AUTO_BUDGET_MS = 5;
/** ...and frames take longer than this (below ~55 FPS). */
const AUTO_SLOW_FRAME_MS = 18;
const AUTO_WINDOW_FRAMES = 90;

interface ClothBody {
    sim: XpbdCloth;
    renderer: MeshRenderer;
    geometry: primitives.IDynamicGeometry;
    minPos: Vec3;
    maxPos: Vec3;
    /** Solver time for this cloth, smoothed, in ms. */
    ms: number;
}

export interface ClothPick {
    body: number;
    index: number;
    t: number;
}

/**
 * Cloths, collider sphere and ground; owns the solvers, the dynamic meshes they
 * stream into, the scene presets and the quality level. The compare preset
 * hangs a PBD sheet (blue) next to an XPBD sheet (red); the PD preset swings a
 * Projective Dynamics flap (green) next to an XPBD flap (red). Call
 * `update(dt)` once per frame.
 */
export class ClothScene {
    preset: Preset = 'drape';
    quality: number;
    /** When set, the quality drops by itself while the solver is over budget. */
    autoQuality = true;
    stiffness = COTTON;
    substepScale = 1;
    /** Index into PD_SETTINGS for the PD flap. */
    pdSetting = 0;
    selfCollision = true;
    paused = false;
    wind = false;
    /** Solver + normals + mesh upload time, smoothed, in ms. */
    simMs = 0;

    private bodies: ClothBody[] = [];
    private frameMs = 16.7;
    private readonly parent: Node;
    private readonly renderers: MeshRenderer[] = [];
    private readonly sphereNode: Node;
    private overBudgetFrames = 0;
    private time = 0;
    private grabBody = -1;
    private readonly sphereUniform = new Vec4();
    private readonly pickScratch = { index: -1, t: 0 };

    private constructor(
        parent: Node,
        private readonly clothMaterials: Readonly<Record<'xpbd' | 'pbd' | 'pd', Material>>,
        private readonly groundMaterial: Material,
        sphereMaterial: Material,
    ) {
        this.parent = parent;
        this.quality = sys.isMobile ? 1 : 2;

        const ground = new Node('Ground');
        parent.addChild(ground);
        ground.addComponent(MeshRenderer).mesh = utils.MeshUtils.createMesh(primitives.plane({ width: 40, length: 40, widthSegments: 1, lengthSegments: 1 }));
        ground.getComponent(MeshRenderer)!.setSharedMaterial(groundMaterial, 0);

        this.sphereNode = new Node('Sphere');
        parent.addChild(this.sphereNode);
        const sphereRenderer = this.sphereNode.addComponent(MeshRenderer);
        sphereRenderer.mesh = utils.MeshUtils.createMesh(primitives.sphere(1, { segments: 32 }));
        sphereRenderer.setSharedMaterial(sphereMaterial, 0);

        this.rebuild();
    }

    static async create(parent: Node): Promise<ClothScene> {
        const [clothEffect, litEffect] = await Promise.all([loadEffect('effects/xpbd-cloth'), loadEffect('effects/xpbd-lit')]);
        const xpbd = new Material();
        xpbd.initialize({ effectAsset: clothEffect });
        xpbd.setProperty('lightDir', LIGHT);
        const pbd = new Material();
        pbd.initialize({ effectAsset: clothEffect });
        pbd.setProperty('lightDir', LIGHT);
        pbd.setProperty('frontColor', new Vec4(0.16, 0.42, 0.85, 1));
        pbd.setProperty('backColor', new Vec4(0.7, 0.82, 0.95, 1));
        const pd = new Material();
        pd.initialize({ effectAsset: clothEffect });
        pd.setProperty('lightDir', LIGHT);
        pd.setProperty('frontColor', new Vec4(0.18, 0.62, 0.36, 1));
        pd.setProperty('backColor', new Vec4(0.75, 0.92, 0.78, 1));
        const ground = new Material();
        ground.initialize({ effectAsset: litEffect, defines: { USE_GRID: true } });
        ground.setProperty('lightDir', LIGHT);
        ground.setProperty('baseColor', new Vec4(0.52, 0.54, 0.58, 1));
        const sphere = new Material();
        sphere.initialize({ effectAsset: litEffect });
        sphere.setProperty('lightDir', LIGHT);
        sphere.setProperty('baseColor', new Vec4(0.2, 0.5, 1.0, 1));
        return new ClothScene(parent, { xpbd, pbd, pd }, ground, sphere);
    }

    get level(): QualityLevel {
        return QUALITY[this.quality];
    }

    get substeps(): number {
        return Math.max(2, Math.round(this.level.substeps * SUBSTEP_SCALES[this.substepScale]));
    }

    get sphere(): XpbdCloth['sphere'] {
        return this.bodies[0].sim.sphere;
    }

    /** Particles per side of the cloths in the scene (the PD scene caps the quality level's). */
    get segments(): number {
        return this.bodies[0].sim.segments;
    }

    get particleCount(): number {
        return this.bodies.reduce((sum, b) => sum + b.sim.count, 0);
    }

    get constraintCount(): number {
        return this.bodies.reduce((sum, b) => sum + b.sim.constraintCount, 0);
    }

    /** Compare preset only: how far the bottom edge of the PBD and XPBD sheets hangs below its rest height, in metres. */
    get sag(): { pbd: number; xpbd: number } | null {
        if (this.preset !== 'compare') return null;
        const bottom = (sim: XpbdCloth) => {
            const n = sim.segments;
            return COMPARE_HEIGHT - COMPARE_SIZE - sim.pos[((n - 1) * n + (n >> 1)) * 3 + 1];
        };
        return { pbd: bottom(this.bodies[0].sim), xpbd: bottom(this.bodies[1].sim) };
    }

    /** Recreates the cloths for the current preset and quality level. */
    rebuild(): void {
        // The banded direct solve grows with the cube of the grid side, so the PD scene stops at Medium.
        const n = this.preset === 'pd' ? Math.min(this.level.segments, PD_MAX_SEGMENTS) : this.level.segments;
        this.releaseGrab();
        let sims: XpbdCloth[];
        if (this.preset === 'compare') {
            const topEdge = Array.from({ length: n }, (_, col) => [col, 0] as const);
            const sheet = (offsetX: number) => new XpbdCloth({
                segments: n,
                size: COMPARE_SIZE,
                mass: CLOTH_MASS,
                orientation: 'vertical',
                height: COMPARE_HEIGHT,
                pins: topEdge,
                tethers: false,
                offsetX,
            });
            sims = [sheet(-COMPARE_OFFSET), sheet(COMPARE_OFFSET)];
            sims[0].method = 'pbd';
        } else if (this.preset === 'pd') {
            // Held along the back edge (row 0), the flaps fall and swing through the vertical.
            const backEdge = Array.from({ length: n }, (_, col) => [col, 0] as const);
            const FLAP_OFFSETS = [-0.55, 0.55];
            const flap = (i: number) => new XpbdCloth({
                segments: n,
                size: COMPARE_SIZE,
                mass: CLOTH_MASS,
                orientation: 'horizontal',
                height: FLAP_HEIGHTS[i],
                pins: backEdge,
                tethers: false,
                offsetX: FLAP_OFFSETS[i],
            });
            sims = [flap(0), flap(1)];
            sims[0].method = 'pd';
        } else {
            const curtain = this.preset === 'curtain';
            sims = [new XpbdCloth({
                segments: n,
                size: CLOTH_SIZE,
                mass: CLOTH_MASS,
                orientation: curtain ? 'vertical' : 'horizontal',
                height: curtain ? 2.0 : 1.5,
                pins: curtain ? [[0, 0], [n - 1, 0]] : [],
            })];
        }
        for (const sim of sims) {
            sim.sphere.r = SPHERE_RADIUS;
            if (this.preset === 'compare') sim.placeSphere(0, SPHERE_RADIUS, -1.1);
            else if (this.preset === 'pd') sim.placeSphere(0, SPHERE_RADIUS, 8);
            else if (this.preset === 'curtain') sim.placeSphere(-0.3, SPHERE_RADIUS, 1.1);
            else sim.placeSphere(0, 0.6, 0);
        }

        this.bodies = sims.map((sim, i) => this.makeBody(sim, i));
        for (let i = sims.length; i < this.renderers.length; i++) this.renderers[i].node.active = false;
        this.applySettings();
        this.overBudgetFrames = 0;
        this.syncSphere();
        this.sphereNode.active = this.preset !== 'pd';
    }

    update(dt: number): void {
        this.time += dt;
        const start = performance.now();
        if (!this.paused) {
            // The PD factor depends on the time step, so the PD scene runs a fixed
            // step for both flaps (slow motion if frames are late) instead of refactoring.
            const step = this.preset === 'pd' ? 1 / 60 : Math.min(Math.max(dt, 1 / 120), 1 / 30);
            for (const body of this.bodies) {
                const cloth = body.sim;
                if (this.wind) {
                    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.9) * Math.sin(this.time * 2.3 + 1);
                    cloth.wind.x = 0.5 * Math.sin(this.time * 0.37);
                    cloth.wind.z = 0.6 + 2.4 * gust;
                    cloth.windDrag = 2;
                } else {
                    cloth.windDrag = 0;
                }
                const t0 = performance.now();
                cloth.step(step);
                body.ms += (performance.now() - t0 - body.ms) * 0.1;
                cloth.computeNormals();
                body.minPos.set(cloth.minPos.x, cloth.minPos.y, cloth.minPos.z);
                body.maxPos.set(cloth.maxPos.x, cloth.maxPos.y, cloth.maxPos.z);
                updateDynamicMesh(body.renderer, body.geometry);
            }
        }
        const ms = performance.now() - start;
        this.simMs += (ms - this.simMs) * 0.1;
        this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
        this.syncSphere();
        if (!this.paused) this.adaptQuality();
    }

    cyclePreset(): void {
        const next = PRESETS[(PRESETS.indexOf(this.preset) + 1) % PRESETS.length];
        // Rubber shows the PBD / XPBD difference best; the other scenes start as cotton.
        if (next === 'compare') this.stiffness = RUBBER;
        else if (this.preset === 'compare' && this.stiffness === RUBBER) this.stiffness = COTTON;
        this.preset = next;
        this.wind = next === 'curtain';
        this.selfCollision = next !== 'compare' && next !== 'pd';
        this.rebuild();
    }

    /** PD scene only: per flap, what runs it, its solver time and its worst grid edge stretch right now. */
    get flaps(): { label: string; ms: number; stretch: number }[] | null {
        if (this.preset !== 'pd') return null;
        return this.bodies.map(({ sim, ms }) => ({
            label: sim.method === 'pd' ? `PD ${PD_SETTINGS[this.pdSetting].name}` : `XPBD ${sim.substeps} substeps`,
            ms,
            stretch: worstStretch(sim),
        }));
    }

    /** Manual choice; turns automatic quality off. */
    cycleQuality(): void {
        this.autoQuality = false;
        this.quality = (this.quality + 1) % QUALITY.length;
        this.rebuild();
    }

    cycleStiffness(): void {
        this.stiffness = (this.stiffness + 1) % STIFFNESS.length;
        this.applySettings();
    }

    /** Substep multiplier, or in the PD scene the PD flap's solver setting. */
    cycleSubsteps(): void {
        if (this.preset === 'pd') this.pdSetting = (this.pdSetting + 1) % PD_SETTINGS.length;
        else this.substepScale = (this.substepScale + 1) % SUBSTEP_SCALES.length;
        this.applySettings();
    }

    toggleSelfCollision(): void {
        this.selfCollision = !this.selfCollision;
        this.applySettings();
    }

    unpinAll(): void {
        for (const body of this.bodies) body.sim.unpinAll();
    }

    moveSphere(x: number, y: number, z: number): void {
        for (const body of this.bodies) body.sim.setSphere(x, y, z);
        this.syncSphere();
    }

    /** The cloth particle nearest to where a ray first hits any cloth. */
    pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: ClothPick): boolean {
        out.body = -1;
        out.t = Infinity;
        const hit = this.pickScratch;
        this.bodies.forEach((body, i) => {
            if (body.sim.pick(ox, oy, oz, dx, dy, dz, hit) && hit.t < out.t) {
                out.body = i;
                out.index = hit.index;
                out.t = hit.t;
            }
        });
        return out.body >= 0;
    }

    grab(pick: ClothPick, out: Vec3): void {
        this.releaseGrab();
        const sim = this.bodies[pick.body].sim;
        sim.grab(pick.index);
        this.grabBody = pick.body;
        const k = pick.index * 3;
        out.set(sim.pos[k], sim.pos[k + 1], sim.pos[k + 2]);
    }

    moveGrab(x: number, y: number, z: number): void {
        if (this.grabBody >= 0) this.bodies[this.grabBody].sim.moveGrab(x, y, z);
    }

    releaseGrab(): void {
        if (this.grabBody >= 0) this.bodies[this.grabBody]?.sim.releaseGrab();
        this.grabBody = -1;
    }

    private makeBody(sim: XpbdCloth, slot: number): ClothBody {
        let renderer = this.renderers[slot];
        if (!renderer) {
            const node = new Node(`Cloth${slot}`);
            this.parent.addChild(node);
            renderer = node.addComponent(MeshRenderer);
            renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            this.renderers[slot] = renderer;
        }
        renderer.node.active = true;
        const minPos = new Vec3(sim.minPos.x, sim.minPos.y, sim.minPos.z);
        const maxPos = new Vec3(sim.maxPos.x, sim.maxPos.y, sim.maxPos.z);
        const geometry: primitives.IDynamicGeometry = {
            positions: sim.pos,
            normals: sim.normals,
            uvs: sim.uvs,
            indices16: sim.indices,
            minPos,
            maxPos,
        };
        const mesh: Mesh = utils.MeshUtils.createDynamicMesh(0, geometry, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: sim.count,
            maxSubMeshIndices: sim.indices.length,
        });
        const old = renderer.mesh;
        renderer.mesh = mesh;
        renderer.setSharedMaterial(this.clothMaterials[sim.method], 0);
        old?.destroy();
        // Later uploads skip the UVs: updateSubMesh maps buffers to attributes in order (positions, normals, uvs).
        delete geometry.uvs;
        return { sim, renderer, geometry, minPos, maxPos, ms: 0 };
    }

    /** Stiffness, substeps and self collision onto every cloth. PBD is matched to XPBD at the level's own substep count. */
    private applySettings(): void {
        const s = STIFFNESS[this.stiffness];
        const pd = PD_SETTINGS[this.pdSetting];
        for (const { sim } of this.bodies) {
            sim.compliance[GROUP_STRETCH] = s.stretch;
            sim.compliance[GROUP_SHEAR] = s.shear;
            sim.compliance[GROUP_BEND] = s.bend;
            sim.matchPbdStiffness(this.level.substeps);
            sim.substeps = this.substeps;
            if (sim.method === 'pd') {
                sim.substeps = pd.steps;
                sim.pd.solver = pd.solver;
                sim.pd.iterations = pd.iterations;
            }
            sim.selfCollision = this.selfCollision;
            sim.selfCollisionEvery = 2;
        }
    }

    private adaptQuality(): void {
        if (!this.autoQuality || this.quality === 0) return;
        // Only while frames are actually late; leaky, so a cost hovering around the budget still triggers.
        const over = this.simMs > AUTO_BUDGET_MS && this.frameMs > AUTO_SLOW_FRAME_MS;
        this.overBudgetFrames = Math.max(0, this.overBudgetFrames + (over ? 1 : -1));
        if (this.overBudgetFrames < AUTO_WINDOW_FRAMES) return;
        this.quality--;
        this.simMs = 0;
        this.rebuild();
    }

    private syncSphere(): void {
        const s = this.sphere;
        this.sphereNode.setPosition(s.x, s.y, s.z);
        this.sphereNode.setScale(s.r, s.r, s.r);
        this.groundMaterial.setProperty('sphere', this.sphereUniform.set(s.x, s.y, s.z, s.r));
    }
}

/** Largest relative stretch of any row or column edge of the grid. */
function worstStretch(sim: XpbdCloth): number {
    const n = sim.segments;
    const p = sim.pos;
    const rest = sim.spacing;
    let worst = 0;
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            const a = (row * n + col) * 3;
            if (col < n - 1) worst = Math.max(worst, Math.hypot(p[a] - p[a + 3], p[a + 1] - p[a + 4], p[a + 2] - p[a + 5]));
            if (row < n - 1) {
                const b = a + n * 3;
                worst = Math.max(worst, Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]));
            }
        }
    }
    return worst / rest - 1;
}
