// Headless checks of the SSAO estimator (assets/game/ssao/AoMath.ts, the
// TypeScript twin of ssao-ao.effect) on G-buffers ray-cast from analytic
// scenes and quantised exactly like the 8-bit render texture.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { ambientOcclusion, type AoSettings, bayer4, type GBuffer, kernelSample, packDepth, unpackDepth } from '../assets/game/ssao/AoMath.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

const FAR = 40;
const DEFAULTS: AoSettings = { radius: 0.5, bias: 0.025, samples: 16, intensity: 1.5, slopeScale: 0.5 };

// Kernel: inside the unit hemisphere, never shorter than 0.1, cosine-weighted directions.
{
    const h = [0, 0, 0];
    let worstOut = 0;
    let shortest = Infinity;
    let below = 0;
    let cosSum = 0;
    const n = 32;
    for (let i = 0; i < n; i++) {
        kernelSample(i, n, h);
        const len = Math.hypot(h[0], h[1], h[2]);
        worstOut = Math.max(worstOut, len - 1);
        shortest = Math.min(shortest, len);
        if (h[2] <= 0) below++;
        cosSum += h[2] / len;
    }
    check('kernel inside the unit hemisphere', worstOut <= 1e-12 && below === 0, `longest ${(1 + worstOut).toFixed(3)}, below horizon ${below}`);
    check('kernel lengths ≥ 0.1', shortest >= 0.1 - 1e-12, `shortest ${shortest.toFixed(3)}`);
    check('kernel cosine-weighted (mean cos ≈ 2/3)', Math.abs(cosSum / n - 2 / 3) < 0.02, `mean cos ${(cosSum / n).toFixed(3)}`);
}

// Dither: each 4×4 tile uses all 16 rotations.
{
    const ranks = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ranks.add(bayer4(x + 8, y + 12));
    check('4×4 dither uses 16 distinct rotations', ranks.size === 16);
}

// Depth packing: 16 bits over the far distance.
{
    let worst = 0;
    for (let i = 0; i <= 10000; i++) {
        const d = (i / 10000) * 0.9999;
        const [hi, lo] = packDepth(d);
        worst = Math.max(worst, Math.abs(unpackDepth(hi, lo) - d));
    }
    check('depth pack round trip within half a 16-bit step', worst <= 0.5 / 65025 + 1e-12, `worst ${(worst * FAR * 1000).toFixed(2)} mm at far ${FAR} m`);
}

interface Hit { t: number; nx: number; ny: number; nz: number; x: number; y: number; z: number }
type Shape = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => Hit | null;

const floor: Shape = (ox, oy, oz, dx, dy, dz) => {
    if (dy >= 0) return null;
    const t = -oy / dy;
    return { t, nx: 0, ny: 1, nz: 0, x: ox + dx * t, y: 0, z: oz + dz * t };
};
const wall = (zw: number): Shape => (ox, oy, oz, dx, dy, dz) => {
    if (dz >= 0) return null;
    const t = (zw - oz) / dz;
    return t > 0 ? { t, nx: 0, ny: 0, nz: 1, x: ox + dx * t, y: oy + dy * t, z: zw } : null;
};
const sphere = (cx: number, cy: number, cz: number, r: number): Shape => (ox, oy, oz, dx, dy, dz) => {
    const lx = ox - cx, ly = oy - cy, lz = oz - cz;
    const a = dx * dx + dy * dy + dz * dz;
    const b = lx * dx + ly * dy + lz * dz;
    const c = lx * lx + ly * ly + lz * lz - r * r;
    const disc = b * b - a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / a;
    if (t <= 0) return null;
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    return { t, nx: (x - cx) / r, ny: (y - cy) / r, nz: (z - cz) / r, x, y, z };
};

interface Scene { g: GBuffer; hits: (Hit | null)[] }

/**
 * Ray-casts a W×H G-buffer from a camera at height 1.6 m pitched down by
 * `pitch` degrees (60° vertical FOV, 4:3), storing view depth and normals as
 * the 8-bit G-buffer would.
 */
function render(shapes: Shape[], width: number, height: number, pitch = 20): Scene {
    const tanY = Math.tan((30 * Math.PI) / 180);
    const tanX = tanY * (width / height);
    const a = (-pitch * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const g: GBuffer = {
        width, height, tanX, tanY, far: FAR,
        depth: new Float64Array(width * height), nx: new Float64Array(width * height), ny: new Float64Array(width * height),
    };
    const hits: (Hit | null)[] = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            // View ray with view z = -1, so the hit distance t is the view depth.
            const vx = ((x + 0.5) / width * 2 - 1) * tanX;
            const vy = ((y + 0.5) / height * 2 - 1) * tanY;
            const vz = -1;
            const dx = vx, dy = ca * vy - sa * vz, dz = sa * vy + ca * vz;
            let best: Hit | null = null;
            for (const s of shapes) {
                const hit = s(0, 1.6, 0, dx, dy, dz);
                if (hit && hit.t > 0 && (!best || hit.t < best.t)) best = hit;
            }
            const k = y * width + x;
            hits.push(best);
            if (!best || best.t >= FAR) {
                g.depth[k] = FAR * (1 + 1 / 255);
                continue;
            }
            const [hi, lo] = packDepth(Math.min(best.t / FAR, 0.9999));
            g.depth[k] = unpackDepth(hi, lo) * FAR;
            // World normal to view space (inverse pitch), then 8-bit like the render texture.
            const nvy = ca * best.ny + sa * best.nz;
            g.nx[k] = Math.round((best.nx * 0.5 + 0.5) * 255) / 255 * 2 - 1;
            g.ny[k] = Math.round((nvy * 0.5 + 0.5) * 255) / 255 * 2 - 1;
        }
    }
    return { g, hits };
}

/** Mean AO over texels whose hit point passes `where`; also returns how many. */
function meanAo(scene: Scene, s: AoSettings, where: (h: Hit) => boolean): { mean: number; min: number; count: number } {
    let sum = 0, min = 1, count = 0;
    scene.hits.forEach((h, k) => {
        if (!h || !where(h)) return;
        const ao = ambientOcclusion(scene.g, k % scene.g.width, Math.floor(k / scene.g.width), s);
        sum += ao; min = Math.min(min, ao); count++;
    });
    return { mean: count ? sum / count : NaN, min, count };
}

const fmt = (r: { mean: number; min: number; count: number }) => `mean ${r.mean.toFixed(3)}, min ${r.min.toFixed(3)} over ${r.count} texels`;

// A flat floor must stay open, including at grazing angles far away.
{
    const scene = render([floor], 160, 120, 15);
    const near = meanAo(scene, DEFAULTS, (h) => h.t < 10);
    const far = meanAo(scene, DEFAULTS, (h) => h.t >= 10 && h.t < 30);
    check('flat floor: no self-occlusion near (< 10 m)', near.mean > 0.99 && near.min > 0.9, fmt(near));
    check('flat floor: no self-occlusion at grazing angles (10–30 m)', far.mean > 0.97, fmt(far));
    const noSlope = meanAo(scene, { ...DEFAULTS, slopeScale: 0 }, (h) => h.t >= 10 && h.t < 30);
    console.log(`info flat floor, constant bias only, 10–30 m: ${fmt(noSlope)}`);
}

// Floor meeting a wall 5 m ahead: dark in the crease, open a metre away.
const creaseScene = render([floor, wall(-5)], 160, 120);
const inCrease = (h: Hit) => (h.ny === 1 ? h.z < -4.85 : h.y < 0.15) && Math.abs(h.x) < 2;
const awayFromCrease = (h: Hit) => (h.ny === 1 ? h.z > -3.5 && h.z < -2 : h.y > 1.2) && Math.abs(h.x) < 2;
{
    const crease = meanAo(creaseScene, DEFAULTS, inCrease);
    const open = meanAo(creaseScene, DEFAULTS, awayFromCrease);
    check('wall crease is darker than open floor and wall', crease.mean < 0.8 && open.mean > 0.97, `crease ${fmt(crease)}; open ${fmt(open)}`);
}

// A sphere resting on the floor: a dark ring round its base.
{
    const r = 0.5;
    const scene = render([floor, sphere(0, r, -4, r)], 160, 120);
    const ring = meanAo(scene, DEFAULTS, (h) => h.ny === 1 && Math.hypot(h.x, h.z + 4) < 1.25 * r);
    const open = meanAo(scene, DEFAULTS, (h) => h.ny === 1 && Math.hypot(h.x, h.z + 4) > 4 * r && h.t < 10);
    check('sphere on floor: contact ring darkened, floor further out open', ring.mean < 0.85 && open.mean > 0.98, `ring ${fmt(ring)}; open ${fmt(open)}`);
}

// Sample count and AO resolution: how far each setting is from 32 samples at full size.
{
    const ref = meanAo(creaseScene, { ...DEFAULTS, samples: 32 }, inCrease).mean;
    for (const n of [8, 16]) {
        const m = meanAo(creaseScene, { ...DEFAULTS, samples: n }, inCrease).mean;
        console.log(`info crease mean AO, ${n} samples: ${m.toFixed(3)} (32 samples: ${ref.toFixed(3)})`);
    }
}

// Floor AO against distance from the crease, at three G-buffer sizes: the
// profile should rise away from the wall and barely depend on resolution.
{
    // Wall 3 m ahead, camera pitched 35° down, so the floor near the wall covers many texels.
    const bands = [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 1]];
    const sizes = [[640, 480], [320, 240], [160, 120]];
    const profiles = sizes.map(([w, h]) => {
        const scene = render([floor, wall(-3)], w, h, 35);
        return bands.map(([a, b]) => meanAo(scene, DEFAULTS, (hit) => hit.ny === 1 && Math.abs(hit.x) < 1.5 && hit.z + 3 >= a && hit.z + 3 < b).mean);
    });
    sizes.forEach(([w, h], i) => console.log(`info floor AO by distance to the wall, ${w}×${h} (0–0.1, 0.1–0.25, 0.25–0.5, 0.5–1 m): ${profiles[i].map((v) => v.toFixed(3)).join(', ')}`));
    const rising = profiles.every((p) => p.every((v, i) => i === 0 || v >= p[i - 1] - 0.01));
    let spread = 0;
    for (let b = 0; b < bands.length; b++) spread = Math.max(spread, Math.abs(profiles[1][b] - profiles[0][b]), Math.abs(profiles[2][b] - profiles[0][b]));
    check('floor AO rises away from the wall at every size', rising);
    check('floor AO profile within 0.1 across 640×480, 320×240, 160×120', spread < 0.1, `largest difference ${spread.toFixed(3)}`);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
