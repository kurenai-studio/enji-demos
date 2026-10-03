/**
 * 3D Position Based Fluids (Macklin & Mueller, SIGGRAPH 2013).
 *
 * Per substep:
 *   1. v += g dt, predict p = x + v dt, clamp p to the tank
 *   2. uniform-grid neighbour search on p (counting sort, cell size = h)
 *   3. `iterations` x { lambda_i from the density constraint C_i = rho_i / rho0 - 1,
 *      dp_i = 1/rho0 sum_j (lambda_i + lambda_j + s_corr) gradW(p_i - p_j), p += dp, clamp }
 *   4. v = (p - x) / dt, vorticity confinement, XSPH viscosity, x = p
 *
 * All state lives in preallocated typed arrays; the inner loops allocate nothing.
 */
export class PBFSolver {
    readonly capacity: number;
    count = 0;

    readonly h: number;
    readonly spacing: number;
    restDensity = 1;

    iterations = 3;
    substeps = 1;
    xsph = 0.02;
    vorticity = 0.0004;
    sCorrK = 0.0008;
    relaxation = 20;
    gravityX = 0;
    gravityY = -9.8;
    gravityZ = 0;

    /** Tank interior in simulation space; `wallOffsetX` moves the x walls (shaking). */
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    wallOffsetX = 0;

    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
    readonly vx: Float32Array;
    readonly vy: Float32Array;
    readonly vz: Float32Array;
    private readonly px: Float32Array;
    private readonly py: Float32Array;
    private readonly pz: Float32Array;
    private readonly lambda: Float32Array;
    readonly density: Float32Array;
    private readonly dvx: Float32Array;
    private readonly dvy: Float32Array;
    private readonly dvz: Float32Array;
    private readonly wx: Float32Array;
    private readonly wy: Float32Array;
    private readonly wz: Float32Array;

    /**
     * Each pair is stored once, in the list of its lower index ("forward" neighbours), and
     * every pair pass updates both particles. The cap applies to forward neighbours.
     */
    static readonly MAX_NEIGHBORS = 48;
    private readonly neighbors: Int32Array;
    private readonly neighborCount: Int32Array;
    /** Per-pair spiky gradient factor and s_corr kernel ratio, filled by computeLambda for applyDelta. */
    private readonly pairGrad: Float32Array;
    private readonly pairW: Float32Array;
    /** Per-particle sums for the lambda denominator: Σ∇C and Σ|∇_j C|². */
    private readonly gradX: Float32Array;
    private readonly gradY: Float32Array;
    private readonly gradZ: Float32Array;
    private readonly grad2: Float32Array;

    private readonly gridNx: number;
    private readonly gridNy: number;
    private readonly gridNz: number;
    private readonly gridOriginX: number;
    private readonly gridOriginY: number;
    private readonly gridOriginZ: number;
    private readonly cellStart: Int32Array;
    private readonly cellCursor: Int32Array;
    private readonly cellOf: Int32Array;
    private readonly sorted: Int32Array;
    private readonly tmpFloat: Float32Array;
    private readonly tmpInt: Int32Array;

    private readonly poly6: number;
    private readonly spikyGrad: number;
    private readonly h2: number;
    private readonly sCorrDenom: number;

    /** Average neighbour count and max density error of the last substep (diagnostics). */
    avgNeighbors = 0;
    densityError = 0;
    avgDensityError = 0;

    constructor(capacity: number, h: number, spacing: number, bounds: { min: [number, number, number]; max: [number, number, number] }) {
        this.capacity = capacity;
        this.h = h;
        this.spacing = spacing;
        this.h2 = h * h;
        this.poly6 = 315 / (64 * Math.PI * Math.pow(h, 9));
        this.spikyGrad = -45 / (Math.PI * Math.pow(h, 6));
        const dq = 0.2 * h;
        this.sCorrDenom = this.poly6 * Math.pow(this.h2 - dq * dq, 3);

        [this.minX, this.minY, this.minZ] = bounds.min;
        [this.maxX, this.maxY, this.maxZ] = bounds.max;

        const f = () => new Float32Array(capacity);
        this.x = f(); this.y = f(); this.z = f();
        this.vx = f(); this.vy = f(); this.vz = f();
        this.px = f(); this.py = f(); this.pz = f();
        this.lambda = f(); this.density = f();
        this.dvx = f(); this.dvy = f(); this.dvz = f();
        this.wx = f(); this.wy = f(); this.wz = f();
        this.gradX = f(); this.gradY = f(); this.gradZ = f(); this.grad2 = f();
        this.neighbors = new Int32Array(capacity * PBFSolver.MAX_NEIGHBORS);
        this.neighborCount = new Int32Array(capacity);
        this.pairGrad = new Float32Array(capacity * PBFSolver.MAX_NEIGHBORS);
        this.pairW = new Float32Array(capacity * PBFSolver.MAX_NEIGHBORS);

        // Grid covers the tank plus room for splashes above it and the shake travel.
        const margin = h * 4;
        this.gridOriginX = this.minX - margin;
        this.gridOriginY = this.minY - h;
        this.gridOriginZ = this.minZ - h;
        this.gridNx = Math.ceil((this.maxX - this.minX + 2 * margin) / h) + 1;
        this.gridNy = Math.ceil((this.maxY - this.minY + 2 * h) / h) + 1;
        this.gridNz = Math.ceil((this.maxZ - this.minZ + 2 * h) / h) + 1;
        this.cellStart = new Int32Array(this.gridNx * this.gridNy * this.gridNz + 1);
        this.cellCursor = new Int32Array(this.gridNx * this.gridNy * this.gridNz);
        this.cellOf = new Int32Array(capacity);
        this.sorted = new Int32Array(capacity);
        this.tmpFloat = new Float32Array(capacity);
        this.tmpInt = new Int32Array(capacity);

        this.restDensity = this.latticeDensity();
    }

    /** Density at a particle inside an infinite cubic lattice of the rest spacing. */
    private latticeDensity(): number {
        let rho = 0;
        const s = this.spacing;
        const n = Math.ceil(this.h / s);
        for (let i = -n; i <= n; i++) {
            for (let j = -n; j <= n; j++) {
                for (let k = -n; k <= n; k++) {
                    const r2 = (i * i + j * j + k * k) * s * s;
                    if (r2 < this.h2) {
                        const d = this.h2 - r2;
                        rho += this.poly6 * d * d * d;
                    }
                }
            }
        }
        return rho;
    }

    /** Fills an axis-aligned block with particles on the rest lattice (plus jitter). */
    addBlock(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, maxCount = Infinity): number {
        const s = this.spacing;
        let added = 0;
        for (let yy = y0 + s * 0.5; yy < y1; yy += s) {
            for (let zz = z0 + s * 0.5; zz < z1; zz += s) {
                for (let xx = x0 + s * 0.5; xx < x1; xx += s) {
                    if (this.count >= this.capacity || added >= maxCount) return added;
                    const i = this.count++;
                    this.x[i] = xx + (Math.random() - 0.5) * s * 0.02;
                    this.y[i] = yy;
                    this.z[i] = zz + (Math.random() - 0.5) * s * 0.02;
                    this.vx[i] = this.vy[i] = this.vz[i] = 0;
                    added++;
                }
            }
        }
        return added;
    }

    /**
     * Drops a cube of `per`^3 particles with its lower corner at (x0, y0, z0). New particles are
     * appended while capacity lasts; after that, evenly strided existing particles are recycled
     * (storage is sorted by cell, so the stride removes volume uniformly from the pool).
     */
    dropBlock(per: number, x0: number, y0: number, z0: number, vy: number): void {
        const s = this.spacing;
        const n = per * per * per;
        const fresh = Math.min(n, this.capacity - this.count);
        const recycled = n - fresh;
        const stride = recycled > 0 ? Math.max(1, Math.floor(this.count / recycled)) : 1;
        const firstNew = this.count;
        this.count += fresh;
        for (let m = 0; m < n; m++) {
            const i = m < fresh ? firstNew + m : Math.min(firstNew - 1, (m - fresh) * stride);
            const a = m % per;
            const b = Math.floor(m / per) % per;
            const c = Math.floor(m / (per * per));
            this.x[i] = x0 + (a + 0.5) * s;
            this.y[i] = y0 + (c + 0.5) * s;
            this.z[i] = z0 + (b + 0.5) * s;
            this.vx[i] = 0;
            this.vy[i] = vy;
            this.vz[i] = 0;
        }
    }

    step(dt: number): void {
        const sub = dt / this.substeps;
        for (let s = 0; s < this.substeps; s++) this.substep(sub);
    }

    private substep(dt: number): void {
        const n = this.count;
        const { x, y, z, vx, vy, vz, px, py, pz } = this;
        const gx = this.gravityX * dt;
        const gy = this.gravityY * dt;
        const gz = this.gravityZ * dt;
        for (let i = 0; i < n; i++) {
            vx[i] += gx;
            vy[i] += gy;
            vz[i] += gz;
            px[i] = x[i] + vx[i] * dt;
            py[i] = y[i] + vy[i] * dt;
            pz[i] = z[i] + vz[i] * dt;
        }
        this.clampAll();
        this.findNeighbors();

        for (let it = 0; it < this.iterations; it++) {
            this.computeLambda();
            this.applyDelta();
            this.clampAll();
        }

        const inv = 1 / dt;
        for (let i = 0; i < n; i++) {
            vx[i] = (px[i] - x[i]) * inv;
            vy[i] = (py[i] - y[i]) * inv;
            vz[i] = (pz[i] - z[i]) * inv;
        }
        if (this.vorticity > 0) this.confineVorticity(dt);
        if (this.xsph > 0) this.applyXsph();
        for (let i = 0; i < n; i++) {
            x[i] = px[i];
            y[i] = py[i];
            z[i] = pz[i];
        }
    }

    private clampAll(): void {
        const n = this.count;
        const { px, py, pz } = this;
        const r = this.spacing * 0.25;
        const x0 = this.minX + this.wallOffsetX + r;
        const x1 = this.maxX + this.wallOffsetX - r;
        const y0 = this.minY + r;
        const z0 = this.minZ + r;
        const z1 = this.maxZ - r;
        for (let i = 0; i < n; i++) {
            const a = px[i];
            if (a < x0) px[i] = x0 + (x0 - a) * 0.01;
            else if (a > x1) px[i] = x1 - (a - x1) * 0.01;
            if (py[i] < y0) py[i] = y0;
            const c = pz[i];
            if (c < z0) pz[i] = z0 + (z0 - c) * 0.01;
            else if (c > z1) pz[i] = z1 - (c - z1) * 0.01;
        }
    }

    private cellIndex(ax: number, ay: number, az: number): number {
        const h = this.h;
        let i = Math.floor((ax - this.gridOriginX) / h);
        let j = Math.floor((ay - this.gridOriginY) / h);
        let k = Math.floor((az - this.gridOriginZ) / h);
        if (i < 0) i = 0; else if (i >= this.gridNx) i = this.gridNx - 1;
        if (j < 0) j = 0; else if (j >= this.gridNy) j = this.gridNy - 1;
        if (k < 0) k = 0; else if (k >= this.gridNz) k = this.gridNz - 1;
        return i + this.gridNx * (j + this.gridNy * k);
    }

    /** Counting sort of particles into cells, then a 27-cell query per particle. */
    private findNeighbors(): void {
        const n = this.count;
        const { px, py, pz, cellStart, cellOf, sorted, neighbors, neighborCount } = this;
        const nx = this.gridNx;
        const ny = this.gridNy;
        const nz = this.gridNz;
        const nxy = nx * ny;
        const cells = nxy * nz;
        const cursor = this.cellCursor;
        cellStart.fill(0);
        for (let i = 0; i < n; i++) {
            const c = this.cellIndex(px[i], py[i], pz[i]);
            cellOf[i] = c;
            cellStart[c + 1]++;
        }
        for (let c = 0; c < cells; c++) {
            cellStart[c + 1] += cellStart[c];
            cursor[c] = cellStart[c];
        }
        for (let i = 0; i < n; i++) sorted[cursor[cellOf[i]]++] = i;
        // Reorder particle storage by cell so neighbours are contiguous in memory; after this
        // particle `s` lives in slot `s` and cell c spans slots cellStart[c]..cellStart[c+1].
        this.permute(this.x); this.permute(this.y); this.permute(this.z);
        this.permute(this.vx); this.permute(this.vy); this.permute(this.vz);
        this.permute(px); this.permute(py); this.permute(pz);
        const tmpI = this.tmpInt;
        for (let s = 0; s < n; s++) tmpI[s] = cellOf[sorted[s]];
        for (let s = 0; s < n; s++) {
            cellOf[s] = tmpI[s];
            sorted[s] = s;
        }

        // Storage is sorted by cell index, so every particle in a later row of cells has a
        // higher index: only those rows, and the own row from i + 1 on, hold forward neighbours.
        const h2 = this.h2;
        const maxN = PBFSolver.MAX_NEIGHBORS;
        let total = 0;
        for (let i = 0; i < n; i++) {
            const c = cellOf[i];
            const ci = c % nx;
            const cj = ((c / nx) | 0) % ny;
            const ck = (c / nxy) | 0;
            const xi = px[i];
            const yi = py[i];
            const zi = pz[i];
            const base = i * maxN;
            let count = 0;
            const k1 = ck < nz - 1 ? ck + 1 : ck;
            const j0 = cj > 0 ? cj - 1 : 0;
            const j1 = cj < ny - 1 ? cj + 1 : cj;
            const i0 = ci > 0 ? ci - 1 : 0;
            const i1 = ci < nx - 1 ? ci + 1 : ci;
            for (let kk = ck; kk <= k1; kk++) {
                for (let jj = kk === ck ? cj : j0; jj <= j1; jj++) {
                    const row = nx * (jj + ny * kk);
                    const start = kk === ck && jj === cj ? i + 1 : cellStart[row + i0];
                    const end = cellStart[row + i1 + 1];
                    for (let j = start; j < end; j++) {
                        const dx = xi - px[j];
                        const dy = yi - py[j];
                        const dz = zi - pz[j];
                        if (dx * dx + dy * dy + dz * dz < h2 && count < maxN) {
                            neighbors[base + count++] = j;
                        }
                    }
                }
            }
            neighborCount[i] = count;
            total += count;
        }
        this.avgNeighbors = n > 0 ? (2 * total) / n : 0;
    }

    private permute(a: Float32Array): void {
        const n = this.count;
        const tmp = this.tmpFloat;
        const sorted = this.sorted;
        for (let s = 0; s < n; s++) tmp[s] = a[sorted[s]];
        a.set(tmp.subarray(0, n));
    }

    private computeLambda(): void {
        const n = this.count;
        const { px, py, pz, neighbors, neighborCount, lambda, density, pairGrad, pairW, gradX, gradY, gradZ, grad2 } = this;
        const invDenom = 1 / this.sCorrDenom;
        const h = this.h;
        const h2 = this.h2;
        const poly6 = this.poly6;
        const spiky = this.spikyGrad;
        const invRho0 = 1 / this.restDensity;
        const maxN = PBFSolver.MAX_NEIGHBORS;
        const self = poly6 * h2 * h2 * h2;
        const eps = this.relaxation;
        density.fill(self, 0, n);
        gradX.fill(0, 0, n);
        gradY.fill(0, 0, n);
        gradZ.fill(0, 0, n);
        grad2.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            const xi = px[i];
            const yi = py[i];
            const zi = pz[i];
            let rho = 0;
            let gix = 0;
            let giy = 0;
            let giz = 0;
            let sumGrad2 = 0;
            const base = i * maxN;
            const cnt = neighborCount[i];
            for (let m = 0; m < cnt; m++) {
                const j = neighbors[base + m];
                const dx = xi - px[j];
                const dy = yi - py[j];
                const dz = zi - pz[j];
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 >= h2) {
                    pairGrad[base + m] = 0;
                    continue;
                }
                const d = h2 - r2;
                const w = poly6 * d * d * d;
                rho += w;
                density[j] += w;
                pairW[base + m] = w * invDenom;
                if (r2 > 1e-12) {
                    const r = Math.sqrt(r2);
                    const t = h - r;
                    const gs = (spiky * t * t) / r;
                    pairGrad[base + m] = gs;
                    const g = gs * invRho0;
                    const gx = g * dx;
                    const gy = g * dy;
                    const gz = g * dz;
                    const g2 = gx * gx + gy * gy + gz * gz;
                    gix += gx;
                    giy += gy;
                    giz += gz;
                    sumGrad2 += g2;
                    gradX[j] -= gx;
                    gradY[j] -= gy;
                    gradZ[j] -= gz;
                    grad2[j] += g2;
                } else {
                    pairGrad[base + m] = 0;
                }
            }
            density[i] += rho;
            gradX[i] += gix;
            gradY[i] += giy;
            gradZ[i] += giz;
            grad2[i] += sumGrad2;
        }
        let maxErr = 0;
        let sumErr = 0;
        for (let i = 0; i < n; i++) {
            // Unilateral constraint: only resist compression, so the free surface does not clump.
            let c = density[i] * invRho0 - 1;
            if (c < 0) c = 0;
            if (c > maxErr) maxErr = c;
            sumErr += c;
            const g2 = grad2[i] + gradX[i] * gradX[i] + gradY[i] * gradY[i] + gradZ[i] * gradZ[i];
            lambda[i] = -c / (g2 + eps);
        }
        this.densityError = maxErr;
        this.avgDensityError = n > 0 ? sumErr / n : 0;
    }

    private applyDelta(): void {
        const n = this.count;
        const { px, py, pz, neighbors, neighborCount, lambda, dvx, dvy, dvz, pairGrad, pairW } = this;
        const invRho0 = 1 / this.restDensity;
        const maxN = PBFSolver.MAX_NEIGHBORS;
        const k = this.sCorrK;
        dvx.fill(0, 0, n);
        dvy.fill(0, 0, n);
        dvz.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            const xi = px[i];
            const yi = py[i];
            const zi = pz[i];
            const li = lambda[i];
            let ddx = 0;
            let ddy = 0;
            let ddz = 0;
            const base = i * maxN;
            const cnt = neighborCount[i];
            for (let m = 0; m < cnt; m++) {
                const gs = pairGrad[base + m];
                if (gs === 0) continue;
                const j = neighbors[base + m];
                const w = pairW[base + m];
                const w2 = w * w;
                const g = (li + lambda[j] - k * w2 * w2) * gs;
                const ex = g * (xi - px[j]);
                const ey = g * (yi - py[j]);
                const ez = g * (zi - pz[j]);
                ddx += ex;
                ddy += ey;
                ddz += ez;
                dvx[j] -= ex;
                dvy[j] -= ey;
                dvz[j] -= ez;
            }
            dvx[i] += ddx;
            dvy[i] += ddy;
            dvz[i] += ddz;
        }
        for (let i = 0; i < n; i++) {
            px[i] += dvx[i] * invRho0;
            py[i] += dvy[i] * invRho0;
            pz[i] += dvz[i] * invRho0;
        }
    }

    /**
     * omega_i = sum_j (v_j - v_i) x gradW; f = eps (N x omega), N = normalize(grad |omega|).
     * Both pair terms come out identical for i and j, so each forward pair adds its term to both.
     */
    private confineVorticity(dt: number): void {
        const n = this.count;
        const { px, py, pz, vx, vy, vz, wx, wy, wz, neighbors, neighborCount, dvx, dvy, dvz } = this;
        const h = this.h;
        const h2 = this.h2;
        const spiky = this.spikyGrad;
        const maxN = PBFSolver.MAX_NEIGHBORS;
        wx.fill(0, 0, n);
        wy.fill(0, 0, n);
        wz.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            let ox = 0;
            let oy = 0;
            let oz = 0;
            const base = i * maxN;
            const cnt = neighborCount[i];
            for (let m = 0; m < cnt; m++) {
                const j = neighbors[base + m];
                const dx = px[i] - px[j];
                const dy = py[i] - py[j];
                const dz = pz[i] - pz[j];
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 >= h2 || r2 < 1e-12) continue;
                const r = Math.sqrt(r2);
                const t = h - r;
                const g = (spiky * t * t) / r;
                const gx = g * dx;
                const gy = g * dy;
                const gz = g * dz;
                const ux = vx[j] - vx[i];
                const uy = vy[j] - vy[i];
                const uz = vz[j] - vz[i];
                const cx = uy * gz - uz * gy;
                const cy = uz * gx - ux * gz;
                const cz = ux * gy - uy * gx;
                ox += cx;
                oy += cy;
                oz += cz;
                wx[j] += cx;
                wy[j] += cy;
                wz[j] += cz;
            }
            wx[i] += ox;
            wy[i] += oy;
            wz[i] += oz;
        }
        // |omega| per particle, stored in grad2 (free after the constraint iterations).
        const mag = this.grad2;
        for (let i = 0; i < n; i++) mag[i] = Math.sqrt(wx[i] * wx[i] + wy[i] * wy[i] + wz[i] * wz[i]);
        dvx.fill(0, 0, n);
        dvy.fill(0, 0, n);
        dvz.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            const wi = mag[i];
            let nx = 0;
            let ny = 0;
            let nz = 0;
            const base = i * maxN;
            const cnt = neighborCount[i];
            for (let m = 0; m < cnt; m++) {
                const j = neighbors[base + m];
                const dx = px[i] - px[j];
                const dy = py[i] - py[j];
                const dz = pz[i] - pz[j];
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 >= h2 || r2 < 1e-12) continue;
                const r = Math.sqrt(r2);
                const t = h - r;
                const g = ((mag[j] - wi) * spiky * t * t) / r;
                const ex = g * dx;
                const ey = g * dy;
                const ez = g * dz;
                nx -= ex;
                ny -= ey;
                nz -= ez;
                dvx[j] -= ex;
                dvy[j] -= ey;
                dvz[j] -= ez;
            }
            dvx[i] += nx;
            dvy[i] += ny;
            dvz[i] += nz;
        }
        const eps = this.vorticity * dt;
        for (let i = 0; i < n; i++) {
            let nx = dvx[i];
            let ny = dvy[i];
            let nz = dvz[i];
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len < 1e-6) continue;
            nx /= len;
            ny /= len;
            nz /= len;
            vx[i] += eps * (ny * wz[i] - nz * wy[i]);
            vy[i] += eps * (nz * wx[i] - nx * wz[i]);
            vz[i] += eps * (nx * wy[i] - ny * wx[i]);
        }
    }

    /** XSPH: v_i += c sum_j (v_j - v_i) W(p_i - p_j) / rho0 * volume normalisation. */
    private applyXsph(): void {
        const n = this.count;
        const { px, py, pz, vx, vy, vz, neighbors, neighborCount, dvx, dvy, dvz } = this;
        const h2 = this.h2;
        const poly6 = this.poly6;
        const c = this.xsph / (poly6 * h2 * h2 * h2) * 8;
        const maxN = PBFSolver.MAX_NEIGHBORS;
        dvx.fill(0, 0, n);
        dvy.fill(0, 0, n);
        dvz.fill(0, 0, n);
        for (let i = 0; i < n; i++) {
            let ax = 0;
            let ay = 0;
            let az = 0;
            const base = i * maxN;
            const cnt = neighborCount[i];
            for (let m = 0; m < cnt; m++) {
                const j = neighbors[base + m];
                const dx = px[i] - px[j];
                const dy = py[i] - py[j];
                const dz = pz[i] - pz[j];
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 >= h2) continue;
                const d = h2 - r2;
                const w = poly6 * d * d * d;
                const ux = (vx[j] - vx[i]) * w;
                const uy = (vy[j] - vy[i]) * w;
                const uz = (vz[j] - vz[i]) * w;
                ax += ux;
                ay += uy;
                az += uz;
                dvx[j] -= ux;
                dvy[j] -= uy;
                dvz[j] -= uz;
            }
            dvx[i] += ax;
            dvy[i] += ay;
            dvz[i] += az;
        }
        for (let i = 0; i < n; i++) {
            vx[i] += dvx[i] * c;
            vy[i] += dvy[i] * c;
            vz[i] += dvz[i] * c;
        }
    }
}
