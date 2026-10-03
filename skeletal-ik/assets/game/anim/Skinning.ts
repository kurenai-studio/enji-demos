import { qMul, qRotate, quat, vec, vSub, type Vec } from './Math3';
import type { GlobalPose, Skeleton } from './Skeleton';

/** 3×4 rows (rotation | translation) per joint: what the GPU gets for linear blend skinning. */
export const ROW_FLOATS = 12;
/** Real and dual quaternion per joint: what the GPU gets for dual quaternion skinning. */
export const DQ_FLOATS = 8;

const t = vec();
const pure = quat();
const dual = quat();

/**
 * Skin transforms from a global pose in the mesh's frame. The bind pose has
 * no rotations, so joint j's transform is its rotation q and the
 * translation p − q·bind_j.
 */
export function skinTransforms(skel: Skeleton, global: GlobalPose, rows: Float32Array, dqs: Float32Array): void {
    for (let j = 0; j < skel.count; j++) {
        const q = global.rot[j];
        qRotate(t, q, skel.bind[j]);
        vSub(t, global.pos[j], t);
        const { x, y, z, w } = q;
        const o = ROW_FLOATS * j;
        rows[o] = 1 - 2 * (y * y + z * z); rows[o + 1] = 2 * (x * y - z * w); rows[o + 2] = 2 * (x * z + y * w); rows[o + 3] = t.x;
        rows[o + 4] = 2 * (x * y + z * w); rows[o + 5] = 1 - 2 * (x * x + z * z); rows[o + 6] = 2 * (y * z - x * w); rows[o + 7] = t.y;
        rows[o + 8] = 2 * (x * z - y * w); rows[o + 9] = 2 * (y * z + x * w); rows[o + 10] = 1 - 2 * (x * x + y * y); rows[o + 11] = t.z;
        // Dual part ½·(t, 0)·q.
        pure.x = t.x; pure.y = t.y; pure.z = t.z; pure.w = 0;
        qMul(dual, pure, q);
        const k = DQ_FLOATS * j;
        dqs[k] = x; dqs[k + 1] = y; dqs[k + 2] = z; dqs[k + 3] = w;
        dqs[k + 4] = 0.5 * dual.x; dqs[k + 5] = 0.5 * dual.y; dqs[k + 6] = 0.5 * dual.z; dqs[k + 7] = 0.5 * dual.w;
    }
}

/** Linear blend skinning of one point (CPU reference of the shader): Σ wᵢ Mᵢ p. */
export function skinLinear(rows: Float32Array, p: Vec, joints: ArrayLike<number>, weights: ArrayLike<number>, out: Vec): Vec {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
        const w = weights[k];
        if (w === 0) continue;
        const o = ROW_FLOATS * joints[k];
        x += w * (rows[o] * p.x + rows[o + 1] * p.y + rows[o + 2] * p.z + rows[o + 3]);
        y += w * (rows[o + 4] * p.x + rows[o + 5] * p.y + rows[o + 6] * p.z + rows[o + 7]);
        z += w * (rows[o + 8] * p.x + rows[o + 9] * p.y + rows[o + 10] * p.z + rows[o + 11]);
    }
    out.x = x; out.y = y; out.z = z;
    return out;
}

/**
 * Dual quaternion skinning of one point (Kavan et al. 2007, CPU reference
 * of the shader): blend the dual quaternions on the first one's hemisphere,
 * normalise, apply as rotation then translation.
 */
export function skinDualQuat(dqs: Float32Array, p: Vec, joints: ArrayLike<number>, weights: ArrayLike<number>, out: Vec): Vec {
    let rx = 0, ry = 0, rz = 0, rw = 0, dx = 0, dy = 0, dz = 0, dw = 0;
    const o0 = DQ_FLOATS * joints[0];
    for (let k = 0; k < 4; k++) {
        let w = weights[k];
        if (w === 0) continue;
        const o = DQ_FLOATS * joints[k];
        if (dqs[o] * dqs[o0] + dqs[o + 1] * dqs[o0 + 1] + dqs[o + 2] * dqs[o0 + 2] + dqs[o + 3] * dqs[o0 + 3] < 0) w = -w;
        rx += w * dqs[o]; ry += w * dqs[o + 1]; rz += w * dqs[o + 2]; rw += w * dqs[o + 3];
        dx += w * dqs[o + 4]; dy += w * dqs[o + 5]; dz += w * dqs[o + 6]; dw += w * dqs[o + 7];
    }
    const len = Math.hypot(rx, ry, rz, rw);
    rx /= len; ry /= len; rz /= len; rw /= len;
    dx /= len; dy /= len; dz /= len; dw /= len;
    const r = quat(rx, ry, rz, rw);
    qRotate(out, r, p);
    // Translation 2·(w_r d.xyz − w_d r.xyz + r.xyz × d.xyz).
    out.x += 2 * (rw * dx - dw * rx + (ry * dz - rz * dy));
    out.y += 2 * (rw * dy - dw * ry + (rz * dx - rx * dz));
    out.z += 2 * (rw * dz - dw * rz + (rx * dy - ry * dx));
    return out;
}
