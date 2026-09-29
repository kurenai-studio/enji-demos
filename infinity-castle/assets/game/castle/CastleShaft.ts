import { Material, Mesh, MeshRenderer, Node, primitives, Quat, utils, Vec3, Vec4 } from 'cc';
import { updateDynamicMesh } from '../../enji/helpers';
import { BlockInfo, CastleLayout, CHUNK_HEIGHT } from './CastleLayout';
import { Rng } from './Rng';

/** Chunks kept around the camera: a little above (looking up) and far below (the fall). */
const CHUNKS_ABOVE = 2;
const CHUNKS_BELOW = 6;
const MAX_GLOW_QUADS = 1024;
const LAMP_COUNT = 6;

interface Chunk {
    k: number;
    blocks: { name: string; node: Node }[];
    glow: GlowMesh;
    /** Lantern centres in world space, xyz triples. */
    lanterns: Float32Array;
}

interface GlowMesh {
    node: Node;
    renderer: MeshRenderer;
}

export interface ShaftStats {
    chunks: number;
    activeBlocks: number;
    pooledBlocks: number;
    createdBlocks: number;
    createdGlowMeshes: number;
    lanterns: number;
}

/**
 * The endless shaft: builds chunks of castle ahead of the camera and recycles
 * the ones it has left behind. Block nodes and halo meshes come from pools, so
 * node and mesh counts stop growing once the pools cover the visible window.
 */
export class CastleShaft {
    private readonly chunks = new Map<number, Chunk>();
    private readonly freeBlocks = new Map<string, Node[]>();
    private readonly freeGlows: GlowMesh[] = [];
    private readonly layout: CastleLayout;
    private readonly lampUniforms: Vec4[] = [];
    private readonly lampHandles: number[] = [];
    private createdBlocks = 0;
    private createdGlows = 0;

    constructor(
        private readonly world: Node,
        private readonly meshes: Record<string, Mesh>,
        private readonly blocks: Record<string, BlockInfo>,
        private readonly castleMaterial: Material,
        private readonly glowMaterial: Material,
        seed: number,
    ) {
        this.layout = new CastleLayout(seed, blocks);
        for (let i = 0; i < LAMP_COUNT; i++) this.lampUniforms.push(new Vec4(0, -1e4, 0, 0));
        const pass = castleMaterial.passes[0];
        for (let i = 0; i < LAMP_COUNT; i++) this.lampHandles.push(pass.getHandle(`lamp${i}`));
    }

    /**
     * Keeps chunks [k - above, k + below] alive around depth `depth` (metres fallen).
     * At most `budget` new chunks are built per call so spawning never stalls a frame
     * for long; far chunks are hidden in the haze anyway.
     */
    update(depth: number, budget = 1): void {
        const k0 = Math.floor(depth / CHUNK_HEIGHT);
        for (const [k, chunk] of this.chunks) {
            if (k < k0 - CHUNKS_ABOVE || k > k0 + CHUNKS_BELOW) this.release(chunk);
        }
        // nearest first, so a teleport or a fast fall fills the view around the camera first
        const wanted: number[] = [];
        for (let k = k0 - CHUNKS_ABOVE; k <= k0 + CHUNKS_BELOW; k++) if (!this.chunks.has(k)) wanted.push(k);
        wanted.sort((a, b) => Math.abs(a - k0) - Math.abs(b - k0));
        for (let i = 0; i < Math.min(budget, wanted.length); i++) this.build(wanted[i]);
    }

    /** Feeds the six lanterns closest to `eye` to the castle shader as point lights. */
    updateLamps(eye: Vec3, intensity: number): void {
        const best: { d: number; x: number; y: number; z: number }[] = [];
        const k0 = Math.floor(-eye.y / CHUNK_HEIGHT);
        for (let k = k0 - 1; k <= k0 + 1; k++) {
            const lanterns = this.chunks.get(k)?.lanterns;
            if (!lanterns) continue;
            for (let i = 0; i < lanterns.length; i += 3) {
                const dx = lanterns[i] - eye.x;
                const dy = lanterns[i + 1] - eye.y;
                const dz = lanterns[i + 2] - eye.z;
                const d = dx * dx + dy * dy + dz * dz;
                if (best.length < LAMP_COUNT || d < best[best.length - 1].d) {
                    best.push({ d, x: lanterns[i], y: lanterns[i + 1], z: lanterns[i + 2] });
                    best.sort((a, b) => a.d - b.d);
                    if (best.length > LAMP_COUNT) best.pop();
                }
            }
        }
        const pass = this.castleMaterial.passes[0];
        for (let i = 0; i < LAMP_COUNT; i++) {
            const lamp = best[i];
            const u = this.lampUniforms[i];
            if (lamp) u.set(lamp.x, lamp.y, lamp.z, intensity);
            else u.set(0, -1e4, 0, 0);
            pass.setUniform(this.lampHandles[i], u);
        }
    }

    stats(): ShaftStats {
        let active = 0;
        let lanterns = 0;
        for (const chunk of this.chunks.values()) {
            active += chunk.blocks.length;
            lanterns += chunk.lanterns.length / 3;
        }
        let pooled = 0;
        for (const list of this.freeBlocks.values()) pooled += list.length;
        return {
            chunks: this.chunks.size,
            activeBlocks: active,
            pooledBlocks: pooled,
            createdBlocks: this.createdBlocks,
            createdGlowMeshes: this.createdGlows,
            lanterns,
        };
    }

    private build(k: number): void {
        const placements = this.layout.chunk(k);
        const blocks: Chunk['blocks'] = [];
        const lanterns: number[] = [];
        const tmp = new Vec3();
        for (const p of placements) {
            const node = this.acquireBlock(p.name);
            node.setPosition(p.pos);
            node.setRotation(p.rot);
            blocks.push({ name: p.name, node });
            for (const l of this.blocks[p.name].lanterns) {
                Vec3.transformQuat(tmp, tmp.set(l[0], l[1], l[2]), p.rot).add(p.pos);
                lanterns.push(tmp.x, tmp.y, tmp.z);
            }
        }
        const glow = this.acquireGlow();
        this.fillGlow(glow, lanterns, Rng.forChunk(7919, k));
        this.chunks.set(k, { k, blocks, glow, lanterns: new Float32Array(lanterns) });
    }

    private release(chunk: Chunk): void {
        for (const b of chunk.blocks) {
            b.node.active = false;
            this.freeBlocks.get(b.name)!.push(b.node);
        }
        chunk.glow.node.active = false;
        this.freeGlows.push(chunk.glow);
        this.chunks.delete(chunk.k);
    }

    private acquireBlock(name: string): Node {
        let list = this.freeBlocks.get(name);
        if (!list) this.freeBlocks.set(name, (list = []));
        const reused = list.pop();
        if (reused) {
            reused.active = true;
            return reused;
        }
        const node = new Node(name);
        this.world.addChild(node);
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = this.meshes[name];
        renderer.setSharedMaterial(this.castleMaterial, 0);
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
        this.createdBlocks += 1;
        return node;
    }

    private acquireGlow(): GlowMesh {
        const reused = this.freeGlows.pop();
        if (reused) {
            reused.node.active = true;
            return reused;
        }
        const node = new Node('LanternGlow');
        this.world.addChild(node);
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = utils.MeshUtils.createDynamicMesh(0, glowGeometry([], new Rng(1)), undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: MAX_GLOW_QUADS * 4,
            maxSubMeshIndices: MAX_GLOW_QUADS * 6,
        });
        renderer.setSharedMaterial(this.glowMaterial, 0);
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        this.createdGlows += 1;
        return { node, renderer };
    }

    private fillGlow(glow: GlowMesh, lanterns: number[], rng: Rng): void {
        updateDynamicMesh(glow.renderer, glowGeometry(lanterns, rng));
    }
}

const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** One camera-facing quad per lantern (expanded in lantern-glow.effect). */
function glowGeometry(lanterns: number[], rng: Rng): primitives.IDynamicGeometry {
    const count = Math.min(lanterns.length / 3, MAX_GLOW_QUADS);
    const quads = Math.max(count, 1);
    const positions = new Float32Array(quads * 12);
    const normals = new Float32Array(quads * 12);
    const uvs = new Float32Array(quads * 8);
    const indices = new Uint16Array(quads * 6);
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let q = 0; q < quads; q++) {
        const x = count ? lanterns[q * 3] : 0;
        const y = count ? lanterns[q * 3 + 1] : -1e4;
        const z = count ? lanterns[q * 3 + 2] : 0;
        const size = rng.uniform(0.9, 1.4);
        const gain = count ? rng.uniform(0.6, 1.2) : 0;
        for (let c = 0; c < 4; c++) {
            const v = q * 4 + c;
            positions.set([x, y, z], v * 3);
            normals.set([size, gain, 0], v * 3);
            uvs.set([CORNERS[c * 2], CORNERS[c * 2 + 1]], v * 2);
        }
        indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
        min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
        max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
    }
    // halos grow up to ~3 m with distance; pad the bounds so frustum culling keeps them
    const pad = 4;
    return {
        positions,
        normals,
        uvs,
        indices16: indices,
        minPos: { x: min.x - pad, y: min.y - pad, z: min.z - pad },
        maxPos: { x: max.x + pad, y: max.y + pad, z: max.z + pad },
    };
}
