import {
    clamp, qAxisAngle, qCopy, qFromTo, qMul, qRotate, quat, vAdd, vCross, vDist, vDot, vec, vMad, vNorm, vScale, vSub,
    type Quat, type Vec,
} from './Math3';
import { localFromGlobal, type GlobalPose, type Pose, type Skeleton } from './Skeleton';

export interface Limb {
    /** Upper (hip / shoulder), middle (knee / elbow) and end (ankle / wrist) joints. */
    upper: number;
    middle: number;
    end: number;
    /** Direction the middle joint bends towards, in the upper joint's frame (knee: forward). */
    bend: Vec;
}

export interface IkResult {
    /** Distance from the end joint to the target after solving (0 when reachable). */
    miss: number;
    reached: boolean;
}

const MIN_BEND = 1e-4;

const a = vec(), b = vec(), c = vec(), t = vec(), dir = vec(), n = vec(), u = vec(), u1 = vec();
const bendOld = vec(), bendNew = vec(), b1 = vec(), c1 = vec(), v0 = vec(), v1 = vec(), tmp = vec(), axis = vec();
const q1 = quat(), q2 = quat(), q3 = quat(), gUpper = quat(), gMiddle = quat(), gEnd = quat();

/**
 * Analytic two-bone IK in a global pose. The triangle upper–middle–end is
 * solved with the law of cosines; the middle joint goes into the plane
 * spanned by the target direction and the limb's bend direction (taken from
 * the current pose, or `pole` if given), so an animated knee keeps pointing
 * where the animation had it. The end joint keeps its global rotation unless
 * `endRot` gives a new one. Unreachable targets straighten the limb towards
 * them (stopping just short of fully straight). Writes the new local
 * rotations into `pose` and updates `global` for the three joints; the end
 * joint's descendants are left to the caller's next FK pass.
 */
export function solveTwoBone(
    skel: Skeleton, pose: Pose, global: GlobalPose, limb: Limb, target: Vec, pole: Vec | null = null, endRot: Quat | null = null, rootRot: Quat = quat(),
): IkResult {
    const { upper, middle, end } = limb;
    a.x = global.pos[upper].x; a.y = global.pos[upper].y; a.z = global.pos[upper].z;
    b.x = global.pos[middle].x; b.y = global.pos[middle].y; b.z = global.pos[middle].z;
    c.x = global.pos[end].x; c.y = global.pos[end].y; c.z = global.pos[end].z;
    t.x = target.x; t.y = target.y; t.z = target.z;
    const l1 = vDist(a, b);
    const l2 = vDist(b, c);
    const want = vDist(a, t);
    const d = clamp(want, Math.abs(l1 - l2) + MIN_BEND, l1 + l2 - MIN_BEND);
    vNorm(dir, vSub(dir, t, a));
    if (want < 1e-9) vNorm(dir, vSub(dir, c, a));

    // Current bend direction of the limb (perpendicular to the upper bone).
    vNorm(u, vSub(u, b, a));
    qRotate(bendOld, global.rot[upper], limb.bend);
    vNorm(bendOld, vMad(bendOld, bendOld, u, -vDot(bendOld, u)));
    // Wanted bend direction: perpendicular to the target direction.
    if (pole) vSub(n, pole, a);
    else vMad(n, bendOld, u, 0);
    vMad(n, n, dir, -vDot(n, dir));
    if (vNorm(n, n).x === 0 && n.y === 0 && n.z === 0) {
        // Bend direction parallel to the target: fall back to the current one.
        vMad(n, bendOld, dir, -vDot(bendOld, dir));
        vNorm(n, n);
    }

    // New middle and end positions.
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    vMad(b1, a, dir, l1 * cosA);
    vMad(b1, b1, n, l1 * sinA);
    vMad(c1, a, dir, d);

    // Upper joint: swing the bone onto its new direction, then twist about it so the bend direction matches.
    vNorm(u1, vSub(u1, b1, a));
    qFromTo(q1, u, u1);
    qRotate(tmp, q1, bendOld);
    vNorm(bendNew, vMad(bendNew, n, u1, -vDot(n, u1)));
    vCross(axis, tmp, bendNew);
    qAxisAngle(q2, u1.x, u1.y, u1.z, Math.atan2(vDot(axis, u1), vDot(tmp, bendNew)));
    qMul(gUpper, qMul(gUpper, q2, q1), global.rot[upper]);

    // Middle joint: keep its local rotation under the new upper, then swing the lower bone onto c1 − b1.
    const oldUpperInv = quat(-global.rot[upper].x, -global.rot[upper].y, -global.rot[upper].z, global.rot[upper].w);
    const middleLocal = qMul(quat(), oldUpperInv, global.rot[middle]);
    qMul(gMiddle, gUpper, middleLocal);
    vNorm(v0, qRotate(v0, gMiddle, skel.joints[end].offset));
    vNorm(v1, vSub(v1, c1, b1));
    qMul(gMiddle, qFromTo(q3, v0, v1), gMiddle);

    qCopy(gEnd, endRot ?? global.rot[end]);

    localFromGlobal(skel, global, upper, gUpper, pose.rot[upper], rootRot);
    qCopy(global.rot[upper], gUpper);
    global.pos[middle].x = b1.x; global.pos[middle].y = b1.y; global.pos[middle].z = b1.z;
    localFromGlobal(skel, global, middle, gMiddle, pose.rot[middle], rootRot);
    qCopy(global.rot[middle], gMiddle);
    vAdd(global.pos[end], b1, qRotate(tmp, gMiddle, skel.joints[end].offset));
    localFromGlobal(skel, global, end, gEnd, pose.rot[end], rootRot);
    qCopy(global.rot[end], gEnd);

    const miss = vDist(global.pos[end], target);
    return { miss, reached: want <= l1 + l2 - MIN_BEND && want >= Math.abs(l1 - l2) + MIN_BEND };
}

/** Rotates a unit vector `from` towards `to` by at most `maxAngle`: handy for limiting foot tilt. */
export function limitedFromTo(out: Quat, from: Vec, to: Vec, maxAngle: number): Quat {
    qFromTo(out, from, to);
    const angle = 2 * Math.acos(clamp(out.w, -1, 1));
    if (angle <= maxAngle || angle < 1e-9) return out;
    const s = Math.sin(angle / 2);
    vScale(axis, vec(out.x / s, out.y / s, out.z / s), 1);
    return qAxisAngle(out, axis.x, axis.y, axis.z, maxAngle);
}
