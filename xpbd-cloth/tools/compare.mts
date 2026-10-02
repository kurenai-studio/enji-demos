// PBD vs XPBD and self collision: node --no-warnings --import ./tools/ts-resolve.mjs tools/compare.mts
//
// 1. A rubber sheet hung by its whole top edge, at 0.5x to 4x the base substep
//    count. PBD uses the stiffness that matches XPBD at the base count. Prints
//    how far the bottom edge sags below its rest height after 8 s.
// 2. A sheet dropped edge-first onto the ground, so it piles onto itself, with
//    and without self collision. Prints the cost per frame and the closest
//    distance between particles that are not grid neighbours.
import { GROUP_BEND, GROUP_SHEAR, GROUP_STRETCH, XpbdCloth } from '../assets/game/xpbd/XpbdCloth.ts';

const RUBBER = { stretch: 0.15, shear: 0.15, bend: 0.5 };
const SIZE = 1.1;
const HEIGHT = 2.0;
const BASE_SUBSTEPS = 10;

function hang(method: 'xpbd' | 'pbd', substeps: number): number {
    const n = 32;
    const cloth = new XpbdCloth({
        segments: n,
        size: SIZE,
        mass: 0.4,
        orientation: 'vertical',
        height: HEIGHT,
        pins: Array.from({ length: n }, (_, c) => [c, 0] as const),
        tethers: false,
    });
    cloth.compliance[GROUP_STRETCH] = RUBBER.stretch;
    cloth.compliance[GROUP_SHEAR] = RUBBER.shear;
    cloth.compliance[GROUP_BEND] = RUBBER.bend;
    cloth.matchPbdStiffness(BASE_SUBSTEPS);
    cloth.method = method;
    cloth.substeps = substeps;
    cloth.setSphere(0, 0.45, 50);
    for (let f = 0; f < 480; f++) cloth.step(1 / 60);
    const bottom = ((n - 1) * n + (n >> 1)) * 3 + 1;
    return HEIGHT - SIZE - cloth.pos[bottom];
}

const only = process.argv[2];

if (only !== 'pile') console.log('Rubber sheet sag below rest (cm); PBD matched at', BASE_SUBSTEPS, 'substeps');
for (const scale of only === 'pile' ? [] : [0.5, 1, 2, 4]) {
    const substeps = Math.round(BASE_SUBSTEPS * scale);
    const x = hang('xpbd', substeps);
    const p = hang('pbd', substeps);
    console.log(`  substeps ${String(substeps).padStart(2)}  XPBD ${(x * 100).toFixed(1).padStart(5)}  PBD ${(p * 100).toFixed(1).padStart(5)}`);
}

function pile(n: number, substeps: number, every: number) {
    const cloth = new XpbdCloth({ segments: n, size: 1.6, mass: 0.4, orientation: 'vertical', height: 2.4, pins: [] });
    cloth.substeps = substeps;
    cloth.selfCollision = every > 0;
    cloth.selfCollisionEvery = Math.max(1, every);
    cloth.setSphere(0, 0.45, 50);
    const times: number[] = [];
    for (let f = 0; f < 300; f++) {
        const t0 = performance.now();
        cloth.step(1 / 60);
        cloth.computeNormals();
        times.push(performance.now() - t0);
    }
    let closest = Infinity;
    for (let i = 0; i < cloth.count; i++) {
        const ri = Math.floor(i / n), ci = i % n;
        for (let j = i + 1; j < cloth.count; j++) {
            const rj = Math.floor(j / n), cj = j % n;
            if (Math.abs(ri - rj) <= 2 && Math.abs(ci - cj) <= 2) continue;
            const d = Math.hypot(cloth.pos[i * 3] - cloth.pos[j * 3], cloth.pos[i * 3 + 1] - cloth.pos[j * 3 + 1], cloth.pos[i * 3 + 2] - cloth.pos[j * 3 + 2]);
            if (d < closest) closest = d;
        }
    }
    const sorted = times.slice(60).sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { avg, p95: sorted[Math.floor(sorted.length * 0.95)], closest, thickness: cloth.selfThickness, finite: cloth.pos.every(Number.isFinite) };
}

if (only !== 'hang') console.log('\nSheet piled on the ground (closest = nearest non-neighbour pair)');
for (const [n, substeps] of only === 'hang' ? [] : [[20, 8], [32, 10], [48, 12], [64, 15]]) {
    // Self collision off, on every substep, on every second substep.
    for (const every of [0, 1, 2]) {
        // Best of three runs, to keep other load on the machine out of the numbers.
        const r = [pile(n, substeps, every), pile(n, substeps, every), pile(n, substeps, every)].sort((a, b) => a.avg - b.avg)[0];
        const label = every === 0 ? 'off     ' : every === 1 ? 'every   ' : 'every 2nd';
        console.log(
            `  ${`${n}x${n}`.padEnd(6)} self ${label}  avg ${r.avg.toFixed(2)} ms  p95 ${r.p95.toFixed(2)} ms  ` +
            `closest ${(r.closest * 100).toFixed(2)} cm (thickness ${(r.thickness * 100).toFixed(2)} cm)${r.finite ? '' : '  NaN!'}`,
        );
    }
}
