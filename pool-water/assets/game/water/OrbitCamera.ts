import { Camera, clamp, screen, toDegree, toRadian, Vec3 } from 'cc';

/**
 * Orbit controller in the style of three.js OrbitControls: drag rotates around
 * `target` with damping, the wheel dollies between min and max distance.
 */
export class OrbitCamera {
    readonly target = new Vec3(0, -0.35, 0);
    minDistance = 1.2;
    maxDistance = 14;
    /** Fraction of the pending rotation applied per 60 Hz frame. */
    dampingFactor = 0.08;

    private yaw: number;
    private pitch: number;
    private distance: number;
    private pendingYaw = 0;
    private pendingPitch = 0;
    private readonly position = new Vec3();

    constructor(readonly camera: Camera, eye: Readonly<Vec3>) {
        const offset = Vec3.subtract(new Vec3(), eye, this.target);
        this.distance = offset.length();
        this.yaw = Math.atan2(offset.x, offset.z);
        this.pitch = Math.asin(offset.y / this.distance);
        this.apply();
    }

    /** Rotation from a pointer drag, in fractions of the viewport height (UI axes, y up). */
    rotate(dxFraction: number, dyFraction: number): void {
        this.pendingYaw -= 2 * Math.PI * dxFraction;
        this.pendingPitch -= 2 * Math.PI * dyFraction;
    }

    /** Wheel dolly; positive `wheelDelta` (scroll down) moves away, like OrbitControls. */
    zoom(wheelDelta: number): void {
        const scale = Math.pow(0.95, Math.abs(wheelDelta) * 0.01);
        this.distance = clamp(wheelDelta > 0 ? this.distance / scale : this.distance * scale, this.minDistance, this.maxDistance);
    }

    update(dt: number): void {
        const k = 1 - Math.pow(1 - this.dampingFactor, dt * 60);
        this.yaw += this.pendingYaw * k;
        this.pitch += this.pendingPitch * k;
        this.pendingYaw *= 1 - k;
        this.pendingPitch *= 1 - k;
        const limit = Math.PI / 2 - 1e-4;
        this.pitch = clamp(this.pitch, -limit, limit);
        this.apply();
    }

    private apply(): void {
        const horizontal = Math.cos(this.pitch) * this.distance;
        this.position.set(
            this.target.x + Math.sin(this.yaw) * horizontal,
            this.target.y + Math.sin(this.pitch) * this.distance,
            this.target.z + Math.cos(this.yaw) * horizontal,
        );
        const node = this.camera.node;
        node.setPosition(this.position);
        node.lookAt(this.target);

        // Vertical FOV of at least 45 degrees, widened so portrait screens still see 55 degrees across.
        const size = screen.windowSize;
        const aspect = size.width / Math.max(1, size.height);
        const vFovFromH = 2 * Math.atan(Math.tan(toRadian(55) / 2) / aspect);
        this.camera.fov = clamp(toDegree(vFovFromH), 45, 80);
    }
}
