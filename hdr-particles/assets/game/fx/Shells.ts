import { RING, SHELL_CYCLES, SHELL_LIFE, SHELL_PERIOD, SHELLS, SPHERE, WILLOW, shellTexel } from './Particles';

/** Linear colours, normalised to their brightest channel; the particle shader scales them up. */
const PALETTE: readonly (readonly [number, number, number])[] = [
    [1, 0.12, 0.06], [1, 0.55, 0.12], [0.18, 1, 0.3], [0.25, 0.42, 1],
    [0.72, 0.25, 1], [1, 0.88, 0.75], [0.15, 0.9, 1], [1, 0.3, 0.55],
];

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The fireworks programme: SHELLS × SHELL_CYCLES bursts, three RGBA32F texels
 * each (centre + speed, colour + kind, ring normal), one row per cycle. The
 * GPU samples it as a data texture; the CPU path and the ground lights read
 * the same numbers.
 */
export function buildShellTable(seed = 11): Float32Array {
    const rand = mulberry32(seed);
    const data = new Float32Array(SHELLS * 3 * SHELL_CYCLES * 4);
    for (let k = 0; k < SHELL_CYCLES; k++) {
        for (let s = 0; s < SHELLS; s++) {
            const o = (k * SHELLS * 3 + s * 3) * 4;
            const roll = rand();
            const kind = roll < 0.6 ? SPHERE : roll < 0.8 ? RING : WILLOW;
            const speed = (3.6 + 1.6 * rand()) * (kind === WILLOW ? 0.7 : 1);
            data.set([-8 + 16 * rand(), 9 + 4.5 * rand(), -7 + 6 * rand(), speed], o);
            const c = PALETTE[Math.floor(rand() * PALETTE.length)];
            data.set([c[0], c[1], c[2], kind], o + 4);
            // Ring plane normal, tilted at most ~50° from facing the camera (+z).
            let nx = rand() * 2 - 1, ny = rand() * 2 - 1;
            const nz = 1;
            const l = Math.hypot(nx, ny, nz);
            nx /= l; ny /= l;
            data.set([nx, ny, nz / l, 0], o + 8);
        }
    }
    return data;
}

export interface ShellLight {
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
}

const tmp = [0, 0, 0, 0];
const col = [0, 0, 0, 0];

/** The brightest bursts at time t, as point lights for the ground (flash fading over ~1 s). */
export function shellLights(table: Float32Array, t: number, max: number, intensity: number): ShellLight[] {
    const lights: (ShellLight & { w: number })[] = [];
    for (let s = 0; s < SHELLS; s++) {
        const phase = (s / SHELLS) * SHELL_PERIOD;
        const k = Math.floor((t - phase) / SHELL_PERIOD);
        if (k < 0) continue;
        const age = t - phase - k * SHELL_PERIOD;
        if (age > SHELL_LIFE) continue;
        const w = intensity * Math.exp(-age * 3.5);
        shellTexel(table, s, k, 0, tmp);
        shellTexel(table, s, k, 1, col);
        const gold = col[3] === WILLOW;
        lights.push({
            x: tmp[0], y: tmp[1], z: tmp[2], w,
            r: (gold ? 1 : col[0]) * w, g: (gold ? 0.6 : col[1]) * w, b: (gold ? 0.2 : col[2]) * w,
        });
    }
    lights.sort((p, q) => q.w - p.w);
    return lights.slice(0, max);
}
