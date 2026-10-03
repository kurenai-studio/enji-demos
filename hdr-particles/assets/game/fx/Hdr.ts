/**
 * How HDR light is stored in 8-bit render targets, tone mapped and bloomed.
 * hp-common.chunk and hp-bloom.effect are the same maths in GLSL.
 *
 * Three targets per frame, all RGBA8:
 * - stage: the opaque scene (sky, ground, lamps). Nothing blends into it, so
 *   it can use any invertible curve: x = c / (1 + c) maps [0, ∞) to [0, 1),
 *   then a 1/2.2 power spends the bytes on the darks.
 * - particle low: the additive particles × 1, clamped at 1 by the target.
 * - particle high: the same particles × 1/16.
 * Additive blending needs linear storage, so the particles go to two linear
 * ranges: below 1 the low target is exact to 1/255, above it the high one
 * takes over with steps of 16/255 (6% at 1, 0.4% at 16).
 */

export const HIGH_SCALE = 16;

/** How the targets are used. DUAL is the demo's method; the others are for comparison. */
export const DUAL = 0;
/** Everything clamped at 1: the stage stored linearly, particles from the low target only. */
export const LDR = 1;
/** One linear range: the stage and the particles stored as c / 16. */
export const SINGLE = 2;
export const HDR_NAMES = ['Two ranges', 'LDR (clamp)', 'One range /16'];

export const ACES = 0;
export const REINHARD = 1;
export const CLAMP = 2;
export const TONE_NAMES = ['ACES', 'Reinhard', 'No tone map'];

export function encodeStage(c: number, mode: number): number {
    if (mode === DUAL) return Math.pow(c / (1 + c), 1 / 2.2);
    if (mode === LDR) return c;
    return c / HIGH_SCALE;
}

export function decodeStage(e: number, mode: number): number {
    if (mode === DUAL) {
        const x = Math.min(Math.pow(e, 2.2), 0.996);
        return x / (1 - x);
    }
    if (mode === LDR) return e;
    return e * HIGH_SCALE;
}

/** Particle light from the two additive targets (each already in 0..1). */
export function decodeParticles(low: number, high: number, mode: number): number {
    if (mode === LDR) return low;
    if (mode === SINGLE) return high * HIGH_SCALE;
    return low < 0.996 ? low : Math.max(low, high * HIGH_SCALE);
}

/**
 * Bloom levels store √(c / (1 + c)): no blending happens into them, and their
 * faint tails are what matter. Without the square root the first step above
 * black is 1/255 in linear light, which the display gamma turns into a visible
 * edge round every halo (blocky on the coarse levels).
 */
export function bloomEncode(c: number): number {
    return Math.sqrt(c / (1 + c));
}

export function bloomDecode(e: number): number {
    const x = Math.min(e, 0.998) ** 2;
    return x / (1 - x);
}

/** The same without the square root, for comparison in the tests. */
export function bloomEncodeLinear(c: number): number {
    return c / (1 + c);
}

export function bloomDecodeLinear(e: number): number {
    const x = Math.min(e, 0.996);
    return x / (1 - x);
}

/** Stephen Hill's ACES fit (RRT + ODT), with three.js's 1/0.6 exposure scale. */
export function acesHill(rgb: readonly number[], out: number[]): number[] {
    const r = rgb[0] / 0.6, g = rgb[1] / 0.6, b = rgb[2] / 0.6;
    const ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
    const ig = 0.076 * r + 0.90834 * g + 0.01566 * b;
    const ib = 0.0284 * r + 0.13383 * g + 0.83777 * b;
    const f = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    const fr = f(ir), fg = f(ig), fb = f(ib);
    out[0] = clamp01(1.60475 * fr - 0.53108 * fg - 0.07367 * fb);
    out[1] = clamp01(-0.10208 * fr + 1.10813 * fg - 0.00605 * fb);
    out[2] = clamp01(-0.00327 * fr - 0.07276 * fg + 1.07602 * fb);
    return out;
}

export function toneMap(rgb: readonly number[], mode: number, out: number[]): number[] {
    if (mode === ACES) return acesHill(rgb, out);
    for (let i = 0; i < 3; i++) out[i] = mode === REINHARD ? rgb[i] / (1 + rgb[i]) : clamp01(rgb[i]);
    return out;
}

/** Display encoding, as the composite pass does it (the pipeline writes shader output to the screen as is). */
export function toDisplay(x: number): number {
    return Math.pow(clamp01(x), 1 / 2.2);
}

export function clamp01(x: number): number {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** An RGB image in floats, row-major. */
export interface Image {
    w: number;
    h: number;
    data: Float32Array;
}

export function newImage(w: number, h: number): Image {
    return { w, h, data: new Float32Array(w * h * 3) };
}

/** Bilinear sample of channel c at uv, clamped to the edge, of `map` applied to each texel. */
function bilinear(img: Image, u: number, v: number, c: number, map: (e: number) => number): number {
    const x = u * img.w - 0.5, y = v * img.h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const at = (i: number, j: number): number => {
        const xi = Math.min(Math.max(i, 0), img.w - 1), yj = Math.min(Math.max(j, 0), img.h - 1);
        return map(img.data[(yj * img.w + xi) * 3 + c]);
    };
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

export interface BloomStore {
    /** 8-bit storage with this encoding and dither; null keeps floats (the reference). */
    encode: ((c: number) => number) | null;
    decode: ((e: number) => number) | null;
    rand: () => number;
    /**
     * Filter the stored values and decode after, as hardware bilinear on an
     * encoded LINEAR texture would. The shaders decode texels first instead.
     */
    filterEncoded?: boolean;
}

const identity = (e: number): number => e;

function sample(img: Image, u: number, v: number, c: number, s: BloomStore): number {
    if (!s.decode) return bilinear(img, u, v, c, identity);
    return s.filterEncoded ? s.decode(bilinear(img, u, v, c, identity)) : bilinear(img, u, v, c, s.decode);
}

function store(img: Image, s: BloomStore): Image {
    if (!s.encode || !s.decode) return img;
    const out = newImage(img.w, img.h);
    for (let i = 0; i < img.data.length; i++) {
        const e = Math.round((s.encode(img.data[i]) + (s.rand() - 0.5) / 255) * 255);
        out.data[i] = Math.min(Math.max(e, 0), 255) / 255;
    }
    return out;
}

function decoded(e: number, s: BloomStore): number {
    return s.decode ? s.decode(e) : e;
}

const DOWN13: readonly [number, number, number][] = [
    [0, 0, 0.125], [-2, 2, 0.03125], [2, 2, 0.03125], [-2, -2, 0.03125], [2, -2, 0.03125],
    [0, 2, 0.0625], [-2, 0, 0.0625], [2, 0, 0.0625], [0, -2, 0.0625],
    [-1, 1, 0.125], [1, 1, 0.125], [-1, -1, 0.125], [1, -1, 0.125],
];
const TENT: readonly [number, number, number][] = [
    [-1, -1, 1], [0, -1, 2], [1, -1, 1], [-1, 0, 2], [0, 0, 4], [1, 0, 2], [-1, 1, 1], [0, 1, 2], [1, 1, 1],
];

/** Soft-knee threshold on the brightest channel (as in Unity's bloom). */
export function threshold(r: number, g: number, b: number, t: number, knee: number): number {
    const br = Math.max(r, g, b);
    let rq = Math.min(Math.max(br - t + knee, 0), 2 * knee);
    rq = (rq * rq) / (4 * knee + 1e-5);
    return Math.max(rq, br - t) / Math.max(br, 1e-4);
}

/**
 * The bloom chain of hp-bloom.effect on the CPU: 2×2 box + threshold to half
 * resolution, 13-tap downsamples (Jimenez 2014), 3×3 tent upsamples adding
 * each level. Each level is stored with `s` and decoded per texel before the
 * taps interpolate, as the shaders do. Returns the top upsampled level.
 */
export function bloomChain(src: Image, levels: number, t: number, knee: number, s: BloomStore): Image {
    const mips: Image[] = [];
    let w = Math.ceil(src.w / 2), h = Math.ceil(src.h / 2);
    const m0 = newImage(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const rgb = [0, 0, 0];
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    const sx = Math.min(x * 2 + dx, src.w - 1), sy = Math.min(y * 2 + dy, src.h - 1);
                    sum += src.data[(sy * src.w + sx) * 3 + c];
                }
                rgb[c] = sum / 4;
            }
            const k = threshold(rgb[0], rgb[1], rgb[2], t, knee);
            for (let c = 0; c < 3; c++) m0.data[(y * w + x) * 3 + c] = rgb[c] * k;
        }
    }
    mips.push(store(m0, s));
    for (let l = 1; l < levels; l++) {
        const prev = mips[l - 1];
        w = Math.max(1, Math.ceil(prev.w / 2));
        h = Math.max(1, Math.ceil(prev.h / 2));
        const m = newImage(w, h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const u = (x + 0.5) / w, v = (y + 0.5) / h;
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    for (const [dx, dy, wt] of DOWN13) sum += sample(prev, u + dx / prev.w, v + dy / prev.h, c, s) * wt;
                    m.data[(y * w + x) * 3 + c] = sum;
                }
            }
        }
        mips.push(store(m, s));
    }
    let up = mips[levels - 1];
    for (let l = levels - 2; l >= 0; l--) {
        const base = mips[l];
        const out = newImage(base.w, base.h);
        for (let y = 0; y < base.h; y++) {
            for (let x = 0; x < base.w; x++) {
                const u = (x + 0.5) / base.w, v = (y + 0.5) / base.h;
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    for (const [dx, dy, wt] of TENT) sum += sample(up, u + dx / up.w, v + dy / up.h, c, s) * wt;
                    out.data[(y * base.w + x) * 3 + c] = sum / 16 + decoded(base.data[(y * base.w + x) * 3 + c], s);
                }
            }
        }
        up = store(out, s);
    }
    if (s.decode) for (let i = 0; i < up.data.length; i++) up.data[i] = s.decode(up.data[i]);
    return up;
}
