/**
 * The lighting maths of the effects in TypeScript, for the tests: point light
 * falloff, Blinn-Phong, the 8-bit G-buffer and light-buffer encodings, and
 * the final composite. Keep in step with dl-light.effect and dl-lit.effect.
 */

/** Linear depth is stored as a fraction of this distance; keep it at the camera's far plane. */
export const DEPTH_FAR = 60;
/** Light buffer stores diffuse and specular light times this (8 bits cover 0..1 / LIGHT_SCALE). */
export const LIGHT_SCALE = 0.25;
export const GLOSS = 24;
export const EXPOSURE = 1.8;

export type V3 = [number, number, number];

/**
 * Windowed inverse-square falloff (Karis 2013): 1 / (d² + 1), times a window
 * that reaches 0 at the light's radius with zero slope, so a volume of that
 * radius loses nothing.
 */
export function falloff(d: number, radius: number): number {
    const x = d / radius;
    const w = Math.max(0, 1 - x * x * x * x);
    return (w * w) / (d * d + 1);
}

export interface PointLight {
    pos: V3;
    radius: number;
    color: V3;
    intensity: number;
}

/** Diffuse and specular light (both scalars) one light gives a surface point; colour applied by the caller. */
export function lightTerms(p: V3, n: V3, view: V3, light: PointLight): { diffuse: number; spec: number } {
    const lx = light.pos[0] - p[0], ly = light.pos[1] - p[1], lz = light.pos[2] - p[2];
    const d = Math.hypot(lx, ly, lz);
    if (d >= light.radius || d < 1e-6) return { diffuse: 0, spec: 0 };
    const a = falloff(d, light.radius) * light.intensity;
    const l: V3 = [lx / d, ly / d, lz / d];
    const ndl = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
    const hx = l[0] + view[0], hy = l[1] + view[1], hz = l[2] + view[2];
    const hl = Math.hypot(hx, hy, hz) || 1;
    const ndh = Math.max(0, (n[0] * hx + n[1] * hy + n[2] * hz) / hl);
    return { diffuse: a * ndl, spec: a * ndl * Math.pow(ndh, GLOSS) };
}

export function luminance(c: V3): number {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** 8-bit storage: round to the nearest of 256 levels after adding `dither` (in levels, −0.5..0.5). */
export function quantize8(x: number, dither = 0): number {
    return Math.min(255, Math.max(0, Math.round(x * 255 + dither))) / 255;
}

/** Depth over DEPTH_FAR in two 8-bit channels (16 bits). */
export function packDepth(d: number): [number, number] {
    const v = Math.min(Math.max(d / DEPTH_FAR, 0), 0.9999);
    const hi = Math.floor(v * 255) / 255;
    return [hi, quantize8((v - hi) * 255)];
}

export function unpackDepth(hi: number, lo: number): number {
    return (hi + lo / 255) * DEPTH_FAR;
}

/** View-space normal stored as xy * 0.5 + 0.5 in two 8-bit channels; z rebuilt towards the camera. */
export function packNormal(n: V3): [number, number] {
    return [quantize8(n[0] * 0.5 + 0.5), quantize8(n[1] * 0.5 + 0.5)];
}

export function unpackNormal(x: number, y: number): V3 {
    const nx = x * 2 - 1, ny = y * 2 - 1;
    return [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))];
}

/** 4×4 Bayer rank in −0.5..0.5, the same table as bayer4() in dl-light.effect. */
export function bayer(px: number, py: number): number {
    const b2 = (x: number, y: number): number => 2 * x + 3 * y - 4 * x * y;
    const cx = px & 3, cy = py & 3;
    return (4 * b2(cx & 1, cy & 1) + b2(cx >> 1, cy >> 1) + 0.5) / 16 - 0.5;
}

/** Albedo times (ambient + diffuse light) plus specular, then the exposure curve. */
export function composite(albedo: V3, specStrength: number, ambient: number, diffuse: V3, spec: V3): V3 {
    const out: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) out[k] = 1 - Math.exp(-EXPOSURE * (albedo[k] * (ambient + diffuse[k]) + specStrength * spec[k]));
    return out;
}

/**
 * The deferred path's specular colour: the light buffer keeps one specular
 * value per pixel (alpha), so its colour is taken from the diffuse light's
 * hue at that pixel. Exact under one light, an approximation where lights
 * of different colours overlap.
 */
export function specFromBuffer(diffuse: V3, specLum: number): V3 {
    const l = Math.max(luminance(diffuse), 1e-4);
    return [diffuse[0] / l * specLum, diffuse[1] / l * specLum, diffuse[2] / l * specLum];
}
