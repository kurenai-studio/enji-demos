/** Most lights the demo can show; the light texture holds this many. */
export const MAX_LIGHTS = 1024;
/** Light texture: two RGBA32F texels per light (position + radius, colour + intensity), 32 lights per row. */
export const LIGHTS_PER_ROW = 32;
export const LIGHT_TEX_WIDTH = LIGHTS_PER_ROW * 2;
export const LIGHT_TEX_HEIGHT = MAX_LIGHTS / LIGHTS_PER_ROW;
/** Lights wander inside this half-size square round the origin. */
export const FIELD_HALF = 17;

/** Small deterministic PRNG (mulberry32), so the tests and the demo see the same lights. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function hsv(h: number, s: number, v: number): [number, number, number] {
    const f = (n: number): number => {
        const k = (n + h * 6) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}

/**
 * The point lights: each circles its own centre at its own speed and bobs
 * up and down, so all of them move every frame. Showing fewer lights uses the
 * first `count` and makes them larger, so the scene stays about as bright.
 */
export class LightField {
    /** Per light: centre x, centre z, orbit radius, angular speed, phase, height, bob, base radius. */
    readonly motion = new Float32Array(MAX_LIGHTS * 8);
    /** Per light: r, g, b, intensity. */
    readonly color = new Float32Array(MAX_LIGHTS * 4);
    /** Per light this frame: x, y, z, radius. */
    readonly position = new Float32Array(MAX_LIGHTS * 4);
    /** What the shaders read, laid out as the light texture. */
    readonly texture = new Float32Array(LIGHT_TEX_WIDTH * LIGHT_TEX_HEIGHT * 4);
    count = 0;

    constructor(seed = 7) {
        const r = rng(seed);
        for (let i = 0; i < MAX_LIGHTS; i++) {
            const m = this.motion;
            m[i * 8] = (r() * 2 - 1) * (FIELD_HALF - 1);
            m[i * 8 + 1] = (r() * 2 - 1) * (FIELD_HALF - 1);
            m[i * 8 + 2] = 0.5 + r() * 2.5;
            m[i * 8 + 3] = (0.15 + r() * 0.5) * (r() < 0.5 ? -1 : 1);
            m[i * 8 + 4] = r() * Math.PI * 2;
            m[i * 8 + 5] = 0.35 + r() * 1.6;
            m[i * 8 + 6] = 0.1 + r() * 0.3;
            m[i * 8 + 7] = 1.6 + r() * 1.4;
            const [cr, cg, cb] = hsv(r(), 0.55 + r() * 0.4, 1);
            this.color.set([cr, cg, cb, 1.1 + r() * 0.9], i * 4);
        }
    }

    /** Radius multiplier for `count` lights: fewer lights reach further. */
    static radiusScale(count: number): number {
        return Math.pow(256 / count, 0.35);
    }

    /** Positions at time `t` for the first `count` lights; fills `position` and `texture`. */
    update(t: number, count: number): void {
        this.count = count;
        const scale = LightField.radiusScale(count);
        const m = this.motion;
        const p = this.position;
        const tex = this.texture;
        for (let i = 0; i < count; i++) {
            const a = m[i * 8 + 4] + m[i * 8 + 3] * t;
            p[i * 4] = m[i * 8] + m[i * 8 + 2] * Math.cos(a);
            p[i * 4 + 1] = m[i * 8 + 5] + m[i * 8 + 6] * Math.sin(1.3 * t + 2 * m[i * 8 + 4]);
            p[i * 4 + 2] = m[i * 8 + 1] + m[i * 8 + 2] * Math.sin(a);
            p[i * 4 + 3] = m[i * 8 + 7] * scale;
            const row = Math.floor(i / LIGHTS_PER_ROW);
            const texel = (row * LIGHT_TEX_WIDTH + (i % LIGHTS_PER_ROW) * 2) * 4;
            tex.set(p.subarray(i * 4, i * 4 + 4), texel);
            tex.set(this.color.subarray(i * 4, i * 4 + 4), texel + 4);
        }
    }
}
