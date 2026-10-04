import { Node, Quat, Vec3 } from 'cc';
import type { HandPose } from './Hand';

const q = new Quat();
const ex = new Vec3(), ey = new Vec3(), ez = new Vec3();

/** Puts the gauntlet model (laid out in hand space, see tools/gauntlet.py) at `pose`, matching `toWorld`. */
export function placeGauntlet(node: Node, pose: HandPose): void {
    const cy = Math.cos(pose.yaw), sy = Math.sin(pose.yaw), cl = Math.cos(pose.lean), sl = Math.sin(pose.lean);
    // Columns of toWorld(): hand x → across, y → up the leaning arm, z → push.
    ex.set(sy, 0, -cy);
    ey.set(-sl * cy, cl, -sl * sy);
    ez.set(cl * cy, sl, cl * sy);
    Quat.fromAxes(q, ex, ey, ez);
    node.setPosition(pose.x, pose.y, pose.z);
    node.setRotation(q);
}
