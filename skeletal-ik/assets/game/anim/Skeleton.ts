import { qCopy, qMul, qRotate, quat, vAdd, vec, vCopy, type Quat, type Vec } from './Math3';

/**
 * A joint hierarchy whose bind pose has identity rotations everywhere, so a
 * joint's rest offset is the same in its parent's frame and in the
 * character's. The character faces +z with y up; its left side is +x.
 */
export interface JointDef {
    name: string;
    parent: number;
    /** Rest offset from the parent joint (for the root: from the character origin). */
    offset: Vec;
}

/** Local joint rotations plus a translation of the root joint away from its rest offset. */
export interface Pose {
    rot: Quat[];
    root: Vec;
}

/** Joint rotations and positions in one frame (character or world). */
export interface GlobalPose {
    rot: Quat[];
    pos: Vec[];
}

export class Skeleton {
    readonly joints: JointDef[];
    /** Bind-pose joint positions in character space. */
    readonly bind: Vec[];
    private readonly byName = new Map<string, number>();

    constructor(joints: JointDef[]) {
        this.joints = joints;
        this.bind = [];
        joints.forEach((j, i) => {
            if (j.parent >= i) throw new Error(`joint ${j.name}: parents must come first`);
            this.byName.set(j.name, i);
            this.bind.push(j.parent < 0 ? vCopy(vec(), j.offset) : vAdd(vec(), this.bind[j.parent], j.offset));
        });
    }

    get count(): number {
        return this.joints.length;
    }

    index(name: string): number {
        const i = this.byName.get(name);
        if (i === undefined) throw new Error(`no joint ${name}`);
        return i;
    }

    newPose(): Pose {
        return { rot: this.joints.map(() => quat()), root: vec() };
    }

    newGlobal(): GlobalPose {
        return { rot: this.joints.map(() => quat()), pos: this.joints.map(() => vec()) };
    }
}

const tmp = vec();

/**
 * Forward kinematics: global rotations and positions of every joint, with
 * the whole character placed by (rootRot, rootPos).
 */
export function forwardKinematics(skel: Skeleton, pose: Pose, out: GlobalPose, rootRot: Quat = quat(), rootPos: Vec = vec()): GlobalPose {
    const joints = skel.joints;
    for (let i = 0; i < joints.length; i++) {
        const j = joints[i];
        if (j.parent < 0) {
            qMul(out.rot[i], rootRot, pose.rot[i]);
            vAdd(tmp, j.offset, pose.root);
            vAdd(out.pos[i], rootPos, qRotate(tmp, rootRot, tmp));
        } else {
            const pr = out.rot[j.parent];
            qMul(out.rot[i], pr, pose.rot[i]);
            vAdd(out.pos[i], out.pos[j.parent], qRotate(tmp, pr, j.offset));
        }
    }
    return out;
}

/** Local rotation of joint i that gives it global rotation `g` under its parent's current global rotation. */
export function localFromGlobal(skel: Skeleton, global: GlobalPose, i: number, g: Quat, out: Quat, rootRot: Quat = quat()): Quat {
    const p = skel.joints[i].parent;
    const pr = p < 0 ? rootRot : global.rot[p];
    const inv = quat(-pr.x, -pr.y, -pr.z, pr.w);
    return qMul(out, inv, g);
}

export function copyPose(out: Pose, a: Pose): Pose {
    for (let i = 0; i < a.rot.length; i++) qCopy(out.rot[i], a.rot[i]);
    vCopy(out.root, a.root);
    return out;
}

/** Humanoid of 19 joints, 1.75 m tall, standing on y = 0. */
export function humanoid(): Skeleton {
    const j: JointDef[] = [];
    const add = (name: string, parent: string | null, x: number, y: number, z: number): void => {
        j.push({ name, parent: parent === null ? -1 : j.findIndex((p) => p.name === parent), offset: vec(x, y, z) });
    };
    add('pelvis', null, 0, 0.95, 0);
    add('spine', 'pelvis', 0, 0.1, 0);
    add('chest', 'spine', 0, 0.2, 0);
    add('neck', 'chest', 0, 0.22, 0);
    add('head', 'neck', 0, 0.1, 0);
    for (const [side, s] of [['L', 1], ['R', -1]] as const) {
        add(`upperArm.${side}`, 'chest', 0.19 * s, 0.17, 0);
        add(`forearm.${side}`, `upperArm.${side}`, 0, -0.28, 0);
        add(`hand.${side}`, `forearm.${side}`, 0, -0.25, 0);
    }
    for (const [side, s] of [['L', 1], ['R', -1]] as const) {
        add(`thigh.${side}`, 'pelvis', 0.1 * s, -0.05, 0);
        add(`shin.${side}`, `thigh.${side}`, 0, -0.42, 0);
        add(`foot.${side}`, `shin.${side}`, 0, -0.4, 0);
        add(`toe.${side}`, `foot.${side}`, 0, -0.05, 0.13);
    }
    return new Skeleton(j);
}

/** Ankle height above the sole in the bind pose. */
export const ANKLE_HEIGHT = 0.08;
