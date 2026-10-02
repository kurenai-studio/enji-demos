import { Material, Mesh, MeshRenderer, Node, primitives, sys, utils, Vec3, Vec4 } from 'cc';
import { loadEffect, updateDynamicMesh } from '../../enji/helpers';
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

export type Preset = 'drape' | 'curtain' | 'compare';
export const PRESETS: readonly Preset[] = ['drape', 'curtain', 'compare'];

const CLOTH_SIZE = 1.6;
const CLOTH_MASS = 0.4;
const COMPARE_SIZE = 1.1;
const COMPARE_HEIGHT = 2.0;
const COMPARE_OFFSET = 0.65;
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
}

export interface ClothPick {
    body: number;
    index: number;
    t: number;
}

/**
 * Cloths, collider sphere and ground; owns the solvers, the dynamic meshes they
 * stream into, the scene presets and the quality level. The compare preset
 * hangs a PBD sheet (blue) next to an XPBD sheet (red). Call `update(dt)` once
 * per frame.
 */
export class ClothScene {
    preset: Preset = 'drape';
    quality: number;
    /** When set, the quality drops by itself while the solver is over budget. */
    autoQuality = true;
    stiffness = COTTON;
    substepScale = 1;
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
        private readonly clothMaterials: readonly Material[],
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
        const ground = new Material();
        ground.initialize({ effectAsset: litEffect, defines: { USE_GRID: true } });
        ground.setProperty('lightDir', LIGHT);
        ground.setProperty('baseColor', new Vec4(0.52, 0.54, 0.58, 1));
        const sphere = new Material();
        sphere.initialize({ effectAsset: litEffect });
        sphere.setProperty('lightDir', LIGHT);
        sphere.setProperty('baseColor', new Vec4(0.2, 0.5, 1.0, 1));
        return new ClothScene(parent, [xpbd, pbd], ground, sphere);
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
        const n = this.level.segments;
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
            else if (this.preset === 'curtain') sim.placeSphere(-0.3, SPHERE_RADIUS, 1.1);
            else sim.placeSphere(0, 0.6, 0);
        }

        this.bodies = sims.map((sim, i) => this.makeBody(sim, i));
        for (let i = sims.length; i < this.renderers.length; i++) this.renderers[i].node.active = false;
        this.applySettings();
        this.overBudgetFrames = 0;
        this.syncSphere();
    }

    update(dt: number): void {
        this.time += dt;
        const start = performance.now();
        if (!this.paused) {
            const step = Math.min(Math.max(dt, 1 / 120), 1 / 30);
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
                cloth.step(step);
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
        this.selfCollision = next !== 'compare';
        this.rebuild();
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

    cycleSubsteps(): void {
        this.substepScale = (this.substepScale + 1) % SUBSTEP_SCALES.length;
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
        renderer.setSharedMaterial(this.clothMaterials[sim.method === 'pbd' ? 1 : 0], 0);
        old?.destroy();
        // Later uploads skip the UVs: updateSubMesh maps buffers to attributes in order (positions, normals, uvs).
        delete geometry.uvs;
        return { sim, renderer, geometry, minPos, maxPos };
    }

    /** Stiffness, substeps and self collision onto every cloth. PBD is matched to XPBD at the level's own substep count. */
    private applySettings(): void {
        const s = STIFFNESS[this.stiffness];
        for (const { sim } of this.bodies) {
            sim.compliance[GROUP_STRETCH] = s.stretch;
            sim.compliance[GROUP_SHEAR] = s.shear;
            sim.compliance[GROUP_BEND] = s.bend;
            sim.matchPbdStiffness(this.level.substeps);
            sim.substeps = this.substeps;
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
