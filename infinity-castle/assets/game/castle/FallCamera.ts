import { Camera, Quat, Vec3 } from 'cc';

const UP = new Vec3(0, 1, 0);

function noise1(t: number): number {
    return Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.1 + 1.3) * 0.3 + Math.sin(t * 5.9 + 2.1) * 0.2;
}

/**
 * The endless fall: spirals down the shaft within 3 m of its axis, mostly
 * looking down, heading slowly turning, with a rolling sway like `fall_pose`
 * in the Blender script. Mouse drag adds a look offset on top.
 */
export class FallCamera {
    depth = 0;
    speed = 10;
    paused = false;
    yawOffset = 0;
    pitchOffset = 0;
    private time = 0;
    private readonly rot = new Quat();
    readonly position = new Vec3();

    constructor(readonly camera: Camera) {}

    update(dt: number): void {
        if (!this.paused) {
            this.depth += this.speed * dt;
            this.time += dt;
        }
        this.apply();
    }

    apply(): void {
        const s = this.depth;
        const t = this.time;
        const r = 2.0 + 0.8 * Math.sin(s * 0.021);
        const th = s * 0.045;
        this.position.set(r * Math.cos(th), -s, r * Math.sin(th));

        const heading = 20 + s * 0.55 + this.yawOffset;
        const pitch = Math.max(-89, Math.min(40, -70 + 14 * Math.sin(s * 0.013 + 1) + this.pitchOffset));
        const shake = Math.min(this.speed / 20, 1.5);
        const roll = 7 * Math.sin(t * 0.5) + shake * 2.5 * noise1(t * 2.2);
        const pitchShake = shake * 0.8 * noise1(t * 2.7 + 11);

        Quat.fromAxisAngle(this.rot, UP, (heading * Math.PI) / 180);
        Quat.rotateX(this.rot, this.rot, ((pitch + pitchShake) * Math.PI) / 180);
        Quat.rotateZ(this.rot, this.rot, (roll * Math.PI) / 180);
        this.camera.node.setPosition(this.position);
        this.camera.node.setRotation(this.rot);
    }
}
