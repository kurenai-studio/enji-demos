import { qDot, qNormalize, qSet, type Quat } from './Math3';
import type { Pose } from './Skeleton';

/** Baked keyframes, like an imported motion-capture clip: one local rotation per joint per frame. */
export interface Clip {
    name: string;
    /** Seconds per loop. */
    duration: number;
    /** Frames per loop; frame i is at phase i / frames and the last one wraps to the first. */
    frames: number;
    joints: number;
    /** frames × joints × 4 (x, y, z, w). */
    rot: Float32Array;
    /** frames × 3: root joint translation from its rest offset. */
    root: Float32Array;
    /** frames × 2: 1 while the left / right foot is planted. */
    contact: Float32Array;
    /** Root speed along the character's +z that keeps planted feet still (m/s). */
    speed: number;
}

export const BAKE_FPS = 30;

/** Samples `clip` at `phase` ∈ [0, 1): per-joint nlerp between the two nearest frames (sign-corrected). */
export function sampleClip(clip: Clip, phase: number, out: Pose, contact?: number[]): void {
    const f = (((phase % 1) + 1) % 1) * clip.frames;
    const i0 = Math.floor(f) % clip.frames;
    const i1 = (i0 + 1) % clip.frames;
    const t = f - Math.floor(f);
    const J = clip.joints;
    const r = clip.rot;
    for (let j = 0; j < J; j++) {
        const o0 = (i0 * J + j) * 4;
        const o1 = (i1 * J + j) * 4;
        const s = r[o0] * r[o1] + r[o0 + 1] * r[o1 + 1] + r[o0 + 2] * r[o1 + 2] + r[o0 + 3] * r[o1 + 3] < 0 ? -1 : 1;
        const q = out.rot[j];
        qSet(
            q,
            r[o0] + (s * r[o1] - r[o0]) * t,
            r[o0 + 1] + (s * r[o1 + 1] - r[o0 + 1]) * t,
            r[o0 + 2] + (s * r[o1 + 2] - r[o0 + 2]) * t,
            r[o0 + 3] + (s * r[o1 + 3] - r[o0 + 3]) * t,
        );
        qNormalize(q, q);
    }
    const p = clip.root;
    out.root.x = p[i0 * 3] + (p[i1 * 3] - p[i0 * 3]) * t;
    out.root.y = p[i0 * 3 + 1] + (p[i1 * 3 + 1] - p[i0 * 3 + 1]) * t;
    out.root.z = p[i0 * 3 + 2] + (p[i1 * 3 + 2] - p[i0 * 3 + 2]) * t;
    if (contact) {
        const c = clip.contact;
        contact[0] = c[i0 * 2] + (c[i1 * 2] - c[i0 * 2]) * t;
        contact[1] = c[i0 * 2 + 1] + (c[i1 * 2 + 1] - c[i0 * 2 + 1]) * t;
    }
}

/**
 * Weighted blend of poses: root translations are averaged, rotations summed
 * as quaternions on the first pose's hemisphere and normalised (nlerp,
 * which for weights summing to one is what game runtimes use).
 */
export function blendPoses(out: Pose, poses: readonly Pose[], weights: readonly number[]): void {
    const J = out.rot.length;
    for (let j = 0; j < J; j++) {
        let x = 0, y = 0, z = 0, w = 0;
        let ref: Quat | null = null;
        for (let k = 0; k < poses.length; k++) {
            const wk = weights[k];
            if (wk === 0) continue;
            const q = poses[k].rot[j];
            if (!ref) ref = q;
            const s = qDot(ref, q) < 0 ? -wk : wk;
            x += s * q.x; y += s * q.y; z += s * q.z; w += s * q.w;
        }
        qNormalize(out.rot[j], qSet(out.rot[j], x, y, z, w));
    }
    let rx = 0, ry = 0, rz = 0, total = 0;
    for (let k = 0; k < poses.length; k++) {
        rx += weights[k] * poses[k].root.x;
        ry += weights[k] * poses[k].root.y;
        rz += weights[k] * poses[k].root.z;
        total += weights[k];
    }
    total = total || 1;
    out.root.x = rx / total;
    out.root.y = ry / total;
    out.root.z = rz / total;
}
