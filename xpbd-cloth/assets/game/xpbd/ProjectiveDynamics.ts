/**
 * Projective Dynamics (Bouaziz, Martin, Liu, Kavan, Pauly 2014) for the
 * cloth's distance constraints. One implicit Euler step minimises
 *
 *   1/(2h²) |M^½ (x − s)|² + Σ w_j/2 |(x_a − x_b) − p_j|²,
 *
 * where s is the inertial prediction and p_j the constraint's projection: the
 * current edge direction scaled to its rest length. For a distance constraint
 * the second term is exactly the XPBD energy C²/(2α), so w = 1/α. Each
 * iteration projects every constraint (local step) and then solves the linear
 * system (M/h² + Σ w_j Gᵀ G) x = M s/h² + Σ w_j Gᵀ p_j (global step), whose
 * matrix only changes when the time step, the stiffness or the set of fixed
 * particles does.
 *
 * Two global solvers:
 * - 'direct': the matrix is prefactored once with a banded Cholesky (the grid
 *   in row order has a bandwidth of two rows because of the bending
 *   constraints), and every iteration is a forward and a back substitution.
 * - 'chebyshev': one Jacobi sweep per iteration, accelerated with the
 *   Chebyshev semi-iterative method (Wang 2015, "A Chebyshev Semi-Iterative
 *   Approach for Accelerating Projective and Position-based Dynamics"). The
 *   local step, the right-hand side and the Jacobi sweep fuse into one pass
 *   over the constraints, so an iteration costs about as much as one XPBD sweep.
 *
 * Fixed particles (pins, the grabbed particle) keep the position they have
 * when the solve starts. Pins are taken out of the factor; the grabbed
 * particle is not, so grabbing needs no refactorisation: its column of the
 * inverse is solved for once, and each iteration adds the multiple of it that
 * puts the particle on its target (the exact solution with that one position
 * fixed).
 */

export type PdSolver = 'direct' | 'chebyshev';

export class PdSystem {
    solver: PdSolver = 'direct';
    iterations = 10;
    /**
     * Weight (N/m) used for constraints with zero compliance. Stiffer slows PD's
     * convergence further; at 1e4 a converged cotton flap stretches about as
     * much as the XPBD one (around 1%).
     */
    hardWeight = 1e4;
    /**
     * Chebyshev: spectral radius estimate of the Jacobi iteration (0 = derive
     * it from the matrix), under-relaxation, and plain iterations before the
     * acceleration starts.
     */
    rho = 0;
    gamma = 0.9;
    chebyshevDelay = 2;
    /** Chebyshev restarts when an iteration moves the cloth this many times more (squared) than the one before. */
    restartGrowth = 1;
    /** The spectral radius estimate in use. */
    rhoUsed = 0;

    private readonly count: number;
    private readonly bandwidth: number;
    private readonly ca: Int32Array;
    private readonly cb: Int32Array;
    private readonly rest: Float32Array;
    private readonly groupEnd: Int32Array;
    private readonly weight: Float64Array;
    /** xyz, float64 working copies: prediction, current iterate, previous iterate, right-hand side / accumulator. */
    private readonly s: Float64Array;
    private readonly x: Float64Array;
    private readonly xOld: Float64Array;
    private readonly rhs: Float64Array;
    private readonly massH2: Float64Array;
    private readonly diag: Float64Array;
    private readonly fixed: Uint8Array;
    private band: Float64Array | null = null;
    /** Direct solver: column `zIndex` of the inverse matrix, for the grabbed particle. */
    private readonly z: Float64Array;
    private zIndex = -1;
    private builtH = 0;
    private builtSolver: PdSolver | null = null;
    private readonly builtWeights = new Float64Array(3);
    private builtHard = 0;

    constructor(count: number, bandwidth: number, ca: Int32Array, cb: Int32Array, rest: Float32Array, groupEnd: Int32Array) {
        this.count = count;
        this.bandwidth = bandwidth;
        this.ca = ca;
        this.cb = cb;
        this.rest = rest;
        this.groupEnd = groupEnd;
        this.weight = new Float64Array(rest.length);
        this.s = new Float64Array(count * 3);
        this.x = new Float64Array(count * 3);
        this.xOld = new Float64Array(count * 3);
        this.rhs = new Float64Array(count * 3);
        this.massH2 = new Float64Array(count);
        this.diag = new Float64Array(count);
        this.fixed = new Uint8Array(count);
        this.z = new Float64Array(count);
    }

    /** Milliseconds spent in the last (re)factorisation. */
    factorMs = 0;

    /**
     * Replaces `pos` (the inertial prediction on entry) by the end-of-step
     * positions. `grab` is the grabbed particle (−1 for none) and
     * `grabInvMass` its inverse mass before it was grabbed.
     */
    solve(pos: Float32Array, invMass: Float32Array, h: number, compliance: Float64Array, grab = -1, grabInvMass = 0): void {
        // A grabbed pin stays a pin; only a free particle gets the low-rank treatment.
        const soft = this.solver === 'direct' && grab >= 0 && grabInvMass > 0 ? grab : -1;
        this.prepare(invMass, h, compliance, soft, grabInvMass);
        const s = this.s;
        const x = this.x;
        for (let k = 0; k < s.length; k++) s[k] = x[k] = pos[k];
        if (this.solver === 'direct') {
            if (soft >= 0 && this.zIndex !== soft) this.solveColumn(soft);
            const z = this.z;
            for (let it = 0; it < this.iterations; it++) {
                this.buildRhs();
                this.substitute();
                if (soft < 0) continue;
                const g = soft * 3;
                const inv = 1 / z[soft];
                const cx = (s[g] - x[g]) * inv, cy = (s[g + 1] - x[g + 1]) * inv, cz = (s[g + 2] - x[g + 2]) * inv;
                for (let i = 0, k = 0; i < this.count; i++, k += 3) {
                    const zi = z[i];
                    x[k] += cx * zi; x[k + 1] += cy * zi; x[k + 2] += cz * zi;
                }
            }
        } else {
            this.chebyshev();
        }
        for (let k = 0; k < x.length; k++) pos[k] = x[k];
    }

    /** Rebuilds the diagonal and, for the direct solver, the factor, when anything the matrix depends on changed. */
    private prepare(invMass: Float32Array, h: number, compliance: Float64Array, soft: number, softInvMass: number): void {
        let dirty = this.builtSolver !== this.solver || Math.abs(h - this.builtH) > 0.02 * this.builtH || this.builtHard !== this.hardWeight;
        for (let g = 0; g < 3; g++) if (compliance[g] !== this.builtWeights[g]) dirty = true;
        const fixed = this.fixed;
        for (let i = 0; i < this.count; i++) {
            const f = invMass[i] === 0 && i !== soft ? 1 : 0;
            if (f !== fixed[i]) {
                fixed[i] = f;
                dirty = true;
            }
        }
        if (!dirty) return;
        this.builtSolver = this.solver;
        this.builtH = h;
        this.builtHard = this.hardWeight;
        this.builtWeights.set(compliance);

        const invH2 = 1 / (h * h);
        for (let i = 0; i < this.count; i++) this.massH2[i] = fixed[i] ? 0 : invH2 / (i === soft ? softInvMass : invMass[i]);
        for (let g = 0, start = 0; g < 3; start = this.groupEnd[g], g++) {
            const w = compliance[g] > 0 ? 1 / compliance[g] : this.hardWeight;
            this.weight.fill(w, start, this.groupEnd[g]);
        }
        const diag = this.diag;
        for (let i = 0; i < this.count; i++) diag[i] = fixed[i] ? 1 : this.massH2[i];
        for (let j = 0; j < this.rest.length; j++) {
            const a = this.ca[j];
            const b = this.cb[j];
            if (!fixed[a]) diag[a] += this.weight[j];
            if (!fixed[b]) diag[b] += this.weight[j];
        }
        // Gershgorin bound on the Jacobi iteration matrix: the largest share of a
        // row's diagonal taken by its constraints. Overestimating ρ only slows
        // Chebyshev down; underestimating it makes it diverge.
        let rho = 0;
        for (let i = 0; i < this.count; i++) if (!fixed[i]) rho = Math.max(rho, 1 - this.massH2[i] / diag[i]);
        this.rhoUsed = this.rho > 0 ? this.rho : rho;
        this.zIndex = -1;
        if (this.solver === 'direct') this.factor();
    }

    /** z = A⁻¹ e_i through the factor (reusing the x axis of the work buffers). */
    private solveColumn(index: number): void {
        const rhs = this.rhs;
        const x = this.x;
        const saved = this.xOld;
        saved.set(x);
        rhs.fill(0);
        rhs[index * 3] = 1;
        this.substitute();
        for (let i = 0; i < this.count; i++) this.z[i] = x[i * 3];
        x.set(saved);
        this.zIndex = index;
    }

    /** Banded Cholesky of the global matrix restricted to the free particles (fixed rows become identity rows). */
    private factor(): void {
        const t0 = performance.now();
        const n = this.count;
        const bw = this.bandwidth;
        const stride = bw + 1;
        if (!this.band || this.band.length !== n * stride) this.band = new Float64Array(n * stride);
        const L = this.band;
        L.fill(0);
        // Row i keeps columns i − bw … i at offsets 0 … bw.
        for (let i = 0; i < n; i++) L[i * stride + bw] = this.diag[i];
        const fixed = this.fixed;
        for (let j = 0; j < this.rest.length; j++) {
            const a = this.ca[j];
            const b = this.cb[j];
            if (fixed[a] || fixed[b]) continue;
            const hi = a > b ? a : b;
            const lo = a > b ? b : a;
            L[hi * stride + bw - (hi - lo)] -= this.weight[j];
        }
        for (let i = 0; i < n; i++) {
            const ri = i * stride;
            const j0 = i - bw > 0 ? i - bw : 0;
            for (let j = j0; j <= i; j++) {
                const rj = j * stride;
                let sum = L[ri + bw - (i - j)];
                // Columns both rows store: max(i, j) − bw … j − 1.
                for (let k = j0 > j - bw ? j0 : j - bw; k < j; k++) sum -= L[ri + bw - (i - k)] * L[rj + bw - (j - k)];
                if (j === i) L[ri + bw] = Math.sqrt(sum);
                else L[ri + bw - (i - j)] = sum / L[rj + bw];
            }
        }
        this.factorMs = performance.now() - t0;
    }

    /** Local step for every constraint, accumulated into the right-hand side of the global system. */
    private buildRhs(): void {
        const x = this.x;
        const s = this.s;
        const rhs = this.rhs;
        const fixed = this.fixed;
        const massH2 = this.massH2;
        const ca = this.ca;
        const cb = this.cb;
        const rest = this.rest;
        const weight = this.weight;
        for (let i = 0, k = 0; i < this.count; i++, k += 3) {
            const m = fixed[i] ? 1 : massH2[i];
            rhs[k] = m * s[k];
            rhs[k + 1] = m * s[k + 1];
            rhs[k + 2] = m * s[k + 2];
        }
        for (let j = 0; j < rest.length; j++) {
            const ia = ca[j];
            const ib = cb[j];
            const fa = fixed[ia];
            const fb = fixed[ib];
            if (fa && fb) continue;
            const a = ia * 3;
            const b = ib * 3;
            const dx = x[a] - x[b];
            const dy = x[a + 1] - x[b + 1];
            const dz = x[a + 2] - x[b + 2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const w = weight[j];
            const f = len > 1e-12 ? (w * rest[j]) / len : 0;
            const px = dx * f, py = dy * f, pz = dz * f;
            if (!fa) {
                rhs[a] += px; rhs[a + 1] += py; rhs[a + 2] += pz;
                // A fixed neighbour moves to the right-hand side.
                if (fb) { rhs[a] += w * s[b]; rhs[a + 1] += w * s[b + 1]; rhs[a + 2] += w * s[b + 2]; }
            }
            if (!fb) {
                rhs[b] -= px; rhs[b + 1] -= py; rhs[b + 2] -= pz;
                if (fa) { rhs[b] += w * s[a]; rhs[b + 1] += w * s[a + 1]; rhs[b + 2] += w * s[a + 2]; }
            }
        }
    }

    /** x = (L Lᵀ)⁻¹ rhs, all three axes at once. */
    private substitute(): void {
        const L = this.band!;
        const n = this.count;
        const bw = this.bandwidth;
        const stride = bw + 1;
        const y = this.rhs;
        const x = this.x;
        for (let i = 0; i < n; i++) {
            const ri = i * stride;
            let sx = y[i * 3], sy = y[i * 3 + 1], sz = y[i * 3 + 2];
            for (let k = i - bw > 0 ? i - bw : 0; k < i; k++) {
                const l = L[ri + bw - (i - k)];
                sx -= l * y[k * 3]; sy -= l * y[k * 3 + 1]; sz -= l * y[k * 3 + 2];
            }
            const inv = 1 / L[ri + bw];
            y[i * 3] = sx * inv; y[i * 3 + 1] = sy * inv; y[i * 3 + 2] = sz * inv;
        }
        // Lᵀ x = y, column by column so the band is still read row-wise.
        for (let i = n - 1; i >= 0; i--) {
            const ri = i * stride;
            const inv = 1 / L[ri + bw];
            const xx = y[i * 3] * inv, xy = y[i * 3 + 1] * inv, xz = y[i * 3 + 2] * inv;
            x[i * 3] = xx; x[i * 3 + 1] = xy; x[i * 3 + 2] = xz;
            for (let k = i - bw > 0 ? i - bw : 0; k < i; k++) {
                const l = L[ri + bw - (i - k)];
                y[k * 3] -= l * xx; y[k * 3 + 1] -= l * xy; y[k * 3 + 2] -= l * xz;
            }
        }
    }

    /**
     * Local step + one Jacobi sweep per iteration, in one pass over the
     * constraints: row a of the system reads
     * (m/h² + Σw) x_a = m/h² s_a + Σ w (x_b + p), so the accumulator gets
     * w (x_b + p) from every constraint and is divided by the diagonal.
     */
    private chebyshev(): void {
        const x = this.x;
        const xOld = this.xOld;
        const acc = this.rhs;
        const s = this.s;
        const fixed = this.fixed;
        const massH2 = this.massH2;
        const diag = this.diag;
        const ca = this.ca;
        const cb = this.cb;
        const rest = this.rest;
        const weight = this.weight;
        const gamma = this.gamma;
        const rho2 = this.rhoUsed * this.rhoUsed;
        let omega = 1;
        // Iterations since the last (re)start of the acceleration.
        let since = 0;
        let lastChange = Infinity;
        xOld.set(x);
        for (let it = 0; it < this.iterations; it++, since++) {
            for (let i = 0, k = 0; i < this.count; i++, k += 3) {
                const m = fixed[i] ? 1 : massH2[i];
                acc[k] = m * s[k];
                acc[k + 1] = m * s[k + 1];
                acc[k + 2] = m * s[k + 2];
            }
            for (let j = 0; j < rest.length; j++) {
                const ia = ca[j];
                const ib = cb[j];
                const fa = fixed[ia];
                const fb = fixed[ib];
                if (fa && fb) continue;
                const a = ia * 3;
                const b = ib * 3;
                const xa = x[a], ya = x[a + 1], za = x[a + 2];
                const xb = x[b], yb = x[b + 1], zb = x[b + 2];
                const dx = xa - xb, dy = ya - yb, dz = za - zb;
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const w = weight[j];
                const f = len > 1e-12 ? rest[j] / len : 0;
                const px = dx * f, py = dy * f, pz = dz * f;
                if (!fa) { acc[a] += w * (xb + px); acc[a + 1] += w * (yb + py); acc[a + 2] += w * (zb + pz); }
                if (!fb) { acc[b] += w * (xa - px); acc[b + 1] += w * (ya - py); acc[b + 2] += w * (za - pz); }
            }
            if (since < this.chebyshevDelay) omega = 1;
            else if (since === this.chebyshevDelay) omega = 2 / (2 - rho2);
            else omega = 4 / (4 - rho2 * omega);
            let change = 0;
            for (let i = 0, k = 0; i < this.count; i++, k += 3) {
                if (fixed[i]) continue;
                const inv = 1 / diag[i];
                for (let c = k; c < k + 3; c++) {
                    const cur = x[c];
                    const next = omega * (gamma * (acc[c] * inv - cur) + cur - xOld[c]) + xOld[c];
                    xOld[c] = cur;
                    x[c] = next;
                    change += (next - cur) * (next - cur);
                }
            }
            // The local step makes the iteration nonlinear, so the acceleration can
            // overshoot; when an iteration moves the cloth more than the one before,
            // fall back to plain Jacobi and start the acceleration again.
            if (since > this.chebyshevDelay && change > this.restartGrowth * lastChange) {
                since = -1;
                xOld.set(x);
            }
            lastChange = change;
        }
    }
}
