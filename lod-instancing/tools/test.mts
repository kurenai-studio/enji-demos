// Headless checks of the LOD pipeline: mesh simplification, culling, level
// selection with hysteresis and cross-fades, the GPU path's texture layouts,
// transform conventions shared by the paths, and impostor frames and mipmaps.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { readFileSync } from 'node:fs';
import { boxDistance, classifyBox, frustumPlanes, INSIDE, OUTSIDE, sphereVisible } from '../assets/game/lod/Culling.ts';
import { makeForest } from '../assets/game/lod/Forest.ts';
import { boundaryEdgeCount, triangleCount, type Geo } from '../assets/game/lod/Geometry.ts';
import { bakeYaw, buildMips, cellCoverage, CELL_PX, FRAMES, viewFrame } from '../assets/game/lod/Impostor.ts';
import { bayer4, DEFAULT_LOD, IMPOSTOR, keeps, LOD_LEVELS, LodSystem, rawLevel, stepLevel, type LodSettings } from '../assets/game/lod/Lod.ts';
import { mergeTrees } from '../assets/game/lod/Merge.ts';
import { symmetricError } from '../assets/game/lod/MeshError.ts';
import { HEADER_ENTRIES, instancePoint, listTextureRows, packInstances, packList, readEntry, TEX_WIDTH } from '../assets/game/lod/Pack.ts';
import * as Shading from '../assets/game/lod/Shading.ts';
import { simplifyClustering, simplifyQem } from '../assets/game/lod/Simplify.ts';
import { buildSpecies, copiesPerChunk, LEVEL_FRACTIONS, MAX_VERTICES } from '../assets/game/lod/Species.ts';
import { mulberry32 } from '../assets/game/lod/Trees.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

const species = buildSpecies();
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

// ---------------------------------------------------------------- GLSL ↔ TS
{
    const chunk = readFileSync(new URL('../assets/resources/effects/chunks/lod-common.chunk', import.meta.url), 'utf8');
    const impostor = readFileSync(new URL('../assets/resources/effects/lod-impostor.effect', import.meta.url), 'utf8');
    const defines = new Map<string, number[]>();
    for (const m of (chunk + impostor).matchAll(/^\s*#define (\w+) (.+)$/gm)) {
        defines.set(m[1], [...m[2].replace(/vec\d\(/g, '(').matchAll(/-?\d+(\.\d+)?(e-?\d+)?/g)].map((x) => Number(x[0])));
    }
    const ts: Record<string, number[]> = {
        SUN_DIR: Shading.SUN_DIR, SUN_COLOR: Shading.SUN_COLOR, SKY_COLOR: Shading.SKY_COLOR, GROUND_COLOR: Shading.GROUND_COLOR,
        FOG_COLOR: Shading.FOG_COLOR, FOG_DENSITY: [Shading.FOG_DENSITY], TEX_WIDTH: [TEX_WIDTH], FRAMES: [FRAMES],
        ROWS: [species.length * 2],
    };
    const wrong = Object.entries(ts).filter(([k, v]) => JSON.stringify(defines.get(k)) !== JSON.stringify(v)).map(([k, v]) => `${k}: ${defines.get(k)} vs ${v}`);
    check('every shared #define (light, fog, texture width, frames, atlas rows) equals the TypeScript constant', wrong.length === 0, wrong.join('; ') || `${Object.keys(ts).length} constants`);

    const tintSrc = chunk.slice(chunk.indexOf('vec3 lodTint'), chunk.indexOf('}', chunk.indexOf('vec3 lodTint')));
    const tints = [...tintSrc.matchAll(/vec3\(([^)]+)\)/g)].map((m) => m[1].split(',').map(Number));
    check('the GLSL level tints equal LOD_TINTS', JSON.stringify(tints) === JSON.stringify(Shading.LOD_TINTS));

    const bayerSrc = chunk.slice(chunk.indexOf('float bayer4'), chunk.indexOf('float ign'));
    const rows = [...bayerSrc.matchAll(/vec4\(([^)]+)\)/g)].map((m) => m[1].split(',').map(Number));
    let same = rows.length === 4;
    for (let y = 0; y < 4 && same; y++) for (let x = 0; x < 4; x++) if ((rows[y][x] + 0.5) / 16 !== bayer4(x, y)) same = false;
    const values = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) values.add(bayer4(x, y));
    check('the GLSL Bayer matrix equals bayer4() and holds each of the 16 levels once', same && values.size === 16);
}

// ---------------------------------------------------------------- meshes and simplification
{
    const closed = species.every((s) => boundaryEdgeCount(s.levels[0].indices) === 0);
    check('every species mesh is closed (no boundary edges)', closed, species.map((s) => `${s.name} ${triangleCount(s.levels[0])} tris`).join(', '));

    const counts = species.map((s) => s.levels.map(triangleCount));
    const onTarget = species.every((s, i) => s.levels.every((g, k) => Math.abs(triangleCount(g) - Math.round(counts[i][0] * LEVEL_FRACTIONS[k])) <= 2));
    check('QEM reaches every level\'s triangle budget (25 % and 8 % of level 0) within 2 triangles', onTarget, counts.map((c) => c.join('/')).join(', '));

    const degenerate = species.reduce((n, s) => n + s.levels.reduce((m, g) => m + degenerateCount(g), 0), 0);
    check('no simplified level has a zero-area triangle', degenerate === 0, `${degenerate}`);

    const ratios: string[] = [];
    let volumeOk = true;
    for (const s of species) {
        const v0 = volume(s.levels[0]);
        const r = s.levels.slice(1).map((g) => volume(g) / v0);
        if (r.some((x) => x < 0.9 || x > 1.05)) volumeOk = false;
        ratios.push(`${s.name} ${r.map((x) => x.toFixed(3)).join('/')}`);
    }
    check('simplified levels keep the enclosed volume within -10 % / +5 %', volumeOk, ratios.join(', '));

    // QEM against vertex clustering at the same budgets.
    const lines: string[] = [];
    let better = true;
    let worstRatio = Infinity;
    for (const s of species) {
        for (const k of [1, 2]) {
            const budget = triangleCount(s.levels[k]);
            const qem = symmetricError(s.levels[0], s.levels[k], 1500, mulberry32(5));
            const cl = symmetricError(s.levels[0], simplifyClustering(s.levels[0], budget), 1500, mulberry32(5));
            const ratio = cl.rms / qem.rms;
            worstRatio = Math.min(worstRatio, ratio);
            if (ratio < 2.5) better = false;
            lines.push(`${s.name} L${k}: ${pct(qem.rms / s.radius)} vs ${pct(cl.rms / s.radius)}`);
        }
    }
    check('at equal budgets QEM\'s RMS surface error is at least 2.5× lower than vertex clustering\'s', better,
        `worst ${worstRatio.toFixed(1)}× (rms / radius: ${lines.join('; ')})`);

    // Screen-space error where each level starts: s = T(1 + h) is the largest size it is drawn at.
    const halfHeight = 540;
    const t = DEFAULT_LOD.thresholds, h = DEFAULT_LOD.hysteresis;
    const px: string[] = [];
    let worst = 0;
    for (const s of species) {
        for (const k of [1, 2]) {
            const e = symmetricError(s.levels[0], s.levels[k], 1500, mulberry32(9));
            const sMax = t[k - 1] * (1 + h);
            const maxPx = (e.max / s.radius) * sMax * halfHeight;
            const rmsPx = (e.rms / s.radius) * sMax * halfHeight;
            worst = Math.max(worst, maxPx);
            px.push(`${s.name} L${k} ${rmsPx.toFixed(2)}/${maxPx.toFixed(1)}`);
        }
    }
    check('at 1080p every mesh level\'s largest deviation is under 6 pixels where it switches in (RMS under 1)', worst < 6,
        `rms/max px: ${px.join(', ')}`);

    const sizes = species.map((s) => s.levels.map(copiesPerChunk));
    const fits = species.every((s) => s.levels.every((g) => copiesPerChunk(g) * (g.positions.length / 3) <= MAX_VERTICES + 1));
    check('each GPU chunk (K copies of a level) fits 16-bit indices', fits, `K per level ${sizes.map((x) => x.join('/')).join(', ')}`);
}

// ---------------------------------------------------------------- culling
const forest = makeForest(16384, 7, species);
{
    const rand = mulberry32(3);
    let agree = 0, total = 0;
    for (let c = 0; c < 20; c++) {
        const m = randomViewProj(rand, forest.size);
        const planes = frustumPlanes(m);
        for (let i = 0; i < 5000; i++) {
            const x = (rand() - 0.5) * 600, y = (rand() - 0.2) * 100, z = (rand() - 0.5) * 600;
            const clip = mulPoint(m, x, y, z);
            const inside = Math.abs(clip[0]) <= clip[3] && Math.abs(clip[1]) <= clip[3] && Math.abs(clip[2]) <= clip[3];
            if (inside === sphereVisible(planes, x, y, z, 0)) agree++;
            total++;
        }
    }
    check('frustum planes from the view-projection matrix agree with the clip-space test on 100K points', agree === total, `${agree}/${total}`);

    let wrong = 0, inside = 0, outside = 0;
    for (let c = 0; c < 20; c++) {
        const planes = frustumPlanes(randomViewProj(rand, forest.size));
        for (let b = 0; b < 500; b++) {
            const min = [(rand() - 0.5) * 500, (rand() - 0.5) * 40, (rand() - 0.5) * 500];
            const max = [min[0] + rand() * 40, min[1] + rand() * 30, min[2] + rand() * 40];
            const cls = classifyBox(planes, min, max);
            let any = false, all = true;
            for (let s = 0; s < 64; s++) {
                const p = [0, 1, 2].map((k) => (s < 8 ? ((s >> k) & 1 ? max[k] : min[k]) : min[k] + rand() * (max[k] - min[k])));
                const vis = sphereVisible(planes, p[0], p[1], p[2], 0);
                any ||= vis; all &&= vis;
            }
            if ((cls === OUTSIDE && any) || (cls === INSIDE && !all)) wrong++;
            if (cls === INSIDE) inside++;
            if (cls === OUTSIDE) outside++;
        }
    }
    check('box classification is conservative (OUTSIDE holds no visible point, INSIDE no hidden one)', wrong === 0, `${outside} outside, ${inside} inside of 10000`);

    // Cell culling + per-tree spheres against testing every tree.
    const sys = new LodSystem(forest, species.map((s) => s.radius), species.map((s) => s.centerY), species.length);
    let mismatches = 0, visibleSum = 0, testsSum = 0;
    for (let c = 0; c < 20; c++) {
        const m = randomViewProj(rand, forest.size);
        const eye = (m as { eye?: number[] }).eye!;
        const planes = frustumPlanes(m);
        sys.update(planes, eye[0], eye[1], eye[2], 2.4, 1 / 60, DEFAULT_LOD);
        const got = new Set<number>();
        for (let e = 0; e < sys.total; e++) got.add(sys.entries[e * 2]);
        for (let i = 0; i < forest.count; i++) {
            const sp = species[forest.species[i]];
            const y = forest.y[i] + sp.centerY * forest.scale[i];
            const d = Math.hypot(forest.x[i] - eye[0], y - eye[1], forest.z[i] - eye[2]);
            const vis = d <= DEFAULT_LOD.maxDistance && sphereVisible(planes, forest.x[i], y, forest.z[i], sp.radius * forest.scale[i]);
            if (vis !== got.has(i)) mismatches++;
        }
        visibleSum += sys.stats.visible;
        testsSum += sys.stats.sphereTests;
    }
    check('cell culling then sphere tests select exactly the trees a test of every tree selects', mismatches === 0,
        `${mismatches} mismatches; ${(visibleSum / 20).toFixed(0)} visible, ${(testsSum / 20).toFixed(0)} sphere tests of ${forest.count} per view`);
}

// ---------------------------------------------------------------- level selection
{
    const set: LodSettings = { ...DEFAULT_LOD };
    const T = set.thresholds[1];
    const switches = (h: number): number => {
        const s2: LodSettings = { ...set, hysteresis: h };
        let level = rawLevel(T * 1.2, s2), n = 0;
        for (let i = 0; i < 2000; i++) {
            // Jitter of ±6 % around the 1|2 boundary, as a camera bobbing in place would cause.
            const s = T * (1 + 0.06 * Math.sin(i * 0.37) * Math.cos(i * 0.11));
            const next = stepLevel(level, s, s2);
            if (next !== level) n++;
            level = next;
        }
        return n;
    };
    check('with 10 % hysteresis a size jittering ±6 % around a boundary never switches levels (without: many times)',
        switches(0.1) === 0 && switches(0) > 50, `${switches(0.1)} vs ${switches(0)} switches in 2000 frames`);

    let monotone = true;
    for (let lv = 0; lv < LOD_LEVELS; lv++) for (let s = 0.001; s < 2; s *= 1.05) {
        const a = stepLevel(lv, s, set), b = rawLevel(s, set);
        if (Math.abs(a - b) > 1) monotone = false;
        if (stepLevel(a, s, set) !== a) monotone = false;
    }
    check('stepLevel settles in one step and stays within one level of the size\'s own level', monotone);

    check('levels: off draws level 0; no impostors stops at level 2',
        rawLevel(0.001, { ...set, enabled: false }) === 0 && rawLevel(0.001, { ...set, impostors: false }) === 2 && rawLevel(0.001, set) === IMPOSTOR);

    let complementary = true, coverageOk = true;
    for (let f = 0.001; f <= 1; f += 0.0137) {
        let incoming = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            const d = bayer4(x, y);
            if (keeps(f, d) === keeps(-f, d)) complementary = false;
            if (keeps(f, d)) incoming++;
        }
        if (Math.abs(incoming / 16 - f) > 1 / 16 + 1e-9) coverageOk = false;
    }
    check('cross-fade masks are complementary: every pixel is drawn by exactly one of the two levels', complementary);
    check('the incoming level covers its fade fraction of each 4×4 block (to 1/16)', coverageOk);
}

// ---------------------------------------------------------------- fades, list packing
{
    const sys = new LodSystem(forest, species.map((s) => s.radius), species.map((s) => s.centerY), species.length);
    const planes = frustumPlanes(lookAtViewProj([0, 30, 0], [0, 0, -1], 1.2, 0.3, 2000));
    const dt = 1 / 60;
    const data = new Float32Array(listTextureRows(forest.count * 2) * TEX_WIDTH * 4);
    // Walk towards -z: trees move up levels and fade.
    let maxFading = 0, roundTrip = true, splitOk = true, frames = 0;
    // Length of each completed fade run (a run cut short by culling or the walk's end is dropped).
    const run = new Int32Array(forest.count), runs: number[] = [];
    for (let k = 0; k < 240; k++) {
        const ez = 150 - k * 1.5;
        const p = frustumPlanes(lookAtViewProj([0, 30, ez], [0, 0, ez - 1], 1.2, 0.3, 2000));
        sys.update(p, 0, 30, ez, 2.4, dt, DEFAULT_LOD);
        packList(sys, data);
        frames++;
        maxFading = Math.max(maxFading, sys.stats.fading);
        // Every bucket reads back exactly its entries, and nothing past its count.
        for (let b = 0; b < sys.buckets && roundTrip; b++) {
            for (let j = 0; j < sys.counts[b]; j++) {
                const e = readEntry(data, b, j);
                const o = (sys.offsets[b] + j) * 2;
                if (!e || e[0] !== sys.entries[o] || e[1] !== sys.entries[o + 1]) roundTrip = false;
                if ((b < sys.steadyBuckets) !== (sys.entries[o + 1] === 1)) splitOk = false;
            }
            if (readEntry(data, b, sys.counts[b]) !== null) roundTrip = false;
        }
        for (let i = 0; i < forest.count; i++) {
            if (sys.level[i] < 0) run[i] = 0;
            else if (sys.fade[i] < 1) run[i]++;
            else if (run[i] > 0) { runs.push(run[i]); run[i] = 0; }
        }
    }
    void planes;
    // The switch frame draws both levels at fade dt / T, so both are drawn for T / dt - 1 frames
    // (24 - 1 at 0.4 s, 60 Hz); float rounding may add the 24th.
    const expected = Math.round(DEFAULT_LOD.fadeSeconds / dt);
    const okFade = runs.length > 0 && runs.every((n) => n === expected - 1 || n === expected);
    check('every packed bucket reads back entry for entry the way the vertex shader reads it', roundTrip, `${frames} frames, header at entry ${HEADER_ENTRIES}`);
    check('steady buckets hold only code-1 entries and fading buckets only fading ones (so steady draws skip the discard)', splitOk);
    check(`a level change cross-fades for ${DEFAULT_LOD.fadeSeconds} s (${expected} frames at 60 Hz) per switch`, okFade,
        `${runs.length} completed fades, lengths ${Math.min(...runs)}–${Math.max(...runs)} frames, up to ${maxFading} at once`);

    const pop = new LodSystem(forest, species.map((s) => s.radius), species.map((s) => s.centerY), species.length);
    let anyFade = 0;
    for (let k = 0; k < 120; k++) {
        const ez = 150 - k * 3;
        pop.update(frustumPlanes(lookAtViewProj([0, 30, ez], [0, 0, ez - 1], 1.2, 0.3, 2000)), 0, 30, ez, 2.4, dt, { ...DEFAULT_LOD, fadeSeconds: 0 });
        anyFade += pop.stats.fading;
        if (pop.total !== pop.stats.visible) anyFade++;
    }
    check('with fades off each visible tree is exactly one entry', anyFade === 0);
}

// ---------------------------------------------------------------- transforms shared by the paths
{
    const inst = packInstances(forest);
    const geos = species.map((s) => s.levels[2]);
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const merged = mergeTrees(forest, items, geos);
    let worst = 0, v = 0;
    for (const i of items) {
        const g = geos[forest.species[i]];
        for (let q = 0; q < g.positions.length / 3; q++, v++) {
            const p = instancePoint(inst, i, g.positions[q * 3], g.positions[q * 3 + 1], g.positions[q * 3 + 2]);
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(p[c] - merged.positions[v * 3 + c]));
        }
    }
    check('the GPU path\'s instance transform equals the merged path\'s pre-transformed vertices', worst < 1e-4, `max diff ${worst.toExponential(1)} m`);

    // Cocos node rotation: quaternion about +Y by the yaw (setRotationFromEuler(0, yaw°, 0)).
    let qWorst = 0;
    for (let i = 0; i < 50; i++) {
        const yaw = forest.yaw[i], s = forest.scale[i];
        const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
        const p = [1.3, 0.7, -2.1];
        const r = quatRotate(q, p);
        const g = instancePoint(inst, i, p[0], p[1], p[2]);
        for (let c = 0; c < 3; c++) qWorst = Math.max(qWorst, Math.abs(g[c] - ([forest.x[i], forest.y[i], forest.z[i]][c] + r[c] * s)));
    }
    check('and both equal the node path\'s quaternion rotation about +Y', qWorst < 1e-4, `max diff ${qWorst.toExponential(1)} m`);
}

// ---------------------------------------------------------------- impostors
{
    const rand = mulberry32(17);
    let exact = true;
    for (let t = 0; t < 1000; t++) {
        const yaw = rand() * Math.PI * 2;
        const k = Math.floor(rand() * FRAMES);
        // Frame k was baked from object-space azimuth k · 2π / F: the camera sits there in world space too.
        const a = yaw + (k * Math.PI * 2) / FRAMES;
        const f = viewFrame(Math.sin(a), Math.cos(a), yaw);
        if (Math.abs(f - k) > 1e-6 && Math.abs(f - k - FRAMES) > 1e-6 && Math.abs(f - k + FRAMES) > 1e-6) exact = false;
    }
    // The bake turns copy k by bakeYaw(k); the bake camera looks from world +Z.
    let bakeOk = true;
    for (let k = 0; k < FRAMES; k++) {
        const y = -bakeYaw(k);
        const dir = [Math.sin(y), Math.cos(y)];
        if (Math.abs(Math.atan2(dir[0], dir[1]) - (((k * Math.PI * 2) / FRAMES + Math.PI) % (Math.PI * 2) - Math.PI)) > 1e-9 &&
            Math.abs(viewFrame(dir[0], dir[1], 0) - k) > 1e-9) bakeOk = false;
    }
    check('the run-time frame for a view from baked azimuth k is exactly k, whatever the tree\'s yaw', exact && bakeOk);

    // Real silhouettes, rasterised as the bake camera sees them, plus a speckled foliage mask.
    const cell = CELL_PX;
    const w = FRAMES * cell, hgt = 4 * cell;
    const atlas = new Uint8Array(w * hgt * 4);
    species.forEach((sp, s) => {
        for (let k = 0; k < FRAMES; k++) rasterSilhouette(sp.levels[0], sp.impostor.size, sp.impostor.centerY, bakeYaw(k), atlas, w, k * cell, s * cell, cell);
    });
    const rnd = mulberry32(4);
    for (let k = 0; k < FRAMES; k++) {
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
            const dx = x / cell - 0.5, dy = y / cell - 0.5;
            if (dx * dx + dy * dy < 0.16 && rnd() < 0.3) atlas[((3 * cell + y) * w + k * cell + x) * 4 + 3] = 255;
        }
    }
    const naive = buildMips(atlas, w, hgt, cell, 4, false, 4);
    const kept = buildMips(atlas, w, hgt, cell, 4, true, 4);
    const levels = naive.data.length;
    // Relative coverage change per cell over levels [from, to), and the same in whole texels of that level.
    const drift = (chain: typeof naive, row: number, from: number, to: number): { rel: number; texels: number } => {
        let rel = 0, texels = 0;
        for (let l = from; l < to; l++) for (let k = 0; k < FRAMES; k++) {
            const c0 = cellCoverage(chain, 0, k, row, cell), d = Math.abs(cellCoverage(chain, l, k, row, cell) - c0);
            rel = Math.max(rel, d / c0);
            texels = Math.max(texels, d * (cell >> l) ** 2);
        }
        return { rel, texels };
    };
    const rows = ['conifer', 'broadleaf', 'rock', 'speckled'];
    const fine = levels - 2; // cells of 16 px and larger
    const report = rows.map((name, r) => `${name} ${pct(drift(naive, r, 1, fine).rel)} → ${pct(drift(kept, r, 1, fine).rel)}`).join(', ');
    const real = [0, 1, 2];
    const maxKept = Math.max(...real.map((r) => drift(kept, r, 1, fine).rel));
    const noWorse = rows.every((_, r) => drift(kept, r, 1, levels).rel <= drift(naive, r, 1, levels).rel + 1e-9);
    check('coverage-preserving mips keep the species\' alpha-test coverage within 5 % of level 0 down to 16-pixel cells, never worse than plain mips',
        maxKept < 0.05 && noWorse, `worst change per cell, plain → preserved: ${report}`);
    const coarse = real.map((r) => drift(kept, r, fine, levels).texels);
    check('at 8- and 4-pixel cells the species miss it by at most 1 texel (a 4×4 cell has only 16 coverage steps)', Math.max(...coarse) <= 1 + 1e-9,
        real.map((r) => `${rows[r]} ${coarse[r].toFixed(2)}`).join(', '));
    const speckPlain = drift(naive, 3, 1, levels).rel, speckKept = drift(kept, 3, 1, levels).rel;
    check('plain mips lose a speckled crown entirely; preserved mips keep it within 30 % (one scale per cell moves whole alpha classes)', speckPlain > 0.9 && speckKept < 0.3,
        `speckled, all levels: plain ${pct(speckPlain)} → preserved ${pct(speckKept)}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------- helpers
function degenerateCount(g: Geo): number {
    let n = 0;
    const p = g.positions;
    for (let f = 0; f < g.indices.length; f += 3) {
        const a = g.indices[f] * 3, b = g.indices[f + 1] * 3, c = g.indices[f + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-10) n++;
    }
    return n;
}

/** Enclosed volume by the divergence theorem (sum of signed tetrahedra). */
function volume(g: Geo): number {
    let v = 0;
    const p = g.positions;
    for (let f = 0; f < g.indices.length; f += 3) {
        const a = g.indices[f] * 3, b = g.indices[f + 1] * 3, c = g.indices[f + 2] * 3;
        v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    }
    return v;
}

type M4 = Float64Array & { eye?: number[] };

/** Column-major GL perspective × look-at, like Cocos' camera matrices. */
function lookAtViewProj(eye: number[], target: number[], fovY: number, near: number, far: number, aspect = 1.6): M4 {
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    const fw = f.map((x) => x / fl);
    let r = [fw[1] * 0 - fw[2] * 1, fw[2] * 0 - fw[0] * 0, fw[0] * 1 - fw[1] * 0];
    const rl = Math.hypot(r[0], r[1], r[2]);
    r = r.map((x) => x / rl);
    const u = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
    const view = new Float64Array(16);
    view.set([r[0], u[0], -fw[0], 0, r[1], u[1], -fw[1], 0, r[2], u[2], -fw[2], 0,
        -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]), -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]), fw[0] * eye[0] + fw[1] * eye[1] + fw[2] * eye[2], 1]);
    const t = 1 / Math.tan(fovY / 2);
    const proj = new Float64Array(16);
    proj.set([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
    const out: M4 = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += proj[k * 4 + rr] * view[c * 4 + k];
        out[c * 4 + rr] = s;
    }
    out.eye = eye;
    return out;
}

function randomViewProj(rand: () => number, size: number): M4 {
    const eye = [(rand() - 0.5) * size * 0.8, 5 + rand() * 40, (rand() - 0.5) * size * 0.8];
    const a = rand() * Math.PI * 2;
    const target = [eye[0] + Math.cos(a) * 50, eye[1] - 5 - rand() * 20, eye[2] + Math.sin(a) * 50];
    return lookAtViewProj(eye, target, 0.7 + rand() * 0.6, 0.3, 500);
}

function mulPoint(m: ArrayLike<number>, x: number, y: number, z: number): number[] {
    return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
}

function quatRotate(q: number[], v: number[]): number[] {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** Orthographic coverage of a mesh turned by `yaw`, as the bake camera (looking along -Z) sees it, into one atlas cell. */
function rasterSilhouette(g: Geo, size: number, centerY: number, yaw: number, out: Uint8Array, w: number, x0: number, y0: number, cell: number): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const n = g.positions.length / 3;
    const sx = new Float64Array(n), sy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const px = g.positions[i * 3], py = g.positions[i * 3 + 1], pz = g.positions[i * 3 + 2];
        const wx = px * c + pz * s;
        sx[i] = (wx / size + 0.5) * cell;
        sy[i] = (0.5 - (py - centerY) / size) * cell;
    }
    for (let f = 0; f < g.indices.length; f += 3) {
        const a = g.indices[f], b = g.indices[f + 1], d = g.indices[f + 2];
        const minX = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[d]))), maxX = Math.min(cell - 1, Math.ceil(Math.max(sx[a], sx[b], sx[d])));
        const minY = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[d]))), maxY = Math.min(cell - 1, Math.ceil(Math.max(sy[a], sy[b], sy[d])));
        const area = (sx[b] - sx[a]) * (sy[d] - sy[a]) - (sy[b] - sy[a]) * (sx[d] - sx[a]);
        if (Math.abs(area) < 1e-12) continue;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((sx[b] - px) * (sy[d] - py) - (sy[b] - py) * (sx[d] - px)) / area;
            const w1 = ((sx[d] - px) * (sy[a] - py) - (sy[d] - py) * (sx[a] - px)) / area;
            if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) out[((y0 + y) * w + x0 + x) * 4 + 3] = 255;
        }
    }
}

void boxDistance;
void simplifyQem;
