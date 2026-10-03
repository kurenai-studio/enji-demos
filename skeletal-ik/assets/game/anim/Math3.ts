/** Small vector and quaternion helpers on plain objects (no engine types, so Node can run them). */
export interface Vec {
    x: number;
    y: number;
    z: number;
}

export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}

export function vec(x = 0, y = 0, z = 0): Vec {
    return { x, y, z };
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
    return { x, y, z, w };
}

export function vSet(out: Vec, x: number, y: number, z: number): Vec {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
}

export function vCopy(out: Vec, a: Vec): Vec {
    return vSet(out, a.x, a.y, a.z);
}

export function vAdd(out: Vec, a: Vec, b: Vec): Vec {
    return vSet(out, a.x + b.x, a.y + b.y, a.z + b.z);
}

export function vSub(out: Vec, a: Vec, b: Vec): Vec {
    return vSet(out, a.x - b.x, a.y - b.y, a.z - b.z);
}

export function vScale(out: Vec, a: Vec, s: number): Vec {
    return vSet(out, a.x * s, a.y * s, a.z * s);
}

/** out = a + b·s */
export function vMad(out: Vec, a: Vec, b: Vec, s: number): Vec {
    return vSet(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
}

export function vDot(a: Vec, b: Vec): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vCross(out: Vec, a: Vec, b: Vec): Vec {
    return vSet(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export function vLen(a: Vec): number {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vDist(a: Vec, b: Vec): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function vNorm(out: Vec, a: Vec): Vec {
    const l = vLen(a);
    return l > 1e-12 ? vScale(out, a, 1 / l) : vSet(out, 0, 0, 0);
}

export function vLerp(out: Vec, a: Vec, b: Vec, t: number): Vec {
    return vSet(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

export function qSet(out: Quat, x: number, y: number, z: number, w: number): Quat {
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
    return out;
}

export function qCopy(out: Quat, a: Quat): Quat {
    return qSet(out, a.x, a.y, a.z, a.w);
}

export function qIdentity(out: Quat): Quat {
    return qSet(out, 0, 0, 0, 1);
}

/** out = a·b (apply b, then a). */
export function qMul(out: Quat, a: Quat, b: Quat): Quat {
    return qSet(
        out,
        a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    );
}

export function qConj(out: Quat, a: Quat): Quat {
    return qSet(out, -a.x, -a.y, -a.z, a.w);
}

export function qDot(a: Quat, b: Quat): number {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function qNormalize(out: Quat, a: Quat): Quat {
    const l = Math.sqrt(qDot(a, a)) || 1;
    return qSet(out, a.x / l, a.y / l, a.z / l, a.w / l);
}

/** Rotates v by unit quaternion q. */
export function qRotate(out: Vec, q: Quat, v: Vec): Vec {
    // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return vSet(
        out,
        v.x + q.w * tx + q.y * tz - q.z * ty,
        v.y + q.w * ty + q.z * tx - q.x * tz,
        v.z + q.w * tz + q.x * ty - q.y * tx,
    );
}

export function qAxisAngle(out: Quat, ax: number, ay: number, az: number, angle: number): Quat {
    const l = Math.hypot(ax, ay, az) || 1;
    const s = Math.sin(angle / 2) / l;
    return qSet(out, ax * s, ay * s, az * s, Math.cos(angle / 2));
}

/** Ry(y)·Rx(x)·Rz(z): twist about the bone after flexing, all in the parent frame's axes. */
export function qEuler(out: Quat, x: number, y: number, z: number): Quat {
    const qx = qAxisAngle(quat(), 1, 0, 0, x);
    const qy = qAxisAngle(quat(), 0, 1, 0, y);
    const qz = qAxisAngle(quat(), 0, 0, 1, z);
    return qMul(out, qMul(out, qy, qx), qz);
}

/** Shortest rotation taking unit vector a to unit vector b. */
export function qFromTo(out: Quat, a: Vec, b: Vec): Quat {
    const d = vDot(a, b);
    if (d < -0.999999) {
        // Opposite: any axis perpendicular to a.
        const axis = Math.abs(a.x) < 0.9 ? vCross(vec(), a, vec(1, 0, 0)) : vCross(vec(), a, vec(0, 1, 0));
        vNorm(axis, axis);
        return qSet(out, axis.x, axis.y, axis.z, 0);
    }
    const c = vCross(vec(), a, b);
    return qNormalize(out, qSet(out, c.x, c.y, c.z, 1 + d));
}

export function qSlerp(out: Quat, a: Quat, b: Quat, t: number): Quat {
    let d = qDot(a, b);
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    if (d < 0) {
        d = -d;
        bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    if (d > 0.9995) {
        return qNormalize(out, qSet(out, a.x + (bx - a.x) * t, a.y + (by - a.y) * t, a.z + (bz - a.z) * t, a.w + (bw - a.w) * t));
    }
    const th = Math.acos(d);
    const s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s;
    const wb = Math.sin(t * th) / s;
    return qSet(out, wa * a.x + wb * bx, wa * a.y + wb * by, wa * a.z + wb * bz, wa * a.w + wb * bw);
}

/** Rotation angle of a unit quaternion, in [0, π]. */
export function qAngle(q: Quat): number {
    return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
}

export function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
    return x < lo ? lo : x > hi ? hi : x;
}
