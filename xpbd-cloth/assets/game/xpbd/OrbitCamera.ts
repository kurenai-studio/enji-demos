import { Camera, clamp, screen, toDegree, toRadian, Vec3 } from 'cc';

/**
 * Orbit controller in the style of three.js OrbitControls: drag rotates around
 * `target` with damping, wheel or pinch dollies between min and max distance.
 */
export class OrbitCamera {
    readonly target = new Vec3(0, 0.75, 0);
    minDistance = 1.5;
    maxDistance = 12;
    /** Fraction of the pending rotation applied per 60 Hz frame. */
    dampingFactor = 0.12;

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

    /** Multiplies the distance; below 1 moves closer. */
    dolly(scale: number): void {
        this.distance = clamp(this.distance * scale, this.minDistance, this.maxDistance);
    }

    update(dt: number): void {
        const k = 1 - Math.pow(1 - this.dampingFactor, dt * 60);
        this.yaw += this.pendingYaw * k;
        this.pitch += this.pendingPitch * k;
        this.pendingYaw *= 1 - k;
        this.pendingPitch *= 1 - k;
        this.pitch = clamp(this.pitch, toRadian(3), toRadian(85));
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

        // Vertical FOV of at least 45 degrees, widened so portrait screens still see 42 degrees across.
        const size = screen.windowSize;
        const aspect = size.width / Math.max(1, size.height);
        const vFovFromH = 2 * Math.atan(Math.tan(toRadian(42) / 2) / aspect);
        this.camera.fov = clamp(toDegree(vFovFromH), 45, 75);
    }
}
