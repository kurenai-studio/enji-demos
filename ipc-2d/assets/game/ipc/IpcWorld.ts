import {
    accdPointEdge,
    barrier,
    barrierGrad,
    barrierHess,
    inversionStep,
    peDistance2,
    peDistance2Derivatives,
    peParam,
    neoHookeanHessian,
    projectPsd,
} from './Geometry';
import { BandedPreconditioner } from './BandedPreconditioner';
import { boundaryEdges, type Shape } from './Mesh2D';

export type ContactModel = 'ipc' | 'penalty';

export interface BodyDef {
    shape: Shape;
    /** 2D Young's modulus (N/m) and Poisson ratio; ignored for kinematic bodies. */
    young: number;
    poisson: number;
    /** Areal density, kg/m². */
    density: number;
    vx?: number;
    vy?: number;
    /**
     * Kinematic bodies are not deformed. Without `motion` they never move; with it, every
     * vertex is pulled towards rest pose + motion(t) by a stiff spring, so a blocked
     * plunger lags behind instead of pushing through.
     */
    kinematic?: boolean;
    motion?: (t: number) => [number, number];
    /**
     * Rigid bodies use affine body dynamics (Lan et al. 2022): instead of one
     * unknown per vertex the body has x = p + A x̄, six unknowns (p and the
     * columns of A), and a stiff energy keeping A orthogonal. Young's modulus
     * and Poisson ratio are ignored.
     */
    rigid?: boolean;
    color: readonly number[];
}

export interface WorldParams {
    dt: number;
    gravity: number;
    /** IPC barrier activation distance (m) and stiffness. */
    dHat: number;
    kappa: number;
    /** Penalty model: skin thickness (m) and stiffness (N/m). */
    penaltyThickness: number;
    penaltyStiffness: number;
    /** Spring stiffness (N/m per vertex) that drives kinematic bodies with a motion. */
    driveStiffness: number;
    /** Coulomb coefficient and the sliding speed below which friction is smoothed (m/s). */
    friction: number;
    frictionSpeed: number;
    /** Rigid bodies: stiffness of κ·area·‖AᵀA − I‖² (N/m). */
    abdStiffness: number;
    /** Newton stops when the largest vertex update over dt drops below this (m/s). */
    newtonTol: number;
    maxNewton: number;
    /**
     * Stop Newton once a step has taken this long (ms, 0 = off). Every IPC
     * iterate is intersection free, so a cut step is only less converged.
     */
    budgetMs: number;
    cgTol: number;
    maxCg: number;
}

export const DEFAULT_PARAMS: WorldParams = {
    dt: 1 / 60,
    gravity: -9.8,
    dHat: 2e-3,
    kappa: 1e9,
    penaltyThickness: 5e-3,
    penaltyStiffness: 2e5,
    driveStiffness: 2e5,
    friction: 0.4,
    frictionSpeed: 0.01,
    abdStiffness: 1e7,
    newtonTol: 0.01,
    maxNewton: 40,
    budgetMs: 0,
    cgTol: 1e-2,
    maxCg: 400,
};

export interface BodyInfo {
    start: number;
    count: number;
    triStart: number;
    triCount: number;
    edgeStart: number;
    edgeCount: number;
    kinematic: boolean;
    driven: boolean;
    /** Index among the rigid (affine) bodies, or −1. */
    affine: number;
    motion: ((t: number) => [number, number]) | null;
    color: readonly number[];
    mass: number;
}

export interface StepStats {
    newton: number;
    cg: number;
    contacts: number;
    /** Smallest point-edge distance among active contacts at the end of the step (m), or Infinity. */
    minDistance: number;
    /** Newton iterations whose step was shortened by CCD or the inversion filter. */
    limited: number;
    converged: boolean;
    ms: number;
}

const GRID_CELLS = 64;

/**
 * Soft bodies on triangle meshes, advanced by implicit Euler written as an
 * energy minimisation (inertia + Neo-Hookean elasticity + contact + lagged
 * friction) and solved by projected Newton with a backtracking line search.
 *
 * With `ipc` contact the energy holds the IPC log barrier on point-edge
 * distances and every line search is capped by additive CCD, so no boundary
 * point ever crosses an edge. With `penalty` contact the same solver uses a
 * quadratic penalty inside a thin skin and no CCD, as many game engines do.
 *
 * Rigid bodies join the same solve as affine bodies: their unknowns are the
 * 2D blocks p, c₀, c₁ with vertex x = p + x̄ c₀ + ȳ c₁, so contact, friction
 * and CCD stay on vertices and reach the body through the weights (1, x̄, ȳ).
 */
export class IpcWorld {
    readonly params: WorldParams;
    readonly model: ContactModel;
    readonly bodies: BodyInfo[] = [];
    readonly vertexCount: number;
    readonly dofCount: number;
    readonly x: Float64Array;
    readonly v: Float64Array;
    readonly tri: Int32Array;
    readonly edges: Int32Array;
    readonly points: Int32Array;
    /** Set by countCrossings(): 1 for every boundary edge that crosses another. */
    readonly crossing: Uint8Array;
    readonly stats: StepStats = { newton: 0, cg: 0, contacts: 0, minDistance: Infinity, limited: 0, converged: true, ms: 0 };
    time = 0;

    private readonly rest: Float64Array;
    private readonly drive: Float64Array;
    private readonly driven: Uint8Array;
    private readonly xn: Float64Array;
    private readonly xTilde: Float64Array;
    private readonly xTrial: Float64Array;
    private readonly mass: Float64Array;
    private readonly dof: Int32Array;
    private readonly kinematic: Uint8Array;
    private readonly dmInv: Float64Array;
    private readonly area: Float64Array;
    private readonly mu: Float64Array;
    private readonly lambda: Float64Array;

    // Rigid (affine) bodies. q holds px, py, c₀x, c₀y, c₁x, c₁y per body.
    readonly rigidCount: number;
    readonly q: Float64Array;
    private readonly qn: Float64Array;
    private readonly qv: Float64Array;
    private readonly qTilde: Float64Array;
    private readonly dq: Float64Array;
    private readonly gradQ: Float64Array;
    /** Vertex → rigid body index or −1, and its rest offset x̄ from the centre of mass. */
    private readonly aff: Int32Array;
    private readonly bary: Float64Array;
    private readonly abdDof: Int32Array;
    /** Per rigid body: mass, Σm x̄², Σm x̄ȳ, Σm ȳ². */
    private readonly abdMass: Float64Array;
    private readonly abdArea: Float64Array;
    private readonly abdSlot: Int32Array;
    private readonly pcVal: Float64Array;

    // Block CSR (2×2 blocks) over dynamic vertices for inertia + elasticity.
    private readonly rowStart: Int32Array;
    private readonly col: Int32Array;
    private readonly val: Float64Array;
    private readonly diagSlot: Int32Array;
    private readonly triSlot: Int32Array;

    // Active contacts with their projected 6×6 Hessians.
    private contactCount = 0;
    private contactVerts = new Int32Array(0);
    private contactDof = new Int32Array(0);
    private contactHess = new Float64Array(0);

    // Point-edge candidate pairs from the broad phase.
    private candCount = 0;
    private candPoint = new Int32Array(1024);
    private candEdge = new Int32Array(1024);

    // Friction, lagged at the start of the step.
    private frictionCount = 0;
    private frictionVerts = new Int32Array(0);
    private frictionW = new Float64Array(0);
    private frictionForce = new Float64Array(0);

    // Vectors over all vertices (2V) and over dynamic dofs (2D).
    private readonly grad: Float64Array;
    private readonly dir: Float64Array;
    private readonly rhs: Float64Array;
    private readonly sol: Float64Array;
    private readonly cgR: Float64Array;
    private readonly cgZ: Float64Array;
    private readonly cgP: Float64Array;
    private readonly cgQ: Float64Array;
    private readonly precond: Float64Array;
    private readonly preconditioner: BandedPreconditioner;

    // Broad-phase grid.
    private readonly gridMin = { x: 0, y: 0 };
    private gridCell = 1;
    private readonly cellStart = new Int32Array(GRID_CELLS * GRID_CELLS + 1);
    private cellItems = new Int32Array(0);
    private readonly boxP: Float64Array;
    private readonly boxE: Float64Array;
    private readonly stamp: Int32Array;

    private readonly grabTarget = { x: 0, y: 0 };
    private grabVertex = -1;
    private grabStiffness = 0;

    private readonly g6 = new Float64Array(6);
    private readonly h36 = new Float64Array(36);
    private readonly m16 = new Float64Array(16);
    private readonly t4 = new Float64Array(4);
    private readonly t6 = new Float64Array(6);

    constructor(defs: readonly BodyDef[], model: ContactModel, params: WorldParams = DEFAULT_PARAMS) {
        this.params = params;
        this.model = model;
        let vertexCount = 0;
        let triCount = 0;
        let edgeCount = 0;
        const bodyEdges: number[][] = [];
        for (const def of defs) {
            vertexCount += def.shape.positions.length / 2;
            triCount += def.shape.triangles.length / 3;
            const e = boundaryEdges(def.shape.triangles);
            bodyEdges.push(e);
            edgeCount += e.length / 2;
        }
        this.vertexCount = vertexCount;
        this.x = new Float64Array(2 * vertexCount);
        this.v = new Float64Array(2 * vertexCount);
        this.rest = new Float64Array(2 * vertexCount);
        this.drive = new Float64Array(2 * vertexCount);
        this.driven = new Uint8Array(vertexCount);
        this.xn = new Float64Array(2 * vertexCount);
        this.xTilde = new Float64Array(2 * vertexCount);
        this.xTrial = new Float64Array(2 * vertexCount);
        this.mass = new Float64Array(vertexCount);
        this.dof = new Int32Array(vertexCount).fill(-1);
        this.kinematic = new Uint8Array(vertexCount);
        this.tri = new Int32Array(3 * triCount);
        this.dmInv = new Float64Array(4 * triCount);
        this.area = new Float64Array(triCount);
        this.mu = new Float64Array(triCount);
        this.lambda = new Float64Array(triCount);
        this.edges = new Int32Array(2 * edgeCount);
        this.crossing = new Uint8Array(edgeCount);
        const rigidCount = defs.filter((d) => d.rigid && !d.kinematic).length;
        this.rigidCount = rigidCount;
        this.q = new Float64Array(6 * rigidCount);
        this.qn = new Float64Array(6 * rigidCount);
        this.qv = new Float64Array(6 * rigidCount);
        this.qTilde = new Float64Array(6 * rigidCount);
        this.dq = new Float64Array(6 * rigidCount);
        this.gradQ = new Float64Array(6 * rigidCount);
        this.aff = new Int32Array(vertexCount).fill(-1);
        this.bary = new Float64Array(2 * vertexCount);
        this.abdDof = new Int32Array(rigidCount);
        this.abdMass = new Float64Array(4 * rigidCount);
        this.abdArea = new Float64Array(rigidCount);
        this.abdSlot = new Int32Array(9 * rigidCount);

        let v0 = 0;
        let t0 = 0;
        let e0 = 0;
        let dofs = 0;
        let affine = 0;
        defs.forEach((def, b) => {
            const n = def.shape.positions.length / 2;
            const tris = def.shape.triangles;
            const rigid = !!def.kinematic;
            const driven = rigid && !!def.motion;
            const kin = rigid && !driven;
            const abd = !rigid && !!def.rigid;
            const info: BodyInfo = {
                start: v0, count: n, triStart: t0, triCount: tris.length / 3, edgeStart: e0, edgeCount: bodyEdges[b].length / 2,
                kinematic: rigid, driven, affine: abd ? affine : -1, motion: def.motion ?? null, color: def.color, mass: 0,
            };
            if (abd) {
                this.abdDof[affine] = dofs;
                dofs += 3;
            }
            for (let i = 0; i < n; i++) {
                const vi = v0 + i;
                this.x[2 * vi] = this.rest[2 * vi] = def.shape.positions[2 * i];
                this.x[2 * vi + 1] = this.rest[2 * vi + 1] = def.shape.positions[2 * i + 1];
                this.v[2 * vi] = def.vx ?? 0;
                this.v[2 * vi + 1] = def.vy ?? 0;
                this.kinematic[vi] = kin ? 1 : 0;
                this.driven[vi] = driven ? 1 : 0;
                this.drive[2 * vi] = this.x[2 * vi];
                this.drive[2 * vi + 1] = this.x[2 * vi + 1];
                if (abd) this.aff[vi] = affine;
                else if (!kin) this.dof[vi] = dofs++;
            }
            const mu = def.young / (2 * (1 + def.poisson));
            const lambda = (def.young * def.poisson) / ((1 + def.poisson) * (1 - 2 * def.poisson));
            for (let t = 0; t < tris.length / 3; t++) {
                const ti = t0 + t;
                const a = v0 + tris[3 * t];
                const bb = v0 + tris[3 * t + 1];
                const c = v0 + tris[3 * t + 2];
                this.tri[3 * ti] = a;
                this.tri[3 * ti + 1] = bb;
                this.tri[3 * ti + 2] = c;
                const e1x = this.x[2 * bb] - this.x[2 * a];
                const e1y = this.x[2 * bb + 1] - this.x[2 * a + 1];
                const e2x = this.x[2 * c] - this.x[2 * a];
                const e2y = this.x[2 * c + 1] - this.x[2 * a + 1];
                const det = e1x * e2y - e1y * e2x;
                this.area[ti] = det / 2;
                this.dmInv[4 * ti] = e2y / det;
                this.dmInv[4 * ti + 1] = -e2x / det;
                this.dmInv[4 * ti + 2] = -e1y / det;
                this.dmInv[4 * ti + 3] = e1x / det;
                // Driven bodies keep their own elasticity on top of the drive springs.
                this.mu[ti] = kin || abd ? 0 : mu;
                this.lambda[ti] = kin || abd ? 0 : lambda;
                if (!rigid) {
                    const m = (def.density * det) / 6;
                    this.mass[a] += m;
                    this.mass[bb] += m;
                    this.mass[c] += m;
                    info.mass += 3 * m;
                }
            }
            for (let k = 0; k < bodyEdges[b].length; k++) this.edges[2 * e0 + k] = v0 + bodyEdges[b][k];
            if (abd) {
                this.initAffine(affine, v0, n, info.mass, def.vx ?? 0, def.vy ?? 0);
                for (let t = t0; t < t0 + tris.length / 3; t++) this.abdArea[affine] += this.area[t];
                affine++;
            }
            this.bodies.push(info);
            v0 += n;
            t0 += tris.length / 3;
            e0 += bodyEdges[b].length / 2;
        });
        this.dofCount = dofs;

        const onBoundary = new Uint8Array(vertexCount);
        for (let i = 0; i < this.edges.length; i++) onBoundary[this.edges[i]] = 1;
        const pts: number[] = [];
        for (let i = 0; i < vertexCount; i++) if (onBoundary[i]) pts.push(i);
        this.points = Int32Array.from(pts);

        // Sparsity pattern: dynamic vertices sharing a triangle.
        const neighbours: Set<number>[] = [];
        for (let i = 0; i < dofs; i++) neighbours.push(new Set([i]));
        for (let t = 0; t < triCount; t++) {
            for (let a = 0; a < 3; a++) {
                const da = this.dof[this.tri[3 * t + a]];
                if (da < 0) continue;
                for (let b = 0; b < 3; b++) {
                    const db = this.dof[this.tri[3 * t + b]];
                    if (db >= 0) neighbours[da].add(db);
                }
            }
        }
        // A rigid body's three blocks are fully coupled.
        for (let a = 0; a < rigidCount; a++) {
            const d0 = this.abdDof[a];
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) neighbours[d0 + r].add(d0 + c);
        }
        this.rowStart = new Int32Array(dofs + 1);
        const cols: number[] = [];
        this.diagSlot = new Int32Array(dofs);
        for (let i = 0; i < dofs; i++) {
            const sorted = [...neighbours[i]].sort((p, q) => p - q);
            this.rowStart[i] = cols.length;
            for (const j of sorted) {
                if (j === i) this.diagSlot[i] = cols.length;
                cols.push(j);
            }
        }
        this.rowStart[dofs] = cols.length;
        this.col = Int32Array.from(cols);
        this.val = new Float64Array(4 * cols.length);
        this.triSlot = new Int32Array(9 * triCount).fill(-1);
        for (let t = 0; t < triCount; t++) {
            for (let a = 0; a < 3; a++) {
                const da = this.dof[this.tri[3 * t + a]];
                if (da < 0) continue;
                for (let b = 0; b < 3; b++) {
                    const db = this.dof[this.tri[3 * t + b]];
                    if (db < 0) continue;
                    for (let s = this.rowStart[da]; s < this.rowStart[da + 1]; s++) {
                        if (this.col[s] === db) {
                            this.triSlot[9 * t + 3 * a + b] = s;
                            break;
                        }
                    }
                }
            }
        }

        for (let a = 0; a < rigidCount; a++) {
            const d0 = this.abdDof[a];
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    for (let s = this.rowStart[d0 + r]; s < this.rowStart[d0 + r + 1]; s++) {
                        if (this.col[s] === d0 + c) this.abdSlot[9 * a + 3 * r + c] = s;
                    }
                }
            }
        }
        this.pcVal = new Float64Array(rigidCount > 0 ? this.val.length : 0);

        this.preconditioner = new BandedPreconditioner(
            this.bodies
                .filter((b) => b.affine >= 0 || this.dof[b.start] >= 0)
                .map((b) => (b.affine >= 0 ? { start: this.abdDof[b.affine], count: 3 } : { start: this.dof[b.start], count: b.count })),
            this.rowStart,
            this.col,
        );
        this.grad = new Float64Array(2 * vertexCount);
        this.dir = new Float64Array(2 * vertexCount);
        this.rhs = new Float64Array(2 * dofs);
        this.sol = new Float64Array(2 * dofs);
        this.cgR = new Float64Array(2 * dofs);
        this.cgZ = new Float64Array(2 * dofs);
        this.cgP = new Float64Array(2 * dofs);
        this.cgQ = new Float64Array(2 * dofs);
        this.precond = new Float64Array(4 * dofs);
        this.boxP = new Float64Array(4 * this.points.length);
        this.boxE = new Float64Array(4 * edgeCount);
        this.stamp = new Int32Array(edgeCount).fill(-1);
        this.ensureContacts(256);
        this.ensureFriction(256);

        // Broad-phase grid over the scene bounds (bodies beyond it fall into the border cells).
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < vertexCount; i++) {
            minX = Math.min(minX, this.x[2 * i]);
            maxX = Math.max(maxX, this.x[2 * i]);
            minY = Math.min(minY, this.x[2 * i + 1]);
            maxY = Math.max(maxY, this.x[2 * i + 1]);
        }
        this.gridMin.x = minX;
        this.gridMin.y = minY;
        this.gridCell = Math.max(maxX - minX, maxY - minY, 1e-3) / GRID_CELLS;
    }

    get contactRadius(): number {
        return this.model === 'ipc' ? this.params.dHat : this.params.penaltyThickness;
    }

    /** Rest offsets about the centre of mass (so gravity only acts on p) and the affine mass matrix. */
    private initAffine(a: number, start: number, count: number, mass: number, vx: number, vy: number): void {
        let cx = 0, cy = 0;
        for (let i = start; i < start + count; i++) {
            cx += this.mass[i] * this.x[2 * i];
            cy += this.mass[i] * this.x[2 * i + 1];
        }
        cx /= mass;
        cy /= mass;
        let xx = 0, xy = 0, yy = 0;
        for (let i = start; i < start + count; i++) {
            const bx = this.x[2 * i] - cx;
            const by = this.x[2 * i + 1] - cy;
            this.bary[2 * i] = bx;
            this.bary[2 * i + 1] = by;
            xx += this.mass[i] * bx * bx;
            xy += this.mass[i] * bx * by;
            yy += this.mass[i] * by * by;
        }
        const m = this.abdMass;
        m[4 * a] = mass; m[4 * a + 1] = xx; m[4 * a + 2] = xy; m[4 * a + 3] = yy;
        const q = this.q;
        q.set([cx, cy, 1, 0, 0, 1], 6 * a);
        this.qv.set([vx, vy, 0, 0, 0, 0], 6 * a);
    }

    /** Rigid-body vertices from q. */
    private syncAffine(): void {
        const q = this.q;
        for (let i = 0; i < this.vertexCount; i++) {
            const a = this.aff[i];
            if (a < 0) continue;
            const o = 6 * a;
            const bx = this.bary[2 * i], by = this.bary[2 * i + 1];
            this.x[2 * i] = q[o] + bx * q[o + 2] + by * q[o + 4];
            this.x[2 * i + 1] = q[o + 1] + bx * q[o + 3] + by * q[o + 5];
        }
    }

    /** Largest ‖AᵀA − I‖_F over the rigid bodies: 0 for a perfect rotation. */
    orthogonalityError(): number {
        let worst = 0;
        for (let a = 0; a < this.rigidCount; a++) {
            const o = 6 * a;
            const ax = this.q[o + 2], ay = this.q[o + 3], bx = this.q[o + 4], by = this.q[o + 5];
            const s00 = ax * ax + ay * ay - 1, s01 = ax * bx + ay * by, s11 = bx * bx + by * by - 1;
            worst = Math.max(worst, Math.sqrt(s00 * s00 + 2 * s01 * s01 + s11 * s11));
        }
        return worst;
    }

    // ------------------------------------------------------------------ step

    step(): void {
        const t0 = now();
        const p = this.params;
        const h = p.dt;
        const n = this.vertexCount;
        this.xn.set(this.x);
        this.time += h;
        this.updateDrive();
        for (let i = 0; i < n; i++) {
            if (this.mass[i] === 0) {
                this.xTilde[2 * i] = this.x[2 * i];
                this.xTilde[2 * i + 1] = this.x[2 * i + 1];
            } else {
                this.xTilde[2 * i] = this.xn[2 * i] + h * this.v[2 * i];
                this.xTilde[2 * i + 1] = this.xn[2 * i + 1] + h * this.v[2 * i + 1] + h * h * p.gravity;
            }
        }
        const nq = 6 * this.rigidCount;
        this.qn.set(this.q);
        for (let k = 0; k < nq; k++) this.qTilde[k] = this.q[k] + h * this.qv[k];
        for (let a = 0; a < this.rigidCount; a++) this.qTilde[6 * a + 1] += h * h * p.gravity;
        this.lagFriction();

        const stats = this.stats;
        stats.newton = 0;
        stats.cg = 0;
        stats.limited = 0;
        stats.converged = false;
        if (nq > 0) this.rigidWarmStart();
        for (let iter = 0; iter < p.maxNewton; iter++) {
            this.findPairs(this.x, null, 0);
            this.assemble();
            stats.cg += this.solve();
            let maxStep = 0;
            for (let i = 0; i < 2 * n; i++) maxStep = Math.max(maxStep, Math.abs(this.dir[i]));
            if (maxStep / h < p.newtonTol) {
                stats.converged = true;
                break;
            }
            stats.newton++;
            if (this.advance(40) < 1) stats.limited++;
            if (p.budgetMs > 0 && now() - t0 > p.budgetMs) break;
        }
        for (let i = 0; i < 2 * n; i++) this.v[i] = (this.x[i] - this.xn[i]) / h;
        for (let k = 0; k < nq; k++) this.qv[k] = (this.q[k] - this.qn[k]) / h;
        this.measureContacts();
        stats.ms = now() - t0;
    }

    /**
     * Moves x (and q) along dir (and dq): the largest step ≤ 1 that keeps
     * triangles upright and, with IPC, every pair apart, then halved until
     * the energy does not rise (up to `halvings` times, else no move).
     * Returns the step allowed by the filters.
     */
    private advance(halvings: number): number {
        const n2 = 2 * this.vertexCount;
        const nq = 6 * this.rigidCount;
        let alpha = this.inversionFreeStep(1);
        if (this.model === 'ipc') {
            this.findPairs(this.x, this.dir, alpha);
            alpha = this.ccdStep(alpha);
        }
        const limited = alpha;
        this.findPairs(this.x, this.dir, alpha);
        const e0 = this.energy(this.x, 0);
        for (let k = 0; k < halvings; k++) {
            for (let i = 0; i < n2; i++) this.xTrial[i] = this.x[i] + alpha * this.dir[i];
            if (this.energy(this.xTrial, alpha) <= e0) break;
            alpha *= 0.5;
            if (k === halvings - 1) alpha = 0;
        }
        for (let i = 0; i < n2; i++) this.x[i] += alpha * this.dir[i];
        if (nq > 0) {
            for (let k = 0; k < nq; k++) this.q[k] += alpha * this.dq[k];
            this.syncAffine();
        }
        return limited;
    }

    /**
     * A straight Newton step leaves the curved set of rotations and the stiff
     * orthogonality energy then cuts it short, which bleeds off spin. So each
     * step first tries to move every rigid body to the rotation closest to its
     * inertial prediction (2D polar decomposition), through the same CCD and
     * line search; Newton only has to correct for contacts from there.
     */
    private rigidWarmStart(): void {
        const q = this.q, qt = this.qTilde, dq = this.dq;
        for (let a = 0; a < this.rigidCount; a++) {
            const o = 6 * a;
            // Ã = [c̃₀ c̃₁]; its rotation part has angle atan2(Ã₁₀ − Ã₀₁, Ã₀₀ + Ã₁₁).
            const theta = Math.atan2(qt[o + 3] - qt[o + 4], qt[o + 2] + qt[o + 5]);
            const c = Math.cos(theta), s = Math.sin(theta);
            dq[o] = qt[o] - q[o];
            dq[o + 1] = qt[o + 1] - q[o + 1];
            dq[o + 2] = c - q[o + 2];
            dq[o + 3] = s - q[o + 3];
            dq[o + 4] = -s - q[o + 4];
            dq[o + 5] = c - q[o + 5];
        }
        this.dir.fill(0);
        for (let i = 0; i < this.vertexCount; i++) {
            const a = this.aff[i];
            if (a < 0) continue;
            const o = 6 * a;
            const bx = this.bary[2 * i], by = this.bary[2 * i + 1];
            this.dir[2 * i] = dq[o] + bx * dq[o + 2] + by * dq[o + 4];
            this.dir[2 * i + 1] = dq[o + 1] + bx * dq[o + 3] + by * dq[o + 5];
        }
        this.advance(8);
    }

    /** Spring targets of driven bodies at the new time. */
    private updateDrive(): void {
        for (const b of this.bodies) {
            if (!b.driven || !b.motion) continue;
            const [ox, oy] = b.motion(this.time);
            for (let i = b.start; i < b.start + b.count; i++) {
                this.drive[2 * i] = this.rest[2 * i] + ox;
                this.drive[2 * i + 1] = this.rest[2 * i + 1] + oy;
            }
        }
    }

    // ------------------------------------------------------------ broad phase

    /**
     * Collects point-edge pairs whose boxes overlap: around positions x, or
     * swept over x → x + alpha·dir; both inflated by the contact radius.
     */
    private findPairs(x: Float64Array, dir: Float64Array | null, alpha: number): void {
        const r = this.contactRadius;
        const pts = this.points;
        const edges = this.edges;
        const bp = this.boxP;
        const be = this.boxE;
        for (let k = 0; k < pts.length; k++) {
            const i = pts[k];
            let x0 = x[2 * i], y0 = x[2 * i + 1], x1 = x0, y1 = y0;
            if (dir) {
                const ex = x0 + alpha * dir[2 * i];
                const ey = y0 + alpha * dir[2 * i + 1];
                x0 = Math.min(x0, ex); x1 = Math.max(x1, ex);
                y0 = Math.min(y0, ey); y1 = Math.max(y1, ey);
            }
            bp[4 * k] = x0 - r; bp[4 * k + 1] = y0 - r; bp[4 * k + 2] = x1 + r; bp[4 * k + 3] = y1 + r;
        }
        const ne = edges.length / 2;
        for (let e = 0; e < ne; e++) {
            const a = edges[2 * e];
            const b = edges[2 * e + 1];
            let x0 = Math.min(x[2 * a], x[2 * b]), x1 = Math.max(x[2 * a], x[2 * b]);
            let y0 = Math.min(x[2 * a + 1], x[2 * b + 1]), y1 = Math.max(x[2 * a + 1], x[2 * b + 1]);
            if (dir) {
                const ax = x[2 * a] + alpha * dir[2 * a], ay = x[2 * a + 1] + alpha * dir[2 * a + 1];
                const bx = x[2 * b] + alpha * dir[2 * b], by = x[2 * b + 1] + alpha * dir[2 * b + 1];
                x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx);
                y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
            }
            be[4 * e] = x0; be[4 * e + 1] = y0; be[4 * e + 2] = x1; be[4 * e + 3] = y1;
        }
        this.buildGrid(be, ne);
        this.candCount = 0;
        this.stamp.fill(-1);
        const kin = this.kinematic;
        const aff = this.aff;
        for (let k = 0; k < pts.length; k++) {
            const i = pts[k];
            const ai = aff[i];
            const cx0 = this.cellX(bp[4 * k]), cx1 = this.cellX(bp[4 * k + 2]);
            const cy0 = this.cellY(bp[4 * k + 1]), cy1 = this.cellY(bp[4 * k + 3]);
            for (let cy = cy0; cy <= cy1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    const c = cy * GRID_CELLS + cx;
                    for (let s = this.cellStart[c]; s < this.cellStart[c + 1]; s++) {
                        const e = this.cellItems[s];
                        if (this.stamp[e] === k) continue;
                        this.stamp[e] = k;
                        const a = edges[2 * e];
                        const b = edges[2 * e + 1];
                        if (a === i || b === i) continue;
                        if (kin[i] && kin[a] && kin[b]) continue;
                        if (ai >= 0 && aff[a] === ai) continue;
                        if (bp[4 * k] > be[4 * e + 2] || bp[4 * k + 2] < be[4 * e] || bp[4 * k + 1] > be[4 * e + 3] || bp[4 * k + 3] < be[4 * e + 1]) continue;
                        this.pushCandidate(i, e);
                    }
                }
            }
        }
    }

    private cellX(x: number): number {
        const c = Math.floor((x - this.gridMin.x) / this.gridCell);
        return c < 0 ? 0 : c >= GRID_CELLS ? GRID_CELLS - 1 : c;
    }

    private cellY(y: number): number {
        const c = Math.floor((y - this.gridMin.y) / this.gridCell);
        return c < 0 ? 0 : c >= GRID_CELLS ? GRID_CELLS - 1 : c;
    }

    /** Counting sort of edges into every cell their box touches. */
    private buildGrid(be: Float64Array, ne: number): void {
        const start = this.cellStart;
        start.fill(0);
        let total = 0;
        for (let e = 0; e < ne; e++) {
            const cx0 = this.cellX(be[4 * e]), cx1 = this.cellX(be[4 * e + 2]);
            const cy0 = this.cellY(be[4 * e + 1]), cy1 = this.cellY(be[4 * e + 3]);
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) start[cy * GRID_CELLS + cx + 1]++;
            total += (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
        }
        for (let c = 0; c < GRID_CELLS * GRID_CELLS; c++) start[c + 1] += start[c];
        if (this.cellItems.length < total) this.cellItems = new Int32Array(total * 2);
        const fill = this.cellItems;
        const cursor = start.slice(0, GRID_CELLS * GRID_CELLS);
        for (let e = 0; e < ne; e++) {
            const cx0 = this.cellX(be[4 * e]), cx1 = this.cellX(be[4 * e + 2]);
            const cy0 = this.cellY(be[4 * e + 1]), cy1 = this.cellY(be[4 * e + 3]);
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) fill[cursor[cy * GRID_CELLS + cx]++] = e;
        }
    }

    private pushCandidate(point: number, edge: number): void {
        if (this.candCount === this.candPoint.length) {
            const p = new Int32Array(this.candCount * 2);
            p.set(this.candPoint);
            this.candPoint = p;
            const e = new Int32Array(this.candCount * 2);
            e.set(this.candEdge);
            this.candEdge = e;
        }
        this.candPoint[this.candCount] = point;
        this.candEdge[this.candCount] = edge;
        this.candCount++;
    }

    // ------------------------------------------------------------ contact energy

    /** Contact energy f(s) on squared distance (without the dt² factor), and its first two derivatives. */
    private contactF0(s: number): number {
        if (this.model === 'ipc') {
            const sHat = this.params.dHat * this.params.dHat;
            return this.params.kappa * barrier(s, sHat);
        }
        const d = Math.sqrt(s);
        const gap = this.params.penaltyThickness - d;
        return gap > 0 ? 0.5 * this.params.penaltyStiffness * gap * gap : 0;
    }

    private contactF1(s: number): number {
        if (this.model === 'ipc') {
            const sHat = this.params.dHat * this.params.dHat;
            return this.params.kappa * barrierGrad(s, sHat);
        }
        const d = Math.max(Math.sqrt(s), 1e-9);
        const gap = this.params.penaltyThickness - d;
        return gap > 0 ? (-this.params.penaltyStiffness * gap) / (2 * d) : 0;
    }

    private contactF2(s: number): number {
        if (this.model === 'ipc') {
            const sHat = this.params.dHat * this.params.dHat;
            return this.params.kappa * barrierHess(s, sHat);
        }
        const d = Math.max(Math.sqrt(s), 1e-9);
        return d < this.params.penaltyThickness ? (this.params.penaltyStiffness * this.params.penaltyThickness) / (4 * d * d * d) : 0;
    }

    private distance2(x: Float64Array, point: number, edge: number): number {
        const a = this.edges[2 * edge];
        const b = this.edges[2 * edge + 1];
        return peDistance2(x[2 * point], x[2 * point + 1], x[2 * a], x[2 * a + 1], x[2 * b], x[2 * b + 1]);
    }

    // ------------------------------------------------------------ friction

    /**
     * Lagged friction (IPC): for each contact at the start of the step, the
     * normal force, the closest point on the edge and the edge direction are
     * frozen, so the tangential slip u = wᵀ(x − xⁿ) is linear in x.
     */
    private lagFriction(): void {
        this.frictionCount = 0;
        if (this.params.friction <= 0) return;
        const x = this.x;
        const r2 = this.contactRadius * this.contactRadius;
        this.findPairs(x, null, 0);
        for (let c = 0; c < this.candCount; c++) {
            const i = this.candPoint[c];
            const e = this.candEdge[c];
            const s = this.distance2(x, i, e);
            if (s >= r2) continue;
            const force = Math.abs(this.contactF1(s)) * 2 * Math.sqrt(s);
            if (force <= 0) continue;
            const a = this.edges[2 * e];
            const b = this.edges[2 * e + 1];
            let tx = x[2 * b] - x[2 * a];
            let ty = x[2 * b + 1] - x[2 * a + 1];
            const len = Math.hypot(tx, ty);
            if (len === 0) continue;
            tx /= len;
            ty /= len;
            const t = peParam(x[2 * i], x[2 * i + 1], x[2 * a], x[2 * a + 1], x[2 * b], x[2 * b + 1]);
            if (this.frictionCount === this.frictionForce.length) this.ensureFriction(this.frictionCount * 2);
            const f = this.frictionCount++;
            this.frictionVerts[3 * f] = i;
            this.frictionVerts[3 * f + 1] = a;
            this.frictionVerts[3 * f + 2] = b;
            const w = this.frictionW;
            w[6 * f] = tx; w[6 * f + 1] = ty;
            w[6 * f + 2] = -(1 - t) * tx; w[6 * f + 3] = -(1 - t) * ty;
            w[6 * f + 4] = -t * tx; w[6 * f + 5] = -t * ty;
            this.frictionForce[f] = this.params.friction * force;
        }
    }

    private slip(x: Float64Array, f: number): number {
        const w = this.frictionW;
        let u = 0;
        for (let k = 0; k < 3; k++) {
            const vi = this.frictionVerts[3 * f + k];
            u += w[6 * f + 2 * k] * (x[2 * vi] - this.xn[2 * vi]) + w[6 * f + 2 * k + 1] * (x[2 * vi + 1] - this.xn[2 * vi + 1]);
        }
        return u;
    }

    // ------------------------------------------------------------ energy

    /**
     * Incremental potential at x over the current candidate pairs, with the
     * rigid bodies at q + alpha·dq (x must hold their vertices). Infinity if a
     * triangle inverts.
     */
    private energy(x: Float64Array, alpha: number): number {
        const h2 = this.params.dt * this.params.dt;
        let inertia = 0;
        const kd = this.params.driveStiffness;
        let driveEnergy = 0;
        for (let i = 0; i < this.vertexCount; i++) {
            if (this.driven[i]) {
                const dx = x[2 * i] - this.drive[2 * i];
                const dy = x[2 * i + 1] - this.drive[2 * i + 1];
                driveEnergy += 0.5 * kd * (dx * dx + dy * dy);
                continue;
            }
            if (this.mass[i] === 0 || this.aff[i] >= 0) continue;
            const dx = x[2 * i] - this.xTilde[2 * i];
            const dy = x[2 * i + 1] - this.xTilde[2 * i + 1];
            inertia += 0.5 * this.mass[i] * (dx * dx + dy * dy);
        }
        let potential = driveEnergy;
        const q = this.q, dq = this.dq, qt = this.qTilde, mm = this.abdMass;
        for (let a = 0; a < this.rigidCount; a++) {
            const o = 6 * a;
            const px = q[o] + alpha * dq[o] - qt[o], py = q[o + 1] + alpha * dq[o + 1] - qt[o + 1];
            const ax = q[o + 2] + alpha * dq[o + 2], ay = q[o + 3] + alpha * dq[o + 3];
            const bx = q[o + 4] + alpha * dq[o + 4], by = q[o + 5] + alpha * dq[o + 5];
            const dax = ax - qt[o + 2], day = ay - qt[o + 3], dbx = bx - qt[o + 4], dby = by - qt[o + 5];
            inertia += 0.5 * (mm[4 * a] * (px * px + py * py)
                + mm[4 * a + 1] * (dax * dax + day * day)
                + 2 * mm[4 * a + 2] * (dax * dbx + day * dby)
                + mm[4 * a + 3] * (dbx * dbx + dby * dby));
            const s00 = ax * ax + ay * ay - 1, s01 = ax * bx + ay * by, s11 = bx * bx + by * by - 1;
            potential += this.params.abdStiffness * this.abdArea[a] * (s00 * s00 + 2 * s01 * s01 + s11 * s11);
        }
        const nt = this.area.length;
        for (let t = 0; t < nt; t++) {
            if (this.mu[t] === 0) continue;
            const psi = this.triEnergy(x, t);
            if (!Number.isFinite(psi)) return Infinity;
            potential += psi;
        }
        const r2 = this.contactRadius * this.contactRadius;
        for (let c = 0; c < this.candCount; c++) {
            const s = this.distance2(x, this.candPoint[c], this.candEdge[c]);
            if (s < r2) {
                if (s <= 0) return Infinity;
                potential += this.contactF0(s);
            }
        }
        const eps = this.params.frictionSpeed * this.params.dt;
        for (let f = 0; f < this.frictionCount; f++) potential += this.frictionForce[f] * f0(Math.abs(this.slip(x, f)), eps);
        if (this.grabVertex >= 0) {
            const g = this.grabVertex;
            const dx = x[2 * g] - this.grabTarget.x;
            const dy = x[2 * g + 1] - this.grabTarget.y;
            potential += 0.5 * this.grabStiffness * (dx * dx + dy * dy);
        }
        return inertia + h2 * potential;
    }

    private triEnergy(x: Float64Array, t: number): number {
        const a = this.tri[3 * t], b = this.tri[3 * t + 1], c = this.tri[3 * t + 2];
        const e1x = x[2 * b] - x[2 * a], e1y = x[2 * b + 1] - x[2 * a + 1];
        const e2x = x[2 * c] - x[2 * a], e2y = x[2 * c + 1] - x[2 * a + 1];
        const d = this.dmInv;
        const f00 = e1x * d[4 * t] + e2x * d[4 * t + 2];
        const f01 = e1x * d[4 * t + 1] + e2x * d[4 * t + 3];
        const f10 = e1y * d[4 * t] + e2y * d[4 * t + 2];
        const f11 = e1y * d[4 * t + 1] + e2y * d[4 * t + 3];
        const J = f00 * f11 - f01 * f10;
        if (J <= 0) return Infinity;
        const lnJ = Math.log(J);
        const mu = this.mu[t];
        return this.area[t] * (0.5 * mu * (f00 * f00 + f01 * f01 + f10 * f10 + f11 * f11 - 2) - mu * lnJ + 0.5 * this.lambda[t] * lnJ * lnJ);
    }

    // ------------------------------------------------------------ assembly

    /** Gradient into `grad` (all vertices) and the Hessian into the CSR blocks plus contact matrices. */
    private assemble(): void {
        const x = this.x;
        const h2 = this.params.dt * this.params.dt;
        const grad = this.grad;
        const val = this.val;
        grad.fill(0);
        val.fill(0);
        for (let i = 0; i < this.vertexCount; i++) {
            const di = this.dof[i];
            if (di < 0) continue;
            const s = this.diagSlot[di];
            if (this.driven[i]) {
                const k = h2 * this.params.driveStiffness;
                grad[2 * i] = k * (x[2 * i] - this.drive[2 * i]);
                grad[2 * i + 1] = k * (x[2 * i + 1] - this.drive[2 * i + 1]);
                val[4 * s] += k;
                val[4 * s + 3] += k;
                continue;
            }
            const m = this.mass[i];
            grad[2 * i] = m * (x[2 * i] - this.xTilde[2 * i]);
            grad[2 * i + 1] = m * (x[2 * i + 1] - this.xTilde[2 * i + 1]);
            val[4 * s] += m;
            val[4 * s + 3] += m;
        }
        const nt = this.area.length;
        for (let t = 0; t < nt; t++) if (this.mu[t] !== 0) this.assembleTriangle(t, h2);
        for (let a = 0; a < this.rigidCount; a++) this.assembleAffine(a, h2);

        // Contacts.
        this.contactCount = 0;
        const r2 = this.contactRadius * this.contactRadius;
        const g6 = this.g6;
        const h36 = this.h36;
        for (let c = 0; c < this.candCount; c++) {
            const i = this.candPoint[c];
            const e = this.candEdge[c];
            const a = this.edges[2 * e];
            const b = this.edges[2 * e + 1];
            const s = peDistance2Derivatives(x[2 * i], x[2 * i + 1], x[2 * a], x[2 * a + 1], x[2 * b], x[2 * b + 1], g6, h36);
            if (s >= r2) continue;
            const f1 = this.contactF1(s) * h2;
            const f2 = this.contactF2(s) * h2;
            if (this.contactCount === this.contactVerts.length / 3) this.ensureContacts(this.contactCount * 2);
            const k = this.contactCount++;
            this.contactVerts[3 * k] = i;
            this.contactVerts[3 * k + 1] = a;
            this.contactVerts[3 * k + 2] = b;
            const H = this.contactHess;
            const o = 36 * k;
            for (let r = 0; r < 6; r++) for (let q = 0; q < 6; q++) H[o + r * 6 + q] = f2 * g6[r] * g6[q] + f1 * h36[r * 6 + q];
            projectPsd(H, 6, o);
            grad[2 * i] += f1 * g6[0];
            grad[2 * i + 1] += f1 * g6[1];
            grad[2 * a] += f1 * g6[2];
            grad[2 * a + 1] += f1 * g6[3];
            grad[2 * b] += f1 * g6[4];
            grad[2 * b + 1] += f1 * g6[5];
        }
        this.stats.contacts = this.contactCount;

        // Friction: gradient μλ f1(|u|) sign(u) w, Hessian μλ f1'(|u|) w wᵀ (added as contact matrices).
        const eps = this.params.frictionSpeed * this.params.dt;
        for (let f = 0; f < this.frictionCount; f++) {
            const u = this.slip(x, f);
            const au = Math.abs(u);
            const g = h2 * this.frictionForce[f] * f1(au, eps) * Math.sign(u);
            const hh = h2 * this.frictionForce[f] * f1Prime(au, eps);
            const w = this.frictionW;
            for (let k = 0; k < 3; k++) {
                const vi = this.frictionVerts[3 * f + k];
                grad[2 * vi] += g * w[6 * f + 2 * k];
                grad[2 * vi + 1] += g * w[6 * f + 2 * k + 1];
            }
            if (hh <= 0) continue;
            if (this.contactCount === this.contactVerts.length / 3) this.ensureContacts(this.contactCount * 2);
            const k = this.contactCount++;
            for (let q = 0; q < 3; q++) this.contactVerts[3 * k + q] = this.frictionVerts[3 * f + q];
            const H = this.contactHess;
            for (let r = 0; r < 6; r++) for (let q = 0; q < 6; q++) H[36 * k + r * 6 + q] = hh * w[6 * f + r] * w[6 * f + q];
        }

        if (this.grabVertex >= 0) {
            const gv = this.grabVertex;
            const k = h2 * this.grabStiffness;
            grad[2 * gv] += k * (x[2 * gv] - this.grabTarget.x);
            grad[2 * gv + 1] += k * (x[2 * gv + 1] - this.grabTarget.y);
            const a = this.aff[gv];
            if (a < 0) {
                const s = this.diagSlot[this.dof[gv]];
                val[4 * s] += k;
                val[4 * s + 3] += k;
            } else {
                // k JᵀJ with J = (1, x̄, ȳ) ⊗ I.
                const w = [1, this.bary[2 * gv], this.bary[2 * gv + 1]];
                for (let r = 0; r < 3; r++) {
                    for (let c = 0; c < 3; c++) {
                        const s = this.abdSlot[9 * a + 3 * r + c];
                        val[4 * s] += k * w[r] * w[c];
                        val[4 * s + 3] += k * w[r] * w[c];
                    }
                }
            }
        }
    }

    /**
     * Rigid body a: inertia ½(q − q̃)ᵀM(q − q̃) with M = blockdiag(m, [Σm x̄², Σm x̄ȳ; Σm x̄ȳ, Σm ȳ²]) ⊗ I,
     * plus dt²·κ·area·‖AᵀA − I‖² on the columns c₀, c₁ (PSD-projected).
     * The gradient goes to gradQ, the Hessian into the body's 3×3 CSR blocks.
     */
    private assembleAffine(a: number, h2: number): void {
        const q = this.q, qt = this.qTilde, mm = this.abdMass, g = this.gradQ;
        const o = 6 * a;
        const m = mm[4 * a], ixx = mm[4 * a + 1], ixy = mm[4 * a + 2], iyy = mm[4 * a + 3];
        const ax = q[o + 2], ay = q[o + 3], bx = q[o + 4], by = q[o + 5];
        const dax = ax - qt[o + 2], day = ay - qt[o + 3], dbx = bx - qt[o + 4], dby = by - qt[o + 5];
        const k = h2 * this.params.abdStiffness * this.abdArea[a];
        const s00 = ax * ax + ay * ay - 1, s01 = ax * bx + ay * by, s11 = bx * bx + by * by - 1;
        g[o] = m * (q[o] - qt[o]);
        g[o + 1] = m * (q[o + 1] - qt[o + 1]);
        g[o + 2] = ixx * dax + ixy * dbx + k * 4 * (s00 * ax + s01 * bx);
        g[o + 3] = ixx * day + ixy * dby + k * 4 * (s00 * ay + s01 * by);
        g[o + 4] = ixy * dax + iyy * dbx + k * 4 * (s01 * ax + s11 * bx);
        g[o + 5] = ixy * day + iyy * dby + k * 4 * (s01 * ay + s11 * by);

        // Orthogonality Hessian over (c₀x, c₀y, c₁x, c₁y).
        const H = this.m16;
        const c0 = [ax, ay], c1 = [bx, by];
        for (let i = 0; i < 2; i++) {
            for (let j = 0; j < 2; j++) {
                const d = i === j ? 1 : 0;
                H[i * 4 + j] = k * (4 * s00 * d + 8 * c0[i] * c0[j] + 4 * c1[i] * c1[j]);
                H[(2 + i) * 4 + 2 + j] = k * (4 * s11 * d + 8 * c1[i] * c1[j] + 4 * c0[i] * c0[j]);
                H[i * 4 + 2 + j] = k * (4 * s01 * d + 4 * c1[i] * c0[j]);
                H[(2 + j) * 4 + i] = H[i * 4 + 2 + j];
            }
        }
        projectPsd(H, 4);
        const val = this.val;
        const slot = this.abdSlot;
        const base = 9 * a;
        let s = slot[base];
        val[4 * s] += m;
        val[4 * s + 3] += m;
        const inertia = [ixx, ixy, ixy, iyy];
        for (let r = 0; r < 2; r++) {
            for (let c = 0; c < 2; c++) {
                s = slot[base + 3 * (r + 1) + c + 1];
                val[4 * s] += inertia[r * 2 + c] + H[(2 * r) * 4 + 2 * c];
                val[4 * s + 1] += H[(2 * r) * 4 + 2 * c + 1];
                val[4 * s + 2] += H[(2 * r + 1) * 4 + 2 * c];
                val[4 * s + 3] += inertia[r * 2 + c] + H[(2 * r + 1) * 4 + 2 * c + 1];
            }
        }
    }

    /** Neo-Hookean gradient and PSD-projected Hessian of one triangle, times dt². */
    private assembleTriangle(t: number, h2: number): void {
        const x = this.x;
        const v0 = this.tri[3 * t], v1 = this.tri[3 * t + 1], v2 = this.tri[3 * t + 2];
        const e1x = x[2 * v1] - x[2 * v0], e1y = x[2 * v1 + 1] - x[2 * v0 + 1];
        const e2x = x[2 * v2] - x[2 * v0], e2y = x[2 * v2 + 1] - x[2 * v0 + 1];
        const d = this.dmInv;
        const d00 = d[4 * t], d01 = d[4 * t + 1], d10 = d[4 * t + 2], d11 = d[4 * t + 3];
        const f00 = e1x * d00 + e2x * d10, f01 = e1x * d01 + e2x * d11;
        const f10 = e1y * d00 + e2y * d10, f11 = e1y * d01 + e2y * d11;
        const J = f00 * f11 - f01 * f10;
        const lnJ = Math.log(J);
        const mu = this.mu[t];
        const lam = this.lambda[t];
        // F⁻ᵀ, row major.
        const it = this.t4;
        it[0] = f11 / J; it[1] = -f10 / J; it[2] = -f01 / J; it[3] = f00 / J;
        const p00 = mu * (f00 - it[0]) + lam * lnJ * it[0];
        const p01 = mu * (f01 - it[1]) + lam * lnJ * it[1];
        const p10 = mu * (f10 - it[2]) + lam * lnJ * it[2];
        const p11 = mu * (f11 - it[3]) + lam * lnJ * it[3];
        // w[2 * vertex + j] = ∂F_ij / ∂x_vertex,i.
        const w = this.t6;
        w[0] = -(d00 + d10); w[1] = -(d01 + d11);
        w[2] = d00; w[3] = d01;
        w[4] = d10; w[5] = d11;
        const A = this.area[t] * h2;
        const grad = this.grad;
        grad[2 * v0] += A * (p00 * w[0] + p01 * w[1]);
        grad[2 * v0 + 1] += A * (p10 * w[0] + p11 * w[1]);
        grad[2 * v1] += A * (p00 * w[2] + p01 * w[3]);
        grad[2 * v1 + 1] += A * (p10 * w[2] + p11 * w[3]);
        grad[2 * v2] += A * (p00 * w[4] + p01 * w[5]);
        grad[2 * v2 + 1] += A * (p10 * w[4] + p11 * w[5]);
        const M = this.m16;
        neoHookeanHessian(f00, f01, f10, f11, mu, lam, M);
        const val = this.val;
        for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
                const slot = this.triSlot[9 * t + 3 * a + b];
                if (slot < 0) continue;
                const wa0 = w[2 * a], wa1 = w[2 * a + 1], wb0 = w[2 * b], wb1 = w[2 * b + 1];
                for (let ci = 0; ci < 2; ci++) {
                    for (let di = 0; di < 2; di++) {
                        const r0 = (ci * 2) * 4 + di * 2;
                        const r1 = (ci * 2 + 1) * 4 + di * 2;
                        const sum = wa0 * (M[r0] * wb0 + M[r0 + 1] * wb1) + wa1 * (M[r1] * wb0 + M[r1 + 1] * wb1);
                        val[4 * slot + ci * 2 + di] += A * sum;
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ linear solve

    /** Solves H dir = −grad on the dynamic dofs by block-Jacobi PCG. Returns the iteration count. */
    private solve(): number {
        const D = this.dofCount;
        this.gatherRhs();
        const rhs = this.rhs;
        // Per-body banded Cholesky of the elastic blocks plus the contacts' diagonal blocks
        // (for a rigid vertex, Jᵀ H_ii J lands on all nine blocks of its body).
        const pc = this.precond;
        pc.fill(0);
        const pv = this.rigidCount > 0 ? this.pcVal : this.val;
        if (this.rigidCount > 0) pv.set(this.val);
        for (let k = 0; k < this.contactCount; k++) {
            for (let q = 0; q < 3; q++) {
                const vi = this.contactVerts[3 * k + q];
                const di = this.dof[vi];
                const a = this.aff[vi];
                this.contactDof[3 * k + q] = di >= 0 ? di : a >= 0 ? -2 - a : -1;
                if (di < 0 && a < 0) continue;
                const o = 36 * k + (2 * q) * 6 + 2 * q;
                const h00 = this.contactHess[o], h01 = this.contactHess[o + 1];
                const h10 = this.contactHess[o + 6], h11 = this.contactHess[o + 7];
                if (di >= 0) {
                    pc[4 * di] += h00;
                    pc[4 * di + 1] += h01;
                    pc[4 * di + 2] += h10;
                    pc[4 * di + 3] += h11;
                    continue;
                }
                const w0 = 1, w1 = this.bary[2 * vi], w2 = this.bary[2 * vi + 1];
                for (let r = 0; r < 3; r++) {
                    const wr = r === 0 ? w0 : r === 1 ? w1 : w2;
                    for (let c = 0; c < 3; c++) {
                        const ww = wr * (c === 0 ? w0 : c === 1 ? w1 : w2);
                        const s = this.abdSlot[9 * a + 3 * r + c];
                        pv[4 * s] += ww * h00;
                        pv[4 * s + 1] += ww * h01;
                        pv[4 * s + 2] += ww * h10;
                        pv[4 * s + 3] += ww * h11;
                    }
                }
            }
        }
        this.preconditioner.factor(pv, pc);

        const xk = this.sol;
        const r = this.cgR;
        const z = this.cgZ;
        const p = this.cgP;
        const q = this.cgQ;
        xk.fill(0);
        r.set(rhs);
        let rhsNorm = 0;
        for (let i = 0; i < 2 * D; i++) rhsNorm += rhs[i] * rhs[i];
        rhsNorm = Math.sqrt(rhsNorm);
        let iterations = 0;
        if (rhsNorm > 0) {
            this.applyPrecond(r, z);
            p.set(z);
            let rz = dot(r, z);
            const tol = this.params.cgTol * rhsNorm;
            for (; iterations < this.params.maxCg; iterations++) {
                this.multiply(p, q);
                const pq = dot(p, q);
                if (pq <= 0) break;
                const alpha = rz / pq;
                let rr = 0;
                for (let i = 0; i < 2 * D; i++) {
                    xk[i] += alpha * p[i];
                    r[i] -= alpha * q[i];
                    rr += r[i] * r[i];
                }
                if (Math.sqrt(rr) < tol) {
                    iterations++;
                    break;
                }
                this.applyPrecond(r, z);
                const rzNew = dot(r, z);
                const beta = rzNew / rz;
                rz = rzNew;
                for (let i = 0; i < 2 * D; i++) p[i] = z[i] + beta * p[i];
            }
        }
        this.dir.fill(0);
        for (let a = 0; a < this.rigidCount; a++) {
            const d0 = 2 * this.abdDof[a];
            for (let c = 0; c < 6; c++) this.dq[6 * a + c] = xk[d0 + c];
        }
        const dq = this.dq;
        for (let i = 0; i < this.vertexCount; i++) {
            const di = this.dof[i];
            if (di >= 0) {
                this.dir[2 * i] = xk[2 * di];
                this.dir[2 * i + 1] = xk[2 * di + 1];
                continue;
            }
            const a = this.aff[i];
            if (a < 0) continue;
            const o = 6 * a;
            const bx = this.bary[2 * i], by = this.bary[2 * i + 1];
            this.dir[2 * i] = dq[o] + bx * dq[o + 2] + by * dq[o + 4];
            this.dir[2 * i + 1] = dq[o + 1] + bx * dq[o + 3] + by * dq[o + 5];
        }
        return iterations;
    }

    /** rhs = −(gradient over the unknowns): vertex gradients mapped by Jᵀ, plus the rigid bodies' own terms. */
    private gatherRhs(): void {
        const rhs = this.rhs;
        const grad = this.grad;
        rhs.fill(0);
        for (let i = 0; i < this.vertexCount; i++) {
            const di = this.dof[i];
            if (di >= 0) {
                rhs[2 * di] = -grad[2 * i];
                rhs[2 * di + 1] = -grad[2 * i + 1];
                continue;
            }
            const a = this.aff[i];
            if (a < 0) continue;
            const d = 2 * this.abdDof[a];
            const bx = this.bary[2 * i], by = this.bary[2 * i + 1];
            const gx = grad[2 * i], gy = grad[2 * i + 1];
            rhs[d] -= gx;
            rhs[d + 1] -= gy;
            rhs[d + 2] -= bx * gx;
            rhs[d + 3] -= bx * gy;
            rhs[d + 4] -= by * gx;
            rhs[d + 5] -= by * gy;
        }
        for (let a = 0; a < this.rigidCount; a++) {
            const d = 2 * this.abdDof[a];
            for (let c = 0; c < 6; c++) rhs[d + c] -= this.gradQ[6 * a + c];
        }
    }

    private applyPrecond(r: Float64Array, z: Float64Array): void {
        this.preconditioner.apply(r, z);
    }

    private multiply(xv: Float64Array, out: Float64Array): void {
        const D = this.dofCount;
        const val = this.val;
        for (let i = 0; i < D; i++) {
            let sx = 0, sy = 0;
            for (let s = this.rowStart[i]; s < this.rowStart[i + 1]; s++) {
                const j = this.col[s];
                const a = xv[2 * j], b = xv[2 * j + 1];
                sx += val[4 * s] * a + val[4 * s + 1] * b;
                sy += val[4 * s + 2] * a + val[4 * s + 3] * b;
            }
            out[2 * i] = sx;
            out[2 * i + 1] = sy;
        }
        const H = this.contactHess;
        const cd = this.contactDof;
        const y = this.t6;
        const bary = this.bary;
        const abdDof = this.abdDof;
        for (let k = 0; k < this.contactCount; k++) {
            const o = 36 * k;
            // Vertex displacements of the three contact vertices: J·xv.
            for (let c = 0; c < 3; c++) {
                const dc = cd[3 * k + c];
                if (dc >= 0) {
                    y[2 * c] = xv[2 * dc];
                    y[2 * c + 1] = xv[2 * dc + 1];
                } else if (dc === -1) {
                    y[2 * c] = 0;
                    y[2 * c + 1] = 0;
                } else {
                    const vi = this.contactVerts[3 * k + c];
                    const d = 2 * abdDof[-2 - dc];
                    const bx = bary[2 * vi], by = bary[2 * vi + 1];
                    y[2 * c] = xv[d] + bx * xv[d + 2] + by * xv[d + 4];
                    y[2 * c + 1] = xv[d + 1] + bx * xv[d + 3] + by * xv[d + 5];
                }
            }
            for (let r = 0; r < 3; r++) {
                const dr = cd[3 * k + r];
                if (dr === -1) continue;
                let sx = 0, sy = 0;
                for (let c = 0; c < 6; c++) {
                    sx += H[o + (2 * r) * 6 + c] * y[c];
                    sy += H[o + (2 * r + 1) * 6 + c] * y[c];
                }
                if (dr >= 0) {
                    out[2 * dr] += sx;
                    out[2 * dr + 1] += sy;
                    continue;
                }
                const vi = this.contactVerts[3 * k + r];
                const d = 2 * abdDof[-2 - dr];
                const bx = bary[2 * vi], by = bary[2 * vi + 1];
                out[d] += sx;
                out[d + 1] += sy;
                out[d + 2] += bx * sx;
                out[d + 3] += bx * sy;
                out[d + 4] += by * sx;
                out[d + 5] += by * sy;
            }
        }
    }

    // ------------------------------------------------------------ step filters

    private inversionFreeStep(alpha: number): number {
        const x = this.x;
        const p = this.dir;
        for (let t = 0; t < this.area.length; t++) {
            if (this.mu[t] === 0) continue;
            const a = this.tri[3 * t], b = this.tri[3 * t + 1], c = this.tri[3 * t + 2];
            alpha = inversionStep(
                x[2 * b] - x[2 * a], x[2 * b + 1] - x[2 * a + 1], x[2 * c] - x[2 * a], x[2 * c + 1] - x[2 * a + 1],
                p[2 * b] - p[2 * a], p[2 * b + 1] - p[2 * a + 1], p[2 * c] - p[2 * a], p[2 * c + 1] - p[2 * a + 1],
                alpha,
            );
        }
        return alpha;
    }

    /** Largest step ≤ alpha that keeps every candidate pair apart (additive CCD). */
    private ccdStep(alpha: number): number {
        const x = this.x;
        const p = this.dir;
        for (let c = 0; c < this.candCount; c++) {
            const i = this.candPoint[c];
            const e = this.candEdge[c];
            const a = this.edges[2 * e];
            const b = this.edges[2 * e + 1];
            alpha = accdPointEdge(
                x[2 * i], x[2 * i + 1], x[2 * a], x[2 * a + 1], x[2 * b], x[2 * b + 1],
                alpha * p[2 * i], alpha * p[2 * i + 1], alpha * p[2 * a], alpha * p[2 * a + 1], alpha * p[2 * b], alpha * p[2 * b + 1],
                1,
            ) * alpha;
        }
        return alpha;
    }

    // ------------------------------------------------------------ diagnostics

    private measureContacts(): void {
        this.findPairs(this.x, null, 0);
        const r2 = this.contactRadius * this.contactRadius;
        let minS = Infinity;
        let count = 0;
        for (let c = 0; c < this.candCount; c++) {
            const s = this.distance2(this.x, this.candPoint[c], this.candEdge[c]);
            if (s < r2) {
                count++;
                minS = Math.min(minS, s);
            }
        }
        this.stats.contacts = count;
        this.stats.minDistance = Math.sqrt(minS);
    }

    /** Current over rest area of triangle t (det F). */
    areaRatio(t: number): number {
        const x = this.x;
        const a = this.tri[3 * t], b = this.tri[3 * t + 1], c = this.tri[3 * t + 2];
        const e1x = x[2 * b] - x[2 * a], e1y = x[2 * b + 1] - x[2 * a + 1];
        const e2x = x[2 * c] - x[2 * a], e2y = x[2 * c + 1] - x[2 * a + 1];
        return (e1x * e2y - e1y * e2x) / (2 * this.area[t]);
    }

    /** ‖FᵀF − I‖_F of triangle t: 0 for a pure rotation. */
    strain(t: number): number {
        const x = this.x;
        const a = this.tri[3 * t], b = this.tri[3 * t + 1], c = this.tri[3 * t + 2];
        const e1x = x[2 * b] - x[2 * a], e1y = x[2 * b + 1] - x[2 * a + 1];
        const e2x = x[2 * c] - x[2 * a], e2y = x[2 * c + 1] - x[2 * a + 1];
        const d = this.dmInv;
        const f00 = e1x * d[4 * t] + e2x * d[4 * t + 2], f01 = e1x * d[4 * t + 1] + e2x * d[4 * t + 3];
        const f10 = e1y * d[4 * t] + e2y * d[4 * t + 2], f11 = e1y * d[4 * t + 1] + e2y * d[4 * t + 3];
        const s00 = f00 * f00 + f10 * f10 - 1, s01 = f00 * f01 + f10 * f11, s11 = f01 * f01 + f11 * f11 - 1;
        return Math.sqrt(s00 * s00 + 2 * s01 * s01 + s11 * s11);
    }

    /** Pairs of boundary edges (not sharing a vertex) that cross: zero means no interpenetration of outlines. */
    countCrossings(): number {
        const x = this.x;
        const edges = this.edges;
        const ne = edges.length / 2;
        const be = this.boxE;
        for (let e = 0; e < ne; e++) {
            const a = edges[2 * e], b = edges[2 * e + 1];
            be[4 * e] = Math.min(x[2 * a], x[2 * b]);
            be[4 * e + 1] = Math.min(x[2 * a + 1], x[2 * b + 1]);
            be[4 * e + 2] = Math.max(x[2 * a], x[2 * b]);
            be[4 * e + 3] = Math.max(x[2 * a + 1], x[2 * b + 1]);
        }
        this.buildGrid(be, ne);
        this.stamp.fill(-1);
        this.crossing.fill(0);
        let crossings = 0;
        for (let e = 0; e < ne; e++) {
            const a = edges[2 * e], b = edges[2 * e + 1];
            const cx0 = this.cellX(be[4 * e]), cx1 = this.cellX(be[4 * e + 2]);
            const cy0 = this.cellY(be[4 * e + 1]), cy1 = this.cellY(be[4 * e + 3]);
            for (let cy = cy0; cy <= cy1; cy++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    const cell = cy * GRID_CELLS + cx;
                    for (let s = this.cellStart[cell]; s < this.cellStart[cell + 1]; s++) {
                        const f = this.cellItems[s];
                        if (f <= e || this.stamp[f] === e) continue;
                        this.stamp[f] = e;
                        const c = edges[2 * f], d = edges[2 * f + 1];
                        if (c === a || c === b || d === a || d === b) continue;
                        if (this.kinematic[a] && this.kinematic[b] && this.kinematic[c] && this.kinematic[d]) continue;
                        if (segmentsCross(x, a, b, c, d)) {
                            crossings++;
                            this.crossing[e] = 1;
                            this.crossing[f] = 1;
                        }
                    }
                }
            }
        }
        return crossings;
    }

    // ------------------------------------------------------------ interaction

    /** Grabs the nearest dynamic vertex within `radius`; returns false if none. */
    grab(px: number, py: number, radius: number): boolean {
        let best = -1;
        let bestD = radius * radius;
        for (let i = 0; i < this.vertexCount; i++) {
            if (this.mass[i] === 0) continue;
            const dx = this.x[2 * i] - px;
            const dy = this.x[2 * i + 1] - py;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        if (best < 0) return false;
        this.grabVertex = best;
        const body = this.bodies.find((b) => best >= b.start && best < b.start + b.count)!;
        // About a 6 Hz pull on the whole body.
        this.grabStiffness = body.mass * (2 * Math.PI * 6) ** 2;
        this.grabTarget.x = px;
        this.grabTarget.y = py;
        return true;
    }

    moveGrab(px: number, py: number): void {
        this.grabTarget.x = px;
        this.grabTarget.y = py;
    }

    releaseGrab(): void {
        this.grabVertex = -1;
    }

    get grabbed(): number {
        return this.grabVertex;
    }

    // ------------------------------------------------------------ storage

    private ensureContacts(capacity: number): void {
        const verts = new Int32Array(3 * capacity);
        verts.set(this.contactVerts);
        const hess = new Float64Array(36 * capacity);
        hess.set(this.contactHess);
        this.contactVerts = verts;
        this.contactDof = new Int32Array(3 * capacity);
        this.contactHess = hess;
    }

    private ensureFriction(capacity: number): void {
        const verts = new Int32Array(3 * capacity);
        verts.set(this.frictionVerts);
        const w = new Float64Array(6 * capacity);
        w.set(this.frictionW);
        const force = new Float64Array(capacity);
        force.set(this.frictionForce);
        this.frictionVerts = verts;
        this.frictionW = w;
        this.frictionForce = force;
    }
}

// Smoothed Coulomb friction (IPC): f1 ramps from 0 to 1 over slip ε, f0 is its integral.
function f0(y: number, eps: number): number {
    return y >= eps ? y : (-y * y * y) / (3 * eps * eps) + (y * y) / eps + eps / 3;
}

function f1(y: number, eps: number): number {
    return y >= eps ? 1 : (-y * y) / (eps * eps) + (2 * y) / eps;
}

function f1Prime(y: number, eps: number): number {
    return y >= eps ? 0 : (2 * (eps - y)) / (eps * eps);
}

function dot(a: Float64Array, b: Float64Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

function orient2(x: Float64Array, a: number, b: number, c: number): number {
    return (x[2 * b] - x[2 * a]) * (x[2 * c + 1] - x[2 * a + 1]) - (x[2 * b + 1] - x[2 * a + 1]) * (x[2 * c] - x[2 * a]);
}

function segmentsCross(x: Float64Array, a: number, b: number, c: number, d: number): boolean {
    const o1 = orient2(x, a, b, c);
    const o2 = orient2(x, a, b, d);
    const o3 = orient2(x, c, d, a);
    const o4 = orient2(x, c, d, b);
    return o1 * o2 < 0 && o3 * o4 < 0;
}

const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();
