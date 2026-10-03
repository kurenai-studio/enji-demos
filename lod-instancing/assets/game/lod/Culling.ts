/**
 * Frustum culling. Planes come from the view-projection matrix (Gribb &
 * Hartmann 2001): with rows r0..r3 of M, clip-space -w <= x <= w gives the
 * planes r3 + r0 and r3 - r0, and likewise for y and z. The near plane uses
 * r3 + r2 (GL depth); for a [0, 1] depth range it is merely a little loose.
 */

/** Six planes (a, b, c, d) with unit normals pointing inside: inside when a x + b y + c z + d >= 0. */
export type Planes = Float64Array;

/** `m` is column major (Cocos Mat4 order m00..m15). */
export function frustumPlanes(m: ArrayLike<number>, out: Planes = new Float64Array(24)): Planes {
    const row = (r: number, c: number): number => m[c * 4 + r];
    const combos: [number, number][] = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    combos.forEach(([r, s], p) => {
        let a = row(3, 0) + s * row(r, 0);
        let b = row(3, 1) + s * row(r, 1);
        let c = row(3, 2) + s * row(r, 2);
        let d = row(3, 3) + s * row(r, 3);
        const l = Math.hypot(a, b, c) || 1;
        a /= l; b /= l; c /= l; d /= l;
        out[p * 4] = a; out[p * 4 + 1] = b; out[p * 4 + 2] = c; out[p * 4 + 3] = d;
    });
    return out;
}

export function sphereVisible(p: Planes, x: number, y: number, z: number, r: number): boolean {
    for (let i = 0; i < 24; i += 4) {
        if (p[i] * x + p[i + 1] * y + p[i + 2] * z + p[i + 3] < -r) return false;
    }
    return true;
}

export const OUTSIDE = 0;
export const INTERSECTS = 1;
export const INSIDE = 2;

/** Box vs frustum: OUTSIDE if some plane has the whole box behind it, INSIDE if every plane has it in front. */
export function classifyBox(p: Planes, min: readonly number[], max: readonly number[]): number {
    let result = INSIDE;
    for (let i = 0; i < 24; i += 4) {
        const a = p[i], b = p[i + 1], c = p[i + 2], d = p[i + 3];
        // Corner farthest along the normal, and the nearest one.
        const far = a * (a >= 0 ? max[0] : min[0]) + b * (b >= 0 ? max[1] : min[1]) + c * (c >= 0 ? max[2] : min[2]) + d;
        if (far < 0) return OUTSIDE;
        const near = a * (a >= 0 ? min[0] : max[0]) + b * (b >= 0 ? min[1] : max[1]) + c * (c >= 0 ? min[2] : max[2]) + d;
        if (near < 0) result = INTERSECTS;
    }
    return result;
}

/** Distance from a point to an axis-aligned box (0 inside). */
export function boxDistance(min: readonly number[], max: readonly number[], x: number, y: number, z: number): number {
    const dx = Math.max(min[0] - x, 0, x - max[0]);
    const dy = Math.max(min[1] - y, 0, y - max[1]);
    const dz = Math.max(min[2] - z, 0, z - max[2]);
    return Math.hypot(dx, dy, dz);
}
