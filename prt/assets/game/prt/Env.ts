/**
 * Distant lighting: a sky gradient plus up to three round lamps (cones of
 * constant radiance). Each lamp is given by the irradiance E it delivers at
 * normal incidence, so its radiance is E / (π sin²α) and resizing it only
 * changes how soft its shadows are.
 *
 * Projection to SH: the sky numerically once per preset (4096 directions),
 * the lamps in closed form every frame (cap moments rotated to the lamp).
 */
import { addZonal, capMoments, COEFFS, sphereDirections, basis } from './SH';

export type V3 = [number, number, number];

export interface Lamp {
    /** Unit direction towards the lamp. */
    dir: V3;
    /** Cone half-angle (radians). */
    alpha: number;
    /** Irradiance at normal incidence, linear RGB. */
    irradiance: V3;
}

export interface Env {
    name: string;
    zenith: V3;
    horizon: V3;
    /** Radiance from below the horizon (the world beyond the ground disc). */
    below: V3;
    lamps: Lamp[];
}

export const MAX_LAMPS = 3;
/** Lamp size presets, multiplying each preset's half-angles. */
export const LAMP_SIZES = [1, 0.4, 2];

function dirFrom(elevationDeg: number, azimuthDeg: number): V3 {
    const e = (elevationDeg * Math.PI) / 180, a = (azimuthDeg * Math.PI) / 180;
    return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}

export function presets(): Env[] {
    return [
        {
            name: 'Sunny', zenith: [0.16, 0.3, 0.7], horizon: [0.55, 0.65, 0.8], below: [0.12, 0.11, 0.09],
            lamps: [{ dir: dirFrom(50, -55), alpha: 0.3, irradiance: [3.2, 3.0, 2.6] }],
        },
        {
            name: 'Sunset', zenith: [0.1, 0.12, 0.3], horizon: [0.75, 0.42, 0.25], below: [0.08, 0.06, 0.05],
            lamps: [{ dir: dirFrom(14, -80), alpha: 0.25, irradiance: [3.4, 1.7, 0.7] }],
        },
        {
            name: 'Overcast', zenith: [0.95, 0.97, 1.0], horizon: [0.4, 0.42, 0.45], below: [0.1, 0.1, 0.1],
            lamps: [],
        },
        {
            name: 'Studio', zenith: [0.03, 0.03, 0.035], horizon: [0.02, 0.02, 0.025], below: [0.01, 0.01, 0.01],
            lamps: [
                { dir: dirFrom(40, -30), alpha: 0.35, irradiance: [3.0, 2.5, 1.9] },
                { dir: dirFrom(25, 150), alpha: 0.25, irradiance: [0.5, 0.9, 1.8] },
                { dir: dirFrom(70, 140), alpha: 0.6, irradiance: [0.4, 0.4, 0.45] },
            ],
        },
    ];
}

/**
 * Sets `below` to what a ground of this albedo far from the scene reflects:
 * ρ E / π with E the horizontal irradiance, 2π (h/2 + 2(z − h)/5) from the
 * sky gradient h + (z − h)√y plus each lamp's E · max(dir.y, 0).
 */
export function withGroundBounce(env: Env, albedo: readonly number[]): Env {
    const below = [0, 1, 2].map((c) => {
        let e = 2 * Math.PI * (env.horizon[c] / 2 + (0.4 * (env.zenith[c] - env.horizon[c])));
        for (const l of env.lamps) e += l.irradiance[c] * Math.max(0, l.dir[1]);
        return (albedo[c] * e) / Math.PI;
    }) as V3;
    return { ...env, below };
}

/** Sky radiance without lamps. */
export function skyRadiance(env: Env, x: number, y: number, z: number, out: number[]): void {
    void x; void z;
    if (y < 0) { out[0] = env.below[0]; out[1] = env.below[1]; out[2] = env.below[2]; return; }
    const t = Math.sqrt(y);
    for (let c = 0; c < 3; c++) out[c] = env.horizon[c] + (env.zenith[c] - env.horizon[c]) * t;
}

/** Radiance inside a lamp's cone. */
export function lampRadiance(lamp: Lamp, c: number): number {
    const s = Math.sin(lamp.alpha);
    return lamp.irradiance[c] / (Math.PI * s * s);
}

/** Full radiance in direction (x, y, z): sky plus any lamp covering it. */
export function radiance(env: Env, x: number, y: number, z: number, out: number[]): void {
    skyRadiance(env, x, y, z, out);
    for (const lamp of env.lamps) {
        if (x * lamp.dir[0] + y * lamp.dir[1] + z * lamp.dir[2] >= Math.cos(lamp.alpha)) {
            for (let c = 0; c < 3; c++) out[c] += lampRadiance(lamp, c);
        }
    }
}

export const SKY_SAMPLES = 4096;
let skyDirs: Float64Array | null = null;

/** RGB coefficients of the sky part (75 doubles): (4π / N) Σ L(ω) Y(ω). */
export function projectSky(env: Env): Float64Array {
    skyDirs ??= sphereDirections(SKY_SAMPLES);
    const out = new Float64Array(COEFFS * 3);
    const y = new Float64Array(COEFFS);
    const l = [0, 0, 0];
    for (let i = 0; i < SKY_SAMPLES; i++) {
        const dx = skyDirs[i * 3], dy = skyDirs[i * 3 + 1], dz = skyDirs[i * 3 + 2];
        skyRadiance(env, dx, dy, dz, l);
        basis(dx, dy, dz, y);
        for (let k = 0; k < COEFFS; k++) {
            out[k * 3] += l[0] * y[k];
            out[k * 3 + 1] += l[1] * y[k];
            out[k * 3 + 2] += l[2] * y[k];
        }
    }
    const w = (4 * Math.PI) / SKY_SAMPLES;
    for (let i = 0; i < out.length; i++) out[i] *= w;
    return out;
}

/** Sky coefficients plus every lamp's, into out (75 doubles). */
export function projectEnv(env: Env, sky: Float64Array, out: Float64Array): void {
    out.set(sky);
    for (const lamp of env.lamps) {
        const m = capMoments(lamp.alpha);
        addZonal(out, m, lamp.dir, [lampRadiance(lamp, 0), lampRadiance(lamp, 1), lampRadiance(lamp, 2)]);
    }
}

/** Copy of env with lamps turned by `angle` about +Y and resized by `size`. */
export function posed(env: Env, angle: number, size: number): Env {
    const c = Math.cos(angle), s = Math.sin(angle);
    return {
        ...env,
        lamps: env.lamps.map((l) => ({
            ...l,
            alpha: Math.min(1.2, l.alpha * size),
            dir: [c * l.dir[0] - s * l.dir[2], l.dir[1], s * l.dir[0] + c * l.dir[2]] as V3,
        })),
    };
}
