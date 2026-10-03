import { Pressure, PressureSolver, type PressureKind } from './Pressure';

export const Advection = { SemiLagrangian: 0, MacCormack: 1 } as const;
export type AdvectionKind = (typeof Advection)[keyof typeof Advection];

/** Domain edge: no-through wall, open (pressure 0, fluid leaves freely) or inflow at `inflow` cells/s. */
export const Side = { Wall: 0, Open: 1, Inflow: 2 } as const;
export type SideKind = (typeof Side)[keyof typeof Side];

/** A solid disc; its velocity is imposed on the faces it covers, so dragging it stirs the fluid. */
export interface Obstacle {
    x: number;
    y: number;
    r: number;
    vx: number;
    vy: number;
}

/** MacCormack falls back to semi-Lagrangian this many cells around solids. */
const NEAR_SOLID = 2;
/** Width of a nozzle's soft rim, in cells. */
const NOZZLE_EDGE = 1.5;

export interface FluidParams {
    dt: number;
    advection: AdvectionKind;
    pressure: PressureKind;
    jacobiIterations: number;
    /** Vorticity confinement strength (Fedkiw et al. 2001), 0 = off. */
    vorticity: number;
    /** Upward acceleration per unit dye density, cells/s². */
    buoyancy: number;
    /** Fraction of dye lost per second. */
    dyeDecay: number;
}

export interface FluidStats {
    stepMs: number;
    advectMs: number;
    pressureMs: number;
    pressureIterations: number;
    /** Largest |∇·u| over fluid cells after the projection, in 1/s. */
    maxDivergence: number;
    /** ½ Σ ω² over fluid cells: how much swirl the advection kept. */
    enstrophy: number;
    maxSpeed: number;
}

/**
 * Incompressible 2D flow on a MAC grid (Stam 1999, "Stable Fluids"), one
 * cell = one length unit. Each step: advect velocity and dye along the
 * previous divergence-free field, add forces, then project. Advection is
 * semi-Lagrangian (RK2 backtrace + bilinear lookup) or MacCormack (Selle et
 * al. 2008): a forward and a backward semi-Lagrangian pass estimate the
 * interpolation error, which is removed and then clamped to the values the
 * forward lookup saw, so no new extrema appear.
 */
export class FluidGrid {
    readonly nx: number;
    readonly ny: number;
    /** x velocity on vertical faces, (nx + 1) × ny, face (i, j) at (i, j + ½). */
    u: Float32Array;
    /** y velocity on horizontal faces, nx × (ny + 1), face (i, j) at (i + ½, j). */
    v: Float32Array;
    /** Dye colour per cell, linear RGB, cell (i, j) centred at (i + ½, j + ½). */
    r: Float32Array;
    g: Float32Array;
    b: Float32Array;
    readonly solid: Uint8Array;
    /** Velocity of the solid covering a cell (obstacle velocity). */
    readonly solidVx: Float32Array;
    readonly solidVy: Float32Array;
    /** Cell-centred vorticity, refreshed every step (confinement, display, stats). */
    readonly curl: Float32Array;
    /** Left, right, bottom, top. */
    readonly sides: SideKind[] = [Side.Wall, Side.Wall, Side.Wall, Side.Wall];
    inflow = 0;
    readonly obstacles: Obstacle[] = [];
    readonly params: FluidParams = {
        dt: 1 / 60,
        advection: Advection.MacCormack,
        pressure: PressureSolver.MGPCG,
        jacobiIterations: 40,
        vorticity: 0,
        buoyancy: 0,
        dyeDecay: 0,
    };
    readonly stats: FluidStats = {
        stepMs: 0,
        advectMs: 0,
        pressureMs: 0,
        pressureIterations: 0,
        maxDivergence: 0,
        enstrophy: 0,
        maxSpeed: 0,
    };
    readonly pressure: Pressure;
    time = 0;

    private uNext: Float32Array;
    private vNext: Float32Array;
    private rNext: Float32Array;
    private gNext: Float32Array;
    private bNext: Float32Array;
    private readonly hat: Float32Array;
    private readonly backX: Float32Array;
    private readonly backY: Float32Array;
    private readonly fwdX: Float32Array;
    private readonly fwdY: Float32Array;
    private readonly cellU: Float32Array;
    private readonly cellV: Float32Array;
    private readonly forceX: Float32Array;
    private readonly forceY: Float32Array;
    private readonly divergence: Float64Array;
    private readonly nearCell: Uint8Array;
    private readonly nearU: Uint8Array;
    private readonly nearV: Uint8Array;
    private readonly traced = { x: 0, y: 0 };
    private readonly velocity = { x: 0, y: 0 };
    private readonly range = { lo: 0, hi: 0 };

    constructor(nx: number, ny: number) {
        this.nx = nx;
        this.ny = ny;
        const cells = nx * ny;
        const nu = (nx + 1) * ny;
        const nv = nx * (ny + 1);
        this.u = new Float32Array(nu);
        this.v = new Float32Array(nv);
        this.uNext = new Float32Array(nu);
        this.vNext = new Float32Array(nv);
        this.r = new Float32Array(cells);
        this.g = new Float32Array(cells);
        this.b = new Float32Array(cells);
        this.rNext = new Float32Array(cells);
        this.gNext = new Float32Array(cells);
        this.bNext = new Float32Array(cells);
        this.solid = new Uint8Array(cells);
        this.solidVx = new Float32Array(cells);
        this.solidVy = new Float32Array(cells);
        this.curl = new Float32Array(cells);
        const most = Math.max(nu, nv);
        this.hat = new Float32Array(most);
        this.backX = new Float32Array(most);
        this.backY = new Float32Array(most);
        this.fwdX = new Float32Array(most);
        this.fwdY = new Float32Array(most);
        this.cellU = new Float32Array(cells);
        this.cellV = new Float32Array(cells);
        this.forceX = new Float32Array(cells);
        this.forceY = new Float32Array(cells);
        this.divergence = new Float64Array(cells);
        this.nearCell = new Uint8Array(cells);
        this.nearU = new Uint8Array(nu);
        this.nearV = new Uint8Array(nv);
        this.pressure = new Pressure(nx, ny);
    }

    clear(): void {
        this.u.fill(0);
        this.v.fill(0);
        this.r.fill(0);
        this.g.fill(0);
        this.b.fill(0);
        this.curl.fill(0);
        this.pressure.reset();
        this.time = 0;
    }

    isOpen(): boolean {
        return this.sides.some((s) => s === Side.Open);
    }

    /**
     * One step. `drive` runs after advection, before the projection: emitters,
     * the user's finger, anything that writes velocity or dye.
     */
    step(drive?: (grid: FluidGrid) => void): void {
        const t0 = now();
        const p = this.params;
        this.rasterizeObstacles();
        const t1 = now();
        this.advectVelocity();
        this.advectDye();
        const t2 = now();
        this.computeCurl();
        if (p.vorticity > 0) this.confineVorticity(p.vorticity);
        if (p.buoyancy !== 0) this.addBuoyancy(p.buoyancy);
        if (p.dyeDecay > 0) this.decayDye(p.dyeDecay);
        drive?.(this);
        this.applyBoundary();
        const t3 = now();
        this.project();
        const t4 = now();
        this.computeCurl();
        this.measure();
        this.time += p.dt;
        this.stats.advectMs = t2 - t1;
        this.stats.pressureMs = t4 - t3;
        this.stats.stepMs = now() - t0;
    }

    // ---------------------------------------------------------------- sampling

    /** Bilinear lookup in a field stored w × h with sample (0, 0) at (ox, oy); positions clamp to the samples. */
    sample(field: Float32Array, w: number, h: number, ox: number, oy: number, x: number, y: number): number {
        let gx = x - ox;
        let gy = y - oy;
        if (gx < 0) gx = 0;
        else if (gx > w - 1) gx = w - 1;
        if (gy < 0) gy = 0;
        else if (gy > h - 1) gy = h - 1;
        let i = Math.floor(gx);
        let j = Math.floor(gy);
        if (i > w - 2) i = w - 2;
        if (j > h - 2) j = h - 2;
        const fx = gx - i;
        const fy = gy - j;
        const k = i + j * w;
        const a = field[k] + (field[k + 1] - field[k]) * fx;
        const b = field[k + w] + (field[k + w + 1] - field[k + w]) * fx;
        return a + (b - a) * fy;
    }

    /** Min and max of the four samples a bilinear lookup at (x, y) blends. */
    private sampleRange(field: Float32Array, w: number, h: number, ox: number, oy: number, x: number, y: number): void {
        let gx = x - ox;
        let gy = y - oy;
        if (gx < 0) gx = 0;
        else if (gx > w - 1) gx = w - 1;
        if (gy < 0) gy = 0;
        else if (gy > h - 1) gy = h - 1;
        let i = Math.floor(gx);
        let j = Math.floor(gy);
        if (i > w - 2) i = w - 2;
        if (j > h - 2) j = h - 2;
        const k = i + j * w;
        const a = field[k];
        const b = field[k + 1];
        const c = field[k + w];
        const d = field[k + w + 1];
        this.range.lo = Math.min(Math.min(a, b), Math.min(c, d));
        this.range.hi = Math.max(Math.max(a, b), Math.max(c, d));
    }

    velocityAt(x: number, y: number, out: { x: number; y: number }): void {
        out.x = this.sample(this.u, this.nx + 1, this.ny, 0, 0.5, x, y);
        out.y = this.sample(this.v, this.nx, this.ny + 1, 0.5, 0, x, y);
    }

    /** Midpoint (RK2) path through the current velocity, `dt` may be negative. */
    private trace(x: number, y: number, dt: number): void {
        const vel = this.velocity;
        this.velocityAt(x, y, vel);
        const mx = x - 0.5 * dt * vel.x;
        const my = y - 0.5 * dt * vel.y;
        this.velocityAt(mx, my, vel);
        this.traced.x = x - dt * vel.x;
        this.traced.y = y - dt * vel.y;
    }

    // ---------------------------------------------------------------- advection

    /** Fills the backward (and for MacCormack forward) trace end points of every sample of a w × h field. */
    private computeTraces(w: number, h: number, ox: number, oy: number, forward: boolean): void {
        const dt = this.params.dt;
        const t = this.traced;
        for (let j = 0, k = 0; j < h; j++) {
            for (let i = 0; i < w; i++, k++) {
                const x = i + ox;
                const y = j + oy;
                this.trace(x, y, dt);
                this.backX[k] = t.x;
                this.backY[k] = t.y;
                if (forward) {
                    this.trace(x, y, -dt);
                    this.fwdX[k] = t.x;
                    this.fwdY[k] = t.y;
                }
            }
        }
    }

    /**
     * `near` flags samples within reach of a solid: there the backward pass
     * would read the solid's zeros as error, so MacCormack keeps the plain
     * semi-Lagrangian value (Selle et al. do the same).
     */
    private advectField(src: Float32Array, dst: Float32Array, w: number, h: number, ox: number, oy: number, near: Uint8Array): void {
        const n = w * h;
        const { backX, backY } = this;
        if (this.params.advection === Advection.SemiLagrangian) {
            for (let k = 0; k < n; k++) dst[k] = this.sample(src, w, h, ox, oy, backX[k], backY[k]);
            return;
        }
        const { hat, fwdX, fwdY, range } = this;
        for (let k = 0; k < n; k++) hat[k] = this.sample(src, w, h, ox, oy, backX[k], backY[k]);
        for (let k = 0; k < n; k++) {
            if (near[k]) {
                dst[k] = hat[k];
                continue;
            }
            const back = this.sample(hat, w, h, ox, oy, fwdX[k], fwdY[k]);
            let value = hat[k] + 0.5 * (src[k] - back);
            this.sampleRange(src, w, h, ox, oy, backX[k], backY[k]);
            if (value < range.lo) value = range.lo;
            else if (value > range.hi) value = range.hi;
            dst[k] = value;
        }
    }

    private advectVelocity(): void {
        const { nx, ny } = this;
        const mac = this.params.advection === Advection.MacCormack;
        this.computeTraces(nx + 1, ny, 0, 0.5, mac);
        this.advectField(this.u, this.uNext, nx + 1, ny, 0, 0.5, this.nearU);
        this.computeTraces(nx, ny + 1, 0.5, 0, mac);
        this.advectField(this.v, this.vNext, nx, ny + 1, 0.5, 0, this.nearV);
        let s = this.u;
        this.u = this.uNext;
        this.uNext = s;
        s = this.v;
        this.v = this.vNext;
        this.vNext = s;
    }

    /** Dye moves with the old velocity too: traces use `uNext`/`vNext`, which now hold it. */
    private advectDye(): void {
        const { nx, ny } = this;
        const u = this.u;
        const v = this.v;
        this.u = this.uNext;
        this.v = this.vNext;
        this.computeTraces(nx, ny, 0.5, 0.5, this.params.advection === Advection.MacCormack);
        this.u = u;
        this.v = v;
        this.advectField(this.r, this.rNext, nx, ny, 0.5, 0.5, this.nearCell);
        this.advectField(this.g, this.gNext, nx, ny, 0.5, 0.5, this.nearCell);
        this.advectField(this.b, this.bNext, nx, ny, 0.5, 0.5, this.nearCell);
        let s = this.r;
        this.r = this.rNext;
        this.rNext = s;
        s = this.g;
        this.g = this.gNext;
        this.gNext = s;
        s = this.b;
        this.b = this.bNext;
        this.bNext = s;
        for (let c = 0; c < nx * ny; c++) {
            if (this.solid[c]) {
                this.r[c] = 0;
                this.g[c] = 0;
                this.b[c] = 0;
            }
        }
    }

    // ---------------------------------------------------------------- forces

    private computeCurl(): void {
        const { nx, ny, u, v, cellU, cellV, curl } = this;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                cellU[c] = 0.5 * (u[i + j * (nx + 1)] + u[i + 1 + j * (nx + 1)]);
                cellV[c] = 0.5 * (v[c] + v[c + nx]);
            }
        }
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                if (this.solid[c]) {
                    curl[c] = 0;
                    continue;
                }
                const il = i > 0 ? c - 1 : c;
                const ir = i < nx - 1 ? c + 1 : c;
                const jd = j > 0 ? c - nx : c;
                const ju = j < ny - 1 ? c + nx : c;
                const dvdx = (cellV[ir] - cellV[il]) / Math.max(1, ir - il);
                const dudy = (cellU[ju] - cellU[jd]) / Math.max(1, (ju - jd) / nx);
                curl[c] = dvdx - dudy;
            }
        }
    }

    /** f = ε (N × ω), N = ∇|ω| / |∇|ω||: puts back swirl the grid smears out. */
    private confineVorticity(epsilon: number): void {
        const { nx, ny, curl, forceX, forceY } = this;
        forceX.fill(0);
        forceY.fill(0);
        for (let j = 1; j < ny - 1; j++) {
            for (let i = 1; i < nx - 1; i++) {
                const c = i + j * nx;
                if (this.solid[c]) continue;
                const gx = 0.5 * (Math.abs(curl[c + 1]) - Math.abs(curl[c - 1]));
                const gy = 0.5 * (Math.abs(curl[c + nx]) - Math.abs(curl[c - nx]));
                const len = Math.sqrt(gx * gx + gy * gy) + 1e-5;
                forceX[c] = epsilon * (gy / len) * curl[c];
                forceY[c] = -epsilon * (gx / len) * curl[c];
            }
        }
        this.addCellForces(forceX, forceY);
    }

    private addBuoyancy(alpha: number): void {
        const { nx, ny, forceX, forceY } = this;
        forceX.fill(0);
        for (let c = 0; c < nx * ny; c++) forceY[c] = alpha * (this.r[c] + this.g[c] + this.b[c]) / 3;
        this.addCellForces(forceX, forceY);
    }

    /** Averages cell-centred accelerations onto the faces between two fluid cells. */
    private addCellForces(fx: Float32Array, fy: Float32Array): void {
        const { nx, ny, u, v, solid } = this;
        const dt = this.params.dt;
        for (let j = 0; j < ny; j++) {
            for (let i = 1; i < nx; i++) {
                const c = i + j * nx;
                if (solid[c] || solid[c - 1]) continue;
                u[i + j * (nx + 1)] += dt * 0.5 * (fx[c] + fx[c - 1]);
            }
        }
        for (let j = 1; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                if (solid[c] || solid[c - nx]) continue;
                v[c] += dt * 0.5 * (fy[c] + fy[c - nx]);
            }
        }
    }

    private decayDye(rate: number): void {
        const k = Math.max(0, 1 - rate * this.params.dt);
        for (let c = 0; c < this.nx * this.ny; c++) {
            this.r[c] *= k;
            this.g[c] *= k;
            this.b[c] *= k;
        }
    }

    /**
     * Adds a Gaussian blob of velocity (cells/s) and dye around (x, y). `radius`
     * is the 1/e distance; the blob is cut off at 3 radii.
     */
    splat(x: number, y: number, radius: number, vx: number, vy: number, cr: number, cg: number, cb: number): void {
        const { nx, ny } = this;
        const reach = radius * 3;
        const inv = 1 / (radius * radius);
        const i0 = Math.max(0, Math.floor(x - reach));
        const i1 = Math.min(nx, Math.ceil(x + reach));
        const j0 = Math.max(0, Math.floor(y - reach));
        const j1 = Math.min(ny, Math.ceil(y + reach));
        for (let j = j0; j < j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const dx = i - x;
                const dy = j + 0.5 - y;
                const w = Math.exp(-(dx * dx + dy * dy) * inv);
                if (w < 1e-3) continue;
                this.u[i + j * (nx + 1)] += vx * w;
            }
        }
        for (let j = j0; j <= Math.min(ny, j1); j++) {
            for (let i = i0; i < i1; i++) {
                const dx = i + 0.5 - x;
                const dy = j - y;
                const w = Math.exp(-(dx * dx + dy * dy) * inv);
                if (w < 1e-3) continue;
                this.v[i + j * nx] += vy * w;
            }
        }
        if (cr === 0 && cg === 0 && cb === 0) return;
        for (let j = j0; j < j1; j++) {
            for (let i = i0; i < i1; i++) {
                const c = i + j * nx;
                if (this.solid[c]) continue;
                const dx = i + 0.5 - x;
                const dy = j + 0.5 - y;
                const w = Math.exp(-(dx * dx + dy * dy) * inv);
                if (w < 1e-3) continue;
                this.r[c] = Math.min(4, this.r[c] + cr * w);
                this.g[c] = Math.min(4, this.g[c] + cg * w);
                this.b[c] = Math.min(4, this.b[c] + cb * w);
            }
        }
    }

    /**
     * A nozzle: inside the disc velocity and dye are set to (vx, vy) and the
     * colour, blending out over the last NOZZLE_EDGE cells so the rim does not
     * show the grid's staircase.
     */
    nozzle(x: number, y: number, radius: number, vx: number, vy: number, cr: number, cg: number, cb: number): void {
        const { nx, ny } = this;
        const su = nx + 1;
        const i0 = Math.max(0, Math.floor(x - radius - 1));
        const i1 = Math.min(nx - 1, Math.ceil(x + radius + 1));
        const j0 = Math.max(0, Math.floor(y - radius - 1));
        const j1 = Math.min(ny - 1, Math.ceil(y + radius + 1));
        const weight = (px: number, py: number) => {
            const d = Math.hypot(px - x, py - y);
            return Math.min(1, Math.max(0, (radius - d) / NOZZLE_EDGE + 0.5));
        };
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const c = i + j * nx;
                if (this.solid[c]) continue;
                const w = weight(i + 0.5, j + 0.5);
                if (w > 0) {
                    this.r[c] += (cr - this.r[c]) * w;
                    this.g[c] += (cg - this.g[c]) * w;
                    this.b[c] += (cb - this.b[c]) * w;
                }
                const wu = weight(i, j + 0.5);
                if (wu > 0) this.u[i + j * su] += (vx - this.u[i + j * su]) * wu;
                const wv = weight(i + 0.5, j);
                if (wv > 0) this.v[c] += (vy - this.v[c]) * wv;
            }
        }
    }

    setDye(i: number, j: number, cr: number, cg: number, cb: number): void {
        const c = i + j * this.nx;
        this.r[c] = cr;
        this.g[c] = cg;
        this.b[c] = cb;
    }

    // ---------------------------------------------------------------- boundaries

    private rasterizeObstacles(): void {
        const { nx, ny, solid, solidVx, solidVy } = this;
        solid.fill(0);
        for (const o of this.obstacles) {
            const r2 = o.r * o.r;
            const i0 = Math.max(0, Math.floor(o.x - o.r));
            const i1 = Math.min(nx - 1, Math.ceil(o.x + o.r));
            const j0 = Math.max(0, Math.floor(o.y - o.r));
            const j1 = Math.min(ny - 1, Math.ceil(o.y + o.r));
            for (let j = j0; j <= j1; j++) {
                for (let i = i0; i <= i1; i++) {
                    const dx = i + 0.5 - o.x;
                    const dy = j + 0.5 - o.y;
                    if (dx * dx + dy * dy > r2) continue;
                    const c = i + j * nx;
                    solid[c] = 1;
                    solidVx[c] = o.vx;
                    solidVy[c] = o.vy;
                }
            }
        }
        this.markNearSolid();
    }

    /** Cells within NEAR_SOLID cells of a solid (Chebyshev distance), and the faces beside them. */
    private markNearSolid(): void {
        const { nx, ny, solid, nearCell, nearU, nearV } = this;
        nearCell.fill(0);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                if (!solid[i + j * nx]) continue;
                for (let b = Math.max(0, j - NEAR_SOLID); b <= Math.min(ny - 1, j + NEAR_SOLID); b++) {
                    for (let a = Math.max(0, i - NEAR_SOLID); a <= Math.min(nx - 1, i + NEAR_SOLID); a++) nearCell[a + b * nx] = 1;
                }
            }
        }
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i <= nx; i++) {
                nearU[i + j * (nx + 1)] = nearCell[Math.max(0, i - 1) + j * nx] | nearCell[Math.min(nx - 1, i) + j * nx];
            }
        }
        for (let j = 0; j <= ny; j++) {
            for (let i = 0; i < nx; i++) {
                nearV[i + j * nx] = nearCell[i + Math.max(0, j - 1) * nx] | nearCell[i + Math.min(ny - 1, j) * nx];
            }
        }
    }

    /** Domain edges and faces touching a solid get their prescribed normal velocity. */
    applyBoundary(): void {
        const { nx, ny, u, v, solid, solidVx, solidVy, sides, inflow } = this;
        const su = nx + 1;
        for (let j = 0; j < ny; j++) {
            const row = j * su;
            u[row] = sides[0] === Side.Inflow ? inflow : sides[0] === Side.Open ? u[row + 1] : 0;
            u[row + nx] = sides[1] === Side.Inflow ? -inflow : sides[1] === Side.Open ? u[row + nx - 1] : 0;
        }
        for (let i = 0; i < nx; i++) {
            v[i] = sides[2] === Side.Inflow ? inflow : sides[2] === Side.Open ? v[i + nx] : 0;
            v[i + ny * nx] = sides[3] === Side.Inflow ? -inflow : sides[3] === Side.Open ? v[i + (ny - 1) * nx] : 0;
        }
        for (let j = 0; j < ny; j++) {
            for (let i = 1; i < nx; i++) {
                const c = i + j * nx;
                const a = solid[c - 1];
                const b = solid[c];
                if (!a && !b) continue;
                u[i + j * su] = a && b ? 0.5 * (solidVx[c - 1] + solidVx[c]) : a ? solidVx[c - 1] : solidVx[c];
            }
        }
        for (let j = 1; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                const a = solid[c - nx];
                const b = solid[c];
                if (!a && !b) continue;
                v[c] = a && b ? 0.5 * (solidVy[c - nx] + solidVy[c]) : a ? solidVy[c - nx] : solidVy[c];
            }
        }
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                if (!solid[c]) continue;
                if (i === 0) u[j * su] = solidVx[c];
                if (i === nx - 1) u[nx + j * su] = solidVx[c];
                if (j === 0) v[i] = solidVy[c];
                if (j === ny - 1) v[i + ny * nx] = solidVy[c];
            }
        }
    }

    // ---------------------------------------------------------------- projection

    /** ∇·u per cell (0 for solid cells). */
    computeDivergence(out: Float64Array): void {
        const { nx, ny, u, v, solid } = this;
        const su = nx + 1;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                out[c] = solid[c] ? 0 : u[i + 1 + j * su] - u[i + j * su] + v[c + nx] - v[c];
            }
        }
    }

    /** Solves A p = −∇·u and subtracts ∇p from every face that is not prescribed. */
    project(): void {
        const { nx, ny, u, v, solid, sides } = this;
        const div = this.divergence;
        this.computeDivergence(div);
        const pr = this.pressure;
        pr.build(solid, sides);
        const rhs = pr.rhs;
        for (let c = 0; c < nx * ny; c++) rhs[c] = -div[c];
        const p = pr.solve(this.params.pressure, this.params.jacobiIterations);
        this.stats.pressureIterations = pr.iterations;
        const su = nx + 1;
        for (let j = 0; j < ny; j++) {
            for (let i = 1; i < nx; i++) {
                const c = i + j * nx;
                if (solid[c] || solid[c - 1]) continue;
                u[i + j * su] -= p[c] - p[c - 1];
            }
            const first = j * nx;
            const last = nx - 1 + j * nx;
            if (sides[0] === Side.Open && !solid[first]) u[j * su] -= p[first];
            if (sides[1] === Side.Open && !solid[last]) u[nx + j * su] += p[last];
        }
        for (let j = 1; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                if (solid[c] || solid[c - nx]) continue;
                v[c] -= p[c] - p[c - nx];
            }
        }
        for (let i = 0; i < nx; i++) {
            const top = i + (ny - 1) * nx;
            if (sides[2] === Side.Open && !solid[i]) v[i] -= p[i];
            if (sides[3] === Side.Open && !solid[top]) v[i + ny * nx] += p[top];
        }
    }

    private measure(): void {
        const { nx, ny, solid, curl, cellU, cellV } = this;
        const div = this.divergence;
        this.computeDivergence(div);
        let maxDiv = 0;
        let ens = 0;
        let maxSpeed2 = 0;
        for (let c = 0; c < nx * ny; c++) {
            if (solid[c]) continue;
            const d = Math.abs(div[c]);
            if (d > maxDiv) maxDiv = d;
            ens += curl[c] * curl[c];
            const s2 = cellU[c] * cellU[c] + cellV[c] * cellV[c];
            if (s2 > maxSpeed2) maxSpeed2 = s2;
        }
        this.stats.maxDivergence = maxDiv;
        this.stats.enstrophy = 0.5 * ens;
        this.stats.maxSpeed = Math.sqrt(maxSpeed2);
    }
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
