// Node tests for the deferred-lighting maths: light volumes, falloff, the
// 8-bit G-buffer and light buffer, deferred vs forward on a CPU-rendered
// floor, and the light-pass cost model.
// node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { volumePixels, type ViewSetup } from '../assets/game/deferred/Cost.ts';
import { LightField, MAX_LIGHTS } from '../assets/game/deferred/Lights.ts';
import {
    bayer, composite, DEPTH_FAR, falloff, LIGHT_SCALE, lightTerms, luminance, packDepth, packNormal, quantize8,
    specFromBuffer, unpackDepth, unpackNormal, type V3,
} from '../assets/game/deferred/Shading.ts';
import { icosphere, inradius, volumeBatch } from '../assets/game/deferred/Volume.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failed++;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

// ---------------------------------------------------------------- volumes
{
    const ico = icosphere(1);
    const nv = ico.positions.length / 3, nt = ico.indices.length / 3;
    const r = inradius(ico);
    check('icosphere(1): 42 vertices, 80 triangles, faces wound outwards', nv === 42 && nt === 80 && r > 0, `inradius ${r.toFixed(4)}`);

    // Directions on the unit sphere: distance to the polyhedron surface along each.
    const surfaceDistance = (p: typeof ico, s: number, d: V3): number => {
        let best = Infinity;
        const v = p.positions;
        for (let i = 0; i < p.indices.length; i += 3) {
            const a: V3 = [v[p.indices[i] * 3] * s, v[p.indices[i] * 3 + 1] * s, v[p.indices[i] * 3 + 2] * s];
            const b: V3 = [v[p.indices[i + 1] * 3] * s, v[p.indices[i + 1] * 3 + 1] * s, v[p.indices[i + 1] * 3 + 2] * s];
            const c: V3 = [v[p.indices[i + 2] * 3] * s, v[p.indices[i + 2] * 3 + 1] * s, v[p.indices[i + 2] * 3 + 2] * s];
            const n = cross(sub(b, a), sub(c, a));
            const den = dot(n, d);
            if (den <= 0) continue;
            const t = dot(n, a) / den;
            const q = scale(d, t);
            if (dot(cross(sub(b, a), sub(q, a)), n) >= -1e-12 && dot(cross(sub(c, b), sub(q, b)), n) >= -1e-12 && dot(cross(sub(a, c), sub(q, c)), n) >= -1e-12) {
                best = Math.min(best, t);
            }
        }
        return best;
    };
    const dirs: V3[] = [];
    for (let k = 0; k < 4000; k++) {
        const z = 1 - (2 * (k + 0.5)) / 4000, a = k * 2.399963;
        const s = Math.sqrt(1 - z * z);
        dirs.push([s * Math.cos(a), s * Math.sin(a), z]);
    }
    let missed = 0, worst = Infinity, minScaled = Infinity;
    for (const d of dirs) {
        const t = surfaceDistance(ico, 1, d);
        if (t < 1 - 1e-9) missed++;
        worst = Math.min(worst, t);
        minScaled = Math.min(minScaled, surfaceDistance(ico, 1 / r, d));
    }
    check('unit-vertex icosphere cuts the light sphere off between its vertices', missed > 0,
        `${((missed / dirs.length) * 100).toFixed(0)}% of directions, up to ${((1 - worst) * 100).toFixed(1)}% of the radius short`);
    check('scaled by 1 / inradius it encloses the light sphere', minScaled >= 1 - 1e-9, `closest surface ${minScaled.toFixed(5)} r`);
    // Volume of the scaled polyhedron vs the sphere: what the bound costs in extra fragments.
    let vol = 0;
    const s = 1 / r, v = ico.positions;
    for (let i = 0; i < ico.indices.length; i += 3) {
        const a: V3 = scale([v[ico.indices[i] * 3], v[ico.indices[i] * 3 + 1], v[ico.indices[i] * 3 + 2]], s);
        const b: V3 = scale([v[ico.indices[i + 1] * 3], v[ico.indices[i + 1] * 3 + 1], v[ico.indices[i + 1] * 3 + 2]], s);
        const c: V3 = scale([v[ico.indices[i + 2] * 3], v[ico.indices[i + 2] * 3 + 1], v[ico.indices[i + 2] * 3 + 2]], s);
        vol += dot(a, cross(b, c)) / 6;
    }
    const sphereVol = (4 / 3) * Math.PI;
    check('bounding volume overhead is small', vol / sphereVol < 1.15, `volume ${((vol / sphereVol - 1) * 100).toFixed(1)}% over the sphere, scale ${s.toFixed(4)}`);
    const batch = volumeBatch(ico, MAX_LIGHTS);
    check('1024 light volumes fit 16-bit indices', batch.positions.length / 3 <= 65536, `${batch.positions.length / 3} vertices, ${batch.indices.length / 3} triangles`);
}

// ---------------------------------------------------------------- falloff
{
    const r = 2.5;
    let monotonic = true;
    let prev = Infinity;
    for (let k = 0; k <= 1000; k++) {
        const f = falloff((k / 1000) * r, r);
        if (f > prev + 1e-15) monotonic = false;
        prev = f;
    }
    const slope = (falloff(r, r) - falloff(r - 1e-4, r)) / 1e-4;
    check('falloff: 1 at the light, 0 at the radius with zero slope, monotonic',
        falloff(0, r) === 1 && falloff(r, r) === 0 && falloff(r * 1.5, r) === 0 && Math.abs(slope) < 1e-3 && monotonic,
        `slope at r ${slope.toExponential(1)}`);
}

// ---------------------------------------------------------------- G-buffer encoding
{
    let worstDepth = 0;
    for (let k = 0; k <= 20000; k++) {
        const d = (k / 20000) * DEPTH_FAR * 0.999;
        const [hi, lo] = packDepth(d);
        worstDepth = Math.max(worstDepth, Math.abs(unpackDepth(hi, lo) - d));
    }
    check('packed depth round trip', worstDepth < 1e-3, `worst ${(worstDepth * 1000).toFixed(2)} mm over ${DEPTH_FAR} m`);
    let worstAngle = 0;
    for (let k = 0; k < 5000; k++) {
        const z = 0.1 + 0.9 * ((k * 0.618034) % 1), a = k * 2.399963, s = Math.sqrt(1 - z * z);
        const n: V3 = [s * Math.cos(a), s * Math.sin(a), z];
        const [x, y] = packNormal(n);
        const m = unpackNormal(x, y);
        worstAngle = Math.max(worstAngle, Math.acos(Math.min(1, dot(n, norm(m)))));
    }
    check('8-bit normal xy round trip (normals at least 6° off the screen plane)', worstAngle < 0.06, `worst ${((worstAngle * 180) / Math.PI).toFixed(2)}°`);
}

// ---------------------------------------------------------------- single light: the specular hue is exact
{
    const light = { pos: [0.3, 1.2, 0.4] as V3, radius: 3, color: [1, 0.4, 0.1] as V3, intensity: 1.5 };
    const t = lightTerms([0, 0, 0], [0, 1, 0], norm([0.2, 1, 0.6]), light);
    const diffuse = scale(light.color, t.diffuse * light.intensity / light.intensity);
    const spec = specFromBuffer(diffuse, luminance(light.color) * t.spec);
    const exact = scale(light.color, t.spec);
    const err = Math.max(...[0, 1, 2].map((k) => Math.abs(spec[k] - exact[k])));
    check('one light: specular colour rebuilt from the buffer is exact', err < 1e-12, `error ${err.toExponential(1)}`);
}

// ---------------------------------------------------------------- CPU-rendered floor
const W = 320, H = 240;
const eye: V3 = [13, 9, 15];
const forward = norm(sub([0, 0.5, 0], eye));
const right = norm(cross(forward, [0, 1, 0]));
const up = cross(right, forward);
const tanY = Math.tan((22.5 * Math.PI) / 180);
const tanX = tanY * (W / H);
const view: ViewSetup = { eye, right, up, forward, tanX, tanY, near: 0.1, width: W, height: H };
const ALBEDO: V3 = [0.55, 0.54, 0.52];
const SPEC_STRENGTH = 0.5;
const AMBIENT = 0.06;

interface Pixel { px: number; py: number; p: V3; d: number; ndcX: number; ndcY: number }
const floor: Pixel[] = [];
for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
        const ndcX = ((px + 0.5) / W) * 2 - 1, ndcY = ((py + 0.5) / H) * 2 - 1;
        const dir = add(forward, add(scale(right, ndcX * tanX), scale(up, ndcY * tanY)));
        if (dir[1] >= 0) continue;
        const t = -eye[1] / dir[1];
        if (t >= DEPTH_FAR * 0.999) continue;
        floor.push({ px, py, p: add(eye, scale(dir, t)), d: t, ndcX, ndcY });
    }
}

interface Render { out: V3[]; clipped: number; useful: number }

interface DeferredOptions {
    /** G-buffer through 8 bits (false: exact position and normal). */
    gbuffer8: boolean;
    /** Light buffer through 8 bits (false: float sums). */
    bits: boolean;
    dither: boolean;
    lightScale: number;
}
const DEFERRED: DeferredOptions = { gbuffer8: true, bits: true, dither: true, lightScale: LIGHT_SCALE };

/**
 * Renders the floor with `count` lights: forward with float sums in world
 * space when `options` is null, otherwise the deferred path, its 8-bit
 * stages switchable one by one.
 */
function render(field: LightField, count: number, options: DeferredOptions | null): Render {
    const n: V3 = [0, 1, 0];
    const back = scale(forward, -1);
    const out: V3[] = [];
    let clipped = 0, useful = 0;
    const lights = [];
    for (let i = 0; i < count; i++) {
        const P = field.position, C = field.color;
        lights.push({ pos: [P[i * 4], P[i * 4 + 1], P[i * 4 + 2]] as V3, radius: P[i * 4 + 3], color: [C[i * 4], C[i * 4 + 1], C[i * 4 + 2]] as V3, intensity: C[i * 4 + 3] });
    }
    for (const px of floor) {
        let p = px.p, nn = n;
        if (options?.gbuffer8) {
            const [hi, lo] = packDepth(px.d);
            const d = unpackDepth(hi, lo);
            p = add(eye, scale(add(forward, add(scale(right, px.ndcX * tanX), scale(up, px.ndcY * tanY))), d));
            const [nx, ny] = packNormal([dot(n, right), dot(n, up), dot(n, back)]);
            const m = unpackNormal(nx, ny);
            nn = add(scale(right, m[0]), add(scale(up, m[1]), scale(back, m[2])));
        }
        const v = norm(sub(eye, p));
        const diffuse: V3 = [0, 0, 0];
        let specLum = 0;
        const specRgb: V3 = [0, 0, 0];
        const ls = options?.lightScale ?? 1;
        for (let i = 0; i < count; i++) {
            const L = lights[i];
            const t = lightTerms(p, nn, v, L);
            if (t.diffuse === 0 && t.spec === 0) continue;
            useful++;
            const c = scale(L.color, L.intensity);
            if (!options?.bits) {
                for (let k = 0; k < 3; k++) { diffuse[k] += c[k] * t.diffuse * ls; specRgb[k] += c[k] * t.spec; }
                specLum += luminance(c) * t.spec * ls;
            } else {
                const o = options.dither ? bayer(px.px + i, px.py + Math.floor(i / 4)) : 0;
                for (let k = 0; k < 3; k++) diffuse[k] += quantize8(c[k] * t.diffuse * ls, o);
                specLum += quantize8(luminance(c) * t.spec * ls, o);
            }
        }
        if (options?.bits) {
            // The 8-bit buffer saturates at 1 per channel.
            if (Math.max(diffuse[0], diffuse[1], diffuse[2]) > 1) clipped++;
            for (let k = 0; k < 3; k++) diffuse[k] = Math.min(1, diffuse[k]);
            specLum = Math.min(1, specLum);
        }
        for (let k = 0; k < 3; k++) diffuse[k] /= ls;
        specLum /= ls;
        const spec = options ? specFromBuffer(diffuse, specLum) : specRgb;
        out.push(composite(ALBEDO, SPEC_STRENGTH, AMBIENT, diffuse, spec));
    }
    return { out, clipped, useful };
}

/** Per-channel output difference in 8-bit levels: mean, 99th percentile, worst. */
function diff(a: V3[], b: V3[]): { mean: number; p99: number; max: number } {
    const e: number[] = [];
    for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) e.push(Math.abs(a[i][k] - b[i][k]) * 255);
    e.sort((x, y) => x - y);
    return { mean: e.reduce((s, x) => s + x, 0) / e.length, p99: e[Math.floor(e.length * 0.99)], max: e[e.length - 1] };
}
const fmt = (d: { mean: number; p99: number; max: number }): string => `mean ${d.mean.toFixed(2)}, p99 ${d.p99.toFixed(2)}, worst ${d.max.toFixed(2)}`;

/** Mean difference after a 4×4 box filter: what is left once the eye averages fine noise away. */
function boxDiff(a: V3[], b: V3[]): number {
    const index = new Map<number, number>();
    floor.forEach((px, i) => index.set(px.py * W + px.px, i));
    let sum = 0, n = 0;
    for (let by = 0; by + 4 <= H; by += 4) {
        for (let bx = 0; bx + 4 <= W; bx += 4) {
            const sa: V3 = [0, 0, 0], sb: V3 = [0, 0, 0];
            let full = true;
            for (let y = 0; y < 4 && full; y++) for (let x = 0; x < 4; x++) {
                const i = index.get((by + y) * W + bx + x);
                if (i === undefined) { full = false; break; }
                for (let k = 0; k < 3; k++) { sa[k] += a[i][k]; sb[k] += b[i][k]; }
            }
            if (!full) continue;
            for (let k = 0; k < 3; k++) sum += Math.abs(sa[k] - sb[k]) / 16 * 255;
            n += 3;
        }
    }
    return sum / n;
}

{
    const field = new LightField();
    field.update(3, 256);
    const fwd = render(field, 256, null);
    const hueOnly = render(field, 256, { ...DEFERRED, gbuffer8: false, bits: false });
    const floatBuffer = render(field, 256, { ...DEFERRED, bits: false });
    const noDither = render(field, 256, { ...DEFERRED, dither: false });
    const dithered = render(field, 256, DEFERRED);
    console.log(`     floor ${W}×${H}, ${floor.length} pixels, 256 lights; output differences in 8-bit levels:`);
    const hue = diff(hueOnly.out, fwd.out);
    check('specular hue from the buffer vs true specular colour (forward)', hue.mean < 1, fmt(hue));
    const g = diff(floatBuffer.out, hueOnly.out);
    check('8-bit G-buffer vs exact position and normal', g.mean < 0.5, fmt(g));
    const q0 = diff(noDither.out, floatBuffer.out), q1 = diff(dithered.out, floatBuffer.out);
    check('8-bit light buffer vs float, no dither', q0.mean < 1.5, fmt(q0));
    check('8-bit light buffer vs float, dither', q1.mean < 1.5, fmt(q1));
    const boxNo = boxDiff(noDither.out, floatBuffer.out), boxYes = boxDiff(dithered.out, floatBuffer.out);
    check('dither: 4×4-averaged quantisation error drops (bands become fine noise)', boxYes < boxNo * 0.8,
        `${boxNo.toFixed(2)} → ${boxYes.toFixed(2)} levels`);
    const all = diff(dithered.out, fwd.out);
    check('deferred (all of the above) vs forward', all.mean < 2, fmt(all));

    console.log('     light buffer range: clipped pixels and quantisation error (dithered) at 1024 lights');
    field.update(3, 1024);
    const exact1024 = render(field, 1024, { ...DEFERRED, bits: false });
    for (const ls of [0.5, 1 / 3, 0.25]) {
        const r = render(field, 1024, { ...DEFERRED, lightScale: ls });
        const tag = ls === LIGHT_SCALE ? ' (used)' : '';
        check(`range 0..${(1 / ls).toFixed(0)}${tag}`, true,
            `${((r.clipped / floor.length) * 100).toFixed(2)}% of pixels clip; vs float buffer ${fmt(diff(r.out, exact1024.out))}`);
    }

    for (const count of [64, 256, 1024]) {
        field.update(3, count);
        const r = render(field, count, DEFERRED);
        const est = volumePixels(view, field.position, count, 1 / inradius(icosphere(1))) / (W * H);
        check(`${count} lights: light buffer headroom`, r.clipped / floor.length < 0.01,
            `${((r.clipped / floor.length) * 100).toFixed(2)}% of floor pixels clip; lights reaching a pixel ${(r.useful / floor.length).toFixed(2)} on average; volume pixels ≈ ${est.toFixed(1)} per pixel vs forward ${count}`);
    }
}

// ---------------------------------------------------------------- cost model against exact footprints
{
    const field = new LightField();
    const s = 1 / inradius(icosphere(1));
    const views: [string, V3, V3][] = [['overview', eye, [0, 0.5, 0]], ['close-up', [3, 1.6, 3.5], [0, 0.6, 0]]];
    for (const [name, from, to] of views) {
        const f = norm(sub(to, from));
        const rt = norm(cross(f, [0, 1, 0]));
        const u = cross(rt, f);
        const setup: ViewSetup = { eye: from, right: rt, up: u, forward: f, tanX, tanY, near: 0.1, width: W, height: H };
        for (const count of [256, 1024]) {
            field.update(3, count);
            let exact = 0;
            for (let py = 0; py < H; py++) {
                for (let px = 0; px < W; px++) {
                    const ndcX = ((px + 0.5) / W) * 2 - 1, ndcY = ((py + 0.5) / H) * 2 - 1;
                    const ray = add(f, add(scale(rt, ndcX * tanX), scale(u, ndcY * tanY)));
                    const dir = norm(ray);
                    // Distance along the ray at which it crosses the near plane.
                    const tNear = 0.1 * Math.hypot(ray[0], ray[1], ray[2]);
                    for (let i = 0; i < count; i++) {
                        const P = field.position;
                        const oc = sub(from, [P[i * 4], P[i * 4 + 1], P[i * 4 + 2]]);
                        const r = P[i * 4 + 3] * s;
                        const b = dot(oc, dir), c = dot(oc, oc) - r * r;
                        const disc = b * b - c;
                        if (disc >= 0 && -b + Math.sqrt(disc) > tNear) exact++;
                    }
                }
            }
            const est = volumePixels(setup, field.position, count, s);
            check(`${name}, ${count} lights: cost estimate vs exact sphere footprints`, Math.abs(est / exact - 1) < 0.2,
                `${(est / (W * H)).toFixed(2)} vs ${(exact / (W * H)).toFixed(2)} volume pixels per pixel`);
        }
    }
}

// ---------------------------------------------------------------- CPU cost per frame
{
    const field = new LightField();
    const t0 = performance.now();
    for (let k = 0; k < 2000; k++) field.update(k / 60, MAX_LIGHTS);
    const us = ((performance.now() - t0) / 2000) * 1000;
    check('light update + texture fill, 1024 lights', us < 500, `${us.toFixed(1)} µs per frame (Node)`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exitCode = 1;
