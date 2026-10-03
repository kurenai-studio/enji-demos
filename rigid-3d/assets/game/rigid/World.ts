import { collide, ContactBuffer } from './Collide';
import {
    addScaled, copy, cross, dot, integrateRotation, mulMat, mulMatT, rotateDelta, set, sub, tangents, v3,
} from './Math3';
import type { V3 } from './Math3';
import { RigidBody, Shape } from './RigidBody';
import type { BodyDef } from './RigidBody';

export const Solver = { Naive: 0, Sequential: 1, Soft: 2 } as const;
export type Solver = (typeof Solver)[keyof typeof Solver];
export const SOLVER_NAMES = ['Naive impulses', 'Sequential impulses', 'Soft step'] as const;
export const SOLVER_SHORT = ['Naive', 'SI', 'Soft'] as const;

interface ContactPoint {
    /** Anchors in each body's frame, used to match points between frames. */
    readonly la: V3;
    readonly lb: V3;
    /** Offsets from the centres of mass at the start of the step. */
    readonly rA: V3;
    readonly rB: V3;
    s: number;
    /** Separation minus the anchor offset along the normal (soft step). */
    adjusted: number;
    normalMass: number;
    tangentMass1: number;
    tangentMass2: number;
    bias: number;
    jn: number;
    jt1: number;
    jt2: number;
}

class Manifold {
    a: RigidBody;
    b: RigidBody;
    readonly normal = v3();
    readonly t1 = v3();
    readonly t2 = v3();
    readonly points: ContactPoint[] = Array.from({ length: 4 }, () => ({
        la: v3(), lb: v3(), rA: v3(), rB: v3(), s: 0, adjusted: 0,
        normalMass: 0, tangentMass1: 0, tangentMass2: 0, bias: 0, jn: 0, jt1: 0, jt2: 0,
    }));
    count = 0;
    friction = 0.6;
    stamp = 0;

    constructor(a: RigidBody, b: RigidBody) {
        this.a = a;
        this.b = b;
    }
}

export interface WorldStats {
    stepMs: number;
    manifolds: number;
    contacts: number;
    /** Deepest overlap found by the narrow phase this step, metres. */
    maxPenetration: number;
    /** Largest displacement of a tracked body from where it was placed, metres. */
    maxDrift: number;
    /** Tracked bodies more than DRIFT_LIMIT from their start, overall and per group (index 1..3). */
    moved: number;
    tracked: number;
    groupMoved: number[];
    groupTotal: number[];
}

export const DRIFT_LIMIT = 0.02;
/** Old and new points within this distance (in both bodies' frames) are the same contact. */
const MATCH_DISTANCE = 0.02;
const MAX_ANGULAR_SPEED = 50;
export const BALL_POOL = 6;

const now = (): number => (globalThis.performance ? globalThis.performance.now() : Date.now());

/**
 * Rigid boxes and spheres on a ground plane with persistent contact
 * manifolds and three velocity solvers:
 *  - Naive: per-iteration clamping, no warm start (what not to do).
 *  - Sequential impulses: accumulated clamping, warm starting, Baumgarte (Catto 2005, Box2D-lite).
 *  - Soft step: substeps with soft contacts and a relax pass (Box2D v3, Catto 2024).
 */
export class World {
    readonly bodies: RigidBody[] = [];
    gravity = -9.81;
    solver: Solver = Solver.Sequential;
    /** Velocity iterations for the two PGS solvers. */
    iterations = 10;
    /** Substeps for the soft step (one solve and one relax each). */
    substeps = 4;
    /** Speculative distance: pairs this close get contact points. */
    margin = 0.02;
    slop = 0.005;
    baumgarte = 0.2;
    /** Capped at a quarter of the substep rate; 30 Hz lets a ten-box tower lean on its own compression. */
    contactHertz = 60;
    dampingRatio = 10;
    maxPushVelocity = 3;
    angularDamping = 0.05;
    /** Extra angular damping for spheres, standing in for rolling resistance. */
    rollingDamping = 0.6;
    readonly stats: WorldStats = {
        stepMs: 0, manifolds: 0, contacts: 0, maxPenetration: 0, maxDrift: 0, moved: 0, tracked: 0,
        groupMoved: [0, 0, 0, 0], groupTotal: [0, 0, 0, 0],
    };
    time = 0;

    private readonly manifolds = new Map<number, Manifold>();
    private readonly active: Manifold[] = [];
    private readonly pool: Manifold[] = [];
    private readonly order: number[] = [];
    private readonly buffer = new ContactBuffer();
    private readonly balls: RigidBody[] = [];
    private ballCursor = 0;
    private stamp = 0;
    private nextId = 0;

    add(def: BodyDef): RigidBody {
        const body = new RigidBody(this.nextId++, def);
        this.order.push(this.bodies.length);
        this.bodies.push(body);
        return body;
    }

    /** Fires a ball from `origin` along the unit vector `dir`, reusing the oldest once the pool is full. */
    shoot(origin: V3, dir: V3, speed: number, radius = 0.16, density = 1200): RigidBody {
        let ball: RigidBody;
        if (this.balls.length < BALL_POOL) {
            ball = this.add({ shape: Shape.Sphere, radius, position: origin, density, friction: 0.4, color: [0.92, 0.9, 0.86] });
            this.balls.push(ball);
        } else {
            ball = this.balls[this.ballCursor];
            this.ballCursor = (this.ballCursor + 1) % BALL_POOL;
            this.forget(ball);
            copy(ball.p, origin);
            set(ball.w, 0, 0, 0);
        }
        set(ball.v, dir.x * speed, dir.y * speed, dir.z * speed);
        ball.updateDerived();
        return ball;
    }

    step(h: number): void {
        const t0 = now();
        this.time += h;
        this.findContacts(h);
        if (this.solver === Solver.Soft) this.softStep(h);
        else this.pgsStep(h, this.solver === Solver.Sequential);
        this.measureDrift();
        this.stats.stepMs = now() - t0;
    }

    // ------------------------------------------------------------ contacts

    private findContacts(h: number): void {
        const bodies = this.bodies, order = this.order;
        for (const b of bodies) b.updateBounds(this.margin, h);
        // Sweep and prune along x; insertion sort is cheap because the order barely changes between steps.
        for (let i = 1; i < order.length; i++) {
            const k = order[i], key = bodies[k].aabbMin.x;
            let j = i - 1;
            while (j >= 0 && bodies[order[j]].aabbMin.x > key) { order[j + 1] = order[j]; j--; }
            order[j + 1] = k;
        }
        const stamp = ++this.stamp;
        const st = this.stats;
        st.maxPenetration = 0;
        st.contacts = 0;
        for (let i = 0; i < order.length; i++) {
            const a = bodies[order[i]];
            for (let j = i + 1; j < order.length; j++) {
                const b = bodies[order[j]];
                if (b.aabbMin.x > a.aabbMax.x) break;
                if (a.isStatic && b.isStatic) continue;
                if (b.aabbMin.y > a.aabbMax.y || a.aabbMin.y > b.aabbMax.y) continue;
                if (b.aabbMin.z > a.aabbMax.z || a.aabbMin.z > b.aabbMax.z) continue;
                // Fixed order per pair (shape, then id), so a manifold's normal keeps its direction between steps.
                const aFirst = a.shape < b.shape || (a.shape === b.shape && a.id < b.id);
                const lo = aFirst ? a : b, hi = aFirst ? b : a;
                if (!collide(lo, hi, this.margin + lo.sweep(h) + hi.sweep(h), this.buffer)) continue;
                this.updateManifold(lo, hi, stamp);
            }
        }
        // Drop pairs that stopped touching.
        const active = this.active;
        active.length = 0;
        for (const [key, m] of this.manifolds) {
            if (m.stamp !== stamp) {
                this.manifolds.delete(key);
                this.pool.push(m);
            } else {
                active.push(m);
                st.contacts += m.count;
                for (let k = 0; k < m.count; k++) st.maxPenetration = Math.max(st.maxPenetration, -m.points[k].s);
            }
        }
        st.manifolds = active.length;
    }

    private updateManifold(a: RigidBody, b: RigidBody, stamp: number): void {
        const key = a.id < b.id ? a.id * 65536 + b.id : b.id * 65536 + a.id;
        let m = this.manifolds.get(key);
        const buf = this.buffer;
        const warm = this.solver !== Solver.Naive;
        if (!m) {
            m = this.pool.pop() ?? new Manifold(a, b);
            m.count = 0;
            this.manifolds.set(key, m);
        }
        m.a = a;
        m.b = b;
        // A flipped normal (edge case in the SAT) invalidates the old impulses.
        const keepOld = warm && m.count > 0 && dot(m.normal, buf.normal) > 0.95;
        const oldCount = keepOld ? m.count : 0;
        // Stash the old points' matching data in the scratch arrays.
        for (let k = 0; k < oldCount; k++) {
            const op = m.points[k];
            oldAnchor[k * 6] = op.la.x; oldAnchor[k * 6 + 1] = op.la.y; oldAnchor[k * 6 + 2] = op.la.z;
            oldAnchor[k * 6 + 3] = op.lb.x; oldAnchor[k * 6 + 4] = op.lb.y; oldAnchor[k * 6 + 5] = op.lb.z;
            oldImpulse[k * 3] = op.jn; oldImpulse[k * 3 + 1] = op.jt1; oldImpulse[k * 3 + 2] = op.jt2;
        }
        copy(m.normal, buf.normal);
        tangents(m.normal, m.t1, m.t2);
        m.friction = Math.sqrt(a.friction * b.friction);
        m.count = buf.count;
        m.stamp = stamp;
        const tol2 = MATCH_DISTANCE * MATCH_DISTANCE;
        for (let k = 0; k < buf.count; k++) {
            const raw = buf.points[k], cp = m.points[k];
            mulMatT(cp.la, a.R, sub(cp.la, raw.p, a.p));
            mulMatT(cp.lb, b.R, sub(cp.lb, raw.p, b.p));
            cp.s = raw.s;
            cp.jn = cp.jt1 = cp.jt2 = 0;
            for (let o = 0; o < oldCount; o++) {
                const dxa = cp.la.x - oldAnchor[o * 6], dya = cp.la.y - oldAnchor[o * 6 + 1], dza = cp.la.z - oldAnchor[o * 6 + 2];
                const dxb = cp.lb.x - oldAnchor[o * 6 + 3], dyb = cp.lb.y - oldAnchor[o * 6 + 4], dzb = cp.lb.z - oldAnchor[o * 6 + 5];
                if (dxa * dxa + dya * dya + dza * dza < tol2 || dxb * dxb + dyb * dyb + dzb * dzb < tol2) {
                    cp.jn = oldImpulse[o * 3];
                    cp.jt1 = oldImpulse[o * 3 + 1];
                    cp.jt2 = oldImpulse[o * 3 + 2];
                    break;
                }
            }
        }
    }

    /** Removes a body's manifolds, so a teleported body does not inherit stale impulses. */
    private forget(body: RigidBody): void {
        for (const [key, m] of this.manifolds) {
            if (m.a === body || m.b === body) {
                this.manifolds.delete(key);
                this.pool.push(m);
            }
        }
    }

    // ------------------------------------------------------------ shared pieces

    private integrateVelocities(h: number): void {
        const g = this.gravity * h;
        for (const b of this.bodies) {
            if (b.isStatic) continue;
            b.v.y += g;
            const damp = this.angularDamping + (b.shape === Shape.Sphere ? this.rollingDamping : 0);
            const k = 1 / (1 + h * damp);
            b.w.x *= k; b.w.y *= k; b.w.z *= k;
            const w2 = dot(b.w, b.w);
            if (w2 > MAX_ANGULAR_SPEED * MAX_ANGULAR_SPEED) {
                const s = MAX_ANGULAR_SPEED / Math.sqrt(w2);
                b.w.x *= s; b.w.y *= s; b.w.z *= s;
            }
        }
    }

    private integratePositions(h: number): void {
        for (const b of this.bodies) {
            if (b.isStatic) continue;
            addScaled(b.p, b.p, b.v, h);
            integrateRotation(b.q, b.w, h);
            b.updateDerived();
        }
    }

    /** Anchors and effective masses from the current poses. */
    private prepare(): void {
        for (const m of this.active) {
            const a = m.a, b = m.b;
            for (let k = 0; k < m.count; k++) {
                const cp = m.points[k];
                mulMat(cp.rA, a.R, cp.la);
                mulMat(cp.rB, b.R, cp.lb);
                cp.normalMass = 1 / effectiveMass(a, b, cp.rA, cp.rB, m.normal);
                cp.tangentMass1 = 1 / effectiveMass(a, b, cp.rA, cp.rB, m.t1);
                cp.tangentMass2 = 1 / effectiveMass(a, b, cp.rA, cp.rB, m.t2);
                cp.adjusted = cp.s - (dot(cp.rB, m.normal) - dot(cp.rA, m.normal));
            }
        }
    }

    private warmStart(): void {
        for (const m of this.active) {
            for (let k = 0; k < m.count; k++) {
                const cp = m.points[k];
                set(impulse,
                    m.normal.x * cp.jn + m.t1.x * cp.jt1 + m.t2.x * cp.jt2,
                    m.normal.y * cp.jn + m.t1.y * cp.jt1 + m.t2.y * cp.jt2,
                    m.normal.z * cp.jn + m.t1.z * cp.jt1 + m.t2.z * cp.jt2);
                applyImpulse(m.a, m.b, cp.rA, cp.rB, impulse);
            }
        }
    }

    // ------------------------------------------------------------ PGS (naive and sequential impulses)

    private pgsStep(h: number, accumulate: boolean): void {
        this.integrateVelocities(h);
        this.prepare();
        const inv = 1 / h;
        for (const m of this.active) {
            for (let k = 0; k < m.count; k++) {
                const cp = m.points[k];
                // Speculative points let the gap close in one step; overlaps are pushed out with Baumgarte.
                cp.bias = cp.s > 0 ? cp.s * inv : -this.baumgarte * inv * Math.max(0, -cp.s - this.slop);
                if (!accumulate) cp.jn = cp.jt1 = cp.jt2 = 0;
            }
        }
        if (accumulate) this.warmStart();
        for (let it = 0; it < this.iterations; it++) {
            for (const m of this.active) {
                if (accumulate) solveAccumulated(m);
                else solveNaive(m);
            }
        }
        this.integratePositions(h);
    }

    // ------------------------------------------------------------ soft step

    private softStep(h: number): void {
        const n = this.substeps;
        const hs = h / n;
        for (const b of this.bodies) {
            copy(b.p0, b.p);
            b.R0.set(b.R);
        }
        this.prepare();
        // Contact softness (Catto, "Solver2D"): stiffness from a frequency and damping ratio, clamped to the substep rate.
        const hertz = Math.min(this.contactHertz, 0.25 / hs);
        const omega = 2 * Math.PI * hertz;
        const a1 = 2 * this.dampingRatio + hs * omega;
        const a2 = hs * omega * a1;
        const a3 = 1 / (1 + a2);
        soft.biasRate = omega / a1;
        soft.massScale = a2 * a3;
        soft.impulseScale = a3;
        soft.inv = 1 / hs;
        soft.maxPush = this.maxPushVelocity;
        for (let i = 0; i < n; i++) {
            this.integrateVelocities(hs);
            this.warmStart();
            for (const m of this.active) solveSoft(m, true);
            this.integratePositions(hs);
            for (const m of this.active) solveSoft(m, false);
        }
    }

    private measureDrift(): void {
        const st = this.stats;
        st.maxDrift = 0;
        st.moved = st.tracked = 0;
        st.groupMoved.fill(0);
        st.groupTotal.fill(0);
        for (const b of this.bodies) {
            if (!b.group) continue;
            st.tracked++;
            st.groupTotal[b.group]++;
            const dx = b.p.x - b.restPosition.x, dy = b.p.y - b.restPosition.y, dz = b.p.z - b.restPosition.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            st.maxDrift = Math.max(st.maxDrift, dist);
            if (dist > DRIFT_LIMIT) {
                st.moved++;
                st.groupMoved[b.group]++;
            }
        }
    }

    /** Contacts visible to tests and the view. */
    forEachContact(fn: (p: V3, n: V3, s: number, jn: number) => void): void {
        for (const m of this.active) {
            for (let k = 0; k < m.count; k++) {
                const cp = m.points[k];
                mulMat(tmpA, m.a.R, cp.la);
                fn(addScaled(tmpA, tmpA, m.a.p, 1), m.normal, cp.s, cp.jn);
            }
        }
    }
}

// ---------------------------------------------------------------- per-contact kernels

const oldAnchor = new Float64Array(4 * 6);
const oldImpulse = new Float64Array(4 * 3);
const impulse = v3();
const tmpA = v3();
const tmpB = v3();
const dv = v3();
const soft = { biasRate: 0, massScale: 1, impulseScale: 0, inv: 60, maxPush: 3 };

/** 1 / (mA⁻¹ + mB⁻¹ + (rA×u)·IA⁻¹(rA×u) + (rB×u)·IB⁻¹(rB×u)) is the effective mass along u. */
function effectiveMass(a: RigidBody, b: RigidBody, rA: V3, rB: V3, u: V3): number {
    let k = a.invMass + b.invMass;
    if (a.invMass > 0) {
        cross(tmpA, rA, u);
        k += dot(tmpA, mulMat(tmpB, a.invInertiaWorld, tmpA));
    }
    if (b.invMass > 0) {
        cross(tmpA, rB, u);
        k += dot(tmpA, mulMat(tmpB, b.invInertiaWorld, tmpA));
    }
    return k;
}

function applyImpulse(a: RigidBody, b: RigidBody, rA: V3, rB: V3, p: V3): void {
    if (a.invMass > 0) {
        addScaled(a.v, a.v, p, -a.invMass);
        mulMat(tmpB, a.invInertiaWorld, cross(tmpA, rA, p));
        addScaled(a.w, a.w, tmpB, -1);
    }
    if (b.invMass > 0) {
        addScaled(b.v, b.v, p, b.invMass);
        mulMat(tmpB, b.invInertiaWorld, cross(tmpA, rB, p));
        addScaled(b.w, b.w, tmpB, 1);
    }
}

function applyAlong(a: RigidBody, b: RigidBody, rA: V3, rB: V3, u: V3, j: number): void {
    set(impulse, u.x * j, u.y * j, u.z * j);
    applyImpulse(a, b, rA, rB, impulse);
}

/** Velocity of B's contact point relative to A's. */
function relativeVelocity(a: RigidBody, b: RigidBody, rA: V3, rB: V3): V3 {
    cross(tmpA, b.w, rB);
    dv.x = b.v.x + tmpA.x;
    dv.y = b.v.y + tmpA.y;
    dv.z = b.v.z + tmpA.z;
    cross(tmpA, a.w, rA);
    dv.x -= a.v.x + tmpA.x;
    dv.y -= a.v.y + tmpA.y;
    dv.z -= a.v.z + tmpA.z;
    return dv;
}

/** Clamps each iteration's impulse on its own: never pulls, but forgets what earlier iterations applied. */
function solveNaive(m: Manifold): void {
    const a = m.a, b = m.b;
    for (let k = 0; k < m.count; k++) {
        const cp = m.points[k];
        const vn = dot(relativeVelocity(a, b, cp.rA, cp.rB), m.normal);
        const dn = Math.max(0, -cp.normalMass * (vn + cp.bias));
        cp.jn += dn;
        applyAlong(a, b, cp.rA, cp.rB, m.normal, dn);
        const maxF = m.friction * dn;
        const vt1 = dot(relativeVelocity(a, b, cp.rA, cp.rB), m.t1);
        const d1 = Math.max(-maxF, Math.min(maxF, -cp.tangentMass1 * vt1));
        applyAlong(a, b, cp.rA, cp.rB, m.t1, d1);
        const vt2 = dot(relativeVelocity(a, b, cp.rA, cp.rB), m.t2);
        const d2 = Math.max(-maxF, Math.min(maxF, -cp.tangentMass2 * vt2));
        applyAlong(a, b, cp.rA, cp.rB, m.t2, d2);
    }
}

/** Clamps the accumulated impulse, so later iterations can take back what earlier ones overdid. */
function solveAccumulated(m: Manifold): void {
    const a = m.a, b = m.b;
    for (let k = 0; k < m.count; k++) {
        const cp = m.points[k];
        const vn = dot(relativeVelocity(a, b, cp.rA, cp.rB), m.normal);
        const jn = Math.max(0, cp.jn - cp.normalMass * (vn + cp.bias));
        applyAlong(a, b, cp.rA, cp.rB, m.normal, jn - cp.jn);
        cp.jn = jn;
        solveFriction(m, cp);
    }
}

function solveFriction(m: Manifold, cp: ContactPoint): void {
    const a = m.a, b = m.b;
    const maxF = m.friction * cp.jn;
    const vt1 = dot(relativeVelocity(a, b, cp.rA, cp.rB), m.t1);
    const j1 = Math.max(-maxF, Math.min(maxF, cp.jt1 - cp.tangentMass1 * vt1));
    applyAlong(a, b, cp.rA, cp.rB, m.t1, j1 - cp.jt1);
    cp.jt1 = j1;
    const vt2 = dot(relativeVelocity(a, b, cp.rA, cp.rB), m.t2);
    const j2 = Math.max(-maxF, Math.min(maxF, cp.jt2 - cp.tangentMass2 * vt2));
    applyAlong(a, b, cp.rA, cp.rB, m.t2, j2 - cp.jt2);
    cp.jt2 = j2;
}

const dpA = v3();
const dpB = v3();

/**
 * Soft contact (Box2D v3): the separation is updated from how far the bodies
 * moved this step, overlaps are pushed out by a damped spring capped at
 * maxPush, and the relax pass (useBias false) removes the push velocity.
 */
function solveSoft(m: Manifold, useBias: boolean): void {
    const a = m.a, b = m.b, nrm = m.normal;
    for (let k = 0; k < m.count; k++) {
        const cp = m.points[k];
        rotateDelta(dpA, a.R, a.R0, cp.rA);
        rotateDelta(dpB, b.R, b.R0, cp.rB);
        const s = (b.p.x - b.p0.x - a.p.x + a.p0.x + dpB.x - dpA.x) * nrm.x
            + (b.p.y - b.p0.y - a.p.y + a.p0.y + dpB.y - dpA.y) * nrm.y
            + (b.p.z - b.p0.z - a.p.z + a.p0.z + dpB.z - dpA.z) * nrm.z
            + cp.adjusted;
        let bias = 0, massScale = 1, impulseScale = 0;
        if (s > 0) bias = s * soft.inv;
        else if (useBias) {
            bias = Math.max(soft.biasRate * s, -soft.maxPush);
            massScale = soft.massScale;
            impulseScale = soft.impulseScale;
        }
        const vn = dot(relativeVelocity(a, b, cp.rA, cp.rB), nrm);
        const jn = Math.max(0, cp.jn - cp.normalMass * massScale * (vn + bias) - impulseScale * cp.jn);
        applyAlong(a, b, cp.rA, cp.rB, nrm, jn - cp.jn);
        cp.jn = jn;
        solveFriction(m, cp);
    }
}
