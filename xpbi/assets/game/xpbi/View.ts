import { EffectAsset, Material, Mesh, MeshRenderer, Node, primitives, resources, utils, Vec4 } from 'cc';
import { CLAY, JELLY, SAND, SNOW, type World } from './World';
import type { Sim } from './Sim';

export const WORLD_GAP = 0.08;
const HIDDEN_Z = 50;
const JELLY_C = [0.93, 0.34, 0.5];
const SAND_C = [0.87, 0.71, 0.41];
const SNOW_P = [0.93, 0.97, 1.0];
const SNOW_T = [0.5, 0.56, 0.68];
const CLAY_C = [0.55, 0.72, 0.42];
const WALL = [0.24, 0.26, 0.32];
const BACKGROUND = [0.1, 0.11, 0.14];

function loadEffect(path: string): Promise<EffectAsset> {
    return new Promise((resolve, reject) => {
        resources.load(path, EffectAsset, (err, effect) => (err ? reject(err) : resolve(effect)));
    });
}

export class ParticleView {
    private readonly root: Node;
    private readonly pointMaterial: Material;
    private readonly flatMaterial: Material;
    private frameNode: Node | null = null;
    private pointNode: Node | null = null;
    private pointMesh: Mesh | null = null;
    private positions = new Float32Array(0);
    private colors = new Float32Array(0);
    private offsets: number[] = [];
    private bounds = { x: 0, y: 0 };
    private readonly params = new Vec4();

    private constructor(parent: Node, pointEffect: EffectAsset, flatEffect: EffectAsset) {
        this.root = new Node('XpbiView');
        parent.addChild(this.root);
        this.pointMaterial = new Material();
        this.pointMaterial.initialize({ effectAsset: pointEffect });
        this.flatMaterial = new Material();
        this.flatMaterial.initialize({ effectAsset: flatEffect });
    }

    static async create(parent: Node): Promise<ParticleView> {
        const [points, flat] = await Promise.all([loadEffect('effects/xpbi-points'), loadEffect('effects/xpbi-flat')]);
        return new ParticleView(parent, points, flat);
    }

    get extent(): { width: number; height: number } {
        return { width: this.bounds.x, height: this.bounds.y };
    }

    offset(i: number): number { return this.offsets[i] ?? 0; }

    rebuild(sim: Sim): void {
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
        this.bounds = { x: x - WORLD_GAP, y: height };

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
        const r = this.pointNode.addComponent(MeshRenderer);
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
        r.mesh = this.pointMesh;
        r.setSharedMaterial(this.pointMaterial, 0);
    }

    setPointSize(pixels: number): void {
        this.pointMaterial.setProperty('pointParams', this.params.set(pixels, 0, 0, 0));
    }

    update(sim: Sim): void {
        if (!this.pointMesh) return;
        const { positions, colors } = this;
        let v = 0;
        sim.worlds.forEach((world, wi) => {
            const ox = this.offsets[wi];
            for (let i = 0; i < world.count; i++, v++) {
                positions[v * 3] = world.px[i] + ox;
                positions[v * 3 + 1] = world.py[i];
                positions[v * 3 + 2] = 0;
                colorOf(world, i, colors, v * 4);
            }
            for (let i = world.count; i < world.capacity; i++, v++) positions[v * 3 + 2] = HIDDEN_Z;
        });
        this.pointMesh.updateSubMesh(0, {
            positions, colors,
            minPos: { x: 0, y: 0, z: 0 },
            maxPos: { x: this.bounds.x, y: this.bounds.y, z: 1 },
        });
    }

    private frameMesh(worlds: World[]): Mesh {
        const positions: number[] = [], colors: number[] = [], indices: number[] = [];
        const quad = (x0: number, y0: number, x1: number, y1: number, z: number, c: number[]) => {
            const base = positions.length / 3;
            positions.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
            for (let k = 0; k < 4; k++) colors.push(c[0], c[1], c[2], 1);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        worlds.forEach((w, i) => {
            const ox = this.offsets[i];
            quad(ox - 0.03, -0.03, ox + w.width + 0.03, w.height + 0.03, -2, WALL);
            quad(ox, 0, ox + w.width, w.height, -1, BACKGROUND);
        });
        return utils.MeshUtils.createMesh({ positions, colors, indices });
    }
}

function colorOf(world: World, i: number, out: Float32Array, o: number): void {
    const mat = world.material[i];
    let r: number, g: number, b: number;
    const grain = 0.9 + 0.1 * ((Math.imul(i, 0x9e3779b1) >>> 24) / 255);
    if (mat === JELLY) {
        const J = world.f00[i] * world.f11[i] - world.f01[i] * world.f10[i];
        const k = 1 + Math.min(Math.max((J - 1) * 1.5, -0.35), 0.35);
        r = JELLY_C[0] * k; g = JELLY_C[1] * k; b = JELLY_C[2] * k;
    } else if (mat === SAND) {
        r = SAND_C[0] * grain; g = SAND_C[1] * grain; b = SAND_C[2] * grain;
    } else if (mat === SNOW) {
        const t = Math.min(Math.max((world.logJp[i] - 0.85) / 0.5, 0), 1);
        r = (SNOW_P[0] + (SNOW_T[0] - SNOW_P[0]) * t) * grain;
        g = (SNOW_P[1] + (SNOW_T[1] - SNOW_P[1]) * t) * grain;
        b = (SNOW_P[2] + (SNOW_T[2] - SNOW_P[2]) * t) * grain;
    } else {
        const s = Math.hypot(world.vx[i], world.vy[i]);
        const k = 1 + 0.25 * (s / (s + 2));
        r = CLAY_C[0] * k; g = CLAY_C[1] * k; b = CLAY_C[2] * k;
        void CLAY;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 1;
}
