import { Material, MeshRenderer, Node } from 'cc';
import { boxDistance, classifyBox, OUTSIDE } from './Culling';
import { IMPOSTOR, LOD_LEVELS, rawLevel, screenSize, stepLevel } from './Lod';
import { mergeQuads, mergeTrees } from './Merge';
import { mergedMesh, mergedQuadMesh } from './Meshes';
import { v4, type FrameInput, type RenderPath, type Shared } from './Paths';
import { MAX_VERTICES } from './Species';

interface Built {
    nodes: Node[];
    vertices: number;
    lastUsed: number;
}

/**
 * Static batching per cell: all trees of a cell at one level merged into one
 * vertex buffer (split at 65 536 vertices), built on first use within a
 * per-frame time budget and evicted least-recently-used past a vertex budget.
 * The whole cell switches level at once (with hysteresis, without fade).
 */
export class MergedPath implements RenderPath {
    cpuMs = 0;
    buildBudgetMs = 4;
    vertexBudget = 6_000_000;
    private readonly root: Node;
    private readonly cache = new Map<number, Built>();
    private readonly shown: Int32Array;
    private readonly level: Int8Array;
    private readonly maxRadius: Float32Array;
    private readonly materials: Material[];
    private time = 0;
    private tint = false;
    private fog = 1;
    private vertices = 0;
    private pending = 0;
    private builtThisFrame = 0;
    private draws = 0;
    private totalBuildMs = 0;

    constructor(parent: Node, private readonly shared: Shared) {
        this.root = new Node('MergedPath');
        parent.addChild(this.root);
        const f = shared.forest;
        this.shown = new Int32Array(f.cells.length).fill(-1);
        this.level = new Int8Array(f.cells.length).fill(-1);
        this.maxRadius = new Float32Array(f.cells.length);
        f.cells.forEach((c, k) => {
            for (const i of c.items) this.maxRadius[k] = Math.max(this.maxRadius[k], shared.species[f.species[i]].radius * f.scale[i]);
        });
        this.materials = [0, 1, 2].map((level) => {
            const m = shared.makeMaterial(shared.treeEffect);
            m.setProperty('look', v4(0, level, 0, 0));
            return m;
        });
        const sp = shared.species;
        const imp = shared.makeMaterial(shared.impostorEffect);
        imp.setProperty('atlas', shared.atlas);
        imp.setProperty('sizes', v4(sp[0].impostor.size, sp[1].impostor.size, sp[2].impostor.size, 0));
        imp.setProperty('centers', v4(sp[0].impostor.centerY, sp[1].impostor.centerY, sp[2].impostor.centerY, 0));
        imp.setProperty('lookF', v4(0, IMPOSTOR, 0, 0));
        this.materials.push(imp);
    }

    setVisible(on: boolean): void {
        this.root.active = on;
    }

    update(frame: FrameInput): void {
        const t0 = performance.now();
        this.time += frame.dt;
        this.pending = 0;
        this.builtThisFrame = 0;
        this.draws = 0;
        if (frame.tint !== this.tint || frame.fog !== this.fog) {
            this.tint = frame.tint;
            this.fog = frame.fog;
            this.materials.forEach((m, level) => {
                m.setProperty(level === IMPOSTOR ? 'lookF' : 'look', v4(this.tint ? 1 : 0, level, 0, 0));
                m.setProperty('dims', v4(1, 1, this.fog, 0));
            });
        }
        const f = this.shared.forest;
        const [ex, ey, ez] = frame.eye;
        f.cells.forEach((cell, c) => {
            if (cell.items.length === 0) return;
            const d = boxDistance(cell.min, cell.max, ex, ey, ez);
            if (d > frame.lod.maxDistance || classifyBox(frame.planes, cell.min, cell.max) === OUTSIDE) {
                this.show(c, -1);
                this.level[c] = -1;
                return;
            }
            const s = screenSize(this.maxRadius[c], d, frame.projScale) * frame.lod.bias;
            const lv = this.level[c] < 0 ? rawLevel(s, frame.lod) : stepLevel(this.level[c], s, frame.lod);
            this.level[c] = lv;
            let key = c * LOD_LEVELS + lv;
            let built = this.cache.get(key);
            if (!built && performance.now() - t0 < this.buildBudgetMs) built = this.build(c, lv);
            if (!built) {
                this.pending++;
                // Until it is built, draw whatever level this cell already has.
                key = -1;
                for (let k = 0; k < LOD_LEVELS && key < 0; k++) {
                    for (const alt of [lv + k, lv - k]) {
                        if (alt >= 0 && alt < LOD_LEVELS && this.cache.has(c * LOD_LEVELS + alt)) { key = c * LOD_LEVELS + alt; break; }
                    }
                }
                built = key >= 0 ? this.cache.get(key) : undefined;
            }
            if (built) { built.lastUsed = this.time; this.draws += built.nodes.length; }
            this.show(c, built ? key : -1);
        });
        this.evict();
        this.cpuMs = performance.now() - t0;
    }

    private show(cell: number, key: number): void {
        const old = this.shown[cell];
        if (old === key) return;
        if (old >= 0) for (const n of this.cache.get(old)?.nodes ?? []) n.active = false;
        if (key >= 0) for (const n of this.cache.get(key)!.nodes) n.active = true;
        this.shown[cell] = key;
    }

    private build(c: number, level: number): Built {
        const t0 = performance.now();
        const f = this.shared.forest;
        const cell = f.cells[c];
        const nodes: Node[] = [];
        let vertices = 0;
        const add = (mesh: ReturnType<typeof mergedMesh>, material: Material): void => {
            const node = new Node(`cell${c}-l${level}-${nodes.length}`);
            this.root.addChild(node);
            node.active = false;
            const r = node.addComponent(MeshRenderer);
            r.mesh = mesh;
            r.setSharedMaterial(material, 0);
            r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            r.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
            nodes.push(node);
        };
        if (level === IMPOSTOR) {
            const q = mergeQuads(f, cell.items);
            vertices = q.positions.length / 3;
            add(mergedQuadMesh(q, cell.min, cell.max), this.materials[IMPOSTOR]);
        } else {
            const geos = this.shared.species.map((s) => s.levels[level]);
            // Split into parts that fit 16-bit indices.
            let start = 0;
            while (start < cell.items.length) {
                let end = start, nv = 0;
                while (end < cell.items.length) {
                    const v = geos[f.species[cell.items[end]]].positions.length / 3;
                    if (nv + v > MAX_VERTICES + 1) break;
                    nv += v;
                    end++;
                }
                const m = mergeTrees(f, cell.items.subarray(start, end), geos);
                add(mergedMesh(m, cell.min, cell.max), this.materials[level]);
                vertices += nv;
                start = end;
            }
        }
        const built: Built = { nodes, vertices, lastUsed: this.time };
        this.cache.set(c * LOD_LEVELS + level, built);
        this.vertices += vertices;
        this.builtThisFrame++;
        this.totalBuildMs += performance.now() - t0;
        return built;
    }

    private evict(): void {
        if (this.vertices <= this.vertexBudget) return;
        const old = [...this.cache.entries()].filter(([key, b]) => b.lastUsed < this.time && this.shown[Math.floor(key / LOD_LEVELS)] !== key)
            .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        for (const [key, b] of old) {
            if (this.vertices <= this.vertexBudget * 0.8) break;
            for (const n of b.nodes) n.destroy();
            this.vertices -= b.vertices;
            this.cache.delete(key);
        }
    }

    describe(): string {
        return `Merged: ${this.draws} draws, ${this.cache.size} batches (${(this.vertices / 1e6).toFixed(2)} M verts), ` +
            `${this.pending} pending, ${(this.totalBuildMs / 1000).toFixed(1)} s building`;
    }

    destroy(): void {
        this.root.destroy();
    }
}
