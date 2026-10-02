// Offline light bake: node --import ./tools/ts-resolve.mjs tools/bake.mts
//
// 1. At every bake-grid corner of every quad: direct irradiance from the area
//    light with shadows, then indirect irradiance from `BOUNCES` rounds of
//    cosine-weighted hemisphere gathering (each round reads the previous
//    round's result, so round n carries n reflections). Stored separately so
//    the runtime can toggle direct light and let moving objects shadow it.
// 2. An L2 spherical harmonics irradiance probe at every point of a grid in
//    the room: radiance reflected by the walls from `PROBE_RAYS` evenly spread
//    directions (not the light itself, which the runtime adds analytically),
//    projected and convolved. Probes inside a block take the mean of their
//    valid neighbours.
//
// Writes assets/resources/bake/cornell.json; run `enji import` on it after.
import { writeFileSync, mkdirSync } from 'node:fs';
import { Baked, type BakeData } from '../assets/game/pbr/Baked';
import { BLOCKS, castRay, directFactor, type Hit, LIGHT, QUADS, quadPoint, type V3 } from '../assets/game/pbr/Room';
import { convolve, SH_COEFFS, shBasis, sphereDirections } from '../assets/game/pbr/SH';

const BOUNCES = 4;
const RAYS = 1024;
const PROBE_DIMS: V3 = [5, 4, 5];
const PROBE_MIN: V3 = [-1.7, 0.3, -1.7];
const PROBE_MAX: V3 = [1.7, 2.7, 1.7];
const PROBE_RAYS = 2048;

const t0 = performance.now();

function radicalInverse(i: number): number {
    let bits = i;
    bits = ((bits << 16) | (bits >>> 16)) >>> 0;
    bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
    bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
    bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
    bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
    return bits / 4294967296;
}

let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

interface Point { p: V3; n: V3; t: V3; b: V3 }

function frame(n: V3): { t: V3; b: V3 } {
    const up: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t: V3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
    const l = Math.hypot(t[0], t[1], t[2]);
    t[0] /= l; t[1] /= l; t[2] /= l;
    const b: V3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    return { t, b };
}

// Ceiling corners behind the light panel are never seen but would interpolate
// darkness past its edges, so sample them just outside the panel instead.
function hideFromLight(p: V3): void {
    const edge = LIGHT.half + 0.03;
    if (Math.abs(p[0]) > edge || Math.abs(p[2]) > edge) return;
    if (edge - Math.abs(p[0]) < edge - Math.abs(p[2])) p[0] = Math.sign(p[0] || 1) * edge;
    else p[2] = Math.sign(p[2] || 1) * edge;
}

// Floor corners under a block are black and would smear a jagged dark rim
// around its rotated edges, so sample them just outside the footprint instead.
function leaveBlocks(p: V3): void {
    const margin = 0.02;
    for (const b of BLOCKS) {
        const c = Math.cos(b.angle), s = Math.sin(b.angle);
        const dx = p[0] - b.x, dz = p[2] - b.z;
        let lx = dx * c - dz * s, lz = dx * s + dz * c;
        const edge = b.half + margin;
        if (Math.abs(lx) > edge || Math.abs(lz) > edge || p[1] > b.height) continue;
        if (edge - Math.abs(lx) < edge - Math.abs(lz)) lx = Math.sign(lx || 1) * edge;
        else lz = Math.sign(lz || 1) * edge;
        p[0] = b.x + lx * c + lz * s;
        p[2] = b.z - lx * s + lz * c;
    }
}

// Sample points at the grid corners, nudged inside the face and off the surface.
const points: Point[][] = QUADS.map((q) => {
    const { t, b } = frame(q.normal);
    const list: Point[] = [];
    for (let j = 0; j <= q.nv; j++) {
        for (let i = 0; i <= q.nu; i++) {
            const a = Math.min(Math.max(i / q.nu, 0.002), 0.998);
            const c = Math.min(Math.max(j / q.nv, 0.002), 0.998);
            const p = quadPoint(q, a, c, 1e-3);
            if (q.name === 'ceiling') hideFromLight(p);
            if (q.name === 'floor') leaveBlocks(p);
            list.push({ p, n: q.normal, t, b });
        }
    }
    return list;
});
const pointCount = points.reduce((s, l) => s + l.length, 0);

const direct = points.map((list) => Float32Array.from(list, (pt) => directFactor(pt.p, pt.n)));
console.log(`direct light: ${pointCount} points in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const probeStub = { dims: PROBE_DIMS, min: PROBE_MIN, max: PROBE_MAX, sh: [] as number[] };
const toFaces = (indirect: Float32Array[]) => QUADS.map((q, i) => ({ name: q.name, nu: q.nu, nv: q.nv, e: Array.from(indirect[i]), d: Array.from(direct[i]) }));

let indirect = points.map((list) => new Float32Array(list.length * 3));
const hit: Hit = { quad: -1, t: 0, a: 0, b: 0, back: false };
const L: V3 = [0, 0, 0];
for (let bounce = 1; bounce <= BOUNCES; bounce++) {
    const prev = new Baked(toFaces(indirect), probeStub);
    indirect = points.map((list) => {
        const e = new Float32Array(list.length * 3);
        list.forEach((pt, k) => {
            const ou = random(), ov = random();
            let r = 0, g = 0, bl = 0;
            for (let s = 0; s < RAYS; s++) {
                const u1 = ((s + 0.5) / RAYS + ou) % 1;
                const u2 = (radicalInverse(s) + ov) % 1;
                const rad = Math.sqrt(u1);
                const phi = 2 * Math.PI * u2;
                const x = rad * Math.cos(phi), y = rad * Math.sin(phi), z = Math.sqrt(1 - u1);
                const dx = pt.t[0] * x + pt.b[0] * y + pt.n[0] * z;
                const dy = pt.t[1] * x + pt.b[1] * y + pt.n[1] * z;
                const dz = pt.t[2] * x + pt.b[2] * y + pt.n[2] * z;
                if (!castRay(pt.p[0], pt.p[1], pt.p[2], dx, dy, dz, hit)) continue;
                prev.radiance(hit, L);
                r += L[0]; g += L[1]; bl += L[2];
            }
            e[k * 3] = (Math.PI * r) / RAYS;
            e[k * 3 + 1] = (Math.PI * g) / RAYS;
            e[k * 3 + 2] = (Math.PI * bl) / RAYS;
        });
        return e;
    });
    console.log(`bounce ${bounce}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// Probes.
const lit = new Baked(toFaces(indirect), probeStub);
const dirs = sphereDirections(PROBE_RAYS);
const basis = new Float64Array(SH_COEFFS);
const [nx, ny, nz] = PROBE_DIMS;
const probeCount = nx * ny * nz;
const sh = new Float64Array(probeCount * SH_COEFFS * 3);
const valid = new Uint8Array(probeCount);
for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const probe = i + nx * (j + ny * k);
            const p = lit.probePosition(i, j, k);
            const acc = new Float64Array(SH_COEFFS * 3);
            let backHits = 0;
            for (let s = 0; s < PROBE_RAYS; s++) {
                const dx = dirs[s * 3], dy = dirs[s * 3 + 1], dz = dirs[s * 3 + 2];
                if (!castRay(p[0], p[1], p[2], dx, dy, dz, hit)) continue;
                if (hit.back) backHits++;
                lit.radiance(hit, L);
                shBasis(dx, dy, dz, basis);
                for (let c = 0; c < SH_COEFFS; c++) {
                    acc[c * 3] += L[0] * basis[c];
                    acc[c * 3 + 1] += L[1] * basis[c];
                    acc[c * 3 + 2] += L[2] * basis[c];
                }
            }
            const w = (4 * Math.PI) / PROBE_RAYS;
            for (let c = 0; c < acc.length; c++) acc[c] *= w;
            convolve(acc);
            sh.set(acc, probe * SH_COEFFS * 3);
            valid[probe] = backHits < PROBE_RAYS * 0.02 ? 1 : 0;
        }
    }
}
// Fill probes buried in blocks from their valid neighbours, repeating until all are set.
let invalid = valid.reduce((s, v) => s + (v ? 0 : 1), 0);
const buried = invalid;
while (invalid > 0) {
    const next = valid.slice();
    for (let probe = 0; probe < probeCount; probe++) {
        if (valid[probe]) continue;
        const i = probe % nx, j = Math.floor(probe / nx) % ny, k = Math.floor(probe / (nx * ny));
        const acc = new Float64Array(SH_COEFFS * 3);
        let n = 0;
        for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const a = i + di, b = j + dj, c = k + dk;
            if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
            const q = a + nx * (b + ny * c);
            if (!valid[q]) continue;
            for (let s = 0; s < acc.length; s++) acc[s] += sh[q * SH_COEFFS * 3 + s];
            n++;
        }
        if (n === 0) continue;
        for (let s = 0; s < acc.length; s++) sh[probe * SH_COEFFS * 3 + s] = acc[s] / n;
        next[probe] = 1;
    }
    valid.set(next);
    const left = valid.reduce((s, v) => s + (v ? 0 : 1), 0);
    if (left === invalid) throw new Error('probes with no valid neighbour');
    invalid = left;
}
console.log(`probes: ${probeCount} (${buried} inside blocks, filled from neighbours) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const round = (x: number) => Number(x.toPrecision(4));
const data: BakeData = {
    version: 2,
    bounces: BOUNCES,
    raysPerPoint: RAYS,
    probeRays: PROBE_RAYS,
    faces: toFaces(indirect).map((f) => ({ ...f, e: f.e.map(round), d: f.d.map(round) })),
    probes: { dims: PROBE_DIMS, min: PROBE_MIN, max: PROBE_MAX, sh: Array.from(sh, round) },
};
const dir = new URL('../assets/resources/bake/', import.meta.url);
mkdirSync(dir, { recursive: true });
const json = JSON.stringify(data);
writeFileSync(new URL('cornell.json', dir), json);
console.log(`wrote cornell.json: ${pointCount} points, ${(json.length / 1024).toFixed(0)} KB, ${((performance.now() - t0) / 1000).toFixed(1)} s total`);
