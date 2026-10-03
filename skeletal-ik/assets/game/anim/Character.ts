import { blendPoses, sampleClip, type Clip } from './Clip';
import { bakeClip, type ClipName } from './Gait';
import { qAxisAngle, qConj, qMul, qRotate, qSlerp, quat, vAdd, vec, vLerp, vSub, type Vec } from './Math3';
import { ANKLE_HEIGHT, forwardKinematics, humanoid, type GlobalPose, type Pose, type Skeleton } from './Skeleton';
import { DQ_FLOATS, ROW_FLOATS, skinTransforms } from './Skinning';
import { terrainHeight, terrainNormal } from './Terrain';
import { limitedFromTo, solveTwoBone, type Limb } from './TwoBoneIk';

export type SpeedMode = 'idle' | 'walk' | 'run' | 'auto' | 'exercise';

/** Clips and skeleton shared by every character. */
export interface AnimSet {
    skel: Skeleton;
    clips: Record<ClipName, Clip>;
}

export function createAnimSet(): AnimSet {
    const skel = humanoid();
    const clips = {} as Record<ClipName, Clip>;
    for (const name of ['Idle', 'Walk', 'Run', 'Exercise'] as ClipName[]) clips[name] = bakeClip(skel, name);
    return { skel, clips };
}

/** Ball of the foot above the sole in the bind pose. */
const BALL_HEIGHT = 0.03;
/** Largest tilt of a planted foot towards the ground normal (rad). */
const MAX_FOOT_TILT = 0.45;
const UP = vec(0, 1, 0);
/** Blended contact at which a foot gets pinned (the pin is at full strength 0.2 later). */
const LOCK_CONTACT = 0.75;
/** A pinned foot lets go when the animation has drifted this far from it (m). */
const LOCK_RELEASE = 0.12;
/** Rate at which a released pin's offset fades (1/s). */
const LOCK_FADE = 14;
/** Hip-to-ankle distance the pelvis IK keeps within: thigh + shin less a little knee bend (m). */
const LEG_REACH = 0.81;
/** Auto speed: idle, walk, run, walk, each held for the given seconds. */
const AUTO = [[0, 3], [1, 5], [2, 4], [1, 4]] as const;

export interface FootStats {
    /** Planted-foot samples, the sum of |ball height above ground| and its largest value (m). */
    samples: number;
    error: number;
    maxError: number;
    /** Sum of the planted ball's horizontal speed (m/s). */
    skate: number;
    /** Farthest a pinned ball sat from where the animation had it (m), and pins let go for drifting too far. */
    maxDrag: number;
    releases: number;
}

/**
 * One animated character walking a circle on the terrain. Per frame:
 * blend idle / walk / run by speed (walk and run share one normalised
 * phase, so their steps line up), advance the root by the blend's own
 * speed, then with foot IK lower or raise the pelvis and solve each leg so
 * the feet meet the uneven ground, and with reach solve the right arm to
 * the orb. The result is a global pose in world space and the skin
 * transforms in the character's frame.
 */
export class Character {
    readonly set: AnimSet;
    readonly pose: Pose;
    readonly world: GlobalPose;
    readonly local: GlobalPose;
    readonly rows: Float32Array;
    readonly dqs: Float32Array;
    readonly rootPos = vec();
    readonly rootRot = quat();
    readonly orb = vec();
    readonly stats: FootStats = { samples: 0, error: 0, maxError: 0, skate: 0, maxDrag: 0, releases: 0 };

    footIk = true;
    /** With foot IK: pin a planted ball where it touched down, hiding keyframe and blend drift. */
    footLock = true;
    reach = false;
    mode: SpeedMode = 'auto';
    terrainAmplitude = 1;
    /** Blend weights of idle, walk, run and exercise from the last update. */
    readonly weights = [1, 0, 0, 0];
    speed = 0;
    /** Root speed actually used (m/s). */
    rootSpeed = 0;
    pelvisOffset = 0;
    /** Phase sync of walk and run; turning it off runs each at its own rate (for the test). */
    syncPhases = true;
    /** Fixed target speed instead of the mode's (m/s), for tests. */
    speedOverride: number | null = null;

    private readonly centre: Vec;
    private readonly radius: number;
    private readonly direction: number;
    private angle: number;
    private time: number;
    private phase = 0;
    private readonly phases = [0, 0];
    private idleTime = 0;
    private exerciseTime = 0;
    private exerciseWeight = 0;
    private reachWeight = 0;
    private readonly poses: Pose[];
    private readonly contact = [0, 0];
    private readonly contacts = [[0, 0], [0, 0], [0, 0], [0, 0]];
    private readonly legs: [Limb, Limb];
    private readonly arm: Limb;
    private readonly toe: [number, number];
    private readonly lastBall: [Vec, Vec] = [vec(), vec()];
    private readonly hadBall = [false, false];
    private readonly locked = [false, false];
    private readonly lockBall: [Vec, Vec] = [vec(), vec()];
    private readonly lockOffset: [Vec, Vec] = [vec(), vec()];

    constructor(set: AnimSet, centre: Vec, radius: number, angle: number, direction: number, timeOffset = 0) {
        this.set = set;
        const skel = set.skel;
        this.pose = skel.newPose();
        this.world = skel.newGlobal();
        this.local = skel.newGlobal();
        this.poses = [skel.newPose(), skel.newPose(), skel.newPose(), skel.newPose()];
        this.rows = new Float32Array(ROW_FLOATS * skel.count);
        this.dqs = new Float32Array(DQ_FLOATS * skel.count);
        this.centre = centre;
        this.radius = radius;
        this.angle = angle;
        this.direction = direction;
        this.time = timeOffset;
        const j = (n: string) => skel.index(n);
        const leg = (s: string): Limb => ({ upper: j(`thigh.${s}`), middle: j(`shin.${s}`), end: j(`foot.${s}`), bend: vec(0, 0, 1) });
        this.legs = [leg('L'), leg('R')];
        this.arm = { upper: j('upperArm.R'), middle: j('forearm.R'), end: j('hand.R'), bend: vec(0, 0, -1) };
        this.toe = [j('toe.L'), j('toe.R')];
    }

    get clips(): Record<ClipName, Clip> {
        return this.set.clips;
    }

    /** Target speed for the current mode (m/s). */
    private targetSpeed(): number {
        if (this.speedOverride !== null) return this.speedOverride;
        const { Walk, Run } = this.clips;
        const speeds = [0, Walk.speed, Run.speed];
        if (this.mode === 'idle' || this.mode === 'exercise') return 0;
        if (this.mode === 'walk') return Walk.speed;
        if (this.mode === 'run') return Run.speed;
        const cycle = AUTO.reduce((s, a) => s + a[1], 0);
        let t = this.time % cycle;
        for (const [k, d] of AUTO) {
            if (t < d) return speeds[k];
            t -= d;
        }
        return 0;
    }

    update(dt: number): void {
        const { Idle, Walk, Run, Exercise } = this.clips;
        this.time += dt;
        const s = (this.speed += (this.targetSpeed() - this.speed) * (1 - Math.exp(-dt * 1.5)));
        this.exerciseWeight += ((this.mode === 'exercise' ? 1 : 0) - this.exerciseWeight) * (1 - Math.exp(-dt * 3));
        this.reachWeight += ((this.reach ? 1 : 0) - this.reachWeight) * (1 - Math.exp(-dt * 4));

        // 1D blend space over speed: idle → walk → run.
        let wi = 0, ww = 0, wr = 0;
        if (s <= Walk.speed) {
            ww = s / Walk.speed;
            wi = 1 - ww;
        } else {
            wr = Math.min(1, (s - Walk.speed) / (Run.speed - Walk.speed));
            ww = 1 - wr;
        }
        const ex = this.exerciseWeight;
        const w = this.weights;
        w[0] = wi * (1 - ex); w[1] = ww * (1 - ex); w[2] = wr * (1 - ex); w[3] = ex;

        // Walk and run share a normalised phase whose rate is the blended cycle length.
        const moving = ww + wr;
        const period = moving > 0 ? (ww * Walk.duration + wr * Run.duration) / moving : Walk.duration;
        this.phase = (this.phase + dt / period) % 1;
        this.phases[0] = (this.phases[0] + dt / Walk.duration) % 1;
        this.phases[1] = (this.phases[1] + dt / Run.duration) % 1;
        this.idleTime += dt;
        this.exerciseTime = ex > 0.01 ? this.exerciseTime + dt : 0;
        const walkPhase = this.syncPhases ? this.phase : this.phases[0];
        const runPhase = this.syncPhases ? this.phase : this.phases[1];
        sampleClip(Idle, this.idleTime / Idle.duration, this.poses[0], this.contacts[0]);
        sampleClip(Walk, walkPhase, this.poses[1], this.contacts[1]);
        sampleClip(Run, runPhase, this.poses[2], this.contacts[2]);
        sampleClip(Exercise, this.exerciseTime / Exercise.duration, this.poses[3], this.contacts[3]);
        blendPoses(this.pose, this.poses, w);
        for (let leg = 0; leg < 2; leg++) {
            let c = 0;
            for (let k = 0; k < 4; k++) c += w[k] * this.contacts[k][leg];
            this.contact[leg] = c;
        }

        // Root motion: each clip played at the shared period moves its planted foot at speed·(own period / period).
        const walkSpeed = this.syncPhases ? Walk.speed * (Walk.duration / period) : Walk.speed;
        const runSpeed = this.syncPhases ? Run.speed * (Run.duration / period) : Run.speed;
        this.rootSpeed = w[1] * walkSpeed + w[2] * runSpeed;
        this.angle += (this.direction * this.rootSpeed * dt) / this.radius;
        const x = this.centre.x + this.radius * Math.cos(this.angle);
        const z = this.centre.z + this.radius * Math.sin(this.angle);
        const tx = -Math.sin(this.angle) * this.direction;
        const tz = Math.cos(this.angle) * this.direction;
        qAxisAngle(this.rootRot, 0, 1, 0, Math.atan2(tx, tz));
        this.rootPos.x = x;
        this.rootPos.y = terrainHeight(x, z, this.terrainAmplitude);
        this.rootPos.z = z;

        const skel = this.set.skel;
        forwardKinematics(skel, this.pose, this.world, this.rootRot, this.rootPos);
        if (this.footIk) this.solveFeet(dt);
        else this.releaseFeet();
        this.placeOrb();
        if (this.reachWeight > 0.001) {
            const hand = this.world.pos[this.arm.end];
            const target = vLerp(vec(), hand, this.orb, this.reachWeight);
            solveTwoBone(skel, this.pose, this.world, this.arm, target, null, null, this.rootRot);
        }
        forwardKinematics(skel, this.pose, this.world, this.rootRot, this.rootPos);
        this.measureFeet(dt);
        this.toLocal();
        skinTransforms(skel, this.local, this.rows, this.dqs);
    }

    /**
     * A swinging ankle keeps its animated height above the ground under it.
     * A planted foot is pinned: its ball stays where it touched down, on the
     * ground, and the ankle goes wherever the (ground-tilted) foot puts it.
     * The pelvis follows the lower leg, and drops further if a leg could not
     * otherwise reach.
     */
    private solveFeet(dt: number): void {
        const skel = this.set.skel;
        const targets = [vec(), vec()];
        const tilts = [quat(), quat()];
        const n = vec(), rel = vec();
        let lowest = Infinity, reach = Infinity;
        for (let leg = 0; leg < 2; leg++) {
            const ball = this.world.pos[this.toe[leg]];
            const ankle = this.world.pos[this.legs[leg].end];
            const off = this.lockOffset[leg];
            if (this.footLock && this.contact[leg] >= LOCK_CONTACT) {
                if (!this.locked[leg]) {
                    this.locked[leg] = true;
                    this.lockBall[leg].x = ball.x + off.x;
                    this.lockBall[leg].z = ball.z + off.z;
                }
                off.x = this.lockBall[leg].x - ball.x;
                off.z = this.lockBall[leg].z - ball.z;
                const drag = Math.hypot(off.x, off.z);
                if (this.contact[leg] > 0.99) this.stats.maxDrag = Math.max(this.stats.maxDrag, drag);
                if (drag > LOCK_RELEASE) {
                    // Let go, and fade out from at most the release distance.
                    this.locked[leg] = false;
                    this.stats.releases++;
                    off.x *= LOCK_RELEASE / drag;
                    off.z *= LOCK_RELEASE / drag;
                }
            } else {
                this.locked[leg] = false;
                const k = Math.exp(-dt * LOCK_FADE);
                off.x *= k;
                off.z *= k;
            }
            const x = ankle.x + off.x, z = ankle.z + off.z;
            terrainNormal(x, z, n, this.terrainAmplitude);
            limitedFromTo(tilts[leg], UP, n, MAX_FOOT_TILT);
            qSlerp(tilts[leg], quat(), tilts[leg], Math.min(1, this.contact[leg] * 1.5));
            const t = targets[leg];
            t.x = x;
            t.y = terrainHeight(x, z, this.terrainAmplitude) + ankle.y - this.rootPos.y;
            t.z = z;
            if (this.locked[leg]) {
                const w = Math.min(1, (this.contact[leg] - LOCK_CONTACT) / 0.2);
                const bx = this.lockBall[leg].x, bz = this.lockBall[leg].z;
                qRotate(rel, tilts[leg], vSub(rel, ankle, ball));
                t.x += (bx + rel.x - t.x) * w;
                t.y += (terrainHeight(bx, bz, this.terrainAmplitude) + BALL_HEIGHT + rel.y - t.y) * w;
                t.z += (bz + rel.z - t.z) * w;
            }
            lowest = Math.min(lowest, t.y - ankle.y);
            // Highest pelvis shift at which this leg still reaches its target.
            const hip = this.world.pos[this.legs[leg].upper];
            const dh2 = (hip.x - t.x) ** 2 + (hip.z - t.z) ** 2;
            const limit = LEG_REACH * LEG_REACH;
            if (dh2 < limit) reach = Math.min(reach, t.y + Math.sqrt(limit - dh2) - hip.y);
        }
        const want = Math.max(-0.35, Math.min(0.2, lowest));
        this.pelvisOffset += (want - this.pelvisOffset) * (1 - Math.exp(-dt * 14));
        this.pelvisOffset = Math.max(-0.35, Math.min(this.pelvisOffset, reach));
        this.pose.root.y += this.pelvisOffset;
        forwardKinematics(skel, this.pose, this.world, this.rootRot, this.rootPos);
        for (let leg = 0; leg < 2; leg++) {
            const limb = this.legs[leg];
            const endRot = qMul(quat(), tilts[leg], this.world.rot[limb.end]);
            solveTwoBone(skel, this.pose, this.world, limb, targets[leg], null, endRot, this.rootRot);
        }
    }

    /** Foot IK off: drop the pins, so turning it back on starts from the animation. */
    private releaseFeet(): void {
        this.pelvisOffset = 0;
        for (let leg = 0; leg < 2; leg++) {
            this.locked[leg] = false;
            this.lockOffset[leg].x = 0;
            this.lockOffset[leg].z = 0;
        }
    }

    /** The reach target circles in front of the right shoulder, sometimes out of reach. */
    private placeOrb(): void {
        const t = this.time;
        const local = vec(-0.3 + 0.25 * Math.sin(0.9 * t), 1.3 + 0.28 * Math.sin(1.37 * t) + this.pelvisOffset, 0.42 + 0.3 * Math.cos(0.7 * t));
        vAdd(this.orb, this.rootPos, qRotate(local, this.rootRot, local));
    }

    private measureFeet(dt: number): void {
        for (let leg = 0; leg < 2; leg++) {
            const ball = this.world.pos[this.toe[leg]];
            const planted = this.contact[leg] > 0.99 && this.weights[3] < 0.01;
            if (planted) {
                const ground = terrainHeight(ball.x, ball.z, this.terrainAmplitude);
                const e = Math.abs(ball.y - BALL_HEIGHT - ground);
                this.stats.samples++;
                this.stats.error += e;
                this.stats.maxError = Math.max(this.stats.maxError, e);
                if (this.hadBall[leg] && dt > 0) {
                    this.stats.skate += Math.hypot(ball.x - this.lastBall[leg].x, ball.z - this.lastBall[leg].z) / dt;
                }
            }
            this.hadBall[leg] = planted;
            this.lastBall[leg].x = ball.x;
            this.lastBall[leg].y = ball.y;
            this.lastBall[leg].z = ball.z;
        }
    }

    resetStats(): void {
        this.stats.samples = 0;
        this.stats.error = 0;
        this.stats.maxError = 0;
        this.stats.skate = 0;
        this.stats.maxDrag = 0;
        this.stats.releases = 0;
    }

    /** World pose → the character node's frame (rootPos, rootRot), where the skin transforms live. */
    private toLocal(): void {
        const inv = qConj(quat(), this.rootRot);
        const d = vec();
        for (let j = 0; j < this.set.skel.count; j++) {
            qMul(this.local.rot[j], inv, this.world.rot[j]);
            qRotate(this.local.pos[j], inv, vSub(d, this.world.pos[j], this.rootPos));
        }
    }

    /** Height of the ankle sole above the ground, for tests. */
    soleHeight(leg: number): number {
        const a = this.world.pos[this.legs[leg].end];
        return a.y - ANKLE_HEIGHT - terrainHeight(a.x, a.z, this.terrainAmplitude);
    }
}
