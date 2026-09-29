import { clamp, Vec3 } from 'cc';

const GRAVITY = new Vec3(0, -4, 0);
const scratch = new Vec3();

/**
 * The floating ball: gravity, buoyancy proportional to the submerged fraction,
 * quadratic drag in water and a damped bounce off the pool floor. Positions are
 * in pool space (walls at x, z = +-1, floor at y = -1).
 */
export class FloatingSphere {
    readonly center = new Vec3(-0.4, -0.75, 0.2);
    /** Centre at the previous physics step; the simulation displaces the difference. */
    readonly oldCenter = new Vec3(-0.4, -0.75, 0.2);
    readonly velocity = new Vec3();
    radius = 0.25;
    gravity = false;
    dragging = false;

    step(dt: number): void {
        const r = this.radius;
        if (this.dragging) {
            this.velocity.set(0, 0, 0);
            return;
        }
        if (!this.gravity) return;

        const underwater = clamp((r - this.center.y) / (2 * r), 0, 1);
        Vec3.scaleAndAdd(this.velocity, this.velocity, GRAVITY, dt - 1.1 * dt * underwater);
        const speedSq = this.velocity.lengthSqr();
        if (speedSq > 0) {
            const drag = Math.min(underwater * dt * speedSq, Math.sqrt(speedSq));
            Vec3.normalize(scratch, this.velocity);
            Vec3.scaleAndAdd(this.velocity, this.velocity, scratch, -drag);
        }
        Vec3.scaleAndAdd(this.center, this.center, this.velocity, dt);
        if (this.center.y < r - 1) {
            this.center.y = r - 1;
            this.velocity.y = Math.abs(this.velocity.y) * 0.7;
        }
        this.clampToPool();
    }

    /** Moves the centre by `delta` (dragging), kept inside the pool. */
    moveBy(delta: Readonly<Vec3>): void {
        this.center.add(delta);
        this.clampToPool();
    }

    /** Drops the ball from above the pool with gravity on. */
    dropFromAbove(): void {
        this.center.set((Math.random() - 0.5) * 0.8, 1.4, (Math.random() - 0.5) * 0.8);
        this.oldCenter.set(this.center);
        this.velocity.set(0, 0, 0);
        this.clampToPool();
        this.gravity = true;
    }

    /** Remembers the current centre as the previous one (after the water was displaced). */
    commitMove(): void {
        this.oldCenter.set(this.center);
    }

    clampToPool(): void {
        const r = this.radius;
        this.center.x = clamp(this.center.x, r - 1, 1 - r);
        this.center.y = clamp(this.center.y, r - 1, 10);
        this.center.z = clamp(this.center.z, r - 1, 1 - r);
    }
}
