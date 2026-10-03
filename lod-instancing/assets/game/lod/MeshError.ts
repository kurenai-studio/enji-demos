/**
 * Geometric error between two meshes: distances from area-uniform samples on
 * one surface to the nearest point of the other (brute force; meshes here are
 * a few thousand triangles).
 */
import type { Geo } from './Geometry';

/** Squared distance from p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangleDist2(
    px: number, py: number, pz: number,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
): number {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const d2sq = (x: number, y: number, z: number): number => (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d1 <= 0 && d2 <= 0) return d2sq(ax, ay, az);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return d2sq(bx, by, bz);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return d2sq(ax + abx * v, ay + aby * v, az + abz * v);
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return d2sq(cx, cy, cz);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return d2sq(ax + acx * w, ay + acy * w, az + acz * w);
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
        return d2sq(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    return d2sq(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

export function surfaceArea(g: Geo): number {
    let a = 0;
    const p = g.positions;
    for (let f = 0; f < g.indices.length; f += 3) {
        const i = g.indices[f] * 3, j = g.indices[f + 1] * 3, k = g.indices[f + 2] * 3;
        const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2];
        const vx = p[k] - p[i], vy = p[k + 1] - p[i + 1], vz = p[k + 2] - p[i + 2];
        a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return a;
}

/** `n` points distributed over the surface proportionally to area. */
export function sampleSurface(g: Geo, n: number, rand: () => number): Float32Array {
    const p = g.positions;
    const nf = g.indices.length / 3;
    const cdf = new Float64Array(nf);
    let acc = 0;
    for (let f = 0; f < nf; f++) {
        const i = g.indices[f * 3] * 3, j = g.indices[f * 3 + 1] * 3, k = g.indices[f * 3 + 2] * 3;
        const ux = p[j] - p[i], uy = p[j + 1] - p[i + 1], uz = p[j + 2] - p[i + 2];
        const vx = p[k] - p[i], vy = p[k + 1] - p[i + 1], vz = p[k + 2] - p[i + 2];
        acc += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        cdf[f] = acc;
    }
    const out = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) {
        const r = rand() * acc;
        let lo = 0, hi = nf - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
        let u = rand(), v = rand();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const i = g.indices[lo * 3] * 3, j = g.indices[lo * 3 + 1] * 3, k = g.indices[lo * 3 + 2] * 3;
        for (let c = 0; c < 3; c++) out[s * 3 + c] = p[i + c] + (p[j + c] - p[i + c]) * u + (p[k + c] - p[i + c]) * v;
    }
    return out;
}

export interface DistanceStats { mean: number; rms: number; max: number }

/** One-sided distances from samples to the surface of `g`. */
export function distancesTo(samples: Float32Array, g: Geo): DistanceStats {
    const p = g.positions, idx = g.indices;
    let sum = 0, sum2 = 0, max = 0;
    const n = samples.length / 3;
    for (let s = 0; s < n; s++) {
        const x = samples[s * 3], y = samples[s * 3 + 1], z = samples[s * 3 + 2];
        let best = Infinity;
        for (let f = 0; f < idx.length; f += 3) {
            const i = idx[f] * 3, j = idx[f + 1] * 3, k = idx[f + 2] * 3;
            const d = pointTriangleDist2(x, y, z, p[i], p[i + 1], p[i + 2], p[j], p[j + 1], p[j + 2], p[k], p[k + 1], p[k + 2]);
            if (d < best) best = d;
        }
        const d = Math.sqrt(best);
        sum += d; sum2 += d * d; max = Math.max(max, d);
    }
    return { mean: sum / n, rms: Math.sqrt(sum2 / n), max };
}

/** Symmetric (two-sided) sampled Hausdorff-style error. */
export function symmetricError(a: Geo, b: Geo, n: number, rand: () => number): DistanceStats {
    const ab = distancesTo(sampleSurface(a, n, rand), b);
    const ba = distancesTo(sampleSurface(b, n, rand), a);
    return { mean: (ab.mean + ba.mean) / 2, rms: Math.sqrt((ab.rms ** 2 + ba.rms ** 2) / 2), max: Math.max(ab.max, ba.max) };
}
