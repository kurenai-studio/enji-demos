// Headless checks of the SSAO estimator (assets/game/ssao/AoMath.ts, the
// TypeScript twin of ssao-ao.effect) on G-buffers ray-cast from analytic
// scenes and quantised exactly like the 8-bit render texture.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { ambientOcclusion, type AoSettings, bayer4, decodeNormal, encodeNormal, type GBuffer, kernelSample, packDepth, unpackDepth } from '../assets/game/ssao/AoMath.ts';
import { EDGE_FADE, type SsrResult, type SsrSettings, traceReflection } from '../assets/game/ssao/SsrMath.ts';

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
 * the 8-bit G-buffer would: world normals octahedral, or (`viewXy`, the
 * encoding this demo used first) view-space xy with z rebuilt.
 */
function render(shapes: Shape[], width: number, height: number, pitch = 20, viewXy = false): Scene {
    const tanY = Math.tan((30 * Math.PI) / 180);
    const tanX = tanY * (width / height);
    const a = (-pitch * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const g: GBuffer = {
        width, height, tanX, tanY, far: FAR,
        depth: new Float64Array(width * height), nx: new Float64Array(width * height), ny: new Float64Array(width * height),
        nz: new Float64Array(width * height),
    };
    const hits: (Hit | null)[] = [];
    const n = [0, 0, 0];
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
            if (viewXy) {
                const nvy = ca * best.ny + sa * best.nz;
                g.nx[k] = Math.round((best.nx * 0.5 + 0.5) * 255) / 255 * 2 - 1;
                g.ny[k] = Math.round((nvy * 0.5 + 0.5) * 255) / 255 * 2 - 1;
                g.nz[k] = Math.sqrt(Math.max(0, 1 - g.nx[k] * g.nx[k] - g.ny[k] * g.ny[k]));
                continue;
            }
            // Through the two G-buffer bytes, then world to view (inverse pitch).
            const [p, q] = encodeNormal(best.nx, best.ny, best.nz);
            decodeNormal(p, q, n);
            g.nx[k] = n[0];
            g.ny[k] = ca * n[1] + sa * n[2];
            g.nz[k] = -sa * n[1] + ca * n[2];
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

// ---------------------------------------------------------------- normal encoding
{
    const n = [0, 0, 0];
    let axisErr = 0;
    for (const a of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const [p, q] = encodeNormal(a[0], a[1], a[2]);
        decodeNormal(p, q, n);
        axisErr = Math.max(axisErr, Math.hypot(n[0] - a[0], n[1] - a[1], n[2] - a[2]));
    }
    // Worst angle over a dense spiral of directions.
    let worst = 0;
    for (let i = 0; i < 20000; i++) {
        const z = 1 - (2 * (i + 0.5)) / 20000, r = Math.sqrt(1 - z * z), phi = i * 2.399963;
        const x = r * Math.cos(phi), y = r * Math.sin(phi);
        const [p, q] = encodeNormal(x, y, z);
        decodeNormal(p, q, n);
        worst = Math.max(worst, Math.acos(Math.min(1, x * n[0] + y * n[1] + z * n[2])));
    }
    const deg = (worst * 180) / Math.PI;
    check('octahedral normals: axis-aligned exact, any direction within 1°', axisErr < 1e-12 && deg < 1, `axis error ${axisErr.toExponential(1)}, worst ${deg.toFixed(2)}°`);
}

// ---------------------------------------------------------------- screen-space reflections
// Floor pixels reflect; the analytic reflection ray gives the true hit. SSR
// can find it only when it is on screen, not hidden (the G-buffer holds the
// same surface at its pixel), clear of the edge fade and inside the distance
// fade: those are the resolvable reflections. Errors are in G-buffer texels.
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Shape => (ox, oy, oz, dx, dy, dz) => {
    let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 0;
    const o = [ox, oy, oz], d = [dx, dy, dz], lo = [x0, y0, z0], hi = [x1, y1, z1];
    for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-12) { if (o[i] < lo[i] || o[i] > hi[i]) return null; continue; }
        let ta = (lo[i] - o[i]) / d[i], tb = (hi[i] - o[i]) / d[i];
        let s = -1;
        if (ta > tb) { [ta, tb] = [tb, ta]; s = 1; }
        if (ta > tmin) { tmin = ta; axis = i; sign = s; }
        tmax = Math.min(tmax, tb);
    }
    if (tmin > tmax || tmin <= 0) return null;
    const n = [0, 0, 0];
    n[axis] = sign;
    return { t: tmin, nx: n[0], ny: n[1], nz: n[2], x: ox + dx * tmin, y: oy + dy * tmin, z: oz + dz * tmin };
};

const SSR_DEFAULTS: SsrSettings = { steps: 32, refine: 4, thickness: 0.25, maxDistance: 12 };
const CAM_Y = 1.6;

interface SsrStats {
    resolvable: number; hits: number; median: number; p95: number; wrong: number;
    /** Rays that leave the scene, and those SSR still hit something more than 3 texels from the ray. */
    skyRays: number; falseHits: number;
    /** Reflections SSR cannot see (off screen or hidden), and those it filled with something else. */
    offscreen: number; offscreenHits: number;
    usPerPixel: number;
}

function ssrStats(shapes: Shape[], width: number, height: number, s: SsrSettings, viewXy = false, pitch = 20): SsrStats {
    const scene = render(shapes, width, height, pitch, viewXy);
    const g = scene.g;
    const a = (-pitch * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const errors: number[] = [];
    const st: SsrStats = { resolvable: 0, hits: 0, median: 0, p95: 0, wrong: 0, skyRays: 0, falseHits: 0, offscreen: 0, offscreenHits: 0, usPerPixel: 0 };
    const res: SsrResult = { u: 0, v: 0, confidence: 0, steps: 0 };
    let traced = 0, ms = 0;
    scene.hits.forEach((h, k) => {
        if (!h || h.ny !== 1 || h.t > 20) return;
        const x = k % width, y = Math.floor(k / width);
        const t0 = performance.now();
        traceReflection(g, x, y, s, res);
        ms += performance.now() - t0; traced++;
        const hit = res.confidence > 0.5;
        // True reflection: incoming direction mirrored about the exact floor normal.
        const ix = h.x, iy = h.y - CAM_Y, iz = h.z;
        const il = Math.hypot(ix, iy, iz);
        const rx = ix / il, ry = -iy / il, rz = iz / il;
        let best: Hit | null = null;
        for (const sh of shapes) {
            const q = sh(h.x + rx * 1e-4, h.y + ry * 1e-4, h.z + rz * 1e-4, rx, ry, rz);
            if (q && (!best || q.t < best.t)) best = q;
        }
        if (!best || best.t > 30) {
            st.skyRays++;
            if (!hit) return;
            // A ray grazing an edge may hit within a texel of it; a false hit is a surface well off the ray.
            const hx = Math.min(width - 1, Math.floor(res.u * width)), hy = Math.min(height - 1, Math.floor(res.v * height));
            const hd = g.depth[hy * width + hx];
            const qx = ((hx + 0.5) / width * 2 - 1) * g.tanX * hd, qy = ((hy + 0.5) / height * 2 - 1) * g.tanY * hd, qz = -hd;
            const ox = qx - h.x, oy = ca * qy - sa * qz + CAM_Y - h.y, oz = sa * qy + ca * qz - h.z;
            const along = ox * rx + oy * ry + oz * rz;
            const off = Math.hypot(ox - along * rx, oy - along * ry, oz - along * rz);
            if (off > 3 * hd * 2 * g.tanY / height) st.falseHits++;
            return;
        }
        // Project the true hit: world to view is the inverse pitch.
        const wy = best.y - CAM_Y, wz = best.z;
        const vxv = best.x, vyv = ca * wy + sa * wz, vzv = -sa * wy + ca * wz;
        const u = (vxv / -vzv / g.tanX) * 0.5 + 0.5, v = (vyv / -vzv / g.tanY) * 0.5 + 0.5;
        const tx = Math.floor(u * width), ty = Math.floor(v * height);
        const visible = vzv < 0 && u >= 0 && u < 1 && v >= 0 && v < 1 && Math.abs(g.depth[ty * width + tx] + vzv) < Math.max(0.01, 0.003 * -vzv);
        if (!visible) {
            st.offscreen++;
            if (hit) st.offscreenHits++;
            return;
        }
        if (Math.min(u, 1 - u, v, 1 - v) < EDGE_FADE || best.t > 0.8 * s.maxDistance) return;
        st.resolvable++;
        if (!hit) return;
        st.hits++;
        const e = Math.hypot((res.u - u) * width, (res.v - v) * height);
        errors.push(e);
        if (e > 4) st.wrong++;
    });
    errors.sort((p, q) => p - q);
    st.median = errors.length ? errors[Math.floor(errors.length / 2)] : NaN;
    st.p95 = errors.length ? errors[Math.floor(errors.length * 0.95)] : NaN;
    st.usPerPixel = (ms * 1000) / Math.max(1, traced);
    return st;
}

// A 3 m wall 6 m ahead (rays over it reach the sky), two balls and a post.
const ssrScene: Shape[] = [floor, box(-6, 6, 0, 3, -6.3, -6), sphere(0, 0.5, -3, 0.5), sphere(1.4, 0.3, -2.2, 0.3), box(-1.6, -1.2, 0, 2, -3.4, -3)];
const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const ssrLine = (r: SsrStats) =>
    `found ${r.hits}/${r.resolvable} (${pct(r.hits, r.resolvable)}), error median ${r.median.toFixed(2)} p95 ${r.p95.toFixed(2)} texels, ` +
    `${r.wrong} more than 4 off; false hits on sky rays ${r.falseHits}/${r.skyRays} (${pct(r.falseHits, r.skyRays)}); ` +
    `hidden or off-screen targets filled ${r.offscreenHits}/${r.offscreen}; ${r.usPerPixel.toFixed(2)} µs per pixel`;
{
    const empty = ssrStats([floor], 320, 240, SSR_DEFAULTS);
    check('SSR: a bare floor reflects only sky (no self-hits)', empty.falseHits === 0, `${empty.falseHits} false hits over ${empty.skyRays} floor texels`);
    const d = ssrStats(ssrScene, 320, 240, SSR_DEFAULTS);
    check('SSR at 320×240, defaults: finds ≥ 95% of resolvable reflections, median error < 0.5 texel, false hits < 2% of sky rays',
        d.hits / d.resolvable >= 0.95 && d.median < 0.5 && d.falseHits / d.skyRays < 0.02 && d.skyRays > 1000, ssrLine(d));
    const xy = ssrStats(ssrScene, 320, 240, SSR_DEFAULTS, true);
    check('SSR: view-space xy normals (8-bit) tilt reflections; octahedral world normals do not', xy.median > 4 * d.median,
        `view xy: ${ssrLine(xy)}`);
    const noRefine = ssrStats(ssrScene, 320, 240, { ...SSR_DEFAULTS, refine: 0 });
    check('SSR: bisection cuts the error', d.p95 < noRefine.p95 && d.median < noRefine.median, `without: ${ssrLine(noRefine)}`);
    for (const steps of [16, 64]) console.log(`info SSR ${steps} steps: ${ssrLine(ssrStats(ssrScene, 320, 240, { ...SSR_DEFAULTS, steps }))}`);
    const thin = ssrStats(ssrScene, 320, 240, { ...SSR_DEFAULTS, thickness: 0.05 });
    const thick = ssrStats(ssrScene, 320, 240, { ...SSR_DEFAULTS, thickness: 1.5 });
    console.log(`info SSR thickness 0.05 m: ${ssrLine(thin)}`);
    console.log(`info SSR thickness 1.5 m: ${ssrLine(thick)}`);
    check('SSR: thin surfaces miss more, thick ones smear behind objects', thin.hits < d.hits && thick.offscreenHits + thick.falseHits > d.offscreenHits + d.falseHits,
        `found ${thin.hits} / ${d.hits} / ${thick.hits}, hidden targets and sky rays filled ${thin.offscreenHits + thin.falseHits} / ${d.offscreenHits + d.falseHits} / ${thick.offscreenHits + thick.falseHits} at 0.05 / 0.25 / 1.5 m`);
    const sizes = [[160, 120], [640, 480]].map(([w, h]) => ssrStats(ssrScene, w, h, SSR_DEFAULTS));
    console.log(`info SSR at 160×120: ${ssrLine(sizes[0])}`);
    console.log(`info SSR at 640×480: ${ssrLine(sizes[1])}`);
    check('SSR: error stays under a texel at 160×120 and 640×480', sizes.every((r) => r.median < 1), sizes.map((r) => r.median.toFixed(2)).join(' / '));
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
