/**
 * Shared state for the two 2D MPM solvers (PbMpm.ts, MlsMpm.ts): particles in
 * struct-of-arrays typed arrays and a collocated grid, all in grid units
 * (1 = one cell, y up). Particles stay `GUARDIAN` cells away from the border
 * so their 3×3 stencils never leave the grid.
 */
export const LIQUID = 0;
export const ELASTIC = 1;
export const SAND = 2;
export const VISCO = 3;
export const MATERIAL_NAMES = ['Liquid', 'Jelly', 'Sand', 'Visco'];

export const GUARDIAN = 3;
/** Particles per cell along each axis when a block is seeded. */
export const PARTICLES_PER_AXIS = 2;

export type SolverKind = 'pb' | 'mls';

export interface MpmParams {
    /** Gravity in domain heights per s². */
    gravity: number;
    borderFriction: number;
    // PB-MPM (values from the EA SEED reference).
    iterations: number;
    liquidRelaxation: number;
    elasticRelaxation: number;
    liquidViscosity: number;
    /** 1 = jelly is pulled towards a rotation, 0 = only towards det F = 1. */
    elasticityRatio: number;
    frictionAngle: number;
    plasticity: number;
    useGridVolume: boolean;
    // MLS-MPM moduli (grid units, rest density 1).
    bulkModulus: number;
    youngModulus: number;
    poisson: number;
}

export function defaultParams(): MpmParams {
    return {
        gravity: 2.5,
        borderFriction: 0.5,
        iterations: 5,
        liquidRelaxation: 1.5,
        elasticRelaxation: 1.5,
        liquidViscosity: 0.01,
        elasticityRatio: 1,
        frictionAngle: 30,
        plasticity: 0.9,
        useGridVolume: true,
        bulkModulus: 1.2e5,
        youngModulus: 1.5e5,
        poisson: 0.25,
    };
}

export interface Pointer {
    active: boolean;
    /** Grid units. */
    x: number;
    y: number;
    /** Cells per second. */
    vx: number;
    vy: number;
    radius: number;
    mode: 'grab' | 'push';
}

export class MpmWorld {
    count = 0;
    readonly px: Float64Array;
    readonly py: Float64Array;
    /** PB-MPM: displacement over one substep. MLS-MPM: velocity. */
    readonly vx: Float64Array;
    readonly vy: Float64Array;
    /** Deformation gradient F, row major. */
    readonly f00: Float64Array;
    readonly f01: Float64Array;
    readonly f10: Float64Array;
    readonly f11: Float64Array;
    /** Affine matrix: PB-MPM deformation displacement D, MLS-MPM velocity gradient C. */
    readonly c00: Float64Array;
    readonly c01: Float64Array;
    readonly c10: Float64Array;
    readonly c11: Float64Array;
    /** Liquid volume ratio det F. */
    readonly jac: Float64Array;
    readonly logJp: Float64Array;
    readonly mass: Float64Array;
    readonly volume: Float64Array;
    readonly material: Uint8Array;

    /** Two grids of 4 floats per node: momentum (or displacement) x, y, mass, volume. */
    gridA: Float64Array;
    gridB: Float64Array;

    readonly pointer: Pointer = { active: false, x: 0, y: 0, vx: 0, vy: 0, radius: 8, mode: 'grab' };
    /** True once MLS-MPM had to clamp a particle's speed to keep it inside the grid. */
    blewUp = false;
    framesSinceBlowUp = 0;

    readonly width: number;
    readonly height: number;
    readonly capacity: number;
    solver: SolverKind;
    readonly params: MpmParams;

    constructor(width: number, height: number, capacity: number, solver: SolverKind, params: MpmParams) {
        this.width = width;
        this.height = height;
        this.capacity = capacity;
        this.solver = solver;
        this.params = params;
        const f = () => new Float64Array(capacity);
        this.px = f();
        this.py = f();
        this.vx = f();
        this.vy = f();
        this.f00 = f();
        this.f01 = f();
        this.f10 = f();
        this.f11 = f();
        this.c00 = f();
        this.c01 = f();
        this.c10 = f();
        this.c11 = f();
        this.jac = f();
        this.logJp = f();
        this.mass = f();
        this.volume = f();
        this.material = new Uint8Array(capacity);
        this.gridA = new Float64Array(width * height * 4);
        this.gridB = new Float64Array(width * height * 4);
    }

    clear(): void {
        this.count = 0;
        this.blewUp = false;
        this.framesSinceBlowUp = 0;
    }

    /** Fills [x0, x1] × [y0, y1] (grid units) with particles of one material. */
    addBlock(material: number, x0: number, y0: number, x1: number, y1: number, vx = 0, vy = 0): void {
        const lo = GUARDIAN + 0.5;
        x0 = Math.max(x0, lo);
        y0 = Math.max(y0, lo);
        x1 = Math.min(x1, this.width - lo - 1);
        y1 = Math.min(y1, this.height - lo - 1);
        const step = 1 / PARTICLES_PER_AXIS;
        const vol = step * step;
        for (let y = y0 + step / 2; y < y1; y += step) {
            for (let x = x0 + step / 2; x < x1; x += step) {
                if (this.count >= this.capacity) return;
                const i = this.count++;
                const h = hash(i * 7919 + Math.floor(x * 131 + y * 977));
                this.px[i] = x + ((h & 1023) / 1023 - 0.5) * step * 0.5;
                this.py[i] = y + (((h >> 10) & 1023) / 1023 - 0.5) * step * 0.5;
                this.vx[i] = vx;
                this.vy[i] = vy;
                this.f00[i] = 1;
                this.f01[i] = 0;
                this.f10[i] = 0;
                this.f11[i] = 1;
                this.c00[i] = 0;
                this.c01[i] = 0;
                this.c10[i] = 0;
                this.c11[i] = 0;
                this.jac[i] = 1;
                this.logJp[i] = 1;
                this.mass[i] = vol;
                this.volume[i] = vol;
                this.material[i] = material;
            }
        }
    }

    /** Fills a disc with particles of one material. */
    addDisc(material: number, cx: number, cy: number, r: number): void {
        const start = this.count;
        this.addBlock(material, cx - r, cy - r, cx + r, cy + r);
        let w = start;
        for (let i = start; i < this.count; i++) {
            const dx = this.px[i] - cx;
            const dy = this.py[i] - cy;
            if (dx * dx + dy * dy > r * r) continue;
            if (w !== i) this.copyParticle(i, w);
            w++;
        }
        this.count = w;
    }

    private copyParticle(from: number, to: number): void {
        for (const a of [this.px, this.py, this.vx, this.vy, this.f00, this.f01, this.f10, this.f11,
            this.c00, this.c01, this.c10, this.c11, this.jac, this.logJp, this.mass, this.volume]) {
            a[to] = a[from];
        }
        this.material[to] = this.material[from];
    }

    /** Speed of particle i in cells per second, whichever solver is running. */
    speed(i: number, dt: number): number {
        const s = Math.sqrt(this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i]);
        return this.solver === 'pb' ? s / dt : s;
    }

    get minX(): number { return GUARDIAN; }
    get maxX(): number { return this.width - GUARDIAN - 1; }
    get minY(): number { return GUARDIAN; }
    get maxY(): number { return this.height - GUARDIAN - 1; }
}

/**
 * Tangential speed kept per step at a wall. The friction value is defined per
 * 1/240 s step (the PB-MPM reference rate), so both solvers grip the same
 * whatever their step size.
 */
export function wallKeep(friction: number, dt: number): number {
    return Math.pow(1 - friction, dt * 240);
}

function hash(n: number): number {
    n = (n ^ 61) ^ (n >>> 16);
    n = Math.imul(n, 9);
    n ^= n >>> 4;
    n = Math.imul(n, 0x27d4eb2d);
    return (n ^ (n >>> 15)) >>> 0;
}
