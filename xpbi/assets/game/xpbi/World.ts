import { CLAY, JELLY, SAND, SNOW } from './Svd2';

export type SolverKind = 'xpbi' | 'semi' | 'vanilla';

export interface XpbiParams {
    gravity: number;
    density: number;
    young: number;
    poisson: number;
    frictionDeg: number;
    cohesion: number;
    snowCompression: number;
    snowStretch: number;
    snowHardening: number;
    yieldStress: number;
    xsph: number;
    /** Iterations of coloured/sequential Gauss–Seidel per substep. */
    iterations: number;
    /** Substeps of simulated 1/60 s. */
    substeps: number;
}

export function defaultParams(): XpbiParams {
    return {
        gravity: 6,
        density: 1,
        young: 2500,
        poisson: 0.3,
        frictionDeg: 35,
        cohesion: 0,
        snowCompression: 0.025,
        snowStretch: 0.0075,
        snowHardening: 10,
        yieldStress: 40,
        xsph: 0.01,
        iterations: 5,
        substeps: 8,
    };
}

export const PAD = 0.04;

export interface Pointer {
    active: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
    radius: number;
    mode: 'grab' | 'push';
}

export class World {
    count = 0;
    readonly width: number;
    readonly height: number;
    readonly spacing: number;
    readonly radius: number;
    /** Wendland support = 2 × particle radius. */
    readonly h: number;
    readonly px: Float64Array;
    readonly py: Float64Array;
    readonly vx: Float64Array;
    readonly vy: Float64Array;
    readonly x0: Float64Array;
    readonly y0: Float64Array;
    readonly f00: Float64Array;
    readonly f01: Float64Array;
    readonly f10: Float64Array;
    readonly f11: Float64Array;
    readonly fn00: Float64Array;
    readonly fn01: Float64Array;
    readonly fn10: Float64Array;
    readonly fn11: Float64Array;
    readonly vol0: Float64Array;
    readonly vol: Float64Array;
    readonly mass: Float64Array;
    readonly logJp: Float64Array;
    readonly lambda: Float64Array;
    readonly material: Uint8Array;
    readonly L: Float64Array;
    readonly pointer: Pointer = { active: false, x: 0, y: 0, vx: 0, vy: 0, radius: 0.12, mode: 'grab' };
    params: XpbiParams;
    kind: SolverKind = 'xpbi';

    constructor(width: number, height: number, spacing: number, capacity: number, params: XpbiParams) {
        this.width = width;
        this.height = height;
        this.spacing = spacing;
        this.radius = spacing;
        this.h = 2 * spacing;
        this.params = params;
        this.px = new Float64Array(capacity);
        this.py = new Float64Array(capacity);
        this.vx = new Float64Array(capacity);
        this.vy = new Float64Array(capacity);
        this.x0 = new Float64Array(capacity);
        this.y0 = new Float64Array(capacity);
        this.f00 = new Float64Array(capacity);
        this.f01 = new Float64Array(capacity);
        this.f10 = new Float64Array(capacity);
        this.f11 = new Float64Array(capacity);
        this.fn00 = new Float64Array(capacity);
        this.fn01 = new Float64Array(capacity);
        this.fn10 = new Float64Array(capacity);
        this.fn11 = new Float64Array(capacity);
        this.vol0 = new Float64Array(capacity);
        this.vol = new Float64Array(capacity);
        this.mass = new Float64Array(capacity);
        this.logJp = new Float64Array(capacity);
        this.lambda = new Float64Array(capacity);
        this.material = new Uint8Array(capacity);
        this.L = new Float64Array(capacity * 4);
    }

    get capacity(): number { return this.px.length; }

    clear(): void { this.count = 0; }

    add(x: number, y: number, material: number): void {
        if (this.count >= this.px.length) throw new Error(`World capacity ${this.px.length}`);
        const i = this.count++;
        this.px[i] = x; this.py[i] = y;
        this.vx[i] = 0; this.vy[i] = 0;
        this.f00[i] = 1; this.f01[i] = 0; this.f10[i] = 0; this.f11[i] = 1;
        const v0 = this.spacing * this.spacing;
        this.vol0[i] = v0; this.vol[i] = v0;
        this.mass[i] = this.params.density * v0;
        this.logJp[i] = material === SNOW ? 1 : 0;
        this.material[i] = material;
        this.lambda[i] = 0;
    }

    /** Axis-aligned block, particles on a hexagonal-ish jittered lattice. */
    fillBlock(x0: number, y0: number, x1: number, y1: number, material: number, jitter = 0.15): void {
        const s = this.spacing;
        let row = 0;
        for (let y = y0 + s * 0.5; y < y1 - s * 0.15; y += s, row++) {
            const ox = (row & 1) ? s * 0.5 : 0;
            for (let x = x0 + s * 0.5 + ox; x < x1 - s * 0.15; x += s) {
                const jx = (hash(x, y) - 0.5) * jitter * s;
                const jy = (hash(y, x) - 0.5) * jitter * s;
                this.add(x + jx, y + jy, material);
            }
        }
    }
}

function hash(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
}

export { JELLY, SAND, SNOW, CLAY };
