/**
 * Procedural vegetation. Every part is a closed surface of revolution
 * (a "lathe" whose profile starts and ends on the axis), so the meshes are
 * watertight and the simplifier never has to protect open rims.
 */
import { computeNormals, mergeGeos, type Geo } from './Geometry';

export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hash3(x: number, y: number, z: number, seed: number): number {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Trilinear value noise in [-1, 1]. */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
    let v = 0;
    for (let k = 0; k < 8; k++) {
        const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
        const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
        v += w * hash3(xi + dx, yi + dy, zi + dz, seed);
    }
    return v * 2 - 1;
}

interface LatheOptions {
    /** (radius, height) from the bottom pole to the top pole; the first and last radius must be 0. */
    profile: readonly (readonly [number, number])[];
    segments: number;
    /** Radial displacement factor at a surface point (angle in radians, height). */
    displace?: (angle: number, y: number) => number;
    color: (angle: number, y: number) => [number, number, number];
    offset?: readonly [number, number, number];
}

function lathe(o: LatheOptions): Geo {
    const rings = o.profile.length;
    const seg = o.segments;
    const off = o.offset ?? [0, 0, 0];
    // Pole rings collapse to a single vertex.
    const nv = 2 + (rings - 2) * seg;
    const pos = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const put = (i: number, r: number, y: number, ang: number): void => {
        const d = o.displace ? o.displace(ang, y) : 1;
        pos[i * 3] = off[0] + Math.cos(ang) * r * d;
        pos[i * 3 + 1] = off[1] + y;
        pos[i * 3 + 2] = off[2] + Math.sin(ang) * r * d;
        const c = o.color(ang, y);
        col.set(c, i * 3);
    };
    put(0, 0, o.profile[0][1], 0);
    for (let r = 1; r < rings - 1; r++) {
        for (let s = 0; s < seg; s++) put(1 + (r - 1) * seg + s, o.profile[r][0], o.profile[r][1], (s / seg) * Math.PI * 2);
    }
    put(nv - 1, 0, o.profile[rings - 1][1], 0);
    const idx: number[] = [];
    const ring = (r: number, s: number): number => 1 + (r - 1) * seg + (s % seg);
    for (let s = 0; s < seg; s++) idx.push(0, ring(1, s), ring(1, s + 1));
    for (let r = 1; r < rings - 2; r++) {
        for (let s = 0; s < seg; s++) {
            const a = ring(r, s), b = ring(r, s + 1), c = ring(r + 1, s), d = ring(r + 1, s + 1);
            idx.push(a, c, b, b, c, d);
        }
    }
    for (let s = 0; s < seg; s++) idx.push(ring(rings - 2, s), nv - 1, ring(rings - 2, s + 1));
    const indices = new Uint32Array(idx);
    return { positions: pos, normals: computeNormals(pos, indices), colors: col, indices };
}

const BARK: [number, number, number] = [0.13, 0.07, 0.035];

function trunk(height: number, radius: number, seed: number, segments = 10): Geo {
    const profile: [number, number][] = [[0, -0.1]];
    for (let i = 0; i <= 4; i++) profile.push([radius * (1 - 0.45 * (i / 4)), -0.1 + (height + 0.1) * (i / 4)]);
    profile.push([0, height + 0.02]);
    return lathe({
        profile, segments,
        displace: (a, y) => 1 + 0.1 * valueNoise(Math.cos(a) * 2, y * 3, Math.sin(a) * 2, seed),
        color: (a, y) => {
            const v = 0.8 + 0.2 * valueNoise(a * 3, y * 6, 0, seed + 1);
            return [BARK[0] * v, BARK[1] * v, BARK[2] * v];
        },
    });
}

/** Spruce: saw-tooth lathe profile gives stacked needle tiers. About 1.7k triangles. */
export function conifer(seed: number): Geo {
    const tiers = 6;
    const base = 0.9, top = 5.6;
    const profile: [number, number][] = [[0, base - 0.05]];
    for (let t = 0; t < tiers; t++) {
        const y0 = base + ((top - base) * t) / tiers;
        const y1 = base + ((top - base) * (t + 1)) / tiers;
        const rOut = 1.55 * (1 - t / tiers) + 0.25;
        const rIn = rOut * 0.45;
        // Underside, then the sloped needle surface rising to the next tier.
        profile.push([rIn * 0.8, y0 + 0.02], [rOut, y0 + 0.08]);
        for (let k = 1; k <= 3; k++) {
            const f = k / 4;
            profile.push([rOut + (rIn - rOut) * f, y0 + 0.08 + (y1 - y0) * f]);
        }
    }
    profile.push([0, top + 0.35]);
    const canopy = lathe({
        profile, segments: 32,
        displace: (a, y) => 1 + 0.16 * valueNoise(Math.cos(a) * 2.5, y * 1.8, Math.sin(a) * 2.5, seed),
        color: (a, y) => {
            const h = (y - base) / (top - base);
            const v = 0.85 + 0.15 * valueNoise(Math.cos(a) * 4, y * 4, Math.sin(a) * 4, seed + 7);
            return [(0.018 + 0.03 * h) * v, (0.07 + 0.07 * h) * v, (0.03 + 0.02 * h) * v];
        },
    });
    return mergeGeos([trunk(1.3, 0.22, seed), canopy]);
}

function blob(cx: number, cy: number, cz: number, r: number, seed: number, tint: number): Geo {
    const rings = 12;
    const profile: [number, number][] = [];
    for (let i = 0; i <= rings; i++) {
        const t = (i / rings) * Math.PI;
        profile.push([i === 0 || i === rings ? 0 : Math.sin(t) * r, -Math.cos(t) * r]);
    }
    return lathe({
        profile, segments: 18, offset: [cx, cy, cz],
        displace: (a, y) => 1 + 0.18 * valueNoise(Math.cos(a) * 2.2, y * 2.2 / r, Math.sin(a) * 2.2, seed),
        color: (a, y) => {
            const h = 0.5 + y / (2 * r);
            const v = 0.8 + 0.2 * valueNoise(Math.cos(a) * 5, y * 5, Math.sin(a) * 5, seed + 3);
            return [(0.04 + 0.05 * h + 0.03 * tint) * v, (0.09 + 0.1 * h) * v, (0.02 + 0.01 * h) * v];
        },
    });
}

/** Broadleaf: a few overlapping noisy spheres on a trunk. About 1.8k triangles. */
export function broadleaf(seed: number): Geo {
    const rnd = mulberry32(seed);
    const parts: Geo[] = [trunk(2.4, 0.26, seed)];
    const n = 5;
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.6;
        const d = i === 0 ? 0 : 0.8 + rnd() * 0.3;
        parts.push(blob(Math.cos(a) * d, 3.1 + (i === 0 ? 0.6 : rnd() * 0.5), Math.sin(a) * d, 1.15 + rnd() * 0.35, seed + i * 17, rnd()));
    }
    return mergeGeos(parts);
}

/** Boulder: a flattened, fractal-displaced sphere. About 0.75k triangles. */
export function rock(seed: number): Geo {
    const rings = 16;
    const r = 0.9;
    const profile: [number, number][] = [];
    for (let i = 0; i <= rings; i++) {
        const t = (i / rings) * Math.PI;
        profile.push([i === 0 || i === rings ? 0 : Math.sin(t) * r, -Math.cos(t) * r * 0.65 + 0.25]);
    }
    const fbm = (x: number, y: number, z: number): number =>
        valueNoise(x, y, z, seed) * 0.6 + valueNoise(x * 2.1, y * 2.1, z * 2.1, seed + 1) * 0.3 + valueNoise(x * 4.3, y * 4.3, z * 4.3, seed + 2) * 0.1;
    return lathe({
        profile, segments: 24,
        displace: (a, y) => 1 + 0.32 * fbm(Math.cos(a) * 1.6, y * 1.6, Math.sin(a) * 1.6),
        color: (a, y) => {
            const v = 0.75 + 0.25 * valueNoise(Math.cos(a) * 6, y * 6, Math.sin(a) * 6, seed + 5);
            const moss = Math.max(0, y - 0.25) * 0.5;
            return [(0.12 - moss * 0.08) * v, (0.115 + moss * 0.02) * v, (0.105 - moss * 0.07) * v];
        },
    });
}

export type Species = 'conifer' | 'broadleaf' | 'rock';
export const SPECIES: readonly Species[] = ['conifer', 'broadleaf', 'rock'];

export function makeSpecies(s: Species, seed: number): Geo {
    return s === 'conifer' ? conifer(seed) : s === 'broadleaf' ? broadleaf(seed) : rock(seed);
}
