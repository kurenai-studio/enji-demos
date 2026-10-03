/**
 * The SSAO estimator in plain TypeScript, line for line what ssao-ao.effect
 * does, so tools/test.mts can run it on analytic depth buffers. Keep the two in
 * sync: the shader is the one that ships.
 */

/** Golden angle in radians: consecutive samples spiral round the hemisphere. */
export const GOLDEN_ANGLE = 2.399963;
/** Conjugate golden ratio, decorrelates sample length from direction. */
const LENGTH_STEP = 0.618034;
/** Samples are never shorter than this fraction of the radius. */
const MIN_LENGTH = 0.1;

/**
 * Sample i of `count` in the unit hemisphere around +z: cosine-weighted
 * directions on a golden-angle spiral, lengths biased towards the centre
 * (0.1 to 1, squared) so near occluders count more. Writes x, y, z.
 */
export function kernelSample(i: number, count: number, out: Float64Array | number[]): void {
    const u = (i + 0.5) / count;
    const phi = i * GOLDEN_ANGLE;
    const r = Math.sqrt(u);
    const t = fract((i + 0.5) * LENGTH_STEP);
    const s = MIN_LENGTH + (1 - MIN_LENGTH) * t * t;
    out[0] = r * Math.cos(phi) * s;
    out[1] = r * Math.sin(phi) * s;
    out[2] = Math.sqrt(1 - u) * s;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 4×4 ordered-dither rank of a pixel in [0, 1): neighbours get far-apart kernel rotations, and a 4×4 blur averages all 16. */
export function bayer4(x: number, y: number): number {
    return (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
}

/** Linear depth in [0, 1) as two 8-bit channels (what the G-buffer render texture stores). */
export function packDepth(d: number): [number, number] {
    const hi = Math.floor(d * 255) / 255;
    const lo = (d - hi) * 255;
    return [hi, Math.round(lo * 255) / 255];
}

export function unpackDepth(hi: number, lo: number): number {
    return hi + lo / 255;
}

/**
 * World-space unit normal as two bytes (0..254), octahedral: the normal is
 * projected onto |x| + |y| + |z| = 1 and the lower half folded over the
 * corners. Byte 127 is exactly 0 and 0 / 254 exactly ∓1, so floors and walls
 * are stored without error; view-space xy (the obvious encoding) tilts a
 * floor by up to a degree, which moves its reflections by several texels.
 */
export function encodeNormal(x: number, y: number, z: number): [number, number] {
    const s = Math.abs(x) + Math.abs(y) + Math.abs(z);
    let px = x / s, py = y / s;
    if (z < 0) {
        const fx = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
        py = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1);
        px = fx;
    }
    return [Math.round(px * 127) + 127, Math.round(py * 127) + 127];
}

/** Inverse of encodeNormal; writes a unit vector. */
export function decodeNormal(a: number, b: number, out: Float64Array | number[]): void {
    let x = (a - 127) / 127, y = (b - 127) / 127;
    const z = 1 - Math.abs(x) - Math.abs(y);
    const t = Math.max(-z, 0);
    x += x >= 0 ? -t : t;
    y += y >= 0 ? -t : t;
    const l = Math.hypot(x, y, z);
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
}

export interface AoSettings {
    /** World-space radius of the hemisphere, metres. */
    radius: number;
    /** Sample must be this far behind the stored surface to count, metres. */
    bias: number;
    samples: number;
    /** Exponent on the result. */
    intensity: number;
    /** Texels of surface depth span added to the bias (0.5: a sample is at most half a texel from the texel centre). */
    slopeScale: number;
}

/**
 * A G-buffer as the shader sees it: per texel, view depth (positive, metres,
 * already quantised) and view-space normal (decoded from the stored world
 * normal and rotated by the view matrix). Depth ≥ far marks the sky.
 */
export interface GBuffer {
    width: number;
    height: number;
    depth: Float64Array;
    nx: Float64Array;
    ny: Float64Array;
    nz: Float64Array;
    /** tan of half the horizontal and vertical field of view. */
    tanX: number;
    tanY: number;
    far: number;
}

const h = [0, 0, 0];

/** Ambient visibility of texel (x, y): 1 open, 0 fully occluded. */
export function ambientOcclusion(g: GBuffer, x: number, y: number, s: AoSettings): number {
    const k = y * g.width + x;
    const d = g.depth[k];
    if (d >= g.far * 0.999) return 1;
    const u = (x + 0.5) / g.width;
    const v = (y + 0.5) / g.height;
    const px = (u * 2 - 1) * g.tanX * d;
    const py = (v * 2 - 1) * g.tanY * d;
    const pz = -d;
    const nx = g.nx[k];
    const ny = g.ny[k];
    const nz = g.nz[k];
    const bias = slopeBias(s.bias, px, py, pz, nx, ny, nz, (s.slopeScale * 2 * g.tanY) / g.height);

    // Tangent frame rotated per pixel by the dither rank.
    const a = bayer4(x, y) * Math.PI * 2;
    let rx = Math.cos(a);
    let ry = Math.sin(a);
    let rz = 0;
    let dot = rx * nx + ry * ny + rz * nz;
    let tx = rx - nx * dot;
    let ty = ry - ny * dot;
    let tz = rz - nz * dot;
    let len = Math.hypot(tx, ty, tz);
    if (len < 1e-3) {
        rx = 0; ry = 0; rz = 1;
        dot = nz;
        tx = rx - nx * dot; ty = ry - ny * dot; tz = rz - nz * dot;
        len = Math.hypot(tx, ty, tz);
    }
    tx /= len; ty /= len; tz /= len;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    let occlusion = 0;
    for (let i = 0; i < s.samples; i++) {
        kernelSample(i, s.samples, h);
        const sx = px + (tx * h[0] + bx * h[1] + nx * h[2]) * s.radius;
        const sy = py + (ty * h[0] + by * h[1] + ny * h[2]) * s.radius;
        const sz = pz + (tz * h[0] + bz * h[1] + nz * h[2]) * s.radius;
        const su = (sx / -sz / g.tanX) * 0.5 + 0.5;
        const sv = (sy / -sz / g.tanY) * 0.5 + 0.5;
        if (su < 0 || su > 1 || sv < 0 || sv > 1) continue;
        // Nearest texel, as the G-buffer is sampled with NEAREST filtering.
        const ix = Math.min(g.width - 1, Math.floor(su * g.width));
        const iy = Math.min(g.height - 1, Math.floor(sv * g.height));
        const sceneZ = -g.depth[iy * g.width + ix];
        const range = smoothstep(0, 1, s.radius / Math.abs(pz - sceneZ));
        if (sceneZ >= sz + bias) occlusion += range;
    }
    return Math.pow(1 - occlusion / s.samples, s.intensity);
}

/**
 * Bias plus the depth a surface spans across part of a texel, like a shadow
 * map's slope-scaled bias: depth × texel angle × tan(angle between the normal
 * and the view ray), with the texel angle already times the slope scale. Without it a floor seen at a grazing angle occludes itself,
 * because each texel stores one depth for a long strip of floor.
 */
export function slopeBias(bias: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, texelAngle: number): number {
    const d = Math.hypot(px, py, pz);
    const c = Math.max(-(nx * px + ny * py + nz * pz) / d, 0.05);
    return bias + d * texelAngle * (Math.sqrt(1 - c * c) / c);
}

function fract(x: number): number {
    return x - Math.floor(x);
}

function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
}
