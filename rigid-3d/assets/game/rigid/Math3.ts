/** Minimal allocation-free 3D math for the solver: plain {x,y,z} vectors, quaternions and row-major 3x3 matrices. */

export interface V3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }
/** Row-major 3x3, m[r * 3 + c]. */
export type Mat3 = Float64Array;

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });
export const mat3 = (): Mat3 => new Float64Array(9);

export function set(out: V3, x: number, y: number, z: number): V3 {
    out.x = x; out.y = y; out.z = z;
    return out;
}

export function copy(out: V3, a: V3): V3 {
    out.x = a.x; out.y = a.y; out.z = a.z;
    return out;
}

export function sub(out: V3, a: V3, b: V3): V3 {
    out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z;
    return out;
}

export function add(out: V3, a: V3, b: V3): V3 {
    out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z;
    return out;
}

/** out = a + b * s */
export function addScaled(out: V3, a: V3, b: V3, s: number): V3 {
    out.x = a.x + b.x * s; out.y = a.y + b.y * s; out.z = a.z + b.z * s;
    return out;
}

export function scale(out: V3, a: V3, s: number): V3 {
    out.x = a.x * s; out.y = a.y * s; out.z = a.z * s;
    return out;
}

export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (a: V3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

export function cross(out: V3, a: V3, b: V3): V3 {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    out.x = x; out.y = y; out.z = z;
    return out;
}

export function normalize(out: V3, a: V3): V3 {
    const l = length(a);
    return l > 1e-12 ? scale(out, a, 1 / l) : set(out, 0, 1, 0);
}

/** Two unit vectors completing `n` to an orthonormal basis (Duff et al. 2017). */
export function tangents(n: V3, t1: V3, t2: V3): void {
    const s = n.z >= 0 ? 1 : -1;
    const a = -1 / (s + n.z);
    const b = n.x * n.y * a;
    set(t1, 1 + s * n.x * n.x * a, s * b, -s * n.x);
    set(t2, b, s + n.y * n.y * a, -n.y);
}

export function mulMat(out: V3, m: Mat3, a: V3): V3 {
    const x = m[0] * a.x + m[1] * a.y + m[2] * a.z;
    const y = m[3] * a.x + m[4] * a.y + m[5] * a.z;
    const z = m[6] * a.x + m[7] * a.y + m[8] * a.z;
    out.x = x; out.y = y; out.z = z;
    return out;
}

/** out = mᵀ a */
export function mulMatT(out: V3, m: Mat3, a: V3): V3 {
    const x = m[0] * a.x + m[3] * a.y + m[6] * a.z;
    const y = m[1] * a.x + m[4] * a.y + m[7] * a.z;
    const z = m[2] * a.x + m[5] * a.y + m[8] * a.z;
    out.x = x; out.y = y; out.z = z;
    return out;
}

/** Column `i` of a rotation matrix, i.e. the body's local axis `i` in world space. */
export function axis(out: V3, m: Mat3, i: number): V3 {
    out.x = m[i]; out.y = m[3 + i]; out.z = m[6 + i];
    return out;
}

export function quatToMat(out: Mat3, q: Quat): Mat3 {
    const { x, y, z, w } = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    out[0] = 1 - yy - zz; out[1] = xy - wz; out[2] = xz + wy;
    out[3] = xy + wz; out[4] = 1 - xx - zz; out[5] = yz - wx;
    out[6] = xz - wy; out[7] = yz + wx; out[8] = 1 - xx - yy;
    return out;
}

export function quatFromEuler(out: Quat, rx: number, ry: number, rz: number): Quat {
    const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2);
    const cy = Math.cos(ry / 2), sy = Math.sin(ry / 2);
    const cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
    // Y (yaw) then X then Z, matching Cocos' Quat.fromEuler.
    out.x = sx * cy * cz + cx * sy * sz;
    out.y = cx * sy * cz + sx * cy * sz;
    out.z = cx * cy * sz - sx * sy * cz;
    out.w = cx * cy * cz - sx * sy * sz;
    return out;
}

export function quatNormalize(q: Quat): void {
    const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
    q.x /= l; q.y /= l; q.z /= l; q.w /= l;
}

/** q += 0.5 h (w, 0) q, then renormalise. */
export function integrateRotation(q: Quat, w: V3, h: number): void {
    const hx = 0.5 * h * w.x, hy = 0.5 * h * w.y, hz = 0.5 * h * w.z;
    const { x, y, z, w: qw } = q;
    q.x += hx * qw + hy * z - hz * y;
    q.y += hy * qw + hz * x - hx * z;
    q.z += hz * qw + hx * y - hy * x;
    q.w += -hx * x - hy * y - hz * z;
    quatNormalize(q);
}

/** Rotates `a` by the rotation taking `from` to `to` (to · from⁻¹), without forming the quaternion. */
export function rotateDelta(out: V3, to: Mat3, from: Mat3, a: V3): V3 {
    mulMatT(out, from, a);
    return mulMat(out, to, out);
}

/** out = R diag(d) Rᵀ */
export function rotateDiagonal(out: Mat3, r: Mat3, d: V3): Mat3 {
    for (let i = 0; i < 3; i++) {
        const ri0 = r[i * 3] * d.x, ri1 = r[i * 3 + 1] * d.y, ri2 = r[i * 3 + 2] * d.z;
        for (let j = 0; j < 3; j++) out[i * 3 + j] = ri0 * r[j * 3] + ri1 * r[j * 3 + 1] + ri2 * r[j * 3 + 2];
    }
    return out;
}
