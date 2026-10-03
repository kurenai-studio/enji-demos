import { BAKE_FPS, type Clip } from './Clip';
import { qAxisAngle, qEuler, qIdentity, quat, smoothstep, vec, type Quat, type Vec } from './Math3';
import { ANKLE_HEIGHT, forwardKinematics, type Pose, type Skeleton } from './Skeleton';
import { solveTwoBone, type Limb } from './TwoBoneIk';

/**
 * The clips are authored the way an animator would block them on a flat
 * floor: feet placed on the ground, the pelvis and upper body posed by
 * curves, and the legs solved with the same two-bone IK used at run time.
 * The result is baked to 30 Hz keyframes, like an imported mocap clip.
 *
 * In a step the planted foot moves backwards at exactly the root speed, so
 * a character advanced at `clip.speed` keeps its stance foot still.
 */
interface Locomotion {
    kind: 'locomotion';
    name: string;
    period: number;
    /** Fraction of the cycle a foot is planted. */
    stance: number;
    /** Distance a planted foot travels backwards relative to the root (m). */
    stride: number;
    /** Centre of the stance range ahead of the hip (m). */
    zCentre: number;
    pelvisHeight: number;
    bob: number;
    /** Phase of the lowest pelvis point, as a fraction of the stance. */
    bobLow: number;
    lift: number;
    /** Foot pitch at toe-off (rad). */
    toeOff: number;
    armSwing: number;
    elbow: number;
    elbowSwing: number;
    lean: number;
    pelvisYaw: number;
    sway: number;
    footX: number;
}

export const WALK: Locomotion = {
    kind: 'locomotion', name: 'Walk', period: 1.1, stance: 0.62, stride: 0.66, zCentre: 0.03, pelvisHeight: 0.93,
    bob: 0.022, bobLow: 0, lift: 0.07, toeOff: 0.5, armSwing: 0.32, elbow: 0.25, elbowSwing: 0.15, lean: 0.04,
    pelvisYaw: 0.09, sway: 0.02, footX: 0.1,
};

export const RUN: Locomotion = {
    kind: 'locomotion', name: 'Run', period: 0.7, stance: 0.36, stride: 0.8, zCentre: -0.05, pelvisHeight: 0.9,
    bob: 0.035, bobLow: 0.5, lift: 0.2, toeOff: 0.7, armSwing: 0.55, elbow: 1.4, elbowSwing: 0.3, lean: 0.16,
    pelvisYaw: 0.12, sway: 0.01, footX: 0.08,
};

/** Rest offset from the ankle to the ball of the foot (the toe joint). */
const BALL = vec(0, -0.05, 0.13);
/** Heel lift starts at this fraction of the stance. */
const HEEL_OFF = 0.65;
/** Thigh plus shin. */
const LEG_LENGTH = 0.82;
/** How far short of straight an authored leg stays (m). */
const KNEE_SLACK = 0.008;

export interface BakeReport {
    /** Largest distance between an ankle and its authored target over all frames (m). */
    maxMiss: number;
}

interface Rig {
    skel: Skeleton;
    legs: [Limb, Limb];
    j: Record<string, number>;
}

function rig(skel: Skeleton): Rig {
    const names = ['pelvis', 'spine', 'chest', 'neck', 'head', 'upperArm.L', 'forearm.L', 'hand.L', 'upperArm.R', 'forearm.R', 'hand.R', 'thigh.L', 'shin.L', 'foot.L', 'toe.L', 'thigh.R', 'shin.R', 'foot.R', 'toe.R'];
    const j: Record<string, number> = {};
    for (const n of names) j[n] = skel.index(n);
    const leg = (s: string): Limb => ({ upper: j[`thigh.${s}`], middle: j[`shin.${s}`], end: j[`foot.${s}`], bend: vec(0, 0, 1) });
    return { skel, legs: [leg('L'), leg('R')], j };
}

/** Planted foot or swing: ankle target, foot pitch and toe pitch in character space at one leg phase. */
function footAt(g: Locomotion, legPhase: number, side: number, ankle: Vec): { pitch: number; toe: number; planted: boolean } {
    const x = side * g.footX;
    const ballZ = (s: number) => g.zCentre + g.stride / 2 - g.stride * s + BALL.z;
    // Ankle position for a foot pitched by θ about the ball.
    const pivot = (s: number, theta: number) => {
        const bz = ballZ(s);
        const by = ANKLE_HEIGHT + BALL.y;
        const c = Math.cos(theta), sn = Math.sin(theta);
        // Ankle relative to the ball is −BALL, rotated about +x by θ.
        const ry = -BALL.y * c + BALL.z * sn;
        const rz = -BALL.y * sn - BALL.z * c;
        ankle.x = x;
        ankle.y = by + ry;
        ankle.z = bz + rz;
    };
    if (legPhase < g.stance) {
        const s = legPhase / g.stance;
        const h = Math.max(0, (s - HEEL_OFF) / (1 - HEEL_OFF));
        const theta = g.toeOff * h * h;
        pivot(s, theta);
        return { pitch: theta, toe: -theta, planted: true };
    }
    const u = (legPhase - g.stance) / (1 - g.stance);
    const start = vec();
    const end = vec();
    pivot(1, g.toeOff);
    start.y = ankle.y; start.z = ankle.z;
    pivot(0, 0);
    end.y = ankle.y; end.z = ankle.z;
    const e = (1 - Math.cos(Math.PI * u)) / 2;
    ankle.x = x;
    ankle.y = start.y + (end.y - start.y) * e + g.lift * Math.sin(Math.PI * u);
    ankle.z = start.z + (end.z - start.z) * e;
    const pitch = g.toeOff * (1 - smoothstep(0, 0.75, u));
    const toe = -g.toeOff * (1 - smoothstep(0, 0.35, u));
    return { pitch, toe, planted: false };
}

function poseLocomotion(r: Rig, g: Locomotion, phase: number, pose: Pose, ankles: [Vec, Vec], feet: Quat[], toes: number[], contact: number[]): void {
    const { j } = r;
    const tau = 2 * Math.PI;
    for (const q of pose.rot) qIdentity(q);
    const low = g.bobLow * g.stance;
    pose.root.x = g.sway * Math.cos(tau * (phase - g.stance / 2));
    pose.root.y = g.pelvisHeight - 0.95 - g.bob * Math.cos(2 * tau * (phase - low));
    pose.root.z = 0;
    const yaw = -g.pelvisYaw * Math.cos(tau * phase);
    qEuler(pose.rot[j.pelvis], 0, yaw, 0);
    qEuler(pose.rot[j.spine], g.lean * 0.6, -yaw * 0.6, 0);
    qEuler(pose.rot[j.chest], g.lean * 0.4, -yaw * 0.6, 0);
    qEuler(pose.rot[j.neck], -g.lean * 0.5, yaw * 0.1, 0);
    qEuler(pose.rot[j.head], -g.lean * 0.5, yaw * 0.1, 0);
    for (const [s, sign, offset] of [['L', 1, 0.5], ['R', -1, 0]] as const) {
        // Each arm swings with the opposite leg.
        const swing = g.armSwing * Math.cos(tau * (phase - offset));
        qEuler(pose.rot[j[`upperArm.${s}`]], -swing, 0, sign * 0.08);
        qEuler(pose.rot[j[`forearm.${s}`]], -(g.elbow + g.elbowSwing * (swing / g.armSwing)), 0, 0);
    }
    for (let leg = 0; leg < 2; leg++) {
        const legPhase = (phase + leg * 0.5) % 1;
        const f = footAt(g, legPhase, leg === 0 ? 1 : -1, ankles[leg]);
        qAxisAngle(feet[leg], 1, 0, 0, f.pitch);
        toes[leg] = f.toe;
        contact[leg] = f.planted ? 1 : 0;
    }
}

/** Standing: breathing, a slow weight shift and a glance around, both feet planted. */
function poseIdle(r: Rig, phase: number, pose: Pose, ankles: [Vec, Vec], feet: Quat[], toes: number[], contact: number[]): void {
    const { j } = r;
    const tau = 2 * Math.PI;
    for (const q of pose.rot) qIdentity(q);
    pose.root.x = 0.02 * Math.sin(tau * phase);
    pose.root.y = -0.035 + 0.006 * Math.sin(2 * tau * phase);
    pose.root.z = 0;
    qEuler(pose.rot[j.pelvis], 0, 0, -0.03 * Math.sin(tau * phase));
    qEuler(pose.rot[j.chest], -0.03 * Math.sin(2 * tau * phase), 0, 0.02 * Math.sin(tau * phase));
    qEuler(pose.rot[j.head], 0.05, 0.35 * Math.sin(tau * phase) * Math.abs(Math.sin(tau * phase)), 0);
    for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
        qEuler(pose.rot[j[`upperArm.${s}`]], -0.05 + 0.03 * Math.sin(2 * tau * phase), 0, sign * 0.12);
        qEuler(pose.rot[j[`forearm.${s}`]], -0.2, 0, 0);
    }
    for (let leg = 0; leg < 2; leg++) {
        const side = leg === 0 ? 1 : -1;
        ankles[leg].x = side * 0.12;
        ankles[leg].y = ANKLE_HEIGHT;
        ankles[leg].z = side * 0.03;
        qAxisAngle(feet[leg], 0, 1, 0, side * 0.12);
        toes[leg] = 0;
        contact[leg] = 1;
    }
}

/**
 * A warm-up that bends every joint far: a deep squat with the arms raised
 * and the elbows folded, the forearms twisting 150° and the torso turning.
 * It is there to show where linear blend skinning loses volume.
 */
function poseExercise(r: Rig, phase: number, pose: Pose, ankles: [Vec, Vec], feet: Quat[], toes: number[], contact: number[]): void {
    const { j } = r;
    const tau = 2 * Math.PI;
    for (const q of pose.rot) qIdentity(q);
    const k = 0.5 - 0.5 * Math.cos(tau * phase);
    pose.root.x = 0;
    pose.root.y = -0.05 - 0.36 * k;
    pose.root.z = -0.12 * k;
    qEuler(pose.rot[j.spine], 0.3 * k, 0.45 * Math.sin(tau * phase), 0);
    qEuler(pose.rot[j.chest], 0.15 * k, 0.25 * Math.sin(tau * phase), 0);
    qEuler(pose.rot[j.head], -0.4 * k, -0.5 * Math.sin(tau * phase), 0);
    for (const [s, sign] of [['L', 1], ['R', -1]] as const) {
        qEuler(pose.rot[j[`upperArm.${s}`]], -1.45 * k, 0, sign * (0.1 + 0.2 * k));
        qEuler(pose.rot[j[`forearm.${s}`]], -2.3 * k, 0, 0);
        qEuler(pose.rot[j[`hand.${s}`]], 0, sign * 2.6 * Math.sin(Math.PI * phase) ** 2, 0);
    }
    for (let leg = 0; leg < 2; leg++) {
        const side = leg === 0 ? 1 : -1;
        ankles[leg].x = side * 0.16;
        ankles[leg].y = ANKLE_HEIGHT;
        ankles[leg].z = 0;
        qAxisAngle(feet[leg], 0, 1, 0, side * 0.25);
        toes[leg] = 0;
        contact[leg] = 1;
    }
}

export type ClipName = 'Idle' | 'Walk' | 'Run' | 'Exercise';

/** Bakes one clip: author each frame, solve both legs, store local rotations. */
export function bakeClip(skel: Skeleton, name: ClipName, report?: BakeReport): Clip {
    const r = rig(skel);
    const period = name === 'Idle' ? 4 : name === 'Exercise' ? 6 : name === 'Walk' ? WALK.period : RUN.period;
    const frames = Math.round(period * BAKE_FPS);
    const J = skel.count;
    const clip: Clip = {
        name, duration: period, frames, joints: J,
        rot: new Float32Array(frames * J * 4), root: new Float32Array(frames * 3), contact: new Float32Array(frames * 2),
        speed: name === 'Walk' ? WALK.stride / (WALK.stance * WALK.period) : name === 'Run' ? RUN.stride / (RUN.stance * RUN.period) : 0,
    };
    const pose = skel.newPose();
    const global = skel.newGlobal();
    const ankles: [Vec, Vec] = [vec(), vec()];
    const feet = [quat(), quat()];
    const toes = [0, 0];
    const contact = [0, 0];
    for (let f = 0; f < frames; f++) {
        const phase = f / frames;
        if (name === 'Walk' || name === 'Run') poseLocomotion(r, name === 'Walk' ? WALK : RUN, phase, pose, ankles, feet, toes, contact);
        else if (name === 'Idle') poseIdle(r, phase, pose, ankles, feet, toes, contact);
        else poseExercise(r, phase, pose, ankles, feet, toes, contact);
        forwardKinematics(skel, pose, global);
        // Drop the hips wherever a leg would have to straighten fully (heel strike, toe-off).
        let drop = 0;
        for (let leg = 0; leg < 2; leg++) {
            const hip = global.pos[r.legs[leg].upper];
            const limit = LEG_LENGTH - KNEE_SLACK;
            const dy = hip.y - ankles[leg].y;
            const dh2 = (hip.x - ankles[leg].x) ** 2 + (hip.z - ankles[leg].z) ** 2;
            if (dy * dy + dh2 > limit * limit) drop = Math.max(drop, dy - Math.sqrt(Math.max(0, limit * limit - dh2)));
        }
        if (drop > 0) {
            pose.root.y -= drop;
            forwardKinematics(skel, pose, global);
        }
        for (let leg = 0; leg < 2; leg++) {
            const res = solveTwoBone(skel, pose, global, r.legs[leg], ankles[leg], null, feet[leg]);
            if (report) report.maxMiss = Math.max(report.maxMiss, res.miss);
            qAxisAngle(pose.rot[r.j[leg === 0 ? 'toe.L' : 'toe.R']], 1, 0, 0, toes[leg]);
        }
        for (let jj = 0; jj < J; jj++) {
            const q = pose.rot[jj];
            clip.rot.set([q.x, q.y, q.z, q.w], (f * J + jj) * 4);
        }
        clip.root.set([pose.root.x, pose.root.y, pose.root.z], f * 3);
        clip.contact.set(contact, f * 2);
    }
    return clip;
}
