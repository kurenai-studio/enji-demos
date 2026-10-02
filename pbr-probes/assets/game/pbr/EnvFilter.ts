/**
 * Reflection probe on the CPU, no engine imports: ray-trace the baked room
 * into a cube map around a point, then prefilter it for GGX roughness levels
 * (split-sum, N = V = R) with filtered importance sampling: each sample reads
 * the source mip whose texel matches the sample's solid angle, so 32-64
 * samples per texel give a smooth result.
 *
 * Faces follow the GL layout (+X, -X, +Y, -Y, +Z, -Z, row 0 first), so the
 * shader samples `texture(cube, worldDirection)`.
 */
import type { Baked } from './Baked';
import { castRay, type Hit, type V3 } from './Room';

/** A cube map level: 6 faces of size² RGB floats. */
export interface CubeLevel {
    size: number;
    faces: Float32Array[];
}

export function cubeFaceDirection(face: number, sc: number, tc: number, out: V3): V3 {
    switch (face) {
        case 0: out[0] = 1; out[1] = -tc; out[2] = -sc; break;
        case 1: out[0] = -1; out[1] = -tc; out[2] = sc; break;
        case 2: out[0] = sc; out[1] = 1; out[2] = tc; break;
        case 3: out[0] = sc; out[1] = -1; out[2] = -tc; break;
        case 4: out[0] = sc; out[1] = -tc; out[2] = 1; break;
        default: out[0] = -sc; out[1] = -tc; out[2] = -1; break;
    }
    const l = Math.hypot(out[0], out[1], out[2]);
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
}

/** Radiance of the room seen from `p` (no light emission: the shader adds the light analytically). */
export function captureCube(baked: Baked, p: V3, size: number): CubeLevel {
    const hit: Hit = { quad: -1, t: 0, a: 0, b: 0, back: false };
    const dir: V3 = [0, 0, 0];
    const L: V3 = [0, 0, 0];
    const faces: Float32Array[] = [];
    for (let f = 0; f < 6; f++) {
        const face = new Float32Array(size * size * 3);
        for (let j = 0; j < size; j++) {
            const tc = ((j + 0.5) / size) * 2 - 1;
            for (let i = 0; i < size; i++) {
                const sc = ((i + 0.5) / size) * 2 - 1;
                cubeFaceDirection(f, sc, tc, dir);
                if (!castRay(p[0], p[1], p[2], dir[0], dir[1], dir[2], hit)) continue;
                baked.radiance(hit, L);
                face.set(L, (j * size + i) * 3);
            }
        }
        faces.push(face);
    }
    return { size, faces };
}

/** Box-filtered mip chain down to 1×1 (index 0 is `base`). */
export function mipChain(base: CubeLevel): CubeLevel[] {
    const chain = [base];
    while (chain[chain.length - 1].size > 1) {
        const src = chain[chain.length - 1];
        const size = src.size >> 1;
        const faces = src.faces.map((s) => {
            const d = new Float32Array(size * size * 3);
            for (let j = 0; j < size; j++) {
                for (let i = 0; i < size; i++) {
                    for (let c = 0; c < 3; c++) {
                        const k = (2 * j * src.size + 2 * i) * 3 + c;
                        d[(j * size + i) * 3 + c] = 0.25 * (s[k] + s[k + 3] + s[k + src.size * 3] + s[k + src.size * 3 + 3]);
                    }
                }
            }
            return d;
        });
        chain.push({ size, faces });
    }
    return chain;
}

/** Bilinear lookup in one level along unit direction d (clamped at face edges). */
function sampleLevel(level: CubeLevel, x: number, y: number, z: number, out: V3, weight: number): void {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face: number, sc: number, tc: number, m: number;
    if (ax >= ay && ax >= az) { m = ax; face = x > 0 ? 0 : 1; sc = x > 0 ? -z : z; tc = -y; }
    else if (ay >= az) { m = ay; face = y > 0 ? 2 : 3; sc = x; tc = y > 0 ? z : -z; }
    else { m = az; face = z > 0 ? 4 : 5; sc = z > 0 ? x : -x; tc = -y; }
    const n = level.size;
    const fx = Math.min(Math.max(((sc / m + 1) * 0.5) * n - 0.5, 0), n - 1);
    const fy = Math.min(Math.max(((tc / m + 1) * 0.5) * n - 0.5, 0), n - 1);
    const i0 = Math.min(n - 2, Math.floor(fx)), j0 = Math.min(n - 2, Math.floor(fy));
    const data = level.faces[face];
    if (n === 1) {
        out[0] += data[0] * weight; out[1] += data[1] * weight; out[2] += data[2] * weight;
        return;
    }
    const tx = fx - i0, ty = fy - j0;
    const k00 = (j0 * n + i0) * 3, k10 = k00 + 3, k01 = k00 + n * 3, k11 = k01 + 3;
    const w00 = (1 - tx) * (1 - ty) * weight, w10 = tx * (1 - ty) * weight, w01 = (1 - tx) * ty * weight, w11 = tx * ty * weight;
    for (let c = 0; c < 3; c++) out[c] += data[k00 + c] * w00 + data[k10 + c] * w10 + data[k01 + c] * w01 + data[k11 + c] * w11;
}

function radicalInverse(i: number): number {
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    return bits / 4294967296;
}

/**
 * GGX-prefiltered level for perceptual roughness `roughness` (α = roughness²)
 * at `size`, reading `chain` (a `mipChain`) with `samples` samples per texel.
 */
export function prefilter(chain: CubeLevel[], roughness: number, size: number, samples: number): CubeLevel {
    return { size, faces: [0, 1, 2, 3, 4, 5].map((f) => prefilterFace(chain, roughness, size, samples, f)) };
}

/** One face of `prefilter`, so the work can be spread over frames. */
export function prefilterFace(chain: CubeLevel[], roughness: number, size: number, samples: number, f: number): Float32Array {
    const a = Math.max(roughness * roughness, 1e-3);
    const a2 = a * a;
    const baseSize = chain[0].size;
    const saTexel = (4 * Math.PI) / (6 * baseSize * baseSize);
    // Half vectors in tangent space (z = normal) with their mip level, shared by every texel.
    const hs: { x: number; y: number; z: number; lod: number }[] = [];
    for (let s = 0; s < samples; s++) {
        const u = (s + 0.5) / samples, v = radicalInverse(s);
        const cosT = Math.sqrt((1 - u) / (1 + (a2 - 1) * u));
        const sinT = Math.sqrt(1 - cosT * cosT);
        const phi = 2 * Math.PI * v;
        const d = (cosT * cosT * (a2 - 1) + 1);
        const D = a2 / (Math.PI * d * d);
        // With N = V the pdf of the reflected direction is D / 4.
        const saSample = 1 / (samples * (D / 4) + 1e-6);
        const lod = Math.min(chain.length - 1, Math.max(0, 0.5 * Math.log2(saSample / saTexel) + 1));
        hs.push({ x: sinT * Math.cos(phi), y: sinT * Math.sin(phi), z: cosT, lod });
    }
    const n: V3 = [0, 0, 0];
    const acc: V3 = [0, 0, 0];
    const face = new Float32Array(size * size * 3);
    for (let j = 0; j < size; j++) {
        const tc = ((j + 0.5) / size) * 2 - 1;
        for (let i = 0; i < size; i++) {
            const sc = ((i + 0.5) / size) * 2 - 1;
            cubeFaceDirection(f, sc, tc, n);
            const up: V3 = Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
            let tx = up[1] * n[2] - up[2] * n[1], ty = up[2] * n[0] - up[0] * n[2], tz = up[0] * n[1] - up[1] * n[0];
            const tl = Math.hypot(tx, ty, tz);
            tx /= tl; ty /= tl; tz /= tl;
            const bx = n[1] * tz - n[2] * ty, by = n[2] * tx - n[0] * tz, bz = n[0] * ty - n[1] * tx;
            acc[0] = acc[1] = acc[2] = 0;
            let total = 0;
            for (const h of hs) {
                const hx = tx * h.x + bx * h.y + n[0] * h.z;
                const hy = ty * h.x + by * h.y + n[1] * h.z;
                const hz = tz * h.x + bz * h.y + n[2] * h.z;
                // L = reflect(-V, H) with V = N.
                const vh = n[0] * hx + n[1] * hy + n[2] * hz;
                const lx = 2 * vh * hx - n[0], ly = 2 * vh * hy - n[1], lz = 2 * vh * hz - n[2];
                const nl = n[0] * lx + n[1] * ly + n[2] * lz;
                if (nl <= 0) continue;
                const m0 = Math.floor(h.lod), t = h.lod - m0;
                sampleLevel(chain[m0], lx, ly, lz, acc, nl * (1 - t));
                if (t > 0 && m0 + 1 < chain.length) sampleLevel(chain[m0 + 1], lx, ly, lz, acc, nl * t);
                total += nl;
            }
            const k = (j * size + i) * 3;
            face[k] = acc[0] / total;
            face[k + 1] = acc[1] / total;
            face[k + 2] = acc[2] / total;
        }
    }
    return face;
}

/** RGBM range: decoded colour = rgb · a · RGBM_RANGE. */
export const RGBM_RANGE = 16;

/** RGB floats → RGBA8 RGBM, one face. */
export function encodeRgbm(rgb: Float32Array): Uint8Array {
    const count = rgb.length / 3;
    const out = new Uint8Array(count * 4);
    for (let p = 0; p < count; p++) {
        const r = rgb[p * 3] / RGBM_RANGE, g = rgb[p * 3 + 1] / RGBM_RANGE, b = rgb[p * 3 + 2] / RGBM_RANGE;
        const m = Math.min(1, Math.max(r, g, b, 1e-6));
        const a = Math.max(1, Math.ceil(m * 255));
        const scale = 255 / (a / 255);
        out[p * 4] = Math.min(255, Math.round(r * scale));
        out[p * 4 + 1] = Math.min(255, Math.round(g * scale));
        out[p * 4 + 2] = Math.min(255, Math.round(b * scale));
        out[p * 4 + 3] = a;
    }
    return out;
}
