/**
 * Mesh simplification for LOD generation.
 *
 * `simplifyQem`: Garland & Heckbert 1997, "Surface Simplification Using Quadric
 * Error Metrics". Each vertex carries Q = sum of K_p = p p^T over the planes p of
 * its incident faces (area weighted). Collapsing edge (a, b) to v costs
 * v^T (Q_a + Q_b) v; v minimises it when the 3x3 system is well conditioned,
 * otherwise the best of a, b and the midpoint is used. Edges are taken from a
 * min-heap with lazy invalidation; collapses that would flip a triangle are
 * rejected.
 *
 * `simplifyClustering`: Rossignac & Borrel 1993 vertex clustering, the cheap
 * baseline: snap vertices to a grid, keep triangles spanning three cells.
 */
import { computeNormals, triangleCount, vertexCount, type Geo } from './Geometry';

type Quadric = Float64Array; // a2 ab ac ad b2 bc bd c2 cd d2

function addPlane(q: Float64Array, o: number, a: number, b: number, c: number, d: number, w: number): void {
    q[o] += w * a * a; q[o + 1] += w * a * b; q[o + 2] += w * a * c; q[o + 3] += w * a * d;
    q[o + 4] += w * b * b; q[o + 5] += w * b * c; q[o + 6] += w * b * d;
    q[o + 7] += w * c * c; q[o + 8] += w * c * d; q[o + 9] += w * d * d;
}

function evalQ(q: Quadric, x: number, y: number, z: number): number {
    return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
        + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
        + q[7] * z * z + 2 * q[8] * z + q[9];
}

class MinHeap {
    private cost: number[] = [];
    private a: number[] = [];
    private b: number[] = [];
    private stamp: number[] = [];
    get size(): number { return this.cost.length; }
    push(c: number, a: number, b: number, s: number): void {
        let i = this.cost.length;
        this.cost.push(c); this.a.push(a); this.b.push(b); this.stamp.push(s);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.cost[p] <= this.cost[i]) break;
            this.swap(i, p); i = p;
        }
    }
    pop(): [number, number, number, number] {
        const top: [number, number, number, number] = [this.cost[0], this.a[0], this.b[0], this.stamp[0]];
        const last = this.cost.length - 1;
        this.swap(0, last);
        this.cost.pop(); this.a.pop(); this.b.pop(); this.stamp.pop();
        let i = 0;
        for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < this.cost.length && this.cost[l] < this.cost[m]) m = l;
            if (r < this.cost.length && this.cost[r] < this.cost[m]) m = r;
            if (m === i) break;
            this.swap(i, m); i = m;
        }
        return top;
    }
    private swap(i: number, j: number): void {
        [this.cost[i], this.cost[j]] = [this.cost[j], this.cost[i]];
        [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
        [this.b[i], this.b[j]] = [this.b[j], this.b[i]];
        [this.stamp[i], this.stamp[j]] = [this.stamp[j], this.stamp[i]];
    }
}

export interface SimplifyStats {
    /** Largest quadric cost accepted, in squared world units. */
    maxCost: number;
    rejectedFlips: number;
}

export function simplifyQem(src: Geo, targetTriangles: number, stats?: SimplifyStats): Geo {
    const nv = vertexCount(src);
    const nf = triangleCount(src);
    const pos = Float64Array.from(src.positions);
    const col = Float64Array.from(src.colors);
    const F = Int32Array.from(src.indices);
    const faceAlive = new Uint8Array(nf).fill(1);
    const vertAlive = new Uint8Array(nv).fill(1);
    const version = new Uint32Array(nv);
    const Q = new Float64Array(nv * 10);
    const vf: number[][] = Array.from({ length: nv }, () => []);

    for (let f = 0; f < nf; f++) {
        const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
        vf[i0].push(f); vf[i1].push(f); vf[i2].push(f);
        const ux = pos[i1 * 3] - pos[i0 * 3], uy = pos[i1 * 3 + 1] - pos[i0 * 3 + 1], uz = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
        const vx = pos[i2 * 3] - pos[i0 * 3], vy = pos[i2 * 3 + 1] - pos[i0 * 3 + 1], vz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
        let a = uy * vz - uz * vy, b = uz * vx - ux * vz, c = ux * vy - uy * vx;
        const len = Math.hypot(a, b, c);
        if (len < 1e-20) continue;
        a /= len; b /= len; c /= len;
        const d = -(a * pos[i0 * 3] + b * pos[i0 * 3 + 1] + c * pos[i0 * 3 + 2]);
        const area = len / 2;
        for (const v of [i0, i1, i2]) addPlane(Q, v * 10, a, b, c, d, area);
    }

    // Open rims: a plane through the edge, perpendicular to its face, heavily weighted.
    const edgeFaces = new Map<number, number>();
    const key = (a: number, b: number): number => (a < b ? a * 4194304 + b : b * 4194304 + a);
    for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
        const e = key(F[f * 3 + k], F[f * 3 + ((k + 1) % 3)]);
        edgeFaces.set(e, (edgeFaces.get(e) ?? 0) + 1);
    }
    for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
        const i0 = F[f * 3 + k], i1 = F[f * 3 + ((k + 1) % 3)], i2 = F[f * 3 + ((k + 2) % 3)];
        if (edgeFaces.get(key(i0, i1)) !== 1) continue;
        const ex = pos[i1 * 3] - pos[i0 * 3], ey = pos[i1 * 3 + 1] - pos[i0 * 3 + 1], ez = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
        const ux = pos[i2 * 3] - pos[i0 * 3], uy = pos[i2 * 3 + 1] - pos[i0 * 3 + 1], uz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
        const fnx = ey * uz - ez * uy, fny = ez * ux - ex * uz, fnz = ex * uy - ey * ux;
        let a = fny * ez - fnz * ey, b = fnz * ex - fnx * ez, c = fnx * ey - fny * ex;
        const len = Math.hypot(a, b, c);
        if (len < 1e-20) continue;
        a /= len; b /= len; c /= len;
        const d = -(a * pos[i0 * 3] + b * pos[i0 * 3 + 1] + c * pos[i0 * 3 + 2]);
        const w = 1000 * (ex * ex + ey * ey + ez * ez);
        addPlane(Q, i0 * 10, a, b, c, d, w);
        addPlane(Q, i1 * 10, a, b, c, d, w);
    }

    const qsum = new Float64Array(10);
    const target = new Float64Array(3);
    /** Fills `target` with the optimal position for collapsing (a, b) and returns its cost. */
    const solve = (a: number, b: number): number => {
        for (let k = 0; k < 10; k++) qsum[k] = Q[a * 10 + k] + Q[b * 10 + k];
        const q = qsum;
        // Solve [[q0 q1 q2][q1 q4 q5][q2 q5 q7]] v = -[q3 q6 q8] by Cramer's rule.
        const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
        const scale = Math.max(Math.abs(q[0]), Math.abs(q[4]), Math.abs(q[7]), 1e-30);
        if (Math.abs(det) > 1e-9 * scale * scale * scale) {
            const bx = -q[3], by = -q[6], bz = -q[8];
            const x = (bx * (q[4] * q[7] - q[5] * q[5]) - q[1] * (by * q[7] - q[5] * bz) + q[2] * (by * q[5] - q[4] * bz)) / det;
            const y = (q[0] * (by * q[7] - q[5] * bz) - bx * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * bz - by * q[2])) / det;
            const z = (q[0] * (q[4] * bz - by * q[5]) - q[1] * (q[1] * bz - by * q[2]) + bx * (q[1] * q[5] - q[4] * q[2])) / det;
            // Optimal points far off the edge are usually ill-conditioned; keep them near.
            const mx = (pos[a * 3] + pos[b * 3]) / 2, my = (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, mz = (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2;
            const el = Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
            if (Math.hypot(x - mx, y - my, z - mz) <= 2 * el) {
                target[0] = x; target[1] = y; target[2] = z;
                return Math.max(0, evalQ(q, x, y, z));
            }
        }
        let best = Infinity;
        for (const t of [0, 0.5, 1]) {
            const x = pos[a * 3] + (pos[b * 3] - pos[a * 3]) * t;
            const y = pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t;
            const z = pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t;
            const c = evalQ(q, x, y, z);
            if (c < best) { best = c; target[0] = x; target[1] = y; target[2] = z; }
        }
        return Math.max(0, best);
    };

    const heap = new MinHeap();
    const pushEdge = (a: number, b: number): void => {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        heap.push(solve(lo, hi), lo, hi, version[lo] + version[hi]);
    };
    for (const e of edgeFaces.keys()) pushEdge(Math.floor(e / 4194304), e % 4194304);

    /** True if moving `v` to `target` (with `other` merged into it) flips or degenerates a face. */
    const flips = (v: number, other: number): boolean => {
        for (const f of vf[v]) {
            if (!faceAlive[f]) continue;
            const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
            if (i0 === other || i1 === other || i2 === other) continue;
            const p = (i: number, k: number): number => (i === v ? target[k] : pos[i * 3 + k]);
            const ox = [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]];
            const before = cross(
                pos[i1 * 3] - ox[0], pos[i1 * 3 + 1] - ox[1], pos[i1 * 3 + 2] - ox[2],
                pos[i2 * 3] - ox[0], pos[i2 * 3 + 1] - ox[1], pos[i2 * 3 + 2] - ox[2]);
            const nx0 = p(i0, 0), ny0 = p(i0, 1), nz0 = p(i0, 2);
            const after = cross(
                p(i1, 0) - nx0, p(i1, 1) - ny0, p(i1, 2) - nz0,
                p(i2, 0) - nx0, p(i2, 1) - ny0, p(i2, 2) - nz0);
            const la = Math.hypot(after[0], after[1], after[2]);
            const lb = Math.hypot(before[0], before[1], before[2]);
            if (la < 1e-12) return true;
            if ((after[0] * before[0] + after[1] * before[1] + after[2] * before[2]) < 0.2 * la * lb) return true;
        }
        return false;
    };

    let faces = nf;
    let maxCost = 0, rejected = 0;
    while (faces > targetTriangles && heap.size > 0) {
        const [, a, b, s] = heap.pop();
        if (!vertAlive[a] || !vertAlive[b] || s !== version[a] + version[b]) continue;
        // Still an edge? (Faces around a may have changed.)
        let shared = false;
        for (const f of vf[a]) if (faceAlive[f] && (F[f * 3] === b || F[f * 3 + 1] === b || F[f * 3 + 2] === b)) { shared = true; break; }
        if (!shared) continue;
        const cost = solve(a, b);
        if (flips(a, b) || flips(b, a)) { rejected++; continue; }
        maxCost = Math.max(maxCost, cost);
        // Colour: interpolate by the target's projection onto the edge.
        const ex = pos[b * 3] - pos[a * 3], ey = pos[b * 3 + 1] - pos[a * 3 + 1], ez = pos[b * 3 + 2] - pos[a * 3 + 2];
        const el2 = ex * ex + ey * ey + ez * ez;
        const t = el2 > 0 ? Math.min(1, Math.max(0, ((target[0] - pos[a * 3]) * ex + (target[1] - pos[a * 3 + 1]) * ey + (target[2] - pos[a * 3 + 2]) * ez) / el2)) : 0.5;
        for (let k = 0; k < 3; k++) {
            col[a * 3 + k] += (col[b * 3 + k] - col[a * 3 + k]) * t;
            pos[a * 3 + k] = target[k];
        }
        for (let k = 0; k < 10; k++) Q[a * 10 + k] += Q[b * 10 + k];
        vertAlive[b] = 0;
        for (const f of vf[b]) {
            if (!faceAlive[f]) continue;
            const o = f * 3;
            if (F[o] === a || F[o + 1] === a || F[o + 2] === a) { faceAlive[f] = 0; faces--; continue; }
            for (let k = 0; k < 3; k++) if (F[o + k] === b) F[o + k] = a;
            vf[a].push(f);
        }
        vf[b] = [];
        vf[a] = vf[a].filter((f) => faceAlive[f]);
        version[a]++;
        const nbr = new Set<number>();
        for (const f of vf[a]) for (let k = 0; k < 3; k++) { const v = F[f * 3 + k]; if (v !== a) nbr.add(v); }
        for (const v of nbr) pushEdge(a, v);
    }
    if (stats) { stats.maxCost = maxCost; stats.rejectedFlips = rejected; }
    return compact(pos, col, F, faceAlive);
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function compact(pos: Float64Array, col: Float64Array, F: Int32Array, alive: Uint8Array): Geo {
    const remap = new Map<number, number>();
    const outIdx: number[] = [];
    for (let f = 0; f < alive.length; f++) {
        if (!alive[f]) continue;
        const i0 = F[f * 3], i1 = F[f * 3 + 1], i2 = F[f * 3 + 2];
        if (i0 === i1 || i1 === i2 || i0 === i2) continue;
        for (const v of [i0, i1, i2]) {
            let r = remap.get(v);
            if (r === undefined) { r = remap.size; remap.set(v, r); }
            outIdx.push(r);
        }
    }
    const n = remap.size;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    for (const [v, r] of remap) {
        for (let k = 0; k < 3; k++) { positions[r * 3 + k] = pos[v * 3 + k]; colors[r * 3 + k] = col[v * 3 + k]; }
    }
    const indices = new Uint32Array(outIdx);
    return { positions, normals: computeNormals(positions, indices), colors, indices };
}

/** Vertex clustering on a uniform grid of the given cell size. */
export function clusterOnce(src: Geo, cell: number): Geo {
    const nv = vertexCount(src);
    const cellOf = new Int32Array(nv);
    const ids = new Map<string, number>();
    const sums: number[][] = [];
    for (let v = 0; v < nv; v++) {
        const k = `${Math.floor(src.positions[v * 3] / cell)},${Math.floor(src.positions[v * 3 + 1] / cell)},${Math.floor(src.positions[v * 3 + 2] / cell)}`;
        let id = ids.get(k);
        if (id === undefined) { id = sums.length; ids.set(k, id); sums.push([0, 0, 0, 0, 0, 0, 0]); }
        cellOf[v] = id;
        const s = sums[id];
        for (let c = 0; c < 3; c++) { s[c] += src.positions[v * 3 + c]; s[3 + c] += src.colors[v * 3 + c]; }
        s[6]++;
    }
    const seen = new Set<string>();
    const tri: number[] = [];
    for (let f = 0; f < src.indices.length; f += 3) {
        const a = cellOf[src.indices[f]], b = cellOf[src.indices[f + 1]], c = cellOf[src.indices[f + 2]];
        if (a === b || b === c || a === c) continue;
        const k = [a, b, c].sort((x, y) => x - y).join(',');
        if (seen.has(k)) continue;
        seen.add(k);
        tri.push(a, b, c);
    }
    const pos = new Float64Array(sums.length * 3), col = new Float64Array(sums.length * 3);
    sums.forEach((s, i) => { for (let c = 0; c < 3; c++) { pos[i * 3 + c] = s[c] / s[6]; col[i * 3 + c] = s[3 + c] / s[6]; } });
    return compact(pos, col, Int32Array.from(tri), new Uint8Array(tri.length / 3).fill(1));
}

/** Clustering with the cell size bisected to land at or under `targetTriangles`. */
export function simplifyClustering(src: Geo, targetTriangles: number): Geo {
    let lo = 1e-4, hi = 10;
    let best = clusterOnce(src, hi);
    for (let i = 0; i < 30; i++) {
        const mid = Math.sqrt(lo * hi);
        const g = clusterOnce(src, mid);
        if (triangleCount(g) > targetTriangles) lo = mid; else { hi = mid; best = g; }
    }
    return best;
}
