// Checks: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { readFileSync } from 'node:fs';
import { BUDGET, settle, stepFrame } from '../assets/game/snow/Frame.ts';
import { Hand, PARTS } from '../assets/game/snow/Hand.ts';
import { BEDS, bedCapacity, bedHeight, fillBed } from '../assets/game/snow/Scenes.ts';
import { SCENE, simSize } from '../assets/game/snow/Setup.ts';
import { SHOT, shotPose, shotSize, TIMELINE, wristHeight } from '../assets/game/snow/Shot.ts';
import { BORDER, SnowSim } from '../assets/game/snow/SnowSim.ts';
import { svd3 } from '../assets/game/snow/Svd3.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

function det3(m: ArrayLike<number>): number {
    return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

{
    let seed = 7;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const u = new Float64Array(9), sig = new Float64Array(3), v = new Float64Array(9);
    let worst = 0, worstNear = 0, rotations = true, sorted = true, sawInverted = false;
    for (let t = 0; t < 500; t++) {
        // Mostly near-identity deformation gradients like the solver sees, plus arbitrary ones and reflections.
        const f = new Float64Array(9);
        for (let k = 0; k < 9; k++) f[k] = (k % 4 === 0 ? 1 : 0) + rand() * (t < 250 ? 0.08 : 1);
        if (t % 50 === 0) for (let k = 0; k < 3; k++) f[k] = -f[k];
        svd3(f, 0, u, sig, v);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            let r = 0;
            for (let k = 0; k < 3; k++) r += u[i * 3 + k] * sig[k] * v[j * 3 + k];
            if (t < 250) worstNear = Math.max(worstNear, Math.abs(r - f[i * 3 + j]));
            else worst = Math.max(worst, Math.abs(r - f[i * 3 + j]));
        }
        if (Math.abs(det3(u) - 1) > 1e-6 || Math.abs(det3(v) - 1) > 1e-6) rotations = false;
        if (!(sig[0] >= sig[1] - 1e-9 && sig[1] >= Math.abs(sig[2]) - 1e-9)) sorted = false;
        if (det3(f) < 0) sawInverted ||= sig[2] < 0;
    }
    // Four Jacobi sweeps at most: near-identity F (what the solver sees) is exact, arbitrary F to ~1e-4.
    check('svd3 reconstructs near-identity F = U Σ Vᵀ', worstNear < 1e-6, `max error ${worstNear.toExponential(1)}`);
    check('svd3 reconstructs arbitrary F', worst < 1e-4, `max error ${worst.toExponential(1)}`);
    check('svd3 returns rotations (det U = det V = 1)', rotations);
    check('svd3 sorts σ₁ ≥ σ₂ ≥ |σ₃| and puts an inversion in σ₃', sorted && sawInverted);
}

{
    // A block at rest with no gravity has F = I and must feel no force.
    const sim = new SnowSim(16, 16, 16, 0.03, 4000);
    sim.params.gravity = 0;
    sim.setSpacing(2);
    const s = 0.015;
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) sim.add(0.18 + i * s, 0.18 + j * s, 0.18 + k * s);
    for (let n = 0; n < 60; n++) sim.step(1 / 360);
    let vmax = 0;
    for (let p = 0; p < sim.count; p++) vmax = Math.max(vmax, Math.hypot(sim.vx[p], sim.vy[p], sim.vz[p]));
    check('undeformed snow stays at rest', vmax < 1e-6, `max |v| ${vmax.toExponential(1)}`);
}

const PER_CELL = 1.25;
const { nx, ny, nz } = simSize();
const bed = BEDS[SCENE.bed];
const sim = new SnowSim(nx, ny, nz, SCENE.dx, bedCapacity({ dx: SCENE.dx, nx, nz }, bed, PER_CELL, BORDER));
Object.assign(sim.params, SCENE.params);
const count = fillBed(sim, bed, PER_CELL);
const width = sim.hiX - sim.lo, length = sim.hiZ - sim.lo;

/** Highest snow per (x, z) column bin of `cell` metres, relative to the floor. */
function tops(cell: number): { top: Float64Array; bx: number; bz: number } {
    const bx = Math.ceil(width / cell), bz = Math.ceil(length / cell);
    const top = new Float64Array(bx * bz).fill(-1);
    for (let p = 0; p < sim.count; p++) {
        const i = Math.min(bx - 1, Math.floor((sim.x[p] - sim.lo) / cell));
        const k = Math.min(bz - 1, Math.floor((sim.z[p] - sim.lo) / cell));
        top[i + k * bx] = Math.max(top[i + k * bx], sim.y[p] - sim.lo);
    }
    return { top, bx, bz };
}

{
    const filled = tops(0.04);
    settle(sim, SCENE.settleFrames, 1 / 60, BUDGET.substeps);
    // Walls act on grid nodes, so particles may sit up to half a cell inside them.
    const m = SCENE.dx / 2;
    let outside = 0;
    for (let p = 0; p < sim.count; p++) {
        if (sim.x[p] < sim.lo - m || sim.x[p] > sim.hiX + m || sim.y[p] < sim.lo - m || sim.z[p] < sim.lo - m || sim.z[p] > sim.hiZ + m) outside++;
    }
    check('a fresh bed settles without blowing up or leaking', !sim.blewUp && outside === 0, `${count} particles`);
    // Snow compacts a little under its own weight but keeps its drifts: every column sinks by about the same amount.
    const settled = tops(0.04);
    const drops: number[] = [];
    for (let i = 1; i < settled.bx - 1; i++) for (let k = 1; k < settled.bz - 1; k++) {
        drops.push(filled.top[i + k * filled.bx] - settled.top[i + k * settled.bx]);
    }
    drops.sort((a, b) => a - b);
    const p05 = drops[Math.floor(drops.length * 0.05)], p95 = drops[Math.floor(drops.length * 0.95)];
    check('settled snow keeps its drifts (columns sink 0–4 cm, uniformly)', p05 > -0.005 && p95 < 0.04,
        `5–95% sink ${(p05 * 100).toFixed(1)}–${(p95 * 100).toFixed(1)} cm`);
    check('after settling everything sleeps', sim.activeCount === 0);
}

const before = tops(0.04);

{
    // Hand hovering high above a corner: nothing wakes and nothing moves.
    const hand = new Hand();
    hand.scale = SCENE.handScale;
    sim.colliders.push(...hand.capsules);
    const y0 = Float32Array.from(sim.y.subarray(0, sim.count));
    const pose = { x: sim.lo + 0.1, y: sim.lo + 1.2, z: sim.lo + 0.1, yaw: 0, lean: 0.5 };
    hand.place(pose);
    for (let f = 0; f < 5; f++) stepFrame(sim, hand, pose, 1 / 60);
    let moved = 0;
    for (let p = 0; p < sim.count; p++) moved = Math.max(moved, Math.abs(sim.y[p] - y0[p]));
    check('sleeping snow far from the hand costs nothing and does not move', sim.activeCount === 0 && moved === 0);

    // The demo's sweep: down at the left, across the middle, up and out.
    const cx = (sim.lo + sim.hiX) / 2, cz = (sim.lo + sim.hiZ) / 2;
    let peakAwake = 0;
    for (let fr = 0; fr < 200; fr++) {
        const down = Math.min(fr / 30, 1);
        const sweep = Math.min(Math.max((fr - 30) / 70, 0), 1);
        const lift = Math.min(Math.max((fr - 110) / 30, 0), 1);
        const y = sim.lo + SCENE.liftY - (SCENE.liftY - SCENE.digY) * down + (SCENE.liftY - SCENE.digY) * lift;
        stepFrame(sim, hand, { x: cx - 0.4 + sweep * 0.8, y, z: cz, yaw: 0, lean: 0.5 }, 1 / 60);
        peakAwake = Math.max(peakAwake, sim.activeCount);
    }
    check('the sweep stays stable', !sim.blewUp && sim.count === count, `peak awake ${peakAwake} of ${count}`);
    check('only snow near the hand is simulated', peakAwake < count * 0.6);

    const after = tops(0.04);
    const kLine = Math.floor((cz - sim.lo) / 0.04);
    let trench = 0, cols = 0, pile = 0, far = 0;
    for (let i = 0; i < after.bx; i++) {
        const x = sim.lo + (i + 0.5) * 0.04;
        for (let k = 0; k < after.bz; k++) {
            const rise = after.top[i + k * after.bx] - before.top[i + k * before.bx];
            if (x > cx + 0.4) pile = Math.max(pile, rise);
            const inner = i > 0 && i < after.bx - 1 && k > 0 && k < after.bz - 1;
            if (inner && x < cx + 0.4 && Math.abs(k - kLine) > 7) far = Math.max(far, Math.abs(rise));
        }
        if (Math.abs(x - cx) > 0.2) continue;
        cols++;
        let low = Infinity;
        for (let k = kLine - 1; k <= kLine + 1; k++) low = Math.min(low, before.top[i + k * before.bx] - after.top[i + k * after.bx]);
        trench += low;
    }
    trench /= cols;
    check('the hand digs a furrow (≥ 8 cm along the middle of the sweep)', trench > 0.08, `${(trench * 100).toFixed(1)} cm deep`);
    // Cohesive snow travels ahead of the palm as one mass and is dropped where the sweep ends.
    check('pushed snow piles up past the end of the sweep (≥ 20 cm)', pile > 0.2, `${(pile * 100).toFixed(0)} cm high`);
    check('snow 30 cm to the side of the sweep is untouched', far < 0.01, `max change ${(far * 100).toFixed(1)} cm`);

    let packed = 0;
    for (let p = 0; p < sim.count; p++) if (sim.jp[p] < 0.97) packed++;
    check('snow pushed by the palm is compacted (Jp < 0.97)', packed > 200, `${packed} particles`);

    // The view tints snow below the untouched bed top; the furrow floor must be under it, the far corner not.
    const xi = Math.floor((cx - sim.lo) / 0.04);
    const floorTop = after.top[xi + kLine * after.bx];
    const fresh = sim.lo + bedHeight(bed, (cx - sim.lo) / width, (cz - sim.lo) / length, width, length);
    check('the furrow floor sits below the fresh bed top (tinted blue)', fresh - sim.lo - floorTop > 0.02 + 0.06,
        `${((fresh - sim.lo - floorTop) * 100).toFixed(1)} cm below`);
}

{
    // The exported model shares hand space with PARTS: almost every vertex lies on or just outside a capsule.
    const glb = readFileSync(new URL('../assets/resources/models/gauntlet.glb', import.meta.url));
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
    const bin = glb.subarray(20 + jsonLength + 8);
    let near = 0, total = 0;
    for (const prim of gltf.meshes[0].primitives) {
        const acc = gltf.accessors[prim.attributes.POSITION];
        const view = gltf.bufferViews[acc.bufferView];
        const pos = new Float32Array(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), acc.count * 3);
        for (let v = 0; v < acc.count; v++) {
            const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
            let best = Infinity;
            for (const part of PARTS) {
                const [ax, ay, az] = part.a, [bx, by, bz] = part.b;
                const ex = bx - ax, ey = by - ay, ez = bz - az;
                const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / (ex * ex + ey * ey + ez * ez)));
                best = Math.min(best, Math.hypot(x - ax - ex * t, y - ay - ey * t, z - az - ez * t) - part.r);
            }
            total++;
            if (best < 0.035) near++;
        }
    }
    check('gauntlet.glb sits on the collision capsules', near / total > 0.9, `${((100 * near) / total).toFixed(0)}% of ${total} vertices within 3.5 cm`);
}

{
    // Lich King shot: one wipe across a thin layer on the ice.
    const lean = SHOT.lean, k = SHOT.handScale;
    const pose = { x: 0, y: wristHeight(lean, k, 0.01), z: 0, yaw: SHOT.yaw, lean };
    const hand = new Hand();
    hand.scale = k;
    hand.place(pose);
    hand.at(1);
    let low = Infinity;
    for (const c of hand.capsules) low = Math.min(low, c.ay - c.r, c.by - c.r);
    check('wristHeight puts the lowest capsule at the clearance', Math.abs(low - 0.01) < 1e-9, `lowest ${(low * 1000).toFixed(2)} mm`);

    const size = shotSize();
    const shot = new SnowSim(size.nx, size.ny, size.nz, SHOT.dx, bedCapacity({ dx: SHOT.dx, nx: size.nx, nz: size.nz }, SHOT.bed, SHOT.perCell, BORDER));
    Object.assign(shot.params, SHOT.params);
    const n = fillBed(shot, SHOT.bed, SHOT.perCell);
    shot.sleepAll();
    shot.colliders.push(...hand.capsules);
    const y0 = Float32Array.from(shot.y.subarray(0, shot.count));
    const z0 = Float32Array.from(shot.z.subarray(0, shot.count));
    const cx = (shot.lo + shot.hiX) / 2, cz = (shot.lo + shot.hiZ) / 2;
    hand.place(shotPose(0, cx, cz, shot.lo));
    for (let f = 0; f / 60 < TIMELINE.exit + 0.3; f++) stepFrame(shot, hand, shotPose(f / 60, cx, cz, shot.lo), 1 / 60);
    check('the wipe stays stable', !shot.blewUp && shot.count === n, `${n} particles`);

    const c = 0.01, bx = Math.round(SHOT.text.w / c), bz = Math.round(SHOT.text.h / c);
    const top = new Float64Array(bx * bz);
    let moved = 0;
    for (let p = 0; p < shot.count; p++) {
        const i = Math.floor((shot.x[p] - (cx - SHOT.text.w / 2)) / c), kk = Math.floor((shot.z[p] - (cz - SHOT.text.h / 2)) / c);
        if (i >= 0 && i < bx && kk >= 0 && kk < bz) top[i + kk * bx] = Math.max(top[i + kk * bx], shot.y[p] - shot.lo);
        // The arm reaches in from the far side and its thumb trails through the snow there; the near side sees no hand.
        if (z0[p] - cz > 0.3) moved = Math.max(moved, Math.abs(shot.y[p] - y0[p]));
    }
    let bare = 0;
    for (const h of top) if (h < SHOT.dusting) bare++;
    check('one wipe uncovers the text band (≥ 85% bare ice under the dusting height)', bare / top.length >= 0.85,
        `${((100 * bare) / top.length).toFixed(0)}% bare`);
    check('snow 30 cm on the near side of the line is untouched', moved < 1e-6);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
