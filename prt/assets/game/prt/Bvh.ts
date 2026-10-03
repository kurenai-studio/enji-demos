/**
 * Bounding volume hierarchy over a triangle mesh for the bake's rays: binned
 * SAH build, depth-first flattened nodes (left child follows its parent), and
 * Möller–Trumbore triangle tests. `intersect` finds the closest hit and its
 * barycentrics; `occluded` stops at any hit.
 */

const BINS = 12;
const LEAF_SIZE = 4;
const TRAVERSAL_COST = 1;
const TRIANGLE_COST = 1.5;

export class Bvh {
    /** Per node: min xyz, max xyz. */
    readonly bounds: Float64Array;
    /** Per node: (right child or first triangle, triangle count; 0 for inner nodes). */
    readonly meta: Int32Array;
    /** Triangles in leaf order: v0, edge1, edge2 (9 doubles each). */
    private readonly tris: Float64Array;
    /** Leaf-order slot → original triangle index. */
    readonly order: Int32Array;
    readonly nodeCount: number;
    private readonly stack = new Int32Array(128);

    /** Outputs of the last `intersect`. */
    hitT = 0;
    hitU = 0;
    hitV = 0;
    /** The ray met the triangle's front (counter-clockwise) side. */
    hitFront = false;

    constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
        const n = indices.length / 3;
        const cmin = new Float64Array(n * 3), cmax = new Float64Array(n * 3), cen = new Float64Array(n * 3);
        for (let t = 0; t < n; t++) {
            for (let a = 0; a < 3; a++) {
                let lo = Infinity, hi = -Infinity;
                for (let c = 0; c < 3; c++) {
                    const v = positions[indices[t * 3 + c] * 3 + a];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
                cmin[t * 3 + a] = lo;
                cmax[t * 3 + a] = hi;
                cen[t * 3 + a] = (lo + hi) / 2;
            }
        }
        const ids = new Int32Array(n);
        for (let t = 0; t < n; t++) ids[t] = t;
        const maxNodes = Math.max(1, 2 * n);
        const bounds = new Float64Array(maxNodes * 6);
        const meta = new Int32Array(maxNodes * 2);
        let count = 0;
        const binCount = new Int32Array(BINS);
        const binBox = new Float64Array(BINS * 6);
        const rightArea = new Float64Array(BINS);

        const box = (lo: number, hi: number, out: Float64Array, o: number, useCentroids: boolean): void => {
            out[o] = out[o + 1] = out[o + 2] = Infinity;
            out[o + 3] = out[o + 4] = out[o + 5] = -Infinity;
            const mn = useCentroids ? cen : cmin, mx = useCentroids ? cen : cmax;
            for (let i = lo; i < hi; i++) {
                const t = ids[i] * 3;
                for (let a = 0; a < 3; a++) {
                    if (mn[t + a] < out[o + a]) out[o + a] = mn[t + a];
                    if (mx[t + a] > out[o + 3 + a]) out[o + 3 + a] = mx[t + a];
                }
            }
        };
        const area = (b: Float64Array, o: number): number => {
            const dx = b[o + 3] - b[o], dy = b[o + 4] - b[o + 1], dz = b[o + 5] - b[o + 2];
            return dx < 0 ? 0 : 2 * (dx * dy + dy * dz + dz * dx);
        };
        const cb = new Float64Array(6);
        const build = (lo: number, hi: number): number => {
            const node = count++;
            box(lo, hi, bounds, node * 6, false);
            const m = hi - lo;
            const leaf = (): number => { meta[node * 2] = lo; meta[node * 2 + 1] = m; return node; };
            if (m <= LEAF_SIZE) return leaf();
            box(lo, hi, cb, 0, true);
            let bestCost = TRIANGLE_COST * m, bestAxis = -1, bestSplit = 0;
            const parentArea = area(bounds, node * 6);
            for (let a = 0; a < 3; a++) {
                const extent = cb[3 + a] - cb[a];
                if (extent <= 1e-12) continue;
                binCount.fill(0);
                for (let b = 0; b < BINS; b++) {
                    binBox[b * 6] = binBox[b * 6 + 1] = binBox[b * 6 + 2] = Infinity;
                    binBox[b * 6 + 3] = binBox[b * 6 + 4] = binBox[b * 6 + 5] = -Infinity;
                }
                const scale = BINS / extent;
                for (let i = lo; i < hi; i++) {
                    const t = ids[i] * 3;
                    const b = Math.min(BINS - 1, Math.floor((cen[t + a] - cb[a]) * scale));
                    binCount[b]++;
                    for (let k = 0; k < 3; k++) {
                        if (cmin[t + k] < binBox[b * 6 + k]) binBox[b * 6 + k] = cmin[t + k];
                        if (cmax[t + k] > binBox[b * 6 + 3 + k]) binBox[b * 6 + 3 + k] = cmax[t + k];
                    }
                }
                const acc = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
                const grow = (b: number): void => {
                    for (let k = 0; k < 3; k++) {
                        acc[k] = Math.min(acc[k], binBox[b * 6 + k]);
                        acc[3 + k] = Math.max(acc[3 + k], binBox[b * 6 + 3 + k]);
                    }
                };
                for (let b = BINS - 1; b > 0; b--) { grow(b); rightArea[b] = area(acc, 0); }
                acc.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
                let left = 0;
                for (let b = 0; b < BINS - 1; b++) {
                    grow(b);
                    left += binCount[b];
                    const right = m - left;
                    if (left === 0 || right === 0) continue;
                    const cost = TRAVERSAL_COST + (TRIANGLE_COST * (area(acc, 0) * left + rightArea[b + 1] * right)) / parentArea;
                    if (cost < bestCost) { bestCost = cost; bestAxis = a; bestSplit = b + 1; }
                }
            }
            let mid: number;
            if (bestAxis < 0) {
                if (m <= LEAF_SIZE * 4) return leaf();
                // No useful split (coincident centroids): halve by index.
                mid = lo + (m >> 1);
            } else {
                const a = bestAxis, scale = BINS / (cb[3 + a] - cb[a]);
                let i = lo, j = hi - 1;
                while (i <= j) {
                    const b = Math.min(BINS - 1, Math.floor((cen[ids[i] * 3 + a] - cb[a]) * scale));
                    if (b < bestSplit) i++;
                    else { const s = ids[i]; ids[i] = ids[j]; ids[j] = s; j--; }
                }
                mid = i;
            }
            build(lo, mid);
            meta[node * 2] = build(mid, hi);
            meta[node * 2 + 1] = 0;
            return node;
        };
        if (n > 0) build(0, n);
        this.nodeCount = count;
        this.bounds = bounds.slice(0, count * 6);
        this.meta = meta.slice(0, count * 2);
        this.order = ids;
        const tris = new Float64Array(n * 9);
        for (let i = 0; i < n; i++) {
            const t = ids[i];
            const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
            for (let k = 0; k < 3; k++) {
                tris[i * 9 + k] = positions[a + k];
                tris[i * 9 + 3 + k] = positions[b + k] - positions[a + k];
                tris[i * 9 + 6 + k] = positions[c + k] - positions[a + k];
            }
        }
        this.tris = tris;
    }

    /** Closest triangle hit with t in (0, tmax): its original index, or −1. */
    intersect(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): number {
        return this.trace(ox, oy, oz, dx, dy, dz, tmax, false);
    }

    /** Whether anything lies along the ray with t in (0, tmax). */
    occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): boolean {
        return this.trace(ox, oy, oz, dx, dy, dz, tmax, true) >= 0;
    }

    private trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, any: boolean): number {
        if (this.nodeCount === 0) return -1;
        const B = this.bounds, M = this.meta, T = this.tris, stack = this.stack;
        const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
        let best = tmax, hit = -1, hu = 0, hv = 0, front = false;
        let sp = 0;
        let node = 0;
        for (;;) {
            const count = M[node * 2 + 1];
            if (count > 0) {
                const first = M[node * 2];
                for (let i = first; i < first + count; i++) {
                    const o = i * 9;
                    const e1x = T[o + 3], e1y = T[o + 4], e1z = T[o + 5];
                    const e2x = T[o + 6], e2y = T[o + 7], e2z = T[o + 8];
                    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                    const det = e1x * px + e1y * py + e1z * pz;
                    if (det > -1e-14 && det < 1e-14) continue;
                    const inv = 1 / det;
                    const sx = ox - T[o], sy = oy - T[o + 1], sz = oz - T[o + 2];
                    const u = (sx * px + sy * py + sz * pz) * inv;
                    if (u < 0 || u > 1) continue;
                    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                    const v = (dx * qx + dy * qy + dz * qz) * inv;
                    if (v < 0 || u + v > 1) continue;
                    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
                    if (t <= 0 || t >= best) continue;
                    best = t; hit = i; hu = u; hv = v;
                    // det = e1 · (d × e2) = −d · (e1 × e2): negative when d opposes the face normal.
                    front = det > 0;
                    if (any) return this.order[i];
                }
            } else {
                // Visit both children, nearer first.
                const l = node + 1, r = M[node * 2];
                const tl = slab(B, l * 6, ox, oy, oz, ix, iy, iz, best);
                const tr = slab(B, r * 6, ox, oy, oz, ix, iy, iz, best);
                if (tl < Infinity && tr < Infinity) {
                    if (tl <= tr) { stack[sp++] = r; node = l; } else { stack[sp++] = l; node = r; }
                    continue;
                }
                if (tl < Infinity) { node = l; continue; }
                if (tr < Infinity) { node = r; continue; }
            }
            if (sp === 0) break;
            node = stack[--sp];
        }
        if (hit < 0) return -1;
        this.hitT = best;
        this.hitU = hu;
        this.hitV = hv;
        this.hitFront = front;
        return this.order[hit];
    }
}

/** Entry distance of the ray into box o, or Infinity on a miss or beyond tmax. */
function slab(B: Float64Array, o: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tmax: number): number {
    let t0 = (B[o] - ox) * ix, t1 = (B[o + 3] - ox) * ix;
    let lo = t0 < t1 ? t0 : t1, hi = t0 < t1 ? t1 : t0;
    t0 = (B[o + 1] - oy) * iy; t1 = (B[o + 4] - oy) * iy;
    lo = Math.max(lo, t0 < t1 ? t0 : t1); hi = Math.min(hi, t0 < t1 ? t1 : t0);
    t0 = (B[o + 2] - oz) * iz; t1 = (B[o + 5] - oz) * iz;
    lo = Math.max(lo, t0 < t1 ? t0 : t1); hi = Math.min(hi, t0 < t1 ? t1 : t0);
    if (hi < Math.max(lo, 0) || lo > tmax) return Infinity;
    return lo;
}
