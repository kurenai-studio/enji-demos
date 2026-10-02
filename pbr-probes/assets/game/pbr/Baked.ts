import { type Hit, LIGHT_RADIANCE, QUADS, type V3 } from './Room';
import { SH_COEFFS } from './SH';

/** What tools/bake.mts writes to assets/resources/bake/cornell.json. */
export interface BakeData {
    version: 2;
    bounces: number;
    raysPerPoint: number;
    probeRays: number;
    /**
     * Per quad of `QUADS`, in order, at the (nu+1)·(nv+1) grid corners, row by row along u:
     * `e` indirect irradiance RGB, `d` direct irradiance / LIGHT_RADIANCE (shadowed).
     */
    faces: { name: string; nu: number; nv: number; e: number[]; d: number[] }[];
    /**
     * L2 SH of the indirect light (the light panel's own emission excluded, the
     * runtime adds direct light analytically), 27 floats per probe, x fastest,
     * then y, then z; already convolved: evaluating gives irradiance / π.
     */
    probes: { dims: V3; min: V3; max: V3; sh: number[] };
}

export type BakedFaces = Pick<BakeData, 'faces'>['faces'];

/** Lookups into baked lighting, shared by the baker (between bounces) and the runtime. */
export class Baked {
    readonly indirect: Float32Array[];
    readonly direct: Float32Array[];
    readonly probeSh: Float32Array;
    readonly dims: V3;
    readonly min: V3;
    readonly max: V3;

    constructor(faces: BakedFaces, probes: BakeData['probes']) {
        faces.forEach((f, i) => {
            const q = QUADS[i];
            if (!q || q.name !== f.name || q.nu !== f.nu || q.nv !== f.nv) throw new Error(`bake data does not match the room at face ${i} (${f.name}); run tools/bake.mts`);
        });
        this.indirect = faces.map((f) => Float32Array.from(f.e));
        this.direct = faces.map((f) => Float32Array.from(f.d));
        this.probeSh = Float32Array.from(probes.sh);
        this.dims = probes.dims;
        this.min = probes.min;
        this.max = probes.max;
    }

    /** Bilinear lookup on face `quad` at (a, b) in [0, 1]²: indirect irradiance into `out`, returns the direct factor. */
    sample(quad: number, a: number, b: number, out: V3): number {
        const q = QUADS[quad];
        const e = this.indirect[quad];
        const d = this.direct[quad];
        const fu = Math.min(Math.max(a, 0), 1) * q.nu;
        const fv = Math.min(Math.max(b, 0), 1) * q.nv;
        const i0 = Math.min(q.nu - 1, Math.floor(fu));
        const j0 = Math.min(q.nv - 1, Math.floor(fv));
        const tu = fu - i0, tv = fv - j0;
        const row = q.nu + 1;
        const p00 = j0 * row + i0, p10 = p00 + 1, p01 = p00 + row, p11 = p01 + 1;
        const w00 = (1 - tu) * (1 - tv), w10 = tu * (1 - tv), w01 = (1 - tu) * tv, w11 = tu * tv;
        for (let c = 0; c < 3; c++) out[c] = e[p00 * 3 + c] * w00 + e[p10 * 3 + c] * w10 + e[p01 * 3 + c] * w01 + e[p11 * 3 + c] * w11;
        return d[p00] * w00 + d[p10] * w10 + d[p01] * w01 + d[p11] * w11;
    }

    /** Radiance leaving a hit surface towards the ray origin (no emission): albedo/π · (direct + indirect irradiance). */
    radiance(hit: Hit, out: V3): V3 {
        if (hit.back) {
            out[0] = out[1] = out[2] = 0;
            return out;
        }
        const q = QUADS[hit.quad];
        const d = this.sample(hit.quad, hit.a, hit.b, out);
        for (let c = 0; c < 3; c++) out[c] = (q.albedo[c] * (out[c] + d * LIGHT_RADIANCE[c])) / Math.PI;
        return out;
    }

    /** Trilinear blend of the 8 probes around (x, y, z), clamped to the grid. */
    probeAt(x: number, y: number, z: number, out: Float32Array): Float32Array {
        const [nx, ny] = this.dims;
        const cell = [x, y, z].map((p, axis) => {
            const n = this.dims[axis];
            const f = ((p - this.min[axis]) / (this.max[axis] - this.min[axis])) * (n - 1);
            const c = Math.min(Math.max(f, 0), n - 1);
            const i = Math.min(n - 2, Math.floor(c));
            return { i, t: c - i };
        });
        out.fill(0);
        for (let corner = 0; corner < 8; corner++) {
            const dx = corner & 1, dy = (corner >> 1) & 1, dz = (corner >> 2) & 1;
            const w = (dx ? cell[0].t : 1 - cell[0].t) * (dy ? cell[1].t : 1 - cell[1].t) * (dz ? cell[2].t : 1 - cell[2].t);
            if (w === 0) continue;
            const probe = cell[0].i + dx + nx * (cell[1].i + dy + ny * (cell[2].i + dz));
            const base = probe * SH_COEFFS * 3;
            for (let k = 0; k < SH_COEFFS * 3; k++) out[k] += this.probeSh[base + k] * w;
        }
        return out;
    }

    get probeCount(): number {
        return this.dims[0] * this.dims[1] * this.dims[2];
    }

    /** World position of probe (i, j, k). */
    probePosition(i: number, j: number, k: number): V3 {
        const p = [i, j, k].map((c, axis) => this.min[axis] + ((this.max[axis] - this.min[axis]) * c) / (this.dims[axis] - 1));
        return [p[0], p[1], p[2]];
    }
}
