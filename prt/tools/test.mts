// Headless checks of the PRT pipeline: the SH basis and closed-form
// projections, the BVH, transfer against analytic view factors and a white
// furnace, the band-limited identity, windowing, buried-vertex dilation,
// texture layouts against the shader, and GLSL ↔ TS constants.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { readFileSync } from 'node:fs';
import { Bake, RGB_STRIDE } from '../assets/game/prt/Bake.ts';
import { Bvh } from '../assets/game/prt/Bvh.ts';
import { posed, presets, projectEnv, projectSky, radiance, withGroundBounce, type Env } from '../assets/game/prt/Env.ts';
import * as Pack from '../assets/game/prt/Pack.ts';
import { prtRadiance, Reference, relativeRms } from '../assets/game/prt/Reference.ts';
import { Builder, colonnadeScene, GROUND, knotScene, SCENES, type SceneGeo } from '../assets/game/prt/Scenes.ts';
import {
    addZonal, BAND_OF, BANDS, basis, capMoments, COEFFS, cosineDirections, COSINE_LOBE, evalRgb, hannWindow, legendre,
    sphereDirections, truncate,
} from '../assets/game/prt/SH.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

/** ∫_c^1 f(t) dt by Simpson's rule. */
function integrate(f: (t: number) => number, a: number, b: number, n = 4000): number {
    const h = (b - a) / n;
    let s = f(a) + f(b);
    for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
    return (s * h) / 3;
}

/** Sphere of radius r at height h over a ground disc of radius R, all of one albedo. */
function sphereOverGround(r: number, h: number, R: number, albedo: number, rings = 40): SceneGeo {
    const b = new Builder();
    b.sphere([0, h, 0], r, 48, 24, [albedo, albedo, albedo]);
    b.ground(R, rings, 96, [albedo, albedo, albedo]);
    return b.finish('test', h, r);
}

function uniformEnv(l: number): Env {
    return { name: 'uniform', zenith: [l, l, l], horizon: [l, l, l], below: [l, l, l], lamps: [] };
}

// ---------------------------------------------------------------- SH basis
{
    const n = 60000, dirs = sphereDirections(n), y = new Float64Array(COEFFS);
    const gram = new Float64Array(COEFFS * COEFFS);
    for (let i = 0; i < n; i++) {
        basis(dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], y);
        for (let a = 0; a < COEFFS; a++) for (let b = 0; b < COEFFS; b++) gram[a * COEFFS + b] += y[a] * y[b];
    }
    let worst = 0;
    for (let a = 0; a < COEFFS; a++) for (let b = 0; b < COEFFS; b++) {
        worst = Math.max(worst, Math.abs((gram[a * COEFFS + b] * 4 * Math.PI) / n - (a === b ? 1 : 0)));
    }
    check('25 basis functions are orthonormal over the sphere', worst < 2e-3, `worst |⟨Y_i, Y_j⟩ − δ_ij| = ${worst.toExponential(1)}`);

    // Addition theorem: Σ_m Y_lm(d)² = (2l + 1) / 4π for every direction.
    let addWorst = 0;
    for (let i = 0; i < 500; i++) {
        basis(dirs[i * 117 * 3], dirs[i * 117 * 3 + 1], dirs[i * 117 * 3 + 2], y);
        for (let l = 0; l < BANDS; l++) {
            let s = 0;
            for (let k = l * l; k < (l + 1) * (l + 1); k++) s += y[k] * y[k];
            addWorst = Math.max(addWorst, Math.abs(s - (2 * l + 1) / (4 * Math.PI)));
        }
    }
    check('each band satisfies the addition theorem (rotation invariant)', addWorst < 1e-12, `worst ${addWorst.toExponential(1)}`);
}

// ---------------------------------------------------------------- zonal closed forms
{
    const lobeErr = Math.max(...COSINE_LOBE.map((a, l) => Math.abs(a - 2 * Math.PI * integrate((t) => legendre(t, BANDS)[l] * t, 0, 1))));
    check('clamped-cosine moments Â_l = π, 2π/3, π/4, 0, −π/24', lobeErr < 1e-9, `worst ${lobeErr.toExponential(1)}`);
    const alpha = 0.4, k = capMoments(alpha);
    const capErr = Math.max(...k.map((m, l) => Math.abs(m - 2 * Math.PI * integrate((t) => legendre(t, BANDS)[l], Math.cos(alpha), 1))));
    check('cap moments match numeric integration', capErr < 1e-9, `α = 0.4, worst ${capErr.toExponential(1)}`);

    // A cap projected in closed form vs by brute force over the sphere.
    const d = [0.3, 0.8, -0.52], dl = Math.hypot(...d), dn = d.map((x) => x / dl);
    const closed = new Float64Array(COEFFS * 3);
    addZonal(closed, k, dn, [1, 1, 1]);
    const n = 400000, dirs = sphereDirections(n), y = new Float64Array(COEFFS), numeric = new Float64Array(COEFFS);
    for (let i = 0; i < n; i++) {
        const x = dirs[i * 3], yy = dirs[i * 3 + 1], z = dirs[i * 3 + 2];
        if (x * dn[0] + yy * dn[1] + z * dn[2] < Math.cos(alpha)) continue;
        basis(x, yy, z, y);
        for (let c = 0; c < COEFFS; c++) numeric[c] += (y[c] * 4 * Math.PI) / n;
    }
    const projErr = Math.max(...Array.from(numeric, (v, c) => Math.abs(v - closed[c * 3])));
    check('rotated cap projection equals brute-force projection', projErr < 2e-3, `worst ${projErr.toExponential(1)} (|L_00| = ${closed[0].toFixed(3)})`);
}

// ---------------------------------------------------------------- windowing
{
    // A small lamp alone: the cut-off series rings into negative light; Hann tames it.
    const env: Env = { name: 'lamp', zenith: [0, 0, 0], horizon: [0, 0, 0], below: [0, 0, 0], lamps: [{ dir: [0, 1, 0], alpha: 0.12, irradiance: [1, 1, 1] }] };
    const minOf = (window: boolean): number => {
        const sh = new Float64Array(COEFFS * 3);
        projectEnv(env, projectSky(env), sh);
        truncate(sh, BANDS, window ? hannWindow(BANDS) : null);
        const dirs = sphereDirections(5000), out = [0, 0, 0];
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < 5000; i++) {
            evalRgb(sh, dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2], out);
            min = Math.min(min, out[0]);
            max = Math.max(max, out[0]);
        }
        return min / max;
    };
    const raw = minOf(false), hann = minOf(true);
    check('Hann window shrinks the negative lobes of a small lamp', raw < -0.05 && Math.abs(hann) < Math.abs(raw) / 3,
        `min / max: plain ${raw.toFixed(3)}, Hann ${hann.toFixed(3)}`);
}

// ---------------------------------------------------------------- BVH
{
    const geo = knotScene();
    const bvh = new Bvh(geo.positions, geo.indices);
    const P = geo.positions, I = geo.indices, nt = I.length / 3;
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let mismatches = 0, hits = 0;
    for (let r = 0; r < 300; r++) {
        const o = [rnd() * 6 - 3, rnd() * 2.5, rnd() * 6 - 3];
        let d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        const l = Math.hypot(d[0], d[1], d[2]);
        d = d.map((x) => x / l);
        let best = Infinity, bestTri = -1;
        for (let t = 0; t < nt; t++) {
            const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
            const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
            const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
            const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
            if (Math.abs(det) < 1e-14) continue;
            const s = [o[0] - P[a], o[1] - P[a + 1], o[2] - P[a + 2]];
            const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
            if (u < 0 || u > 1) continue;
            const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
            const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
            if (v < 0 || u + v > 1) continue;
            const t2 = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
            if (t2 > 0 && t2 < best) { best = t2; bestTri = t; }
        }
        const got = bvh.intersect(o[0], o[1], o[2], d[0], d[1], d[2], Infinity);
        if (bestTri >= 0) hits++;
        if (got !== bestTri || (got >= 0 && Math.abs(bvh.hitT - best) > 1e-9)) mismatches++;
        if (bvh.occluded(o[0], o[1], o[2], d[0], d[1], d[2], Infinity) !== bestTri >= 0) mismatches++;
    }
    check('BVH closest hit and any hit agree with brute force', mismatches === 0, `${hits}/300 rays hit, ${bvh.nodeCount} nodes, ${mismatches} mismatches`);
}

// ---------------------------------------------------------------- transfer: analytic cases
{
    // A lone convex sphere sees the whole sky: shadowed transfer must equal Â_l Y(n) / π.
    const b = new Builder();
    b.sphere([0, 0, 0], 1, 48, 24, [1, 1, 1]);
    const bake = new Bake(b.finish('sphere', 0, 1), 256, 0).run();
    let worst = 0;
    for (let v = 0; v < bake.vertexCount; v++) for (let k = 0; k < COEFFS; k++) {
        worst = Math.max(worst, Math.abs(bake.shadowed[v * COEFFS + k] - bake.unshadowed[v * COEFFS + k]));
    }
    check('convex sphere: shadowed transfer = unshadowed (no occlusion)', worst < 0.02, `worst |ΔT| = ${worst.toFixed(4)} (T_00 = ${(0.5 / Math.sqrt(Math.PI)).toFixed(3)})`);
}
{
    // Ground point at distance d from a sphere's centre (fully above its horizon), uniform sky of
    // radiance 1: B = ρ (1 − F), F = (r/d)² cos θ the view factor to the sphere.
    const r = 0.5, h = 1.2;
    const geo = sphereOverGround(r, h, 5, 1);
    const bake = new Bake(geo, 1024, 0).run();
    const light = new Float64Array(COEFFS * 3);
    const env = uniformEnv(1);
    projectEnv(env, projectSky(env), light);
    let worst = 0, n = 0;
    const P = geo.positions;
    for (let v = 0; v < geo.vertexCount; v++) {
        if (P[v * 3 + 1] !== 0) continue;
        const x = Math.hypot(P[v * 3], P[v * 3 + 2]);
        if (x > 1.5) continue;
        const d = Math.hypot(x, h), cos = h / d;
        const expected = 1 - (r / d) ** 2 * cos;
        let got = 0;
        for (let k = 0; k < COEFFS; k++) got += bake.shadowed[v * COEFFS + k] * light[k * 3];
        worst = Math.max(worst, Math.abs(got - expected));
        n++;
    }
    check('ground under a sphere matches the analytic view factor', worst < 0.01, `${n} ground vertices, worst |ΔB| = ${worst.toFixed(4)} (F up to ${((r / h) ** 2).toFixed(3)})`);
}
{
    // White furnace: albedo 1 everywhere under uniform light 1. Every surface then leaves radiance 1,
    // reached only with all bounces; each bounce must close part of the gap.
    const geo = sphereOverGround(0.5, 0.9, 6, 1, 48);
    const bake = new Bake(geo, 512, 10).run();
    const light = new Float64Array(COEFFS * 3);
    const env = uniformEnv(1);
    projectEnv(env, projectSky(env), light);
    const out = new Float32Array(geo.vertexCount * 3), tr = new Float32Array(geo.vertexCount * RGB_STRIDE);
    const P = geo.positions;
    const near = (v: number): boolean => Math.hypot(P[v * 3], P[v * 3 + 2]) < 1.5;
    const stats = (mode: number): [number, number] => {
        bake.transfer(mode, tr);
        prtRadiance(tr, light, geo.vertexCount, out);
        let lo = Infinity, hi = -Infinity;
        for (let v = 0; v < geo.vertexCount; v++) if (near(v)) { lo = Math.min(lo, out[v * 3]); hi = Math.max(hi, out[v * 3]); }
        return [lo, hi];
    };
    const [sLo] = stats(1), [iLo, iHi] = stats(2);
    check('white furnace: interreflected radiance → 1 where shadowed falls short', sLo < 0.8 && iLo > 0.97 && iHi < 1.02,
        `shadowed min ${sLo.toFixed(3)}, 10 bounces ${iLo.toFixed(3)}–${iHi.toFixed(3)}`);
    // The reference (radiance through the same W) must agree exactly for a band-limited light.
    const ref = new Reference(bake, env, 10).run();
    bake.transfer(2, tr);
    prtRadiance(tr, light, geo.vertexCount, out);
    const diff = relativeRms(out, ref.total);
    check('uniform light: PRT interreflected = reference (same rays, same W)', diff < 2e-3, `relative RMS ${diff.toExponential(1)}`);
}

// ---------------------------------------------------------------- band-limited identity
{
    // For a light inside the 25 coefficients, Σ L_i T_i = ρ/M Σ_escaped L(ω_j) on the bake's own rays.
    const geo = colonnadeScene();
    const bake = new Bake(geo, 128, 0).run();
    const light = new Float64Array(COEFFS * 3);
    let seed = 3;
    for (let i = 0; i < light.length; i++) light[i] = ((seed = (seed * 48271) % 2147483647) / 2147483647 - 0.3) * (i < 3 ? 4 : 1);
    const tr = new Float32Array(geo.vertexCount * RGB_STRIDE), out = new Float32Array(geo.vertexCount * 3);
    bake.transfer(1, tr);
    prtRadiance(tr, light, geo.vertexCount, out);
    const dir = [0, 0, 0], l = [0, 0, 0];
    let worst = 0, scale = 0;
    for (let v = 0; v < geo.vertexCount; v += 7) {
        if (bake.buried[v]) continue;
        let r = 0;
        for (let j = 0; j < bake.rays; j++) {
            if (!bake.escapedRay(v, j)) continue;
            bake.rayDirection(v, j, dir);
            evalRgb(light, dir[0], dir[1], dir[2], l);
            r += l[0];
        }
        r *= geo.albedo[v * 3] / bake.rays;
        worst = Math.max(worst, Math.abs(r - out[v * 3]));
        scale = Math.max(scale, Math.abs(r));
    }
    check('band-limited light: Σ L_i T_i = ρ/M Σ_escaped L(ω_j)', worst < 1e-5 * scale, `worst ${worst.toExponential(1)} of ${scale.toFixed(2)}`);
}

// ---------------------------------------------------------------- dilation
{
    const geo = colonnadeScene();
    const bake = new Bake(geo, 128, 1).run();
    const P = geo.positions;
    let underPlinth = 0, buriedUnder = 0, buriedOutside = 0, darkest = Infinity;
    for (let v = 0; v < geo.vertexCount; v++) {
        if (P[v * 3 + 1] !== 0 || geo.normals[v * 3 + 1] !== 1) continue;
        const inside = Math.abs(P[v * 3]) < 1.65 && Math.abs(P[v * 3 + 2]) < 0.85;
        const outside = Math.abs(P[v * 3]) > 1.8 || Math.abs(P[v * 3 + 2]) > 1.0;
        if (inside) { underPlinth++; buriedUnder += bake.buried[v]; }
        if (outside) buriedOutside += bake.buried[v];
        if (inside) darkest = Math.min(darkest, bake.shadowed[v * COEFFS]);
    }
    check('ground under the plinth is buried and filled from outside', buriedUnder === underPlinth && buriedOutside === 0 && darkest > 0.05,
        `${buriedUnder}/${underPlinth} buried under, ${buriedOutside} outside; filled T_00 ≥ ${darkest.toFixed(3)}`);
}

// ---------------------------------------------------------------- scenes
{
    for (const make of SCENES) {
        const g = make();
        const P = g.positions, N = g.normals, I = g.indices;
        let bad = 0, degenerate = 0;
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
            const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
            if (Math.hypot(n[0], n[1], n[2]) < 1e-12) { degenerate++; continue; }
            const s = [0, 1, 2].map((k) => N[a + k] + N[b + k] + N[c + k]);
            if (n[0] * s[0] + n[1] * s[1] + n[2] * s[2] <= 0) bad++;
        }
        check(`${g.name}: every triangle winds towards its vertex normals`, bad === 0 && g.vertexCount < 65536,
            `${g.vertexCount} vertices, ${I.length / 3} triangles (${degenerate} degenerate at poles), ${bad} flipped`);
    }
}

// ---------------------------------------------------------------- PRT vs reference on the real scenes
{
    const rows: string[] = [];
    let monotone = true, overcastOk = true, shadowHelps = true;
    for (const make of SCENES) {
        const geo = make();
        const bake = new Bake(geo, 256, 3).run();
        const tr = new Float32Array(geo.vertexCount * RGB_STRIDE), out = new Float32Array(geo.vertexCount * 3);
        for (const base of presets().map((e) => withGroundBounce(e, GROUND))) {
            const env = posed(base, 0, 1);
            const full = new Float64Array(COEFFS * 3);
            projectEnv(env, projectSky(env), full);
            const ref = new Reference(bake, env, 3).run();
            const errs = [0, 1, 2].map((mode) => {
                bake.transfer(mode, tr);
                return [1, 2, 3, 4, 5].map((bands) => {
                    const l = Float64Array.from(full);
                    truncate(l, bands, null);
                    prtRadiance(tr, l, geo.vertexCount, out);
                    return relativeRms(out, mode === 2 ? ref.total : ref.direct);
                });
            });
            const s = errs[1];
            if (!(s[4] < s[2] && s[2] < s[1])) monotone = false;
            if (env.name === 'Overcast' && errs[1][4] > 0.02) overcastOk = false;
            if (errs[1][4] > errs[0][4] / 3) shadowHelps = false;
            rows.push(`${geo.name.padEnd(9)} ${env.name.padEnd(8)} unshadowed ${pct(errs[0][4])}  shadowed n=1..5 ${s.map((e) => (e * 100).toFixed(1)).join(' / ')}%  interreflected ${pct(errs[2][4])}`);
        }
    }
    check('PRT error falls as bands are added (n = 2 → 3 → 5)', monotone);
    check('overcast sky: shadowed PRT within 2% of the reference at 5 bands', overcastOk);
    check('visibility cuts the error at least 3× against unshadowed', shadowHelps);
    for (const r of rows) console.log(`      ${r}`);
}

// ---------------------------------------------------------------- textures ↔ shader
{
    const geo = knotScene();
    const bake = new Bake(geo, 64, 1).run();
    const nv = geo.vertexCount;
    const tr = new Float32Array(nv * RGB_STRIDE), out = new Float32Array(nv * 3);
    bake.transfer(2, tr);
    const env = posed(presets()[3], 0.7, 1), light = new Float64Array(COEFFS * 3);
    projectEnv(env, projectSky(env), light);
    prtRadiance(tr, light, nv, out);
    const tex = new Float32Array(Pack.transferRows(nv) * Pack.TRANSFER_WIDTH * 4), lt = new Float32Array(Pack.TEXELS_PER_VERTEX * 4);
    Pack.packTransfer(tr, nv, tex);
    Pack.packLight(light, lt);
    let worst = 0;
    const c = [0, 0, 0];
    for (let v = 0; v < nv; v++) {
        Pack.shadeFromTextures(tex, lt, v, c);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(c[k] - out[v * 3 + k]) / (Math.abs(out[v * 3 + k]) + 1e-3));
    }
    check('packed textures reproduce Σ L_k T_k for every vertex', worst < 1e-4, `${nv} vertices, ${Pack.transferRows(nv)} rows, worst relative ${worst.toExponential(1)}`);
}

// ---------------------------------------------------------------- GLSL ↔ TS
{
    const chunk = readFileSync(new URL('../assets/resources/effects/chunks/prt-common.chunk', import.meta.url), 'utf8');
    const define = (name: string): number => Number(new RegExp(`#define ${name} ([\\d.]+)`).exec(chunk)?.[1]);
    check('chunk texture layout matches Pack.ts',
        define('GROUPS') === Pack.GROUPS && define('TEXELS_PER_VERTEX') === Pack.TEXELS_PER_VERTEX
        && define('VERTS_PER_ROW') === Pack.VERTS_PER_ROW && define('TRANSFER_WIDTH') === Pack.TRANSFER_WIDTH);

    // Evaluate the GLSL basis by turning its expressions into JS.
    const body = /void shBasis[^{]*\{([\s\S]*?)\n\}/.exec(chunk)![1];
    const js = body.replace(/float /g, 'let ').replace(/vec4\(/g, '[').replace(/\b(\d+\.\d*)\b/g, '$1')
        .replace(/b\[(\d)\] = \[(.*)\);/g, 'b[$1] = [$2];').replace(/out vec4 b\[7\]/, '');
    const glslBasis = new Function('d', `const b = []; ${js} return b.flat();`) as (d: { x: number; y: number; z: number }) => number[];
    const y = new Float64Array(COEFFS), dirs = sphereDirections(200);
    let worst = 0;
    for (let i = 0; i < 200; i++) {
        const d = { x: dirs[i * 3], y: dirs[i * 3 + 1], z: dirs[i * 3 + 2] };
        basis(d.x, d.y, d.z, y);
        const g = glslBasis(d);
        for (let k = 0; k < COEFFS; k++) worst = Math.max(worst, Math.abs(g[k] - y[k]));
        if (g.length !== 28) worst = Infinity;
    }
    check('GLSL shBasis = SH.ts basis (25 values + 3 zero pads)', worst < 1e-12, `worst ${worst.toExponential(1)}`);

    const sky = readFileSync(new URL('../assets/resources/effects/prt-sky.effect', import.meta.url), 'utf8');
    const env = withGroundBounce(posed(presets()[0], 0.3, 1), GROUND), out = [0, 0, 0];
    radiance(env, 0, 1, 0, out);
    check('sky shader uses the same gradient as Env.skyRadiance', /mix\(horizon\.rgb, zenith\.rgb, sqrt\(d\.y\)\)/.test(sky) && /d\.y < 0\.0 \? below\.rgb/.test(sky),
        `zenith radiance ${out.map((x) => x.toFixed(2)).join(', ')}`);
}

// ---------------------------------------------------------------- misc
{
    const dirs = cosineDirections(4096);
    let mean = 0;
    for (let i = 0; i < 4096; i++) mean += dirs[i * 3 + 2];
    mean /= 4096;
    check('cosine-distributed rays have mean cos θ = 2/3', Math.abs(mean - 2 / 3) < 1e-3, `${mean.toFixed(4)}`);
    const w = hannWindow(5);
    check('Hann window: 1 at band 0, falling, 0 past the kept bands', w[0] === 1 && w.every((x, i) => i === 0 || x < w[i - 1]) && hannWindow(3)[4] === 0,
        w.map((x) => x.toFixed(3)).join(' '));
    check('band table covers 25 coefficients', BAND_OF.length === 25 && BAND_OF[24] === 4 && BAND_OF[9] === 3);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
