/**
 * Analytic occlusion by spheres, the same formulas as chunks/pbr-common.chunk
 * (the CPU applies them to the static room once for the fixed spheres, the
 * shaders per pixel for the moving one).
 */
import type { V3 } from './Room';

export interface Sphere {
    x: number;
    y: number;
    z: number;
    r: number;
}

/** Fraction of the cosine-weighted hemisphere above (p, n) a sphere covers. */
export function sphereOcclusion(p: V3, n: V3, s: Sphere): number {
    const dx = s.x - p[0], dy = s.y - p[1], dz = s.z - p[2];
    const l2 = dx * dx + dy * dy + dz * dz;
    const l = Math.sqrt(l2);
    const cos = (n[0] * dx + n[1] * dy + n[2] * dz) / l;
    return Math.min(1, Math.max(0, (cos * s.r * s.r) / l2));
}

const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

/**
 * Fraction of a spherical light (centre l, radius lr) hidden from p by sphere s,
 * from the overlap of the two discs as seen from p.
 */
export function sphereLightBlock(p: V3, l: V3, lr: number, s: Sphere): number {
    const lx = l[0] - p[0], ly = l[1] - p[1], lz = l[2] - p[2];
    const sx = s.x - p[0], sy = s.y - p[1], sz = s.z - p[2];
    const dl = Math.hypot(lx, ly, lz), ds = Math.hypot(sx, sy, sz);
    if (ds >= dl || ds <= s.r) return ds <= s.r ? 1 : 0;
    const tl = Math.asin(Math.min(lr / dl, 1));
    const ts = Math.asin(Math.min(s.r / ds, 1));
    const g = Math.acos(Math.min(1, Math.max(-1, (lx * sx + ly * sy + lz * sz) / (dl * ds))));
    const inner = Math.min(ts, tl) / tl;
    return inner * inner * (1 - smoothstep(Math.abs(tl - ts), tl + ts, g));
}
