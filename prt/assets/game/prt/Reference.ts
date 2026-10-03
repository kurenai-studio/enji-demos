/**
 * Reference shading for one lighting setup, without SH: what PRT approximates.
 * The sky part sums the true sky radiance over the bake's escaped rays (the
 * same rays, so only the band limit differs); each lamp is integrated with
 * its own shadow rays spread over its cone; bounces go through the bake's W.
 *
 *   direct(p) = ρ/M Σ_{escaped j} sky(ω_j)
 *             + Σ_lamps ρ/π · L_lamp · Ω/K Σ_k V(ω_k) max(n·ω_k, 0),  Ω = 2π(1 − cos α)
 */
import { RAY_OFFSET, RGB_STRIDE, type Bake } from './Bake';
import { lampRadiance, skyRadiance, type Env } from './Env';
import { COEFFS, tangentFrame } from './SH';

export const LAMP_SAMPLES = 48;

/** K directions spread over a cap of half-angle α about +z (Fibonacci), xyz interleaved. */
export function capDirections(alpha: number, k: number): Float64Array {
    const out = new Float64Array(k * 3);
    const golden = Math.PI * (3 - Math.sqrt(5)), c = Math.cos(alpha);
    for (let i = 0; i < k; i++) {
        const z = 1 - ((1 - c) * (i + 0.5)) / k, r = Math.sqrt(Math.max(0, 1 - z * z)), phi = i * golden;
        out[i * 3] = r * Math.cos(phi);
        out[i * 3 + 1] = r * Math.sin(phi);
        out[i * 3 + 2] = z;
    }
    return out;
}

export class Reference {
    readonly env: Env;
    readonly direct: Float32Array;
    readonly total: Float32Array;
    done = false;
    ms = 0;
    private cursor = 0;
    private readonly bake: Bake;
    private readonly bounces: number;
    private readonly lampDirs: Float64Array[];

    constructor(bake: Bake, env: Env, bounces: number) {
        this.bake = bake;
        this.env = env;
        this.bounces = bounces;
        this.direct = new Float32Array(bake.vertexCount * 3);
        this.total = new Float32Array(bake.vertexCount * 3);
        this.lampDirs = env.lamps.map((l) => {
            const local = capDirections(l.alpha, LAMP_SAMPLES), world = new Float64Array(local.length);
            const t = [0, 0, 0], b = [0, 0, 0], [nx, ny, nz] = l.dir;
            tangentFrame(nx, ny, nz, t, b);
            for (let i = 0; i < LAMP_SAMPLES; i++) {
                const x = local[i * 3], y = local[i * 3 + 1], z = local[i * 3 + 2];
                for (let a = 0; a < 3; a++) world[i * 3 + a] = t[a] * x + b[a] * y + l.dir[a] * z;
            }
            return world;
        });
    }

    step(budgetMs: number, now: () => number = () => performance.now()): boolean {
        if (this.done) return true;
        const t0 = now(), nv = this.bake.vertexCount;
        while (this.cursor < nv && now() - t0 < budgetMs) {
            const end = Math.min(nv, this.cursor + 64);
            for (let v = this.cursor; v < end; v++) this.shade(v);
            this.cursor = end;
        }
        if (this.cursor === nv) {
            this.bake.dilate(this.direct, 3);
            this.total.set(this.direct);
            let prev = Float32Array.from(this.direct);
            const next = new Float32Array(prev.length);
            for (let b = 0; b < this.bounces; b++) {
                this.bake.bounceRadiance(prev, next);
                this.bake.dilate(next, 3);
                for (let i = 0; i < next.length; i++) this.total[i] += next[i];
                prev = Float32Array.from(next);
            }
            this.done = true;
        }
        this.ms += now() - t0;
        return this.done;
    }

    run(): this {
        while (!this.step(1e9));
        return this;
    }

    private readonly dir = [0, 0, 0];
    private readonly sky = [0, 0, 0];

    private shade(v: number): void {
        const bake = this.bake, g = bake.geo, A = g.albedo, N = g.normals, P = g.positions;
        let r = 0, gr = 0, bl = 0;
        const d = this.dir, s = this.sky;
        for (let j = 0; j < bake.rays; j++) {
            if (!bake.escapedRay(v, j)) continue;
            bake.rayDirection(v, j, d);
            skyRadiance(this.env, d[0], d[1], d[2], s);
            r += s[0]; gr += s[1]; bl += s[2];
        }
        const inv = 1 / bake.rays;
        r *= inv; gr *= inv; bl *= inv;
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
        const ox = P[v * 3] + nx * RAY_OFFSET, oy = P[v * 3 + 1] + ny * RAY_OFFSET, oz = P[v * 3 + 2] + nz * RAY_OFFSET;
        this.env.lamps.forEach((lamp, li) => {
            const dirs = this.lampDirs[li];
            if (nx * lamp.dir[0] + ny * lamp.dir[1] + nz * lamp.dir[2] < -Math.sin(lamp.alpha)) return;
            let sum = 0;
            for (let k = 0; k < LAMP_SAMPLES; k++) {
                const dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
                const cos = nx * dx + ny * dy + nz * dz;
                if (cos <= 0) continue;
                if (!bake.bvh.occluded(ox, oy, oz, dx, dy, dz, Infinity)) sum += cos;
            }
            const omega = 2 * Math.PI * (1 - Math.cos(lamp.alpha));
            const w = (omega / LAMP_SAMPLES / Math.PI) * sum;
            r += w * lampRadiance(lamp, 0); gr += w * lampRadiance(lamp, 1); bl += w * lampRadiance(lamp, 2);
        });
        this.direct[v * 3] = r * A[v * 3];
        this.direct[v * 3 + 1] = gr * A[v * 3 + 1];
        this.direct[v * 3 + 2] = bl * A[v * 3 + 2];
    }
}

/** Per-vertex RGB radiance Σ_k L_k T_k from RGB transfer and RGB light coefficients. */
export function prtRadiance(transfer: Float32Array, light: ArrayLike<number>, vertices: number, out: Float32Array): void {
    for (let v = 0; v < vertices; v++) {
        let r = 0, g = 0, b = 0;
        const o = v * RGB_STRIDE;
        for (let k = 0; k < COEFFS; k++) {
            r += transfer[o + k * 3] * light[k * 3];
            g += transfer[o + k * 3 + 1] * light[k * 3 + 1];
            b += transfer[o + k * 3 + 2] * light[k * 3 + 2];
        }
        out[v * 3] = r; out[v * 3 + 1] = g; out[v * 3 + 2] = b;
    }
}

/** RMS of the luminance difference over RMS of the reference luminance. */
export function relativeRms(test: Float32Array, ref: Float32Array): number {
    let num = 0, den = 0;
    for (let i = 0; i < ref.length; i += 3) {
        const a = 0.2126 * test[i] + 0.7152 * test[i + 1] + 0.0722 * test[i + 2];
        const b = 0.2126 * ref[i] + 0.7152 * ref[i + 1] + 0.0722 * ref[i + 2];
        num += (a - b) * (a - b);
        den += b * b;
    }
    return Math.sqrt(num / Math.max(den, 1e-30));
}
