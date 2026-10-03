/**
 * Precomputed radiance transfer for diffuse surfaces (Sloan, Kautz & Snyder 2002),
 * per vertex, 25 coefficients. A vertex of albedo ρ under distant light L(ω)
 * leaves radiance B = Σ_i L_i T_i, with
 *
 *   unshadowed      T_i = ρ/π ∫ Y_i(ω) max(n·ω, 0) dω  = ρ Â_l Y_i(n) / π
 *   shadowed        T_i = ρ/π ∫ Y_i(ω) V(ω) max(n·ω, 0) dω ≈ ρ/M Σ_j V_j Y_i(ω_j)
 *   interreflected  T = T⁰ + T¹ + …,  Tᵇ(p) = ρ_p/M Σ_{blocked j} Tᵇ⁻¹(hit point of ray j)
 *
 * using M cosine-distributed rays per vertex (pdf cos θ / π). The hit points'
 * transfer is interpolated from the hit triangle's vertices, so each bounce is
 * one sparse matrix product: row p of W holds Σ of barycentric weights of p's
 * rays on each vertex q, and Tᵇ(p) = ρ_p/M Σ_q W_pq Tᵇ⁻¹(q). Rays that meet a
 * back face (inside a solid) bring nothing.
 *
 * The bake is time-sliced (`step`): first the rays, vertex by vertex, then the
 * bounces. It also keeps which rays escaped, so a reference for any light can
 * reuse the same rays (see Reference.ts).
 */
import { Bvh } from './Bvh';
import type { SceneGeo } from './Scenes';
import { basis, BAND_OF, COEFFS, COSINE_LOBE, cosineDirections, tangentFrame } from './SH';

/** RGB transfer: coefficient k of channel c at [v · RGB_STRIDE + k · 3 + c]. */
export const RGB_STRIDE = COEFFS * 3;
/** Ray origins sit this far off the surface along the normal. */
export const RAY_OFFSET = 1.5e-3;
/** W_pq / M = weight / WEIGHT_ONE. */
const WEIGHT_ONE = 65535;
const GOLDEN = (Math.sqrt(5) - 1) / 2;

export type BakePhase = 'rays' | 'bounces' | 'done';

export class Bake {
    readonly geo: SceneGeo;
    readonly bvh: Bvh;
    readonly rays: number;
    readonly bounceCount: number;
    readonly directions: Float64Array;
    /** Scalar transfer without albedo, per vertex: Â_l Y_i(n) / π. */
    readonly unshadowed: Float32Array;
    /** Scalar transfer without albedo: (1/M) Σ_j V_j Y_i(ω_j). Unbaked vertices hold `unshadowed`. */
    readonly shadowed: Float32Array;
    /** RGB transfer, shadowed plus every bounce done so far. */
    readonly interreflected: Float32Array;
    /** One bit per ray: set when it escaped to the sky. */
    readonly escaped: Uint32Array;
    readonly maskWords: number;
    /** 1 where most of the vertex's rays met back faces. */
    readonly buried: Uint8Array;
    private dilationTargets = new Uint32Array(0);
    private dilationStart = new Uint32Array(1);
    private dilationSources = new Uint32Array(0);
    /**
     * CSR rows of W. Scenes stay under 65536 vertices; a row's weights sum to at
     * most M, so W_pq / M is stored as a 16-bit fraction of 65535.
     */
    rowStart: Uint32Array;
    columns: Uint16Array = new Uint16Array(0);
    weights: Uint16Array = new Uint16Array(0);
    nonZeros = 0;

    phase: BakePhase = 'rays';
    /** Vertices whose rays are traced. */
    tracedVertices = 0;
    bouncesDone = 0;
    raysTraced = 0;
    rayMs = 0;
    bounceMs = 0;

    private prevBounce: Float32Array;
    private nextBounce: Float32Array;
    private bounceVertex = 0;
    private readonly gather: Float64Array;
    private readonly touched: Uint32Array;
    private touchedCount = 0;

    constructor(geo: SceneGeo, rays: number, bounces: number) {
        this.geo = geo;
        this.rays = rays;
        this.bounceCount = bounces;
        this.bvh = new Bvh(geo.positions, geo.indices);
        this.directions = cosineDirections(rays);
        const nv = geo.vertexCount;
        this.unshadowed = new Float32Array(nv * COEFFS);
        const y = new Float64Array(COEFFS);
        const n = geo.normals;
        for (let v = 0; v < nv; v++) {
            basis(n[v * 3], n[v * 3 + 1], n[v * 3 + 2], y);
            for (let k = 0; k < COEFFS; k++) this.unshadowed[v * COEFFS + k] = (COSINE_LOBE[BAND_OF[k]] * y[k]) / Math.PI;
        }
        this.shadowed = Float32Array.from(this.unshadowed);
        this.interreflected = new Float32Array(nv * RGB_STRIDE);
        this.maskWords = Math.ceil(rays / 32);
        this.escaped = new Uint32Array(nv * this.maskWords);
        this.buried = new Uint8Array(nv);
        this.rowStart = new Uint32Array(nv + 1);
        this.prevBounce = new Float32Array(nv * RGB_STRIDE);
        this.nextBounce = new Float32Array(nv * RGB_STRIDE);
        this.gather = new Float64Array(nv);
        this.touched = new Uint32Array(nv);
        this.columns = new Uint16Array(Math.max(1024, nv * 16));
        this.weights = new Uint16Array(this.columns.length);
    }

    get vertexCount(): number { return this.geo.vertexCount; }

    /** 0 → 1 over rays then bounces (rays weigh 80 %). */
    get progress(): number {
        if (this.phase === 'done') return 1;
        const nv = this.vertexCount;
        if (this.phase === 'rays') return (0.8 * this.tracedVertices) / nv;
        return 0.8 + (0.2 * (this.bouncesDone + this.bounceVertex / nv)) / Math.max(1, this.bounceCount);
    }

    /** Works for about `budgetMs`; true once everything is baked. */
    step(budgetMs: number, now: () => number = () => performance.now()): boolean {
        const t0 = now();
        while (this.phase !== 'done' && now() - t0 < budgetMs) {
            const t1 = now();
            if (this.phase === 'rays') {
                const end = Math.min(this.vertexCount, this.tracedVertices + 16);
                for (let v = this.tracedVertices; v < end; v++) this.traceVertex(v);
                this.tracedVertices = end;
                if (end === this.vertexCount) this.finishRays();
                this.rayMs += now() - t1;
            } else {
                const end = Math.min(this.vertexCount, this.bounceVertex + 256);
                for (let v = this.bounceVertex; v < end; v++) this.bounceRow(v);
                this.bounceVertex = end;
                if (end === this.vertexCount) this.finishBounce();
                this.bounceMs += now() - t1;
            }
        }
        return this.phase === 'done';
    }

    /** Runs the whole bake at once (tests, tools). */
    run(): this {
        while (!this.step(1e9));
        return this;
    }

    private readonly t = [0, 0, 0];
    private readonly b = [0, 0, 0];
    private readonly y = new Float64Array(COEFFS);
    private readonly acc = new Float64Array(COEFFS);

    private traceVertex(v: number): void {
        const g = this.geo, P = g.positions, N = g.normals, I = g.indices, bvh = this.bvh, D = this.directions;
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
        const ox = P[v * 3] + nx * RAY_OFFSET, oy = P[v * 3 + 1] + ny * RAY_OFFSET, oz = P[v * 3 + 2] + nz * RAY_OFFSET;
        const t = this.t, b = this.b, y = this.y, acc = this.acc;
        this.frame(v, t, b);
        acc.fill(0);
        const mask = v * this.maskWords;
        let back = 0;
        for (let j = 0; j < this.rays; j++) {
            const lx = D[j * 3], ly = D[j * 3 + 1], lz = D[j * 3 + 2];
            const dx = t[0] * lx + b[0] * ly + nx * lz, dy = t[1] * lx + b[1] * ly + ny * lz, dz = t[2] * lx + b[2] * ly + nz * lz;
            const tri = bvh.intersect(ox, oy, oz, dx, dy, dz, Infinity);
            if (tri < 0) {
                this.escaped[mask + (j >> 5)] |= 1 << (j & 31);
                basis(dx, dy, dz, y);
                for (let k = 0; k < COEFFS; k++) acc[k] += y[k];
            } else if (bvh.hitFront) {
                const u = bvh.hitU, w = bvh.hitV;
                this.addWeight(I[tri * 3], 1 - u - w);
                this.addWeight(I[tri * 3 + 1], u);
                this.addWeight(I[tri * 3 + 2], w);
            } else {
                back++;
            }
        }
        if (back * 2 > this.rays) this.buried[v] = 1;
        this.raysTraced += this.rays;
        const inv = 1 / this.rays;
        for (let k = 0; k < COEFFS; k++) this.shadowed[v * COEFFS + k] = acc[k] * inv;
        this.emitRow(v);
    }

    private addWeight(q: number, w: number): void {
        if (w <= 0) return;
        if (this.gather[q] === 0) this.touched[this.touchedCount++] = q;
        this.gather[q] += w;
    }

    private emitRow(v: number): void {
        const need = this.nonZeros + this.touchedCount;
        if (need > this.columns.length) {
            const size = Math.max(need, Math.ceil(this.columns.length * 1.6));
            const c = new Uint16Array(size), w = new Uint16Array(size);
            c.set(this.columns.subarray(0, this.nonZeros));
            w.set(this.weights.subarray(0, this.nonZeros));
            this.columns = c;
            this.weights = w;
        }
        const scale = WEIGHT_ONE / this.rays;
        for (let i = 0; i < this.touchedCount; i++) {
            const q = this.touched[i];
            const w = Math.round(this.gather[q] * scale);
            this.gather[q] = 0;
            if (w === 0) continue;
            this.columns[this.nonZeros] = q;
            this.weights[this.nonZeros] = w;
            this.nonZeros++;
        }
        this.touchedCount = 0;
        this.rowStart[v + 1] = this.nonZeros;
    }

    private finishRays(): void {
        this.columns = this.columns.slice(0, this.nonZeros);
        this.weights = this.weights.slice(0, this.nonZeros);
        this.planDilation();
        this.dilate(this.shadowed, COEFFS);
        // Bounce 0: shadowed transfer times albedo.
        const nv = this.vertexCount, A = this.geo.albedo;
        for (let v = 0; v < nv; v++) for (let k = 0; k < COEFFS; k++) {
            const s = this.shadowed[v * COEFFS + k];
            for (let c = 0; c < 3; c++) this.prevBounce[v * RGB_STRIDE + k * 3 + c] = s * A[v * 3 + c];
        }
        this.interreflected.set(this.prevBounce);
        this.phase = 'bounces';
        this.bounceVertex = 0;
        if (this.bounceCount === 0) this.finish();
    }

    private bounceRow(v: number): void {
        const prev = this.prevBounce, out = this.nextBounce, C = this.columns, W = this.weights;
        const o = v * RGB_STRIDE;
        for (let k = 0; k < RGB_STRIDE; k++) out[o + k] = 0;
        for (let e = this.rowStart[v]; e < this.rowStart[v + 1]; e++) {
            const q = C[e] * RGB_STRIDE, w = W[e];
            for (let k = 0; k < RGB_STRIDE; k++) out[o + k] += w * prev[q + k];
        }
        const A = this.geo.albedo;
        for (let c = 0; c < 3; c++) {
            const s = A[v * 3 + c] / WEIGHT_ONE;
            for (let k = c; k < RGB_STRIDE; k += 3) out[o + k] *= s;
        }
    }

    private finishBounce(): void {
        const next = this.nextBounce;
        this.dilate(next, RGB_STRIDE);
        for (let i = 0; i < next.length; i++) this.interreflected[i] += next[i];
        this.nextBounce = this.prevBounce;
        this.prevBounce = next;
        this.bouncesDone++;
        this.bounceVertex = 0;
        if (this.bouncesDone >= this.bounceCount) this.finish();
    }

    private finish(): void {
        this.phase = 'done';
        this.prevBounce = new Float32Array(0);
        this.nextBounce = new Float32Array(0);
    }

    /**
     * Tangent frame of vertex v, turned about the normal by a golden-ratio
     * angle per vertex: neighbours with equal normals would otherwise share
     * one ray pattern, and its error shows as streaks instead of fine noise.
     */
    frame(v: number, t: number[], b: number[]): void {
        const N = this.geo.normals;
        tangentFrame(N[v * 3], N[v * 3 + 1], N[v * 3 + 2], t, b);
        const a = 2 * Math.PI * ((v * GOLDEN) % 1), c = Math.cos(a), s = Math.sin(a);
        for (let k = 0; k < 3; k++) {
            const tk = t[k], bk = b[k];
            t[k] = c * tk + s * bk;
            b[k] = c * bk - s * tk;
        }
    }

    /**
     * Fill order for buried vertices (inside another solid, e.g. ground under
     * a plinth: most of their rays meet back faces). Their own transfer is
     * dark and would smear across every triangle straddling the solid's edge,
     * so each takes the mean of its unburied (or already filled) neighbours,
     * ring by ring, as lightmap texels are dilated.
     */
    private planDilation(): void {
        const nv = this.vertexCount, I = this.geo.indices;
        const degree = new Uint32Array(nv + 1);
        for (let i = 0; i < I.length; i++) degree[I[i] + 1] += 2;
        for (let v = 0; v < nv; v++) degree[v + 1] += degree[v];
        const fill = degree.slice(0, nv), adj = new Uint32Array(degree[nv]);
        for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
            const a = I[t + e], b = I[t + ((e + 1) % 3)];
            adj[fill[a]++] = b;
            adj[fill[b]++] = a;
        }
        const ok = new Uint8Array(nv);
        for (let v = 0; v < nv; v++) ok[v] = this.buried[v] ? 0 : 1;
        const targets: number[] = [], starts: number[] = [0], sources: number[] = [];
        for (;;) {
            const ring: number[] = [];
            for (let v = 0; v < nv; v++) {
                if (ok[v]) continue;
                const first = sources.length;
                for (let k = degree[v]; k < degree[v + 1]; k++) if (ok[adj[k]] && !sources.slice(first).includes(adj[k])) sources.push(adj[k]);
                if (sources.length === first) continue;
                targets.push(v);
                starts.push(sources.length);
                ring.push(v);
            }
            if (ring.length === 0) break;
            for (const v of ring) ok[v] = 1;
        }
        this.dilationTargets = Uint32Array.from(targets);
        this.dilationStart = Uint32Array.from(starts);
        this.dilationSources = Uint32Array.from(sources);
    }

    /** Applies the dilation plan to per-vertex data of `stride` floats. */
    dilate(data: Float32Array, stride: number): void {
        const T = this.dilationTargets, S = this.dilationStart, src = this.dilationSources;
        for (let i = 0; i < T.length; i++) {
            const o = T[i] * stride, n = S[i + 1] - S[i];
            for (let k = 0; k < stride; k++) {
                let sum = 0;
                for (let e = S[i]; e < S[i + 1]; e++) sum += data[src[e] * stride + k];
                data[o + k] = sum / n;
            }
        }
    }

    get buriedCount(): number {
        let n = 0;
        for (let v = 0; v < this.vertexCount; v++) n += this.buried[v];
        return n;
    }

    /** Whether ray j of vertex v escaped. */
    escapedRay(v: number, j: number): boolean {
        return (this.escaped[v * this.maskWords + (j >> 5)] & (1 << (j & 31))) !== 0;
    }

    /** World direction of ray j of vertex v. */
    rayDirection(v: number, j: number, out: number[]): void {
        const N = this.geo.normals, D = this.directions;
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
        const t = this.t, b = this.b;
        this.frame(v, t, b);
        const lx = D[j * 3], ly = D[j * 3 + 1], lz = D[j * 3 + 2];
        out[0] = t[0] * lx + b[0] * ly + nx * lz;
        out[1] = t[1] * lx + b[1] * ly + ny * lz;
        out[2] = t[2] * lx + b[2] * ly + nz * lz;
    }

    /** One bounce of RGB radiance through W: out(p) = ρ_p/M Σ_q W_pq src(q). */
    bounceRadiance(src: Float32Array, out: Float32Array): void {
        const A = this.geo.albedo, inv = 1 / WEIGHT_ONE, C = this.columns, W = this.weights;
        for (let v = 0; v < this.vertexCount; v++) {
            let r = 0, g = 0, b = 0;
            for (let e = this.rowStart[v]; e < this.rowStart[v + 1]; e++) {
                const q = C[e] * 3, w = W[e];
                r += w * src[q]; g += w * src[q + 1]; b += w * src[q + 2];
            }
            out[v * 3] = r * A[v * 3] * inv;
            out[v * 3 + 1] = g * A[v * 3 + 1] * inv;
            out[v * 3 + 2] = b * A[v * 3 + 2] * inv;
        }
    }

    /** RGB transfer for a mode: 0 unshadowed, 1 shadowed, 2 interreflected. */
    transfer(mode: number, out: Float32Array): void {
        if (mode === 2 && this.phase !== 'rays') { out.set(this.interreflected); return; }
        const src = mode === 0 ? this.unshadowed : this.shadowed, A = this.geo.albedo;
        for (let v = 0; v < this.vertexCount; v++) for (let k = 0; k < COEFFS; k++) {
            const s = src[v * COEFFS + k], o = v * RGB_STRIDE + k * 3;
            out[o] = s * A[v * 3]; out[o + 1] = s * A[v * 3 + 1]; out[o + 2] = s * A[v * 3 + 2];
        }
    }

    /** Bytes held by the bake's arrays. */
    get bytes(): number {
        return this.unshadowed.byteLength + this.shadowed.byteLength + this.interreflected.byteLength + this.escaped.byteLength
            + this.rowStart.byteLength + this.columns.byteLength + this.weights.byteLength
            + this.prevBounce.byteLength + this.nextBounce.byteLength + this.gather.byteLength + this.touched.byteLength;
    }
}
