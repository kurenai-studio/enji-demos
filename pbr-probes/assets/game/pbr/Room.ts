/**
 * The static scene, shared by the offline baker (tools/bake.mts) and the
 * runtime: a Cornell box open towards +z, a square area light under the
 * ceiling and two rotated blocks. Every surface is a one-sided diffuse quad.
 * Plain TypeScript, no engine imports.
 */

export type V3 = [number, number, number];

export interface Quad {
    name: string;
    origin: V3;
    /** Edge vectors; the normal is normalize(u × v). */
    u: V3;
    v: V3;
    normal: V3;
    albedo: V3;
    /** Emitted radiance (W/sr/m²), black for everything but the light. */
    emission: V3;
    /** Bake grid cells along u and v; irradiance is stored at the (nu+1)·(nv+1) corners. */
    nu: number;
    nv: number;
    area: number;
}

export const ROOM = { minX: -2, maxX: 2, minY: 0, maxY: 3, minZ: -2, maxZ: 2 };

const WHITE: V3 = [0.73, 0.73, 0.73];
const RED: V3 = [0.63, 0.065, 0.05];
const GREEN: V3 = [0.14, 0.45, 0.091];
const BLACK: V3 = [0, 0, 0];
/** Light panel radiance; 1 m² under a 3 m ceiling lights the floor with about 1.7 W/m². */
export const LIGHT_RADIANCE: V3 = [17, 15.5, 13];
/** Bake grid density, cells per metre; 8 puts the light panel edges on ceiling grid lines. */
const DENSITY = 8;

export interface Block {
    x: number;
    z: number;
    half: number;
    height: number;
    /** Rotation about +y, radians. */
    angle: number;
}

export const BLOCKS: readonly Block[] = [
    { x: -0.75, z: -0.85, half: 0.5, height: 1.8, angle: (18 * Math.PI) / 180 },
    { x: 0.8, z: -0.55, half: 0.5, height: 0.9, angle: (-18 * Math.PI) / 180 },
];

export const LIGHT = { y: ROOM.maxY - 0.005, half: 0.5 };

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function len(a: V3): number { return Math.hypot(a[0], a[1], a[2]); }

function quad(name: string, origin: V3, u: V3, v: V3, albedo: V3, emission: V3 = BLACK): Quad {
    const n = cross(u, v);
    const l = len(n);
    return {
        name, origin, u, v,
        normal: [n[0] / l, n[1] / l, n[2] / l],
        albedo, emission,
        nu: Math.max(2, Math.round(len(u) * DENSITY)),
        nv: Math.max(2, Math.round(len(v) * DENSITY)),
        area: l,
    };
}

function blockQuads(b: Block, index: number): Quad[] {
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const rot = (p: V3): V3 => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
    const at = (p: V3): V3 => { const r = rot(p); return [r[0] + b.x, r[1], r[2] + b.z]; };
    const h = b.half, y = b.height;
    return [
        quad(`block${index}-top`, at([-h, y, h]), rot([2 * h, 0, 0]), rot([0, 0, -2 * h]), WHITE),
        quad(`block${index}-front`, at([-h, 0, h]), rot([2 * h, 0, 0]), rot([0, y, 0]), WHITE),
        quad(`block${index}-back`, at([h, 0, -h]), rot([-2 * h, 0, 0]), rot([0, y, 0]), WHITE),
        quad(`block${index}-right`, at([h, 0, h]), rot([0, 0, -2 * h]), rot([0, y, 0]), WHITE),
        quad(`block${index}-left`, at([-h, 0, -h]), rot([0, 0, 2 * h]), rot([0, y, 0]), WHITE),
    ];
}

const { minX, maxX, maxY, minZ, maxZ } = ROOM;
const W = maxX - minX, D = maxZ - minZ;

export const QUADS: readonly Quad[] = [
    quad('floor', [minX, 0, maxZ], [W, 0, 0], [0, 0, -D], WHITE),
    quad('ceiling', [minX, maxY, minZ], [W, 0, 0], [0, 0, D], WHITE),
    quad('back', [minX, 0, minZ], [W, 0, 0], [0, maxY, 0], WHITE),
    quad('left', [minX, 0, maxZ], [0, 0, -D], [0, maxY, 0], RED),
    quad('right', [maxX, 0, minZ], [0, 0, D], [0, maxY, 0], GREEN),
    quad('light', [-LIGHT.half, LIGHT.y, -LIGHT.half], [2 * LIGHT.half, 0, 0], [0, 0, 2 * LIGHT.half], WHITE, LIGHT_RADIANCE),
    ...BLOCKS.flatMap(blockQuads),
];

export const LIGHT_INDEX = QUADS.findIndex((q) => q.name === 'light');

export interface Hit {
    quad: number;
    t: number;
    /** Position on the quad in [0, 1] along u and v. */
    a: number;
    b: number;
    /** The ray hit the side the normal points away from (inside a block). */
    back: boolean;
}

/** Closest quad hit by the ray o + t·d with t in (tMin, tMax); false when it leaves through the open front. */
export function castRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Hit, tMin = 1e-4, tMax = Infinity): boolean {
    let best = tMax;
    let found = -1;
    for (let i = 0; i < QUADS.length; i++) {
        const q = QUADS[i];
        const n = q.normal;
        const denom = dx * n[0] + dy * n[1] + dz * n[2];
        if (denom > -1e-9 && denom < 1e-9) continue;
        const px = q.origin[0] - ox, py = q.origin[1] - oy, pz = q.origin[2] - oz;
        const t = (px * n[0] + py * n[1] + pz * n[2]) / denom;
        if (t <= tMin || t >= best) continue;
        const hx = ox + dx * t - q.origin[0];
        const hy = oy + dy * t - q.origin[1];
        const hz = oz + dz * t - q.origin[2];
        const u = q.u, v = q.v;
        const a = (hx * u[0] + hy * u[1] + hz * u[2]) / (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
        if (a < 0 || a > 1) continue;
        const b = (hx * v[0] + hy * v[1] + hz * v[2]) / (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (b < 0 || b > 1) continue;
        best = t;
        found = i;
        out.a = a;
        out.b = b;
        out.back = denom > 0;
    }
    if (found < 0) return false;
    out.quad = found;
    out.t = best;
    return true;
}

/** Point on a quad at (a, b), pushed `lift` metres off the surface along its normal. */
export function quadPoint(q: Quad, a: number, b: number, lift = 0): V3 {
    return [
        q.origin[0] + q.u[0] * a + q.v[0] * b + q.normal[0] * lift,
        q.origin[1] + q.u[1] * a + q.v[1] * b + q.normal[1] * lift,
        q.origin[2] + q.u[2] * a + q.v[2] * b + q.normal[2] * lift,
    ];
}

const LIGHT_SAMPLES = 6;
const scratch: Hit = { quad: -1, t: 0, a: 0, b: 0, back: false };

/**
 * Irradiance at p (normal n) straight from the area light, with shadows, divided
 * by the light's radiance (so irradiance = factor · LIGHT_RADIANCE):
 * 6×6 stratified samples on the panel.
 */
export function directFactor(p: V3, n: V3): number {
    const light = QUADS[LIGHT_INDEX];
    const ln = light.normal;
    const dA = light.area / (LIGHT_SAMPLES * LIGHT_SAMPLES);
    let e = 0;
    for (let i = 0; i < LIGHT_SAMPLES; i++) {
        for (let j = 0; j < LIGHT_SAMPLES; j++) {
            const q = quadPoint(light, (i + 0.5) / LIGHT_SAMPLES, (j + 0.5) / LIGHT_SAMPLES);
            const wx = q[0] - p[0], wy = q[1] - p[1], wz = q[2] - p[2];
            const d2 = wx * wx + wy * wy + wz * wz;
            const d = Math.sqrt(d2);
            const dx = wx / d, dy = wy / d, dz = wz / d;
            const cosP = n[0] * dx + n[1] * dy + n[2] * dz;
            const cosL = -(ln[0] * dx + ln[1] * dy + ln[2] * dz);
            if (cosP <= 0 || cosL <= 0) continue;
            if (castRay(p[0], p[1], p[2], dx, dy, dz, scratch, 1e-4, d - 1e-3) && scratch.quad !== LIGHT_INDEX) continue;
            e += (cosP * cosL) / d2;
        }
    }
    return e * dA;
}

/** Fraction of the light panel visible from p, ignoring orientation: 6×6 shadow rays. */
export function lightVisibility(p: V3): number {
    const light = QUADS[LIGHT_INDEX];
    let visible = 0;
    for (let i = 0; i < LIGHT_SAMPLES; i++) {
        for (let j = 0; j < LIGHT_SAMPLES; j++) {
            const q = quadPoint(light, (i + 0.5) / LIGHT_SAMPLES, (j + 0.5) / LIGHT_SAMPLES);
            const wx = q[0] - p[0], wy = q[1] - p[1], wz = q[2] - p[2];
            const d = Math.hypot(wx, wy, wz);
            if (!castRay(p[0], p[1], p[2], wx / d, wy / d, wz / d, scratch, 1e-4, d - 1e-3)) visible++;
        }
    }
    return visible / (LIGHT_SAMPLES * LIGHT_SAMPLES);
}
