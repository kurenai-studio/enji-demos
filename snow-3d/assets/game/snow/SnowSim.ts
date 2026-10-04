import { svd3 } from './Svd3';

export interface SnowParams {
    /** Young's modulus E₀ (Pa) and Poisson ratio of the elastic part. */
    young: number;
    poisson: number;
    /** Rest density (kg/m³). Fresh snow is 100–400. */
    density: number;
    /** Stomakhin's critical compression θc and stretch θs. */
    compression: number;
    stretch: number;
    /** Hardening ξ in e^{ξ(1 − Jp)}. */
    hardening: number;
    /** Cap on the hardening factor, so packed snow cannot outrun the explicit step. */
    maxHardening: number;
    gravity: number;
    /** Coulomb friction on the tray floor and walls, and on the hand. */
    floorFriction: number;
    handFriction: number;
}

export function defaultParams(): SnowParams {
    return {
        young: 3.5e4,
        poisson: 0.2,
        density: 400,
        compression: 2.5e-2,
        stretch: 7.5e-3,
        hardening: 10,
        maxHardening: 4,
        gravity: 9.8,
        floorFriction: 0.6,
        handFriction: 0.4,
    };
}

/**
 * Kinematic capsule (segment a–b, radius r). Velocities at both ends let a
 * rotating hand move snow at the right speed along each finger.
 */
export interface Capsule {
    ax: number; ay: number; az: number;
    bx: number; by: number; bz: number;
    r: number;
    vax: number; vay: number; vaz: number;
    vbx: number; vby: number; vbz: number;
}

export function capsule(): Capsule {
    return { ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 0, vax: 0, vay: 0, vaz: 0, vbx: 0, vby: 0, vbz: 0 };
}

/** Grid cells kept between the domain edge and the tray walls (the B-spline stencil needs two). */
export const BORDER = 3;

const U = new Float64Array(9);
const SIG = new Float64Array(3);
const V = new Float64Array(9);
const hit = { phi: 0, nx: 0, ny: 0, nz: 0, vx: 0, vy: 0, vz: 0 };

/**
 * Explicit 3D MLS-MPM (Hu et al. 2018, quadratic B-splines, APIC) with
 * Stomakhin et al. 2013 snow: F = F_E F_P, fixed-corotated elasticity on F_E
 * with moduli scaled by e^{ξ(1 − J_P)}, and F_E's singular values clamped to
 * [1 − θc, 1 + θs] after every step, the cut-off part going into J_P. A box
 * tray with friction and a set of kinematic capsules (the hand) are the
 * boundary conditions, applied on grid velocities and, to stop snow from
 * staying inside a fast hand, on particle positions.
 */
export class SnowSim {
    readonly dx: number;
    readonly inv: number;
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly grid: Float32Array;
    readonly capacity: number;
    count = 0;
    params: SnowParams;

    readonly x: Float32Array;
    readonly y: Float32Array;
    readonly z: Float32Array;
    readonly vx: Float32Array;
    readonly vy: Float32Array;
    readonly vz: Float32Array;
    /** Affine velocity C (APIC), row major. */
    readonly c: Float32Array;
    /** Elastic deformation gradient F_E and its rotation R, row major. */
    readonly f: Float32Array;
    readonly r: Float32Array;
    readonly je: Float32Array;
    /** Plastic volume ratio J_P: below 1 is packed snow, above 1 is torn. */
    readonly jp: Float32Array;

    particleVolume = 0;
    particleMass = 0;
    readonly colliders: Capsule[] = [];
    /** Set when a particle hit the one-cell-per-step speed cap. */
    blewUp = false;

    /**
     * Sleeping: particles at rest away from the hand leave the solve, and grid
     * nodes well inside sleeping snow (`solid`) act as a fixed, sticky surface
     * for the awake snow. Only `active[0..activeCount)` is stepped.
     */
    readonly awake: Uint8Array;
    readonly active: Int32Array;
    activeCount = 0;
    readonly solid: Uint8Array;
    private readonly still: Uint16Array;
    private readonly cover: Float32Array;
    sleepSpeed = 0.04;
    sleepFrames = 40;
    /** Called when a particle falls asleep (true) or wakes (false), e.g. to keep a cached surface field. */
    onSleep: ((p: number, asleep: boolean) => void) | null = null;

    constructor(nx: number, ny: number, nz: number, dx: number, capacity: number, params = defaultParams()) {
        this.nx = nx;
        this.ny = ny;
        this.nz = nz;
        this.dx = dx;
        this.inv = 1 / dx;
        this.capacity = capacity;
        this.params = params;
        this.grid = new Float32Array(nx * ny * nz * 4);
        this.x = new Float32Array(capacity);
        this.y = new Float32Array(capacity);
        this.z = new Float32Array(capacity);
        this.vx = new Float32Array(capacity);
        this.vy = new Float32Array(capacity);
        this.vz = new Float32Array(capacity);
        this.c = new Float32Array(capacity * 9);
        this.f = new Float32Array(capacity * 9);
        this.r = new Float32Array(capacity * 9);
        this.je = new Float32Array(capacity);
        this.jp = new Float32Array(capacity);
        this.awake = new Uint8Array(capacity);
        this.active = new Int32Array(capacity);
        this.still = new Uint16Array(capacity);
        this.solid = new Uint8Array(nx * ny * nz);
        this.cover = new Float32Array(nx * ny * nz);
    }

    /** Inside of the tray walls, in sim metres. */
    get lo(): number { return BORDER * this.dx; }
    get hiX(): number { return (this.nx - BORDER) * this.dx; }
    get hiY(): number { return (this.ny - BORDER) * this.dx; }
    get hiZ(): number { return (this.nz - BORDER) * this.dx; }

    /** Particle volume for `perCell`³ particles per grid cell. */
    setSpacing(perCell: number): void {
        this.particleVolume = (this.dx / perCell) ** 3;
        this.particleMass = this.particleVolume * this.params.density;
    }

    clear(): void {
        this.count = 0;
        this.activeCount = 0;
        this.solid.fill(0);
    }

    add(px: number, py: number, pz: number, jp = 1): number {
        if (this.count >= this.capacity) return -1;
        const p = this.count++;
        this.x[p] = px; this.y[p] = py; this.z[p] = pz;
        this.vx[p] = 0; this.vy[p] = 0; this.vz[p] = 0;
        const o = p * 9;
        for (let k = 0; k < 9; k++) { this.c[o + k] = 0; this.f[o + k] = 0; this.r[o + k] = 0; }
        this.f[o] = this.f[o + 4] = this.f[o + 8] = 1;
        this.r[o] = this.r[o + 4] = this.r[o + 8] = 1;
        this.je[p] = 1;
        this.jp[p] = jp;
        this.awake[p] = 1;
        this.still[p] = 0;
        this.active[this.activeCount++] = p;
        return p;
    }

    wakeAll(): void {
        for (let p = 0; p < this.count; p++) if (!this.awake[p]) this.wake(p);
        this.rebuildActive();
    }

    sleepAll(): void {
        for (let p = 0; p < this.count; p++) if (this.awake[p]) this.putToSleep(p);
        this.rebuildActive();
    }

    private wake(p: number): void {
        this.awake[p] = 1;
        this.still[p] = 0;
        this.onSleep?.(p, false);
    }

    /**
     * Once per frame: wakes snow within `wakeRadius` of the hand, puts snow that
     * has been slower than `sleepSpeed` for `sleepFrames` frames and is farther
     * than `sleepRadius` to sleep, and rebuilds the active list and the solid
     * grid if anything changed. Returns the number of particles that changed.
     */
    updateSleep(wakeRadius: number, sleepRadius: number): number {
        const { x, y, z, vx, vy, vz, awake, still } = this;
        let changed = 0;
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (const s of this.colliders) {
            x0 = Math.min(x0, s.ax - s.r, s.bx - s.r); x1 = Math.max(x1, s.ax + s.r, s.bx + s.r);
            y0 = Math.min(y0, s.ay - s.r, s.by - s.r); y1 = Math.max(y1, s.ay + s.r, s.by + s.r);
            z0 = Math.min(z0, s.az - s.r, s.bz - s.r); z1 = Math.max(z1, s.az + s.r, s.bz + s.r);
        }
        const reach = Math.max(wakeRadius, sleepRadius);
        x0 -= reach; y0 -= reach; z0 -= reach; x1 += reach; y1 += reach; z1 += reach;
        const v2 = this.sleepSpeed * this.sleepSpeed;
        for (let p = 0, n = this.count; p < n; p++) {
            const px = x[p], py = y[p], pz = z[p];
            const near = px > x0 && px < x1 && py > y0 && py < y1 && pz > z0 && pz < z1;
            const d = near ? this.handDistance(px, py, pz) : Infinity;
            if (!awake[p]) {
                if (d < wakeRadius) { this.wake(p); changed++; }
                continue;
            }
            if (vx[p] * vx[p] + vy[p] * vy[p] + vz[p] * vz[p] < v2) still[p]++;
            else still[p] = 0;
            if (still[p] >= this.sleepFrames && d > sleepRadius) { this.putToSleep(p); changed++; }
        }
        if (changed > 0) this.rebuildActive();
        return changed;
    }

    private putToSleep(p: number): void {
        this.awake[p] = 0;
        this.still[p] = 0;
        this.vx[p] = 0; this.vy[p] = 0; this.vz[p] = 0;
        this.c.fill(0, p * 9, p * 9 + 9);
        this.onSleep?.(p, true);
    }

    /** Active list, plus the solid grid: nodes with at least half a particle's worth of sleeping weight. */
    private rebuildActive(): void {
        const { awake, active, cover, solid, x, y, z, nx, ny, inv } = this;
        let a = 0;
        cover.fill(0);
        let sleeping = 0;
        for (let p = 0, n = this.count; p < n; p++) {
            if (awake[p]) { active[a++] = p; continue; }
            sleeping++;
            const gx = x[p] * inv, gy = y[p] * inv, gz = z[p] * inv;
            const bi = (gx - 0.5) | 0, bj = (gy - 0.5) | 0, bk = (gz - 0.5) | 0;
            const fx = gx - bi, fy = gy - bj, fz = gz - bk;
            for (let cz = 0; cz < 3; cz++) {
                const wz = cz === 0 ? 0.5 * (1.5 - fz) ** 2 : cz === 1 ? 0.75 - (fz - 1) ** 2 : 0.5 * (fz - 0.5) ** 2;
                for (let cy = 0; cy < 3; cy++) {
                    const wy = cy === 0 ? 0.5 * (1.5 - fy) ** 2 : cy === 1 ? 0.75 - (fy - 1) ** 2 : 0.5 * (fy - 0.5) ** 2;
                    const q = bi + nx * (bj + cy + ny * (bk + cz));
                    const w = wy * wz;
                    cover[q] += w * 0.5 * (1.5 - fx) ** 2;
                    cover[q + 1] += w * (0.75 - (fx - 1) ** 2);
                    cover[q + 2] += w * 0.5 * (fx - 0.5) ** 2;
                }
            }
        }
        this.activeCount = a;
        // A full cell of particles gives a node weight of perCell³; solid needs half of that.
        const need = sleeping > 0 ? 0.5 * (this.dx ** 3 / this.particleVolume) : Infinity;
        for (let q = 0; q < cover.length; q++) solid[q] = cover[q] >= need ? 1 : 0;
    }

    step(dt: number): void {
        this.grid.fill(0);
        this.p2g(dt);
        this.gridUpdate(dt);
        this.g2p(dt);
    }

    private p2g(dt: number): void {
        const { grid: g, x, y, z, vx, vy, vz, c, f, r, je, jp, nx, ny, dx, inv } = this;
        const prm = this.params;
        const mu0 = prm.young / (2 * (1 + prm.poisson));
        const la0 = (prm.young * prm.poisson) / ((1 + prm.poisson) * (1 - 2 * prm.poisson));
        const m = this.particleMass;
        const k = -dt * this.particleVolume * 4 * inv * inv;
        const xi = prm.hardening;
        const hMax = prm.maxHardening;
        const sy = nx * 4;
        const sz = nx * ny * 4;
        const active = this.active;
        for (let a = 0, n = this.activeCount; a < n; a++) {
            const p = active[a];
            const gx = x[p] * inv, gy = y[p] * inv, gz = z[p] * inv;
            const bi = (gx - 0.5) | 0, bj = (gy - 0.5) | 0, bk = (gz - 0.5) | 0;
            const fx = gx - bi, fy = gy - bj, fz = gz - bk;
            const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx), wx1 = 0.75 - (fx - 1) * (fx - 1), wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
            const wy0 = 0.5 * (1.5 - fy) * (1.5 - fy), wy1 = 0.75 - (fy - 1) * (fy - 1), wy2 = 0.5 * (fy - 0.5) * (fy - 0.5);
            const wz0 = 0.5 * (1.5 - fz) * (1.5 - fz), wz1 = 0.75 - (fz - 1) * (fz - 1), wz2 = 0.5 * (fz - 0.5) * (fz - 0.5);
            const ex0 = -fx * dx, ex1 = (1 - fx) * dx, ex2 = (2 - fx) * dx;

            // Kirchhoff stress τ = 2μ (F − R) Fᵀ + λ (J − 1) J I, hardened by e^{ξ(1 − Jp)}.
            const o = p * 9;
            const F0 = f[o], F1 = f[o + 1], F2 = f[o + 2], F3 = f[o + 3], F4 = f[o + 4], F5 = f[o + 5], F6 = f[o + 6], F7 = f[o + 7], F8 = f[o + 8];
            const D0 = F0 - r[o], D1 = F1 - r[o + 1], D2 = F2 - r[o + 2];
            const D3 = F3 - r[o + 3], D4 = F4 - r[o + 4], D5 = F5 - r[o + 5];
            const D6 = F6 - r[o + 6], D7 = F7 - r[o + 7], D8 = F8 - r[o + 8];
            let h = Math.exp(xi * (1 - jp[p]));
            if (h > hMax) h = hMax;
            const mu2 = 2 * mu0 * h;
            const J = je[p];
            const vol = la0 * h * (J - 1) * J;
            const t0 = mu2 * (D0 * F0 + D1 * F1 + D2 * F2) + vol;
            const t1 = mu2 * (D0 * F3 + D1 * F4 + D2 * F5);
            const t2 = mu2 * (D0 * F6 + D1 * F7 + D2 * F8);
            const t3 = mu2 * (D3 * F0 + D4 * F1 + D5 * F2);
            const t4 = mu2 * (D3 * F3 + D4 * F4 + D5 * F5) + vol;
            const t5 = mu2 * (D3 * F6 + D4 * F7 + D5 * F8);
            const t6 = mu2 * (D6 * F0 + D7 * F1 + D8 * F2);
            const t7 = mu2 * (D6 * F3 + D7 * F4 + D8 * F5);
            const t8 = mu2 * (D6 * F6 + D7 * F7 + D8 * F8) + vol;
            const A0 = k * t0 + m * c[o], A1 = k * t1 + m * c[o + 1], A2 = k * t2 + m * c[o + 2];
            const A3 = k * t3 + m * c[o + 3], A4 = k * t4 + m * c[o + 4], A5 = k * t5 + m * c[o + 5];
            const A6 = k * t6 + m * c[o + 6], A7 = k * t7 + m * c[o + 7], A8 = k * t8 + m * c[o + 8];
            const mvx = m * vx[p], mvy = m * vy[p], mvz = m * vz[p];

            for (let cz = 0; cz < 3; cz++) {
                const wz = cz === 0 ? wz0 : cz === 1 ? wz1 : wz2;
                const ez = (cz - fz) * dx;
                for (let cy = 0; cy < 3; cy++) {
                    const wyz = (cy === 0 ? wy0 : cy === 1 ? wy1 : wy2) * wz;
                    const ey = (cy - fy) * dx;
                    const qx = mvx + A1 * ey + A2 * ez;
                    const qy = mvy + A4 * ey + A5 * ez;
                    const qz = mvz + A7 * ey + A8 * ez;
                    let q = bi * 4 + (bj + cy) * sy + (bk + cz) * sz;
                    let w = wx0 * wyz;
                    g[q] += w * (qx + A0 * ex0); g[q + 1] += w * (qy + A3 * ex0); g[q + 2] += w * (qz + A6 * ex0); g[q + 3] += w * m;
                    q += 4; w = wx1 * wyz;
                    g[q] += w * (qx + A0 * ex1); g[q + 1] += w * (qy + A3 * ex1); g[q + 2] += w * (qz + A6 * ex1); g[q + 3] += w * m;
                    q += 4; w = wx2 * wyz;
                    g[q] += w * (qx + A0 * ex2); g[q + 1] += w * (qy + A3 * ex2); g[q + 2] += w * (qz + A6 * ex2); g[q + 3] += w * m;
                }
            }
        }
    }

    private gridUpdate(dt: number): void {
        const { grid: g, nx, ny, nz, dx } = this;
        const gdt = this.params.gravity * dt;
        const mu = this.params.floorFriction;
        const lo = BORDER, hx = nx - BORDER, hy = ny - BORDER, hz = nz - BORDER;
        const solid = this.solid;
        for (let kz = 0, q = 0, node = 0; kz < nz; kz++) {
            for (let jy = 0; jy < ny; jy++) {
                for (let ix = 0; ix < nx; ix++, q += 4, node++) {
                    const m = g[q + 3];
                    if (m <= 0) continue;
                    if (solid[node]) { g[q] = 0; g[q + 1] = 0; g[q + 2] = 0; continue; }
                    let vx = g[q] / m, vy = g[q + 1] / m - gdt, vz = g[q + 2] / m;
                    // Separating box walls with Coulomb friction: only motion into the wall is removed.
                    if (jy < lo && vy < 0) { const t = friction(vx, vz, -vy, mu); vx *= t; vz *= t; vy = 0; }
                    if (jy >= hy && vy > 0) vy = 0;
                    if ((ix < lo && vx < 0) || (ix >= hx && vx > 0)) { const t = friction(vy, vz, Math.abs(vx), mu); vy *= t; vz *= t; vx = 0; }
                    if ((kz < lo && vz < 0) || (kz >= hz && vz > 0)) { const t = friction(vx, vy, Math.abs(vz), mu); vx *= t; vy *= t; vz = 0; }
                    g[q] = vx; g[q + 1] = vy; g[q + 2] = vz;
                }
            }
        }
        if (this.colliders.length === 0) return;

        // Hand: nodes inside a capsule keep only the velocity that separates from it.
        const margin = dx;
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (const s of this.colliders) {
            x0 = Math.min(x0, s.ax - s.r, s.bx - s.r); x1 = Math.max(x1, s.ax + s.r, s.bx + s.r);
            y0 = Math.min(y0, s.ay - s.r, s.by - s.r); y1 = Math.max(y1, s.ay + s.r, s.by + s.r);
            z0 = Math.min(z0, s.az - s.r, s.bz - s.r); z1 = Math.max(z1, s.az + s.r, s.bz + s.r);
        }
        const i0 = Math.max(0, Math.floor((x0 - margin) / dx)), i1 = Math.min(nx - 1, Math.ceil((x1 + margin) / dx));
        const j0 = Math.max(0, Math.floor((y0 - margin) / dx)), j1 = Math.min(ny - 1, Math.ceil((y1 + margin) / dx));
        const k0 = Math.max(0, Math.floor((z0 - margin) / dx)), k1 = Math.min(nz - 1, Math.ceil((z1 + margin) / dx));
        const hmu = this.params.handFriction;
        for (let kz = k0; kz <= k1; kz++) {
            for (let jy = j0; jy <= j1; jy++) {
                for (let ix = i0; ix <= i1; ix++) {
                    const q = (ix + nx * (jy + ny * kz)) * 4;
                    if (g[q + 3] <= 0) continue;
                    if (!this.probe(ix * dx, jy * dx, kz * dx, margin * 0.5)) continue;
                    const rx = g[q] - hit.vx, ry = g[q + 1] - hit.vy, rz = g[q + 2] - hit.vz;
                    const vn = rx * hit.nx + ry * hit.ny + rz * hit.nz;
                    if (vn >= 0) continue;
                    let tx = rx - vn * hit.nx, ty = ry - vn * hit.ny, tz = rz - vn * hit.nz;
                    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
                    const s = tl > 1e-9 ? Math.max(0, 1 + (hmu * vn) / tl) : 0;
                    tx *= s; ty *= s; tz *= s;
                    g[q] = tx + hit.vx; g[q + 1] = ty + hit.vy; g[q + 2] = tz + hit.vz;
                }
            }
        }
    }

    private g2p(dt: number): void {
        const { grid: g, x, y, z, vx, vy, vz, c, f, r, je, jp, nx, ny, dx, inv } = this;
        const prm = this.params;
        const lo = 2 * dx;
        const hx = (this.nx - 2) * dx - 1e-4, hy = (this.ny - 2) * dx - 1e-4, hz = (this.nz - 2) * dx - 1e-4;
        const sy = nx * 4;
        const sz = nx * ny * 4;
        const kc = 4 * inv * inv;
        const cMin = 1 - prm.compression, cMax = 1 + prm.stretch;
        const vMax = dx / dt;
        const hasHand = this.colliders.length > 0;
        const active = this.active;
        for (let a = 0, n = this.activeCount; a < n; a++) {
            const p = active[a];
            const gx = x[p] * inv, gy = y[p] * inv, gz = z[p] * inv;
            const bi = (gx - 0.5) | 0, bj = (gy - 0.5) | 0, bk = (gz - 0.5) | 0;
            const fx = gx - bi, fy = gy - bj, fz = gz - bk;
            const wx0 = 0.5 * (1.5 - fx) * (1.5 - fx), wx1 = 0.75 - (fx - 1) * (fx - 1), wx2 = 0.5 * (fx - 0.5) * (fx - 0.5);
            const wy0 = 0.5 * (1.5 - fy) * (1.5 - fy), wy1 = 0.75 - (fy - 1) * (fy - 1), wy2 = 0.5 * (fy - 0.5) * (fy - 0.5);
            const wz0 = 0.5 * (1.5 - fz) * (1.5 - fz), wz1 = 0.75 - (fz - 1) * (fz - 1), wz2 = 0.5 * (fz - 0.5) * (fz - 0.5);
            const ex0 = -fx * dx, ex1 = (1 - fx) * dx, ex2 = (2 - fx) * dx;
            let sx = 0, sY = 0, sZ = 0;
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, b7 = 0, b8 = 0;
            for (let cz = 0; cz < 3; cz++) {
                const wz = cz === 0 ? wz0 : cz === 1 ? wz1 : wz2;
                const ez = (cz - fz) * dx;
                for (let cy = 0; cy < 3; cy++) {
                    const wyz = (cy === 0 ? wy0 : cy === 1 ? wy1 : wy2) * wz;
                    const ey = (cy - fy) * dx;
                    const q = bi * 4 + (bj + cy) * sy + (bk + cz) * sz;
                    const a0 = g[q], a1 = g[q + 1], a2 = g[q + 2];
                    const c0 = g[q + 4], c1 = g[q + 5], c2 = g[q + 6];
                    const d0 = g[q + 8], d1 = g[q + 9], d2 = g[q + 10];
                    const ux = wyz * (wx0 * a0 + wx1 * c0 + wx2 * d0);
                    const uy = wyz * (wx0 * a1 + wx1 * c1 + wx2 * d1);
                    const uz = wyz * (wx0 * a2 + wx1 * c2 + wx2 * d2);
                    sx += ux; sY += uy; sZ += uz;
                    b0 += wyz * (wx0 * ex0 * a0 + wx1 * ex1 * c0 + wx2 * ex2 * d0);
                    b3 += wyz * (wx0 * ex0 * a1 + wx1 * ex1 * c1 + wx2 * ex2 * d1);
                    b6 += wyz * (wx0 * ex0 * a2 + wx1 * ex1 * c2 + wx2 * ex2 * d2);
                    b1 += ux * ey; b4 += uy * ey; b7 += uz * ey;
                    b2 += ux * ez; b5 += uy * ez; b8 += uz * ez;
                }
            }
            const o = p * 9;
            const C0 = b0 * kc, C1 = b1 * kc, C2 = b2 * kc, C3 = b3 * kc, C4 = b4 * kc, C5 = b5 * kc, C6 = b6 * kc, C7 = b7 * kc, C8 = b8 * kc;
            c[o] = C0; c[o + 1] = C1; c[o + 2] = C2; c[o + 3] = C3; c[o + 4] = C4; c[o + 5] = C5; c[o + 6] = C6; c[o + 7] = C7; c[o + 8] = C8;

            // F_E ← (I + dt C) F_E, then clamp its singular values (Stomakhin plasticity).
            const F0 = f[o], F1 = f[o + 1], F2 = f[o + 2], F3 = f[o + 3], F4 = f[o + 4], F5 = f[o + 5], F6 = f[o + 6], F7 = f[o + 7], F8 = f[o + 8];
            const e0 = 1 + dt * C0, e1 = dt * C1, e2 = dt * C2;
            const e3 = dt * C3, e4 = 1 + dt * C4, e5 = dt * C5;
            const e6 = dt * C6, e7 = dt * C7, e8 = 1 + dt * C8;
            f[o] = e0 * F0 + e1 * F3 + e2 * F6; f[o + 1] = e0 * F1 + e1 * F4 + e2 * F7; f[o + 2] = e0 * F2 + e1 * F5 + e2 * F8;
            f[o + 3] = e3 * F0 + e4 * F3 + e5 * F6; f[o + 4] = e3 * F1 + e4 * F4 + e5 * F7; f[o + 5] = e3 * F2 + e4 * F5 + e5 * F8;
            f[o + 6] = e6 * F0 + e7 * F3 + e8 * F6; f[o + 7] = e6 * F1 + e7 * F4 + e8 * F7; f[o + 8] = e6 * F2 + e7 * F5 + e8 * F8;
            svd3(f, o, U, SIG, V);
            const s0 = SIG[0], s1 = SIG[1], s2 = SIG[2];
            const k0 = s0 < cMin ? cMin : s0 > cMax ? cMax : s0;
            const k1 = s1 < cMin ? cMin : s1 > cMax ? cMax : s1;
            const k2 = s2 < cMin ? cMin : s2 > cMax ? cMax : s2;
            const jNew = k0 * k1 * k2;
            let jpNew = (jp[p] * (s0 * s1 * s2)) / jNew;
            jpNew = jpNew < 0.6 ? 0.6 : jpNew > 20 ? 20 : jpNew;
            jp[p] = jpNew;
            je[p] = jNew;
            for (let i = 0; i < 3; i++) {
                const ua = U[i * 3], ub = U[i * 3 + 1], uc = U[i * 3 + 2];
                for (let j = 0; j < 3; j++) {
                    const va = V[j * 3], vb = V[j * 3 + 1], vc = V[j * 3 + 2];
                    f[o + i * 3 + j] = ua * k0 * va + ub * k1 * vb + uc * k2 * vc;
                    r[o + i * 3 + j] = ua * va + ub * vb + uc * vc;
                }
            }

            const v2 = sx * sx + sY * sY + sZ * sZ;
            if (!(v2 <= vMax * vMax)) {
                const s = v2 > 0 && Number.isFinite(v2) ? vMax / Math.sqrt(v2) : 0;
                sx *= s; sY *= s; sZ *= s;
                this.blewUp = true;
            }
            let px = x[p] + sx * dt, py = y[p] + sY * dt, pz = z[p] + sZ * dt;
            if (hasHand && this.probe(px, py, pz, 0) && hit.phi < 0) {
                // Snow the grid let into the hand is put back on its surface, moving with it.
                px -= hit.phi * hit.nx; py -= hit.phi * hit.ny; pz -= hit.phi * hit.nz;
                const vn = (sx - hit.vx) * hit.nx + (sY - hit.vy) * hit.ny + (sZ - hit.vz) * hit.nz;
                if (vn < 0) { sx -= vn * hit.nx; sY -= vn * hit.ny; sZ -= vn * hit.nz; }
            }
            vx[p] = sx; vy[p] = sY; vz[p] = sZ;
            x[p] = px < lo ? lo : px > hx ? hx : px;
            y[p] = py < lo ? lo : py > hy ? hy : py;
            z[p] = pz < lo ? lo : pz > hz ? hz : pz;
        }
    }

    /** Signed distance from (px, py, pz) to the hand. */
    handDistance(px: number, py: number, pz: number): number {
        let best = Infinity;
        for (const s of this.colliders) {
            const abx = s.bx - s.ax, aby = s.by - s.ay, abz = s.bz - s.az;
            const l2 = abx * abx + aby * aby + abz * abz;
            let t = l2 > 0 ? ((px - s.ax) * abx + (py - s.ay) * aby + (pz - s.az) * abz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dxp = px - (s.ax + t * abx), dyp = py - (s.ay + t * aby), dzp = pz - (s.az + t * abz);
            const phi = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp) - s.r;
            if (phi < best) best = phi;
        }
        return best;
    }

    /**
     * Nearest capsule surface to (px, py, pz). Returns false when every capsule
     * is farther than `band`; otherwise fills `hit` with the signed distance,
     * the outward normal and the hand velocity at that point.
     */
    private probe(px: number, py: number, pz: number, band: number): boolean {
        let best = band;
        let found = false;
        for (const s of this.colliders) {
            const abx = s.bx - s.ax, aby = s.by - s.ay, abz = s.bz - s.az;
            const l2 = abx * abx + aby * aby + abz * abz;
            let t = l2 > 0 ? ((px - s.ax) * abx + (py - s.ay) * aby + (pz - s.az) * abz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dxp = px - (s.ax + t * abx), dyp = py - (s.ay + t * aby), dzp = pz - (s.az + t * abz);
            const d = Math.sqrt(dxp * dxp + dyp * dyp + dzp * dzp);
            const phi = d - s.r;
            if (phi >= best) continue;
            best = phi;
            found = true;
            hit.phi = phi;
            if (d > 1e-9) { hit.nx = dxp / d; hit.ny = dyp / d; hit.nz = dzp / d; } else { hit.nx = 0; hit.ny = 1; hit.nz = 0; }
            hit.vx = s.vax + t * (s.vbx - s.vax);
            hit.vy = s.vay + t * (s.vby - s.vay);
            hit.vz = s.vaz + t * (s.vbz - s.vaz);
        }
        return found;
    }
}

/** Tangential scale after Coulomb friction removes μ·|vn| of tangential speed. */
function friction(ta: number, tb: number, vn: number, mu: number): number {
    const t = Math.sqrt(ta * ta + tb * tb);
    return t > 1e-9 ? Math.max(0, 1 - (mu * vn) / t) : 0;
}
