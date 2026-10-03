import type { V3 } from './Shading';

export interface ViewSetup {
    eye: V3;
    /** Unit camera axes in world space: right, up, forward (into the screen). */
    right: V3;
    up: V3;
    forward: V3;
    tanX: number;
    tanY: number;
    near: number;
    width: number;
    height: number;
}

/**
 * Screen extent of a sphere along one axis, as x / z (tangent of the angle),
 * after clipping at the near plane (Mara & McGuire 2013, 2D bounds of a
 * clipped perspective-projected sphere). `u` is the centre's offset along the
 * axis, `z` its depth. The tangent points from the eye bound the sphere where
 * they lie in front of the near plane; where one does not, the sphere's
 * crossing of the near plane bounds it instead.
 */
function axisBounds(u: number, z: number, r: number, near: number, out: [number, number]): void {
    const l2 = u * u + z * z;
    if (l2 <= r * r) {
        // The eye is inside the sphere's cross-section on this axis: no bound.
        out[0] = -Infinity;
        out[1] = Infinity;
        return;
    }
    const t = Math.sqrt(l2 - r * r);
    const l = Math.sqrt(l2);
    const cos = t / l, sin = r / l;
    const au = u / l, az = z / l;
    let lo = Infinity, hi = -Infinity;
    let clipped = false;
    for (const s of [1, -1]) {
        const pu = t * (au * cos - s * az * sin);
        const pz = t * (s * au * sin + az * cos);
        if (pz >= near) {
            lo = Math.min(lo, pu / pz);
            hi = Math.max(hi, pu / pz);
        } else clipped = true;
    }
    const dz = near - z;
    if (clipped && Math.abs(dz) < r) {
        const k = Math.sqrt(r * r - dz * dz);
        lo = Math.min(lo, (u - k) / near);
        hi = Math.max(hi, (u + k) / near);
    }
    out[0] = lo;
    out[1] = hi;
}

const bx: [number, number] = [0, 0], by: [number, number] = [0, 0];

/**
 * Estimated screen pixels covered by the light volumes, summed over lights:
 * what the deferred light pass shades (back faces, one fragment per volume
 * per pixel). Each volume is taken as its bounding sphere (`radius ×
 * volumeScale`); its near-clipped screen rectangle, cut to the screen, counts
 * π/4 of its area (the ellipse inside it). A camera inside a volume counts
 * the whole screen.
 */
export function volumePixels(view: ViewSetup, positions: Float32Array, count: number, volumeScale: number): number {
    const { eye, right, up, forward, tanX, tanY, near, width, height } = view;
    let total = 0;
    for (let i = 0; i < count; i++) {
        const dx = positions[i * 4] - eye[0], dy = positions[i * 4 + 1] - eye[1], dz = positions[i * 4 + 2] - eye[2];
        const r = positions[i * 4 + 3] * volumeScale;
        if (dx * dx + dy * dy + dz * dz <= r * r) { total += width * height; continue; }
        const z = dx * forward[0] + dy * forward[1] + dz * forward[2];
        if (z + r < near) continue;
        axisBounds(dx * right[0] + dy * right[1] + dz * right[2], z, r, near, bx);
        axisBounds(dx * up[0] + dy * up[1] + dz * up[2], z, r, near, by);
        const w = Math.max(0, Math.min(tanX, bx[1]) - Math.max(-tanX, bx[0])) / (2 * tanX) * width;
        const h = Math.max(0, Math.min(tanY, by[1]) - Math.max(-tanY, by[0])) / (2 * tanY) * height;
        total += w * h * (Math.PI / 4);
    }
    return total;
}
