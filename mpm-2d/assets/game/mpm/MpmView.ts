import { EffectAsset, Material, Mesh, MeshRenderer, Node, primitives, resources, utils, Vec4 } from 'cc';
import { ELASTIC, GUARDIAN, LIQUID, type MpmWorld, SAND, SNOW } from './MpmWorld';
import type { MpmSim } from './MpmSim';

/** Gap between the two worlds in compare mode, in cells. */
export const WORLD_GAP = 3;
/** Points beyond the camera, for particle slots a world is not using. */
const HIDDEN_Z = 50;

const LIQUID_SLOW = [0.14, 0.42, 0.9];
const LIQUID_FAST = [0.7, 0.86, 1];
const JELLY = [0.93, 0.34, 0.5];
const SAND_COLOR = [0.87, 0.71, 0.41];
const VISCO = [0.36, 0.78, 0.48];
const SNOW_PACKED = [0.93, 0.97, 1.0];
const SNOW_TORN = [0.5, 0.56, 0.68];
const WALL = [0.24, 0.26, 0.32];
const BACKGROUND = [0.1, 0.11, 0.14];

function loadEffect(path: string): Promise<EffectAsset> {
    return new Promise((resolve, reject) => {
        resources.load(path, EffectAsset, (err, effect) => (err ? reject(err) : resolve(effect)));
    });
}

/**
 * Draws the worlds side by side in grid units: a static frame per world and
 * one dynamic point mesh holding every particle, coloured by material
 * (liquid by speed, jelly by area change, sand with grain noise).
 */
export class MpmView {
    private readonly root: Node;
    private readonly pointMaterial: Material;
    private readonly flatMaterial: Material;
    private frameNode: Node | null = null;
    private pointNode: Node | null = null;
    private pointRenderer: MeshRenderer | null = null;
    private pointMesh: Mesh | null = null;
    private positions = new Float32Array(0);
    private colors = new Float32Array(0);
    private offsets: number[] = [];
    private bounds = { x: 0, y: 0, z: 0 };
    private readonly params = new Vec4();

    private constructor(parent: Node, pointEffect: EffectAsset, flatEffect: EffectAsset) {
        this.root = new Node('MpmView');
        parent.addChild(this.root);
        this.pointMaterial = new Material();
        this.pointMaterial.initialize({ effectAsset: pointEffect });
        this.flatMaterial = new Material();
        this.flatMaterial.initialize({ effectAsset: flatEffect });
    }

    static async create(parent: Node): Promise<MpmView> {
        const [points, flat] = await Promise.all([loadEffect('effects/mpm-points'), loadEffect('effects/mpm-flat')]);
        return new MpmView(parent, points, flat);
    }

    /** Total drawn width and height in cells. */
    get extent(): { width: number; height: number } {
        return { width: this.bounds.x, height: this.bounds.y };
    }

    /** x offset of world i in view space. */
    offset(i: number): number {
        return this.offsets[i] ?? 0;
    }

    /** Recreates the meshes for the sim's current worlds. */
    rebuild(sim: MpmSim): void {
        this.frameNode?.destroy();
        this.pointNode?.destroy();
        const worlds = sim.worlds;
        this.offsets = [];
        let x = 0;
        for (const w of worlds) {
            this.offsets.push(x);
            x += w.width + WORLD_GAP;
        }
        const height = worlds[0]?.height ?? 0;
        this.bounds = { x: x - WORLD_GAP, y: height, z: 0 };

        this.frameNode = new Node('Frames');
        this.root.addChild(this.frameNode);
        const frames = this.frameNode.addComponent(MeshRenderer);
        frames.mesh = this.frameMesh(worlds);
        frames.setSharedMaterial(this.flatMaterial, 0);

        const capacity = worlds.reduce((n, w) => n + w.capacity, 0);
        this.positions = new Float32Array(capacity * 3);
        this.colors = new Float32Array(capacity * 4);
        for (let i = 0; i < capacity; i++) this.positions[i * 3 + 2] = HIDDEN_Z;
        this.pointNode = new Node('Particles');
        this.root.addChild(this.pointNode);
        this.pointRenderer = this.pointNode.addComponent(MeshRenderer);
        const geometry: primitives.IDynamicGeometry = {
            positions: this.positions,
            colors: this.colors,
            minPos: { x: 0, y: 0, z: 0 },
            maxPos: { x: this.bounds.x, y: this.bounds.y, z: 1 },
        };
        this.pointMesh = utils.MeshUtils.createDynamicMesh(0, geometry, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: capacity,
            maxSubMeshIndices: 0,
        });
        // Draw topology comes from the material pass (mpm-points.effect: primitive point_list).
        this.pointRenderer.mesh = this.pointMesh;
        this.pointRenderer.setSharedMaterial(this.pointMaterial, 0);
    }

    /** Point diameter in framebuffer pixels. */
    setPointSize(pixels: number): void {
        this.pointMaterial.setProperty('pointParams', this.params.set(pixels, 0, 0, 0));
    }

    update(sim: MpmSim): void {
        if (!this.pointMesh) return;
        const { positions, colors } = this;
        let v = 0;
        sim.worlds.forEach((world, wi) => {
            const ox = this.offsets[wi];
            const dt = sim.dt(wi);
            for (let i = 0; i < world.count; i++, v++) {
                positions[v * 3] = world.px[i] + ox;
                positions[v * 3 + 1] = world.py[i];
                positions[v * 3 + 2] = 0;
                particleColor(world, i, dt, colors, v * 4);
            }
            for (let i = world.count; i < world.capacity; i++, v++) positions[v * 3 + 2] = HIDDEN_Z;
        });
        this.pointMesh.updateSubMesh(0, {
            positions,
            colors,
            minPos: { x: 0, y: 0, z: 0 },
            maxPos: { x: this.bounds.x, y: this.bounds.y, z: 1 },
        });
    }

    private frameMesh(worlds: MpmWorld[]): Mesh {
        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        const quad = (x0: number, y0: number, x1: number, y1: number, z: number, c: number[]) => {
            const base = positions.length / 3;
            positions.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
            for (let k = 0; k < 4; k++) colors.push(c[0], c[1], c[2], 1);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        worlds.forEach((w, i) => {
            const ox = this.offsets[i];
            // Particles live in [GUARDIAN, size − GUARDIAN − 1]; leave room for their radius.
            const lo = GUARDIAN - 0.3;
            quad(ox + lo - 1, lo - 1, ox + w.width - GUARDIAN - 1 + 0.3 + 1, w.height - GUARDIAN - 1 + 0.3 + 1, -2, WALL);
            quad(ox + lo, lo, ox + w.width - GUARDIAN - 1 + 0.3, w.height - GUARDIAN - 1 + 0.3, -1, BACKGROUND);
        });
        return utils.MeshUtils.createMesh({ positions, colors, indices });
    }
}

function particleColor(world: MpmWorld, i: number, dt: number, out: Float32Array, o: number): void {
    const mat = world.material[i];
    let r: number;
    let g: number;
    let b: number;
    if (mat === LIQUID) {
        const s = world.speed(i, dt);
        const t = s / (s + 60);
        r = LIQUID_SLOW[0] + (LIQUID_FAST[0] - LIQUID_SLOW[0]) * t;
        g = LIQUID_SLOW[1] + (LIQUID_FAST[1] - LIQUID_SLOW[1]) * t;
        b = LIQUID_SLOW[2] + (LIQUID_FAST[2] - LIQUID_SLOW[2]) * t;
    } else if (mat === ELASTIC) {
        const J = world.f00[i] * world.f11[i] - world.f01[i] * world.f10[i];
        const k = 1 + Math.min(Math.max((J - 1) * 1.5, -0.35), 0.35);
        r = JELLY[0] * k;
        g = JELLY[1] * k;
        b = JELLY[2] * k;
    } else if (mat === SAND) {
        const k = 0.86 + 0.14 * ((Math.imul(i, 0x9e3779b1) >>> 24) / 255);
        r = SAND_COLOR[0] * k;
        g = SAND_COLOR[1] * k;
        b = SAND_COLOR[2] * k;
    } else if (mat === SNOW) {
        // Fresh snow (Jp = 1) sits between packed (brighter) and torn (grey-blue).
        const t = Math.min(Math.max((world.jac[i] - 0.85) / 0.35, 0), 1);
        const k = 0.9 + 0.1 * ((Math.imul(i, 0x9e3779b1) >>> 24) / 255);
        r = (SNOW_PACKED[0] + (SNOW_TORN[0] - SNOW_PACKED[0]) * t) * k;
        g = (SNOW_PACKED[1] + (SNOW_TORN[1] - SNOW_PACKED[1]) * t) * k;
        b = (SNOW_PACKED[2] + (SNOW_TORN[2] - SNOW_PACKED[2]) * t) * k;
    } else {
        const s = world.speed(i, dt);
        const k = 1 + 0.3 * (s / (s + 60));
        r = VISCO[0] * k;
        g = VISCO[1] * k;
        b = VISCO[2] * k;
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 1;
}
