import { copy, mat3, quat, quatToMat, rotateDiagonal, v3 } from './Math3';
import type { Mat3, Quat, V3 } from './Math3';

/** Shapes are ordered: the narrow phase always receives the lower kind as body A. */
export const Shape = { Plane: 0, Box: 1, Sphere: 2 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

export interface BodyDef {
    shape: Shape;
    /** Box half extents. */
    half?: V3;
    radius?: number;
    position: V3;
    rotation?: Quat;
    velocity?: V3;
    /** kg/m³; 0 makes the body static. */
    density: number;
    friction?: number;
    color?: readonly [number, number, number];
    /** Drift-metric group (1..3) for bodies that should stay where they were placed; 0 is untracked. */
    group?: number;
}

export class RigidBody {
    readonly id: number;
    readonly shape: Shape;
    readonly half: V3;
    readonly radius: number;
    readonly p: V3;
    readonly q: Quat;
    readonly v = v3();
    readonly w = v3();
    readonly R: Mat3 = mat3();
    readonly invMass: number;
    readonly invInertia: V3;
    readonly invInertiaWorld: Mat3 = mat3();
    readonly friction: number;
    readonly color: readonly [number, number, number];
    readonly group: number;
    readonly restPosition: V3;
    /** Pose at the start of the step, for the soft step's separation update. */
    readonly p0 = v3();
    readonly R0: Mat3 = mat3();
    readonly aabbMin = v3();
    readonly aabbMax = v3();
    /** Bounding radius, for the broad phase. */
    readonly extent: number;

    constructor(id: number, def: BodyDef) {
        this.id = id;
        this.shape = def.shape;
        this.half = def.half ? v3(def.half.x, def.half.y, def.half.z) : v3();
        this.radius = def.radius ?? 0;
        this.p = v3(def.position.x, def.position.y, def.position.z);
        this.q = def.rotation ? quat(def.rotation.x, def.rotation.y, def.rotation.z, def.rotation.w) : quat();
        if (def.velocity) copy(this.v, def.velocity);
        this.friction = def.friction ?? 0.6;
        this.color = def.color ?? [0.8, 0.8, 0.8];
        this.group = def.group ?? 0;
        this.restPosition = v3(this.p.x, this.p.y, this.p.z);

        const { x: hx, y: hy, z: hz } = this.half;
        if (def.density <= 0 || this.shape === Shape.Plane) {
            this.invMass = 0;
            this.invInertia = v3();
        } else if (this.shape === Shape.Box) {
            const m = def.density * 8 * hx * hy * hz;
            this.invMass = 1 / m;
            const k = 3 / m;
            this.invInertia = v3(k / (hy * hy + hz * hz), k / (hx * hx + hz * hz), k / (hx * hx + hy * hy));
        } else {
            const r = this.radius;
            const m = (def.density * 4 * Math.PI * r * r * r) / 3;
            this.invMass = 1 / m;
            const i = 1 / (0.4 * m * r * r);
            this.invInertia = v3(i, i, i);
        }
        this.extent = this.shape === Shape.Box ? Math.sqrt(hx * hx + hy * hy + hz * hz) : this.radius;
        this.updateDerived();
    }

    get isStatic(): boolean {
        return this.invMass === 0;
    }

    /** Rotation matrix and world inverse inertia from the orientation. */
    updateDerived(): void {
        quatToMat(this.R, this.q);
        if (this.invMass > 0) rotateDiagonal(this.invInertiaWorld, this.R, this.invInertia);
    }

    /** Fattened by `margin` plus the distance covered this step, so fast bodies get speculative contacts in time. */
    updateBounds(margin: number, h: number): void {
        if (this.shape === Shape.Plane) {
            this.aabbMin.x = this.aabbMin.z = -1e9;
            this.aabbMax.x = this.aabbMax.z = 1e9;
            this.aabbMin.y = -1e9;
            this.aabbMax.y = this.p.y + margin;
            return;
        }
        margin += this.sweep(h);
        let ex = this.radius + margin, ey = ex, ez = ex;
        if (this.shape === Shape.Box) {
            const r = this.R, h = this.half;
            ex = Math.abs(r[0]) * h.x + Math.abs(r[1]) * h.y + Math.abs(r[2]) * h.z + margin;
            ey = Math.abs(r[3]) * h.x + Math.abs(r[4]) * h.y + Math.abs(r[5]) * h.z + margin;
            ez = Math.abs(r[6]) * h.x + Math.abs(r[7]) * h.y + Math.abs(r[8]) * h.z + margin;
        }
        this.aabbMin.x = this.p.x - ex; this.aabbMax.x = this.p.x + ex;
        this.aabbMin.y = this.p.y - ey; this.aabbMax.y = this.p.y + ey;
        this.aabbMin.z = this.p.z - ez; this.aabbMax.z = this.p.z + ez;
    }

    /** Upper bound on how far any point of the body moves in `h`, capped to keep speculative contacts local. */
    sweep(h: number): number {
        if (this.invMass === 0) return 0;
        const v = Math.sqrt(this.v.x * this.v.x + this.v.y * this.v.y + this.v.z * this.v.z);
        const w = Math.sqrt(this.w.x * this.w.x + this.w.y * this.w.y + this.w.z * this.w.z);
        return Math.min(0.25, (v + w * this.extent) * h);
    }
}
