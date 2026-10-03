import { addScaled, axis, cross, dot, length, mulMatT, scale, set, sub, tangents, v3 } from './Math3';
import type { V3 } from './Math3';
import { Shape } from './RigidBody';
import type { RigidBody } from './RigidBody';

export interface RawPoint {
    /** World position, halfway between the two surfaces. */
    p: V3;
    /** Signed distance along the normal; negative means penetration. */
    s: number;
}

/** Narrow-phase output: one normal (from A to B) and up to four points. */
export class ContactBuffer {
    readonly normal = v3();
    readonly points: RawPoint[] = Array.from({ length: 8 }, () => ({ p: v3(), s: 0 }));
    count = 0;

    push(x: number, y: number, z: number, s: number): void {
        const pt = this.points[this.count++];
        set(pt.p, x, y, z);
        pt.s = s;
    }
}

/**
 * Contact manifold between `a` and `b` (a.shape <= b.shape), including
 * speculative points up to `margin` apart. Returns false when they are further apart.
 */
export function collide(a: RigidBody, b: RigidBody, margin: number, out: ContactBuffer): boolean {
    out.count = 0;
    if (a.shape === Shape.Plane) {
        if (b.shape === Shape.Box) planeBox(a, b, margin, out);
        else if (b.shape === Shape.Sphere) planeSphere(a, b, margin, out);
    } else if (a.shape === Shape.Box) {
        if (b.shape === Shape.Box) boxBox(a, b, margin, out);
        else if (b.shape === Shape.Sphere) boxSphere(a, b, margin, out);
    } else {
        sphereSphere(a, b, margin, out);
    }
    return out.count > 0;
}

// ---------------------------------------------------------------- simple pairs

/** The plane is the horizontal surface y = a.p.y, facing up. */
function planeBox(a: RigidBody, b: RigidBody, margin: number, out: ContactBuffer): void {
    set(out.normal, 0, 1, 0);
    const r = b.R, h = b.half;
    for (let i = 0; i < 8; i++) {
        const sx = i & 1 ? h.x : -h.x, sy = i & 2 ? h.y : -h.y, sz = i & 4 ? h.z : -h.z;
        const x = b.p.x + r[0] * sx + r[1] * sy + r[2] * sz;
        const y = b.p.y + r[3] * sx + r[4] * sy + r[5] * sz;
        const z = b.p.z + r[6] * sx + r[7] * sy + r[8] * sz;
        const s = y - a.p.y;
        if (s <= margin) out.push(x, y - s / 2, z, s);
    }
    if (out.count > 4) reduce(out);
}

function planeSphere(a: RigidBody, b: RigidBody, margin: number, out: ContactBuffer): void {
    const s = b.p.y - b.radius - a.p.y;
    if (s > margin) return;
    set(out.normal, 0, 1, 0);
    out.push(b.p.x, b.p.y - b.radius - s / 2, b.p.z, s);
}

function sphereSphere(a: RigidBody, b: RigidBody, margin: number, out: ContactBuffer): void {
    const n = sub(out.normal, b.p, a.p);
    const d = length(n);
    const s = d - a.radius - b.radius;
    if (s > margin) return;
    if (d > 1e-9) scale(n, n, 1 / d);
    else set(n, 0, 1, 0);
    const k = a.radius + s / 2;
    out.push(a.p.x + n.x * k, a.p.y + n.y * k, a.p.z + n.z * k, s);
}

const local = v3();
const tmp = v3();

function boxSphere(a: RigidBody, b: RigidBody, margin: number, out: ContactBuffer): void {
    const h = a.half;
    mulMatT(local, a.R, sub(tmp, b.p, a.p));
    const qx = Math.max(-h.x, Math.min(h.x, local.x));
    const qy = Math.max(-h.y, Math.min(h.y, local.y));
    const qz = Math.max(-h.z, Math.min(h.z, local.z));
    let nx = local.x - qx, ny = local.y - qy, nz = local.z - qz;
    const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
    let s: number;
    let px = qx, py = qy, pz = qz;
    if (d > 1e-9) {
        s = d - b.radius;
        nx /= d; ny /= d; nz /= d;
    } else {
        // Centre inside the box: push out through the nearest face.
        const dx = h.x - Math.abs(local.x), dy = h.y - Math.abs(local.y), dz = h.z - Math.abs(local.z);
        nx = ny = nz = 0;
        if (dx <= dy && dx <= dz) { nx = Math.sign(local.x) || 1; px = nx * h.x; s = -dx; }
        else if (dy <= dz) { ny = Math.sign(local.y) || 1; py = ny * h.y; s = -dy; }
        else { nz = Math.sign(local.z) || 1; pz = nz * h.z; s = -dz; }
        s -= b.radius;
    }
    if (s > margin) return;
    const r = a.R;
    set(out.normal, r[0] * nx + r[1] * ny + r[2] * nz, r[3] * nx + r[4] * ny + r[5] * nz, r[6] * nx + r[7] * ny + r[8] * nz);
    px += nx * s / 2; py += ny * s / 2; pz += nz * s / 2;
    out.push(
        a.p.x + r[0] * px + r[1] * py + r[2] * pz,
        a.p.y + r[3] * px + r[4] * py + r[5] * pz,
        a.p.z + r[6] * px + r[7] * py + r[8] * pz,
        s,
    );
}

// ---------------------------------------------------------------- box-box

const axesA = [v3(), v3(), v3()];
const axesB = [v3(), v3(), v3()];
const C = new Float64Array(9);
const absC = new Float64Array(9);
const d = v3();
const n = v3();
const edgeA = v3();
const edgeB = v3();
const extA = [0, 0, 0];
const extB = [0, 0, 0];
const tA = [0, 0, 0];
/** Clip buffers: x, y, z per vertex in the reference face frame. */
const polyIn = new Float64Array(8 * 3);
const polyOut = new Float64Array(8 * 3);
/** Prefer faces, and A's faces, unless the alternative is clearly better (as in Randy Gaul's qu3e). */
const REL_TOL = 0.95;
const ABS_TOL = 0.005;

/**
 * Separating-axis test over the 15 candidate axes, then either a face
 * contact (incident face clipped against the reference face's side planes)
 * or a single edge-edge point.
 */
function boxBox(a: RigidBody, b: RigidBody, margin: number, out: ContactBuffer): void {
    for (let i = 0; i < 3; i++) {
        axis(axesA[i], a.R, i);
        axis(axesB[i], b.R, i);
    }
    extA[0] = a.half.x; extA[1] = a.half.y; extA[2] = a.half.z;
    extB[0] = b.half.x; extB[1] = b.half.y; extB[2] = b.half.z;
    sub(d, b.p, a.p);
    tA[0] = dot(d, axesA[0]); tA[1] = dot(d, axesA[1]); tA[2] = dot(d, axesA[2]);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            C[i * 3 + j] = dot(axesA[i], axesB[j]);
            absC[i * 3 + j] = Math.abs(C[i * 3 + j]) + 1e-6;
        }
    }

    let sepA = -Infinity, faceA = 0;
    for (let i = 0; i < 3; i++) {
        const s = Math.abs(tA[i]) - (extA[i] + extB[0] * absC[i * 3] + extB[1] * absC[i * 3 + 1] + extB[2] * absC[i * 3 + 2]);
        if (s > margin) return;
        if (s > sepA) { sepA = s; faceA = i; }
    }
    let sepB = -Infinity, faceB = 0;
    for (let j = 0; j < 3; j++) {
        const s = Math.abs(dot(d, axesB[j])) - (extB[j] + extA[0] * absC[j] + extA[1] * absC[3 + j] + extA[2] * absC[6 + j]);
        if (s > margin) return;
        if (s > sepB) { sepB = s; faceB = j; }
    }
    let sepE = -Infinity, edgeI = 0, edgeJ = 0;
    for (let i = 0; i < 3; i++) {
        const i1 = (i + 1) % 3, i2 = (i + 2) % 3;
        for (let j = 0; j < 3; j++) {
            const len = Math.sqrt(Math.max(0, 1 - C[i * 3 + j] * C[i * 3 + j]));
            if (len < 1e-3) continue; // parallel edges: covered by the face axes
            const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
            const ra = extA[i1] * absC[i2 * 3 + j] + extA[i2] * absC[i1 * 3 + j];
            const rb = extB[j1] * absC[i * 3 + j2] + extB[j2] * absC[i * 3 + j1];
            const dist = Math.abs(tA[i2] * C[i1 * 3 + j] - tA[i1] * C[i2 * 3 + j]);
            const s = (dist - ra - rb) / len;
            if (s > margin) return;
            if (s > sepE) { sepE = s; edgeI = i; edgeJ = j; }
        }
    }

    const faceMax = Math.max(sepA, sepB);
    if (REL_TOL * sepE > faceMax + ABS_TOL) {
        edgeContact(a, b, edgeI, edgeJ, out);
        return;
    }
    if (REL_TOL * sepB > sepA + ABS_TOL) faceContact(b, a, axesB, axesA, extB, extA, faceB, true, margin, out);
    else faceContact(a, b, axesA, axesB, extA, extB, faceA, false, margin, out);
}

function faceContact(
    ref: RigidBody, inc: RigidBody, refAxes: V3[], incAxes: V3[], refExt: number[], incExt: number[],
    face: number, flip: boolean, margin: number, out: ContactBuffer,
): void {
    // Reference face normal points from ref towards inc.
    sub(d, inc.p, ref.p);
    const sign = dot(d, refAxes[face]) >= 0 ? 1 : -1;
    scale(n, refAxes[face], sign);
    const u = refAxes[(face + 1) % 3], v = refAxes[(face + 2) % 3];
    const eu = refExt[(face + 1) % 3], ev = refExt[(face + 2) % 3];
    const cx = ref.p.x + n.x * refExt[face], cy = ref.p.y + n.y * refExt[face], cz = ref.p.z + n.z * refExt[face];

    // Incident face: the one most anti-parallel to n.
    let k = 0, best = -1;
    for (let i = 0; i < 3; i++) {
        const c = Math.abs(dot(incAxes[i], n));
        if (c > best) { best = c; k = i; }
    }
    const ks = dot(incAxes[k], n) > 0 ? -1 : 1;
    const k1 = (k + 1) % 3, k2 = (k + 2) % 3;
    const ia = incAxes[k], ib = incAxes[k1], ic = incAxes[k2];
    const fx = inc.p.x + ia.x * ks * incExt[k] - cx;
    const fy = inc.p.y + ia.y * ks * incExt[k] - cy;
    const fz = inc.p.z + ia.z * ks * incExt[k] - cz;
    const e1 = incExt[k1], e2 = incExt[k2];
    let count = 0;
    for (let c = 0; c < 4; c++) {
        const s1 = c === 0 || c === 3 ? e1 : -e1;
        const s2 = c < 2 ? e2 : -e2;
        const px = fx + ib.x * s1 + ic.x * s2, py = fy + ib.y * s1 + ic.y * s2, pz = fz + ib.z * s1 + ic.z * s2;
        polyIn[count * 3] = px * u.x + py * u.y + pz * u.z;
        polyIn[count * 3 + 1] = px * v.x + py * v.y + pz * v.z;
        polyIn[count * 3 + 2] = px * n.x + py * n.y + pz * n.z;
        count++;
    }
    count = clip(polyIn, polyOut, count, 0, 1, eu);
    count = clip(polyOut, polyIn, count, 0, -1, eu);
    count = clip(polyIn, polyOut, count, 1, 1, ev);
    count = clip(polyOut, polyIn, count, 1, -1, ev);

    if (flip) scale(out.normal, n, -1);
    else set(out.normal, n.x, n.y, n.z);
    for (let i = 0; i < count; i++) {
        const x = polyIn[i * 3], y = polyIn[i * 3 + 1], s = polyIn[i * 3 + 2];
        if (s > margin) continue;
        const z = s / 2;
        out.push(cx + u.x * x + v.x * y + n.x * z, cy + u.y * x + v.y * y + n.y * z, cz + u.z * x + v.z * y + n.z * z, s);
    }
    if (out.count > 4) reduce(out);
}

/** Sutherland-Hodgman against the plane sign * coord[c] <= limit. */
function clip(src: Float64Array, dst: Float64Array, count: number, c: number, sign: number, limit: number): number {
    let m = 0;
    for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const di = sign * src[i * 3 + c] - limit;
        const dj = sign * src[j * 3 + c] - limit;
        if (di <= 0) {
            dst[m * 3] = src[i * 3]; dst[m * 3 + 1] = src[i * 3 + 1]; dst[m * 3 + 2] = src[i * 3 + 2];
            m++;
        }
        if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
            const t = di / (di - dj);
            for (let k = 0; k < 3; k++) dst[m * 3 + k] = src[i * 3 + k] + t * (src[j * 3 + k] - src[i * 3 + k]);
            m++;
        }
    }
    return m;
}

function edgeContact(a: RigidBody, b: RigidBody, i: number, j: number, out: ContactBuffer): void {
    cross(n, axesA[i], axesB[j]);
    scale(n, n, 1 / length(n));
    sub(d, b.p, a.p);
    if (dot(n, d) < 0) scale(n, n, -1);
    // Support edges: A's edge furthest along n, B's furthest along -n.
    set(edgeA, a.p.x, a.p.y, a.p.z);
    set(edgeB, b.p.x, b.p.y, b.p.z);
    for (let k = 0; k < 3; k++) {
        if (k !== i) addScaled(edgeA, edgeA, axesA[k], (dot(axesA[k], n) >= 0 ? 1 : -1) * extA[k]);
        if (k !== j) addScaled(edgeB, edgeB, axesB[k], (dot(axesB[k], n) >= 0 ? -1 : 1) * extB[k]);
    }
    const da = axesA[i], db = axesB[j];
    sub(tmp, edgeA, edgeB);
    const bb = dot(da, db), c = dot(da, tmp), f = dot(db, tmp);
    const denom = 1 - bb * bb;
    let s = denom > 1e-9 ? (bb * f - c) / denom : 0;
    let t = denom > 1e-9 ? (f - bb * c) / denom : 0;
    s = Math.max(-extA[i], Math.min(extA[i], s));
    t = Math.max(-extB[j], Math.min(extB[j], t));
    addScaled(edgeA, edgeA, da, s);
    addScaled(edgeB, edgeB, db, t);
    const sep = dot(sub(tmp, edgeB, edgeA), n);
    set(out.normal, n.x, n.y, n.z);
    out.push((edgeA.x + edgeB.x) / 2, (edgeA.y + edgeB.y) / 2, (edgeA.z + edgeB.z) / 2, sep);
}

// ---------------------------------------------------------------- reduction

const keep = [0, 0, 0, 0];
const scratch = new Float64Array(16);
const CLEARLY_DEEPER = 0.01;
const e = v3();
const f = v3();
const g = v3();

/**
 * Keeps four points: a first one, the furthest from it, then the two that span
 * the most area. The first is the deepest only when it is clearly deeper;
 * otherwise millimetre depth noise picks a different set every step, which
 * defeats warm starting on resting stacks of twisted boxes, so it is the
 * extreme point along a tangent fixed by the normal.
 */
function reduce(out: ContactBuffer): void {
    const pts = out.points, nrm = out.normal, count = out.count;
    tangents(nrm, e, f);
    let i0 = 0, deepest = 0;
    for (let i = 1; i < count; i++) {
        if (dot(pts[i].p, e) > dot(pts[i0].p, e) + 1e-6) i0 = i;
        if (pts[i].s < pts[deepest].s) deepest = i;
    }
    if (pts[i0].s - pts[deepest].s > CLEARLY_DEEPER) i0 = deepest;
    let i1 = -1, best = -1;
    for (let i = 0; i < count; i++) {
        const dd = sqDist(pts[i].p, pts[i0].p);
        if (i !== i0 && dd > best) { best = dd; i1 = i; }
    }
    let i2 = -1, bestArea = 0, orient = 1;
    sub(e, pts[i1].p, pts[i0].p);
    for (let i = 0; i < count; i++) {
        if (i === i0 || i === i1) continue;
        const area = dot(cross(g, e, sub(f, pts[i].p, pts[i0].p)), nrm);
        if (Math.abs(area) > Math.abs(bestArea)) { bestArea = area; i2 = i; }
    }
    keep[0] = i0; keep[1] = i1;
    let kept = 2;
    if (i2 >= 0) {
        keep[kept++] = i2;
        orient = bestArea > 0 ? 1 : -1;
        // Fourth point: the one furthest outside the triangle's edges.
        let i3 = -1, out3 = 0;
        const tri = [i0, i1, i2];
        for (let i = 0; i < count; i++) {
            if (i === i0 || i === i1 || i === i2) continue;
            let worst = 0;
            for (let k = 0; k < 3; k++) {
                const pa = pts[tri[k]].p, pb = pts[tri[(k + 1) % 3]].p;
                const area = -orient * dot(cross(g, sub(e, pb, pa), sub(f, pts[i].p, pa)), nrm);
                if (area > worst) worst = area;
            }
            if (worst > out3) { out3 = worst; i3 = i; }
        }
        if (i3 >= 0) keep[kept++] = i3;
    }
    // Compact in place, through scratch so overlapping indices are safe.
    for (let k = 0; k < kept; k++) {
        const pt = pts[keep[k]];
        scratch[k * 4] = pt.p.x; scratch[k * 4 + 1] = pt.p.y; scratch[k * 4 + 2] = pt.p.z; scratch[k * 4 + 3] = pt.s;
    }
    for (let k = 0; k < kept; k++) {
        set(pts[k].p, scratch[k * 4], scratch[k * 4 + 1], scratch[k * 4 + 2]);
        pts[k].s = scratch[k * 4 + 3];
    }
    out.count = kept;
}

function sqDist(a: V3, b: V3): number {
    const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z;
    return x * x + y * y + z * z;
}
