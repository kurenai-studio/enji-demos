import { capsule, type Capsule } from './SnowSim';

/** One part of the hand: a capsule in hand space (x across the palm, y up the arm, z out of the palm). */
interface Part { a: [number, number, number]; b: [number, number, number]; r: number }

/**
 * Collision shape of an open gauntlet, wrist at the origin. The palm faces +z
 * (the push direction), the fingers point down (−y) and curl a little toward
 * the push so the hand scoops; the forearm leaves up and back.
 */
export const PARTS: Part[] = [
    { a: [0, 0, 0], b: [0, 0.2, -0.17], r: 0.042 },
    { a: [-0.026, 0, 0], b: [-0.026, -0.085, 0.006], r: 0.021 },
    { a: [0.026, 0, 0], b: [0.026, -0.085, 0.006], r: 0.021 },
    { a: [-0.039, -0.085, 0.006], b: [-0.041, -0.148, 0.03], r: 0.012 },
    { a: [-0.013, -0.088, 0.006], b: [-0.013, -0.168, 0.034], r: 0.013 },
    { a: [0.013, -0.088, 0.006], b: [0.013, -0.163, 0.033], r: 0.013 },
    { a: [0.039, -0.085, 0.006], b: [0.042, -0.142, 0.028], r: 0.012 },
    { a: [0.048, -0.01, 0.012], b: [0.07, -0.075, 0.035], r: 0.014 },
];

export interface HandPose {
    x: number; y: number; z: number;
    /** Push direction in the ground plane, radians from +x toward +z. */
    yaw: number;
    /** Forward lean of the fingers, radians (0 = straight down). */
    lean: number;
}

/**
 * Kinematic hand: holds the pose of the previous and the current frame and
 * writes the capsules for any time in between, with the velocity of the frame
 * at each end, so substeps see a smooth sweep.
 */
export class Hand {
    readonly capsules: Capsule[] = PARTS.map(() => capsule());
    private prev: number[][] = PARTS.map(() => [0, 0, 0, 0, 0, 0]);
    private cur: number[][] = PARTS.map(() => [0, 0, 0, 0, 0, 0]);
    private frameDt = 1 / 60;
    private started = false;
    /** Size of the gauntlet relative to `PARTS` (a human hand). */
    scale = 1;

    /** Starts a new frame toward `pose`; `dt` is the frame length. */
    moveTo(pose: HandPose, dt: number): void {
        const t = this.prev;
        this.prev = this.cur;
        this.cur = t;
        PARTS.forEach((part, i) => {
            const o = this.cur[i];
            toWorld(pose, part.a, o, 0, this.scale);
            toWorld(pose, part.b, o, 3, this.scale);
        });
        if (!this.started) {
            this.prev.forEach((p, i) => p.splice(0, 6, ...this.cur[i]));
            this.started = true;
        }
        this.frameDt = dt;
    }

    /** Teleports without a sweep (no velocity), e.g. when the hand is lifted and put down elsewhere. */
    place(pose: HandPose): void {
        this.started = false;
        this.moveTo(pose, this.frameDt);
    }

    /** Writes the capsules at fraction `s` ∈ [0, 1] of the frame. */
    at(s: number): void {
        const inv = 1 / this.frameDt;
        PARTS.forEach((part, i) => {
            const a = this.prev[i], b = this.cur[i], c = this.capsules[i];
            c.ax = a[0] + (b[0] - a[0]) * s; c.ay = a[1] + (b[1] - a[1]) * s; c.az = a[2] + (b[2] - a[2]) * s;
            c.bx = a[3] + (b[3] - a[3]) * s; c.by = a[4] + (b[4] - a[4]) * s; c.bz = a[5] + (b[5] - a[5]) * s;
            c.vax = (b[0] - a[0]) * inv; c.vay = (b[1] - a[1]) * inv; c.vaz = (b[2] - a[2]) * inv;
            c.vbx = (b[3] - a[3]) * inv; c.vby = (b[4] - a[4]) * inv; c.vbz = (b[5] - a[5]) * inv;
            c.r = part.r * this.scale;
        });
    }
}

/** Hand space to world: z → push direction, x → across, y → up, with the fingers leaning forward by `lean`. */
export function toWorld(pose: HandPose, p: readonly number[], out: number[], o: number, scale = 1): void {
    const cl = Math.cos(pose.lean), sl = Math.sin(pose.lean);
    // Lean rotates about the across axis: down (−y) tips toward +z.
    const ly = (p[1] * cl + p[2] * sl) * scale;
    const lz = (-p[1] * sl + p[2] * cl) * scale;
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw);
    // Push direction (cy, 0, sy); across = up × push = (sy, 0, −cy).
    out[o] = pose.x + lz * cy + p[0] * scale * sy;
    out[o + 1] = pose.y + ly;
    out[o + 2] = pose.z + lz * sy - p[0] * scale * cy;
}
