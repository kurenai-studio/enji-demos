export const PressureSolver = { MGPCG: 0, Jacobi: 1 } as const;
export type PressureKind = (typeof PressureSolver)[keyof typeof PressureSolver];

/** Side codes shared with FluidGrid (Side.Open = 1); kept numeric so this file stands alone. */
const OPEN = 1;
const CG_MAX_ITERATIONS = 60;
const CG_TOLERANCE = 1e-4;
const PRE_SWEEPS = 2;
const COARSEST_SWEEPS = 16;
const MIN_COARSE_CELLS = 4;

/**
 * The pressure Poisson matrix on one grid level, matrix-free: cell c couples
 * to its east and north neighbours with weights wE[c], wN[c] (west and south
 * come from the neighbour's entry). `dirichlet[c]` counts open domain sides
 * next to the cell (pressure 0 outside). diag = sum of all of them; diag 0
 * marks a cell outside the fluid.
 */
export class PoissonLevel {
    readonly nx: number;
    readonly ny: number;
    readonly diag: Float64Array;
    readonly wE: Float64Array;
    readonly wN: Float64Array;
    readonly dirichlet: Float64Array;
    readonly x: Float64Array;
    readonly b: Float64Array;
    readonly r: Float64Array;

    constructor(nx: number, ny: number) {
        this.nx = nx;
        this.ny = ny;
        const n = nx * ny;
        this.diag = new Float64Array(n);
        this.wE = new Float64Array(n);
        this.wN = new Float64Array(n);
        this.dirichlet = new Float64Array(n);
        this.x = new Float64Array(n);
        this.b = new Float64Array(n);
        this.r = new Float64Array(n);
    }

    finishDiagonal(): void {
        const { nx, ny, diag, wE, wN, dirichlet } = this;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                let d = dirichlet[c] + wE[c] + wN[c];
                if (i > 0) d += wE[c - 1];
                if (j > 0) d += wN[c - nx];
                diag[c] = d;
            }
        }
    }

    /** out = A x */
    apply(x: Float64Array, out: Float64Array): void {
        const { nx, ny, diag, wE, wN } = this;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                if (diag[c] === 0) {
                    out[c] = 0;
                    continue;
                }
                let s = diag[c] * x[c];
                if (i < nx - 1) s -= wE[c] * x[c + 1];
                if (i > 0) s -= wE[c - 1] * x[c - 1];
                if (j < ny - 1) s -= wN[c] * x[c + nx];
                if (j > 0) s -= wN[c - nx] * x[c - nx];
                out[c] = s;
            }
        }
    }

    /** One Gauss–Seidel half sweep over the cells with (i + j) % 2 === color. */
    relax(color: number, x: Float64Array, b: Float64Array): void {
        const { nx, ny, diag, wE, wN } = this;
        for (let j = 0; j < ny; j++) {
            for (let i = (j + color) & 1; i < nx; i += 2) {
                const c = i + j * nx;
                const d = diag[c];
                if (d === 0) continue;
                let s = b[c];
                if (i < nx - 1) s += wE[c] * x[c + 1];
                if (i > 0) s += wE[c - 1] * x[c - 1];
                if (j < ny - 1) s += wN[c] * x[c + nx];
                if (j > 0) s += wN[c - nx] * x[c - nx];
                x[c] = s / d;
            }
        }
    }

    residual(x: Float64Array, b: Float64Array, out: Float64Array): void {
        this.apply(x, out);
        for (let c = 0; c < out.length; c++) out[c] = this.diag[c] === 0 ? 0 : b[c] - out[c];
    }
}

/**
 * Solves the pressure Poisson equation A p = −∇·u (unit cell, unit density,
 * dt folded into p) on the fluid cells.
 *
 * Jacobi: the classic GPU choice, warm-started from the last step's pressure;
 * cheap per iteration but it only removes divergence a few cells wide, so the
 * large-scale part lingers.
 *
 * MGPCG (McAdams, Sifakis & Teran 2010): conjugate gradients preconditioned
 * by one multigrid V-cycle. Coarse levels halve the grid; face weights are the
 * mean of the fine faces they cover, so obstacles and open sides carry down.
 * Restriction sums the four children and prolongation copies the coarse value
 * back (its transpose); smoothing is red-black Gauss–Seidel, run in reverse
 * order on the way up, so the preconditioner stays symmetric as CG requires.
 */
export class Pressure {
    readonly levels: PoissonLevel[] = [];
    /** Right-hand side, filled by the caller before `solve`. */
    readonly rhs: Float64Array;
    /** Pressure, kept between steps as the warm start. */
    readonly p: Float64Array;
    iterations = 0;
    /** Max |residual| after the solve, same units as ∇·u. */
    residualMax = 0;
    private closed = false;
    private readonly r: Float64Array;
    private readonly z: Float64Array;
    private readonly d: Float64Array;
    private readonly q: Float64Array;
    private readonly scratch: Float64Array;

    constructor(nx: number, ny: number) {
        let w = nx;
        let h = ny;
        this.levels.push(new PoissonLevel(w, h));
        while (w % 2 === 0 && h % 2 === 0 && Math.min(w, h) / 2 >= MIN_COARSE_CELLS) {
            w /= 2;
            h /= 2;
            this.levels.push(new PoissonLevel(w, h));
        }
        const n = nx * ny;
        this.rhs = new Float64Array(n);
        this.p = new Float64Array(n);
        this.r = new Float64Array(n);
        this.z = new Float64Array(n);
        this.d = new Float64Array(n);
        this.q = new Float64Array(n);
        this.scratch = new Float64Array(n);
    }

    reset(): void {
        this.p.fill(0);
    }

    /** Rebuilds the operator on every level from the solid mask and the domain sides (left, right, bottom, top). */
    build(solid: Uint8Array, sides: readonly number[]): void {
        const fine = this.levels[0];
        const { nx, ny, wE, wN, dirichlet } = fine;
        this.closed = !sides.some((s) => s === OPEN);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const c = i + j * nx;
                const fluid = !solid[c];
                wE[c] = fluid && i < nx - 1 && !solid[c + 1] ? 1 : 0;
                wN[c] = fluid && j < ny - 1 && !solid[c + nx] ? 1 : 0;
                let open = 0;
                if (fluid) {
                    if (i === 0 && sides[0] === OPEN) open++;
                    if (i === nx - 1 && sides[1] === OPEN) open++;
                    if (j === 0 && sides[2] === OPEN) open++;
                    if (j === ny - 1 && sides[3] === OPEN) open++;
                }
                dirichlet[c] = open;
            }
        }
        fine.finishDiagonal();
        for (let l = 1; l < this.levels.length; l++) coarsen(this.levels[l - 1], this.levels[l]);
        for (let c = 0; c < nx * ny; c++) if (solid[c]) this.p[c] = 0;
    }

    solve(kind: PressureKind, jacobiIterations: number): Float64Array {
        const fine = this.levels[0];
        if (this.closed) removeMean(this.rhs, fine.diag);
        if (kind === PressureSolver.Jacobi) this.jacobi(jacobiIterations);
        else this.pcg();
        if (this.closed) removeMean(this.p, fine.diag);
        fine.residual(this.p, this.rhs, this.r);
        this.residualMax = maxAbs(this.r);
        return this.p;
    }

    private jacobi(iterations: number): void {
        const fine = this.levels[0];
        const { nx, ny, diag, wE, wN } = fine;
        const b = this.rhs;
        let x = this.p;
        let y = this.scratch;
        for (let k = 0; k < iterations; k++) {
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const c = i + j * nx;
                    const dc = diag[c];
                    if (dc === 0) {
                        y[c] = 0;
                        continue;
                    }
                    let s = b[c];
                    if (i < nx - 1) s += wE[c] * x[c + 1];
                    if (i > 0) s += wE[c - 1] * x[c - 1];
                    if (j < ny - 1) s += wN[c] * x[c + nx];
                    if (j > 0) s += wN[c - nx] * x[c - nx];
                    y[c] = s / dc;
                }
            }
            const t = x;
            x = y;
            y = t;
        }
        if (x !== this.p) this.p.set(x);
        this.iterations = iterations;
    }

    private pcg(): void {
        const fine = this.levels[0];
        const { r, z, d, q, p } = this;
        fine.residual(p, this.rhs, r);
        const bNorm = Math.max(maxAbs(this.rhs), 1e-12);
        let it = 0;
        if (maxAbs(r) > CG_TOLERANCE * bNorm) {
            this.precondition(r, z);
            d.set(z);
            let rz = dot(r, z);
            for (it = 1; it <= CG_MAX_ITERATIONS; it++) {
                fine.apply(d, q);
                const dq = dot(d, q);
                if (dq <= 0) break;
                const alpha = rz / dq;
                for (let c = 0; c < p.length; c++) {
                    p[c] += alpha * d[c];
                    r[c] -= alpha * q[c];
                }
                if (maxAbs(r) <= CG_TOLERANCE * bNorm) break;
                this.precondition(r, z);
                const rzNext = dot(r, z);
                const beta = rzNext / rz;
                rz = rzNext;
                for (let c = 0; c < d.length; c++) d[c] = z[c] + beta * d[c];
            }
        }
        this.iterations = Math.min(it, CG_MAX_ITERATIONS);
    }

    /** z = M⁻¹ r, one V-cycle from a zero guess. Public so the tests can check symmetry. */
    precondition(r: Float64Array, z: Float64Array): void {
        const fine = this.levels[0];
        fine.b.set(r);
        this.vcycle(0);
        z.set(fine.x);
        if (this.closed) removeMean(z, fine.diag);
    }

    private vcycle(l: number): void {
        const level = this.levels[l];
        const { x, b } = level;
        x.fill(0);
        if (l === this.levels.length - 1) {
            for (let s = 0; s < COARSEST_SWEEPS; s++) {
                level.relax(0, x, b);
                level.relax(1, x, b);
                level.relax(1, x, b);
                level.relax(0, x, b);
            }
            return;
        }
        for (let s = 0; s < PRE_SWEEPS; s++) {
            level.relax(0, x, b);
            level.relax(1, x, b);
        }
        level.residual(x, b, level.r);
        const coarse = this.levels[l + 1];
        restrict(level, coarse);
        this.vcycle(l + 1);
        prolong(coarse, level);
        for (let s = 0; s < PRE_SWEEPS; s++) {
            level.relax(1, x, b);
            level.relax(0, x, b);
        }
    }
}

function coarsen(fine: PoissonLevel, coarse: PoissonLevel): void {
    const fx = fine.nx;
    const { nx, ny, wE, wN, dirichlet } = coarse;
    for (let J = 0; J < ny; J++) {
        for (let I = 0; I < nx; I++) {
            const C = I + J * nx;
            const f00 = 2 * I + 2 * J * fx;
            const f10 = f00 + 1;
            const f01 = f00 + fx;
            const f11 = f01 + 1;
            wE[C] = I < nx - 1 ? 0.5 * (fine.wE[f10] + fine.wE[f11]) : 0;
            wN[C] = J < ny - 1 ? 0.5 * (fine.wN[f01] + fine.wN[f11]) : 0;
            dirichlet[C] = 0.5 * (fine.dirichlet[f00] + fine.dirichlet[f10] + fine.dirichlet[f01] + fine.dirichlet[f11]);
        }
    }
    coarse.finishDiagonal();
}

/** Coarse right-hand side = sum of the four fine residuals (the transpose of copying back). */
function restrict(fine: PoissonLevel, coarse: PoissonLevel): void {
    const fx = fine.nx;
    const { nx, ny, b, diag } = coarse;
    const r = fine.r;
    for (let J = 0; J < ny; J++) {
        for (let I = 0; I < nx; I++) {
            const C = I + J * nx;
            const f = 2 * I + 2 * J * fx;
            b[C] = diag[C] === 0 ? 0 : r[f] + r[f + 1] + r[f + fx] + r[f + fx + 1];
        }
    }
}

function prolong(coarse: PoissonLevel, fine: PoissonLevel): void {
    const fx = fine.nx;
    const { nx, ny } = coarse;
    const x = fine.x;
    const d = fine.diag;
    for (let J = 0; J < ny; J++) {
        for (let I = 0; I < nx; I++) {
            const e = coarse.x[I + J * nx];
            const f = 2 * I + 2 * J * fx;
            if (d[f] !== 0) x[f] += e;
            if (d[f + 1] !== 0) x[f + 1] += e;
            if (d[f + fx] !== 0) x[f + fx] += e;
            if (d[f + fx + 1] !== 0) x[f + fx + 1] += e;
        }
    }
}

/** A closed box only fixes pressure up to a constant: keep vectors orthogonal to it. */
function removeMean(v: Float64Array, diag: Float64Array): void {
    let sum = 0;
    let n = 0;
    for (let c = 0; c < v.length; c++) {
        if (diag[c] === 0) continue;
        sum += v[c];
        n++;
    }
    if (n === 0) return;
    const mean = sum / n;
    for (let c = 0; c < v.length; c++) if (diag[c] !== 0) v[c] -= mean;
}

function dot(a: Float64Array, b: Float64Array): number {
    let s = 0;
    for (let c = 0; c < a.length; c++) s += a[c] * b[c];
    return s;
}

function maxAbs(a: Float64Array): number {
    let m = 0;
    for (let c = 0; c < a.length; c++) {
        const v = Math.abs(a[c]);
        if (v > m) m = v;
    }
    return m;
}
