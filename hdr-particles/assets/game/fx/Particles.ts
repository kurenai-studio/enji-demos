/**
 * Particle schedule, emitters and forces for the three scenes, and the
 * state encoding. hp-particles.chunk is the same code in GLSL; the GPU runs
 * that one, the CPU path and the tests run this one.
 *
 * State: three RGBA8 texels per particle, two 16-bit values in each
 * (hi byte, lo byte): A = (x, y), B = (z, vx), C = (vy, vz). Positions span
 * POS_RANGE metres from POS_MIN, velocities ±VEL_RANGE / 2 m/s.
 *
 * Particles are not created or destroyed: particle i is re-born every
 * `life` seconds at a fixed phase (fountain, embers) or with its firework
 * shell, so its age is a function of its index and the time, and the
 * simulation only has to spot the step in which it is re-born.
 */

export const FOUNTAIN = 0;
export const EMBERS = 1;
export const FIREWORKS = 2;
export const SCENE_NAMES = ['Fountain', 'Embers', 'Fireworks'];

export const FOUNTAIN_LIFE = 2.8;
export const EMBER_LIFE = 4.5;
export const SHELLS = 16;
export const SHELL_CYCLES = 16;
export const SHELL_PERIOD = 3.6;
export const SHELL_LIFE = 2.6;
/**
 * Fireworks: particle index = shell + SHELLS × (trail + TRAIL × star). The
 * TRAIL particles of a star share its direction, each born TRAIL_DT after
 * the one before, so they retrace its path and draw its trail.
 */
export const TRAIL = 16;
export const TRAIL_DT = 0.025;
/** Shell kinds, in the w of the shell table's second texel. */
export const SPHERE = 0;
export const RING = 1;
export const WILLOW = 2;

export const POS_MIN = [-12, -1, -12] as const;
export const POS_RANGE = 24;
export const VEL_RANGE = 48;
export const Q16 = 65535;
const TAU = Math.PI * 2;

const fract = (x: number): number => x - Math.floor(x);
const smoothstep = (a: number, b: number, x: number): number => {
    const u = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return u * u * (3 - 2 * u);
};
const mod = (x: number, n: number): number => x - n * Math.floor(x / n);

/** Dave Hoskins' "hash without sine", 3 → 1. */
export function hash13(x: number, y: number, z: number): number {
    let a = fract(x * 0.1031), b = fract(y * 0.1031), c = fract(z * 0.1031);
    const d = a * (c + 31.32) + b * (b + 31.32) + c * (a + 31.32);
    a += d; b += d; c += d;
    return fract((a + b) * c);
}

/** 3 → 3. */
export function hash33(x: number, y: number, z: number, out: number[]): number[] {
    let a = fract(x * 0.1031), b = fract(y * 0.1030), c = fract(z * 0.0973);
    const d = a * (b + 33.33) + b * (a + 33.33) + c * (c + 33.33);
    a += d; b += d; c += d;
    out[0] = fract((a + b) * c);
    out[1] = fract((a + a) * b);
    out[2] = fract((b + a) * a);
    return out;
}

/** u in [0, 1] → 16-bit code; r = 0.5 rounds to nearest, r uniform in [0, 1) rounds stochastically. */
export function quantize(u: number, r: number): number {
    const q = Math.floor(u * Q16 + r);
    return q < 0 ? 0 : q > Q16 ? Q16 : q;
}

export interface Schedule {
    age: number;
    /** Which life this is; negative before the particle's first birth (not alive yet). */
    cycle: number;
    life: number;
    shell: number;
}

export function newSchedule(): Schedule {
    return { age: 0, cycle: -1, life: 1, shell: 0 };
}

export function trailIndex(index: number): number {
    return Math.floor(index / SHELLS) % TRAIL;
}

export function starIndex(index: number): number {
    return Math.floor(index / (SHELLS * TRAIL));
}

export function schedule(scene: number, index: number, tx: number, ty: number, t: number, out: Schedule): Schedule {
    if (scene !== FIREWORKS) {
        const life = scene === FOUNTAIN ? FOUNTAIN_LIFE : EMBER_LIFE;
        // R2 sequence over the texel grid: birth times spread evenly, no pulses.
        const phase = fract(tx * 0.7548776662 + ty * 0.569840291) * life;
        const k = Math.floor((t - phase) / life);
        out.age = t - phase - k * life;
        out.cycle = k;
        out.life = life;
        out.shell = 0;
        return out;
    }
    const s = index % SHELLS;
    const phase = (s / SHELLS) * SHELL_PERIOD + trailIndex(index) * TRAIL_DT;
    const k = Math.floor((t - phase) / SHELL_PERIOD);
    out.age = t - phase - k * SHELL_PERIOD;
    out.cycle = k;
    out.life = SHELL_LIFE;
    out.shell = s;
    return out;
}

export function isAlive(s: Schedule): boolean {
    return s.cycle >= 0 && s.age < s.life;
}

/**
 * Born during the step that ends now. Closed at age = dt so that a birth at
 * exactly time 0 is caught by the first step (the state starts as zeros); a
 * birth exactly on a later step boundary is spawned in both steps, which only
 * skips one step of forces.
 */
export function bornThisStep(s: Schedule, dt: number): boolean {
    return s.cycle >= 0 && s.age <= dt;
}

/** Texel j (0: centre + speed, 1: colour + kind, 2: ring normal) of shell s in cycle k. */
export function shellTexel(table: Float32Array, s: number, k: number, j: number, out: number[]): number[] {
    const row = mod(k, SHELL_CYCLES);
    const o = (row * SHELLS * 3 + s * 3 + j) * 4;
    out[0] = table[o]; out[1] = table[o + 1]; out[2] = table[o + 2]; out[3] = table[o + 3];
    return out;
}

const r3: number[] = [0, 0, 0];
const q3: number[] = [0, 0, 0];
const sa: number[] = [0, 0, 0, 0];
const sb: number[] = [0, 0, 0, 0];
const sc: number[] = [0, 0, 0, 0];

/** Birth position and velocity, already moved along for the particle's age (it was born part-way through the step). */
export function spawn(scene: number, tx: number, ty: number, index: number, sch: Schedule, shells: Float32Array, p: number[], v: number[]): void {
    const k = mod(sch.cycle, 1024);
    if (scene === FIREWORKS) hash33(starIndex(index), sch.shell, k + 0.5, r3);
    else hash33(tx, ty, k + 0.5, r3);
    if (scene === FOUNTAIN) {
        const a = r3[0] * TAU;
        const c = 0.985 + 0.015 * r3[1];
        const sn = Math.sqrt(1 - c * c);
        const dx = Math.cos(a) * sn, dy = c, dz = Math.sin(a) * sn;
        const speed = 6.8 + 1.8 * r3[2];
        p[0] = dx * 0.03; p[1] = 0.32 + dy * 0.03; p[2] = dz * 0.03;
        v[0] = dx * speed; v[1] = dy * speed; v[2] = dz * speed;
    } else if (scene === EMBERS) {
        hash33(ty, tx, k + 17.25, q3);
        const a = r3[0] * TAU;
        const rad = 0.6 * Math.sqrt(r3[1]);
        p[0] = Math.cos(a) * rad; p[1] = 0.62; p[2] = Math.sin(a) * rad;
        v[0] = (q3[0] - 0.5) * 1.8; v[1] = 0.6 + 1.2 * r3[2]; v[2] = (q3[1] - 0.5) * 1.8;
    } else {
        shellTexel(shells, sch.shell, sch.cycle, 0, sa);
        shellTexel(shells, sch.shell, sch.cycle, 1, sb);
        const z = r3[0] * 2 - 1;
        const a = r3[1] * TAU;
        const sxy = Math.sqrt(1 - z * z);
        let dx = sxy * Math.cos(a), dy = z, dz = sxy * Math.sin(a);
        let speed = sa[3] * (0.88 + 0.12 * r3[2]);
        if (sb[3] === RING) {
            shellTexel(shells, sch.shell, sch.cycle, 2, sc);
            const d = dx * sc[0] + dy * sc[1] + dz * sc[2];
            dx -= sc[0] * d; dy -= sc[1] * d; dz -= sc[2] * d;
            const l = Math.hypot(dx, dy, dz) + 1e-4;
            dx /= l; dy /= l; dz /= l;
            speed = sa[3];
        }
        p[0] = sa[0]; p[1] = sa[1]; p[2] = sa[2];
        v[0] = dx * speed; v[1] = dy * speed; v[2] = dz * speed;
    }
    p[0] += v[0] * sch.age; p[1] += v[1] * sch.age; p[2] += v[2] * sch.age;
}

/**
 * Divergence-free flow: the curl of a vector potential whose components are
 * products of sines, two octaves drifting with time. Swirls without sinks.
 */
export function curl(x: number, y: number, z: number, t: number, out: number[]): number[] {
    out[0] = 0; out[1] = 0; out[2] = 0;
    for (let o = 0; o < 2; o++) {
        const k1 = o === 0 ? 0.55 : 1.3;
        const k2 = o === 0 ? 0.45 : 1.1;
        const amp = o === 0 ? 1 : 0.35;
        const w = o === 0 ? 1 : 1.7;
        const t1 = 0.31 * w * t + o, t2 = 0.23 * w * t + 1.3 + o, t3 = 0.27 * w * t + 2.1 + o;
        const t4 = 0.19 * w * t + 0.7 + o, t5 = 0.29 * w * t + 3.3 + o, t6 = 0.21 * w * t + 4.1 + o;
        // ψ = (sin(k1 y + t1) cos(k2 z + t2), sin(k1 z + t3) cos(k2 x + t4), sin(k1 x + t5) cos(k2 y + t6))
        const dHdy = -k2 * Math.sin(k1 * x + t5) * Math.sin(k2 * y + t6);
        const dGdz = k1 * Math.cos(k1 * z + t3) * Math.cos(k2 * x + t4);
        const dFdz = -k2 * Math.sin(k1 * y + t1) * Math.sin(k2 * z + t2);
        const dHdx = k1 * Math.cos(k1 * x + t5) * Math.cos(k2 * y + t6);
        const dGdx = -k2 * Math.sin(k1 * z + t3) * Math.sin(k2 * x + t4);
        const dFdy = k1 * Math.cos(k1 * y + t1) * Math.cos(k2 * z + t2);
        out[0] += amp * (dHdy - dGdz);
        out[1] += amp * (dFdz - dHdx);
        out[2] += amp * (dGdx - dFdy);
    }
    return out;
}

const cf: number[] = [0, 0, 0];

/** One semi-implicit Euler step with a bounce off the ground. `kind` is the shell kind (fireworks). */
export function integrate(scene: number, kind: number, age: number, t: number, dt: number, p: number[], v: number[]): void {
    let ax: number, ay: number, az: number;
    if (scene === FOUNTAIN) {
        ax = -v[0] * 0.25; ay = -9.8 - v[1] * 0.25; az = -v[2] * 0.25;
    } else if (scene === EMBERS) {
        curl(p[0] * 1.1, p[1] * 1.1, p[2] * 1.1, t, cf);
        const swirl = 4 * smoothstep(0, 1.2, age);
        ax = cf[0] * swirl - v[0] * 1.4;
        ay = 0.9 + 1.8 * Math.exp(-0.6 * age) + cf[1] * swirl - v[1] * 1.4;
        az = cf[2] * swirl - v[2] * 1.4;
    } else if (kind === WILLOW) {
        ax = -v[0] * 0.9; ay = -4 - v[1] * 0.9; az = -v[2] * 0.9;
    } else {
        ax = -v[0] * 2.2; ay = -9.8 - v[1] * 2.2; az = -v[2] * 2.2;
    }
    v[0] += ax * dt; v[1] += ay * dt; v[2] += az * dt;
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
    if (p[1] < 0) {
        p[1] = -p[1] * 0.3;
        v[1] = Math.abs(v[1]) * 0.35;
        v[0] *= 0.7;
        v[2] *= 0.7;
    }
}

/** Shell kind of a fireworks particle, 0 in the other scenes. */
export function kindOf(scene: number, sch: Schedule, shells: Float32Array): number {
    return scene === FIREWORKS ? shellTexel(shells, sch.shell, sch.cycle, 1, sb)[3] : 0;
}

const unpack = (hi: number, lo: number): number => (hi * 256 + lo) / Q16;

/**
 * The GPU simulation on the CPU: the same step on the same 8-bit state,
 * written into byte arrays that are uploaded as the three state textures.
 */
export class CpuParticles {
    readonly width: number;
    readonly a: Uint8Array;
    readonly b: Uint8Array;
    readonly c: Uint8Array;
    /** Stochastic rounding of the 16-bit codes (off: round to nearest). */
    stochastic = true;
    private seed = 0x9e3779b9;
    private readonly sch = newSchedule();
    private readonly p = [0, 0, 0];
    private readonly v = [0, 0, 0];

    constructor(width: number) {
        this.width = width;
        const n = width * width * 4;
        this.a = new Uint8Array(n);
        this.b = new Uint8Array(n);
        this.c = new Uint8Array(n);
    }

    /** Advances the first `count` particles to time t (the step ends at t). */
    step(scene: number, t: number, dt: number, count: number, shells: Float32Array): void {
        const { a, b, c, p, v, sch, width } = this;
        for (let i = 0; i < count; i++) {
            const tx = i % width, ty = (i - tx) / width;
            schedule(scene, i, tx, ty, t, sch);
            if (sch.cycle < 0) continue;
            const o = i * 4;
            if (bornThisStep(sch, dt)) {
                spawn(scene, tx, ty, i, sch, shells, p, v);
            } else {
                p[0] = POS_MIN[0] + unpack(a[o], a[o + 1]) * POS_RANGE;
                p[1] = POS_MIN[1] + unpack(a[o + 2], a[o + 3]) * POS_RANGE;
                p[2] = POS_MIN[2] + unpack(b[o], b[o + 1]) * POS_RANGE;
                v[0] = (unpack(b[o + 2], b[o + 3]) - 0.5) * VEL_RANGE;
                v[1] = (unpack(c[o], c[o + 1]) - 0.5) * VEL_RANGE;
                v[2] = (unpack(c[o + 2], c[o + 3]) - 0.5) * VEL_RANGE;
                integrate(scene, kindOf(scene, sch, shells), sch.age, t, dt, p, v);
            }
            this.put(a, o, (p[0] - POS_MIN[0]) / POS_RANGE);
            this.put(a, o + 2, (p[1] - POS_MIN[1]) / POS_RANGE);
            this.put(b, o, (p[2] - POS_MIN[2]) / POS_RANGE);
            this.put(b, o + 2, v[0] / VEL_RANGE + 0.5);
            this.put(c, o, v[1] / VEL_RANGE + 0.5);
            this.put(c, o + 2, v[2] / VEL_RANGE + 0.5);
        }
    }

    /** Position and velocity of particle i, decoded. */
    read(i: number, p: number[], v: number[]): void {
        const { a, b, c } = this;
        const o = i * 4;
        p[0] = POS_MIN[0] + unpack(a[o], a[o + 1]) * POS_RANGE;
        p[1] = POS_MIN[1] + unpack(a[o + 2], a[o + 3]) * POS_RANGE;
        p[2] = POS_MIN[2] + unpack(b[o], b[o + 1]) * POS_RANGE;
        v[0] = (unpack(b[o + 2], b[o + 3]) - 0.5) * VEL_RANGE;
        v[1] = (unpack(c[o], c[o + 1]) - 0.5) * VEL_RANGE;
        v[2] = (unpack(c[o + 2], c[o + 3]) - 0.5) * VEL_RANGE;
    }

    private put(bytes: Uint8Array, o: number, u: number): void {
        let r = 0.5;
        if (this.stochastic) {
            let x = this.seed;
            x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
            this.seed = x >>> 0;
            r = this.seed / 4294967296;
        }
        const q = quantize(u, r);
        bytes[o] = q >>> 8;
        bytes[o + 1] = q & 255;
    }
}

/** The same simulation without quantisation, in doubles: the reference for the tests. */
export class FloatParticles {
    readonly width: number;
    readonly pos: Float64Array;
    readonly vel: Float64Array;
    private readonly sch = newSchedule();
    private readonly p = [0, 0, 0];
    private readonly v = [0, 0, 0];

    constructor(width: number) {
        this.width = width;
        this.pos = new Float64Array(width * width * 3);
        this.vel = new Float64Array(width * width * 3);
    }

    step(scene: number, t: number, dt: number, count: number, shells: Float32Array): void {
        const { pos, vel, p, v, sch, width } = this;
        for (let i = 0; i < count; i++) {
            const tx = i % width, ty = (i - tx) / width;
            schedule(scene, i, tx, ty, t, sch);
            if (sch.cycle < 0) continue;
            const o = i * 3;
            if (bornThisStep(sch, dt)) {
                spawn(scene, tx, ty, i, sch, shells, p, v);
            } else {
                p[0] = pos[o]; p[1] = pos[o + 1]; p[2] = pos[o + 2];
                v[0] = vel[o]; v[1] = vel[o + 1]; v[2] = vel[o + 2];
                integrate(scene, kindOf(scene, sch, shells), sch.age, t, dt, p, v);
            }
            for (let j = 0; j < 3; j++) {
                pos[o + j] = Math.min(Math.max(p[j], POS_MIN[j]), POS_MIN[j] + POS_RANGE);
                vel[o + j] = Math.min(Math.max(v[j], -VEL_RANGE / 2), VEL_RANGE / 2);
            }
        }
    }
}
