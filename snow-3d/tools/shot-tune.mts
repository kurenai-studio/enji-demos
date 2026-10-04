// node --no-warnings --import ./tools/ts-resolve.mjs tools/shot-tune.mts   (edit SHOT.lean / SHOT.yaw to compare poses)
// Runs the Lich King shot headless and reports how much of the text band the wipe leaves bare.
import { stepFrame } from '../assets/game/snow/Frame.ts';
import { Hand } from '../assets/game/snow/Hand.ts';
import { bedCapacity, fillBed } from '../assets/game/snow/Scenes.ts';
import { SHOT, shotPose, shotSize, TIMELINE } from '../assets/game/snow/Shot.ts';
import { BORDER, SnowSim } from '../assets/game/snow/SnowSim.ts';

const { nx, ny, nz } = shotSize();
const sim = new SnowSim(nx, ny, nz, SHOT.dx, bedCapacity({ dx: SHOT.dx, nx, nz }, SHOT.bed, SHOT.perCell, BORDER));
Object.assign(sim.params, SHOT.params);
fillBed(sim, SHOT.bed, SHOT.perCell);
sim.sleepAll();
const hand = new Hand();
hand.scale = SHOT.handScale;
sim.colliders.push(...hand.capsules);
const cx = (sim.lo + sim.hiX) / 2, cz = (sim.lo + sim.hiZ) / 2;
hand.place(shotPose(0, cx, cz, sim.lo));
let ms = 0, worst = 0, peak = 0;
for (let f = 0; f * (1 / 60) < TIMELINE.exit + 0.3; f++) {
    const t0 = performance.now();
    stepFrame(sim, hand, shotPose(f / 60, cx, cz, sim.lo), 1 / 60);
    const d = performance.now() - t0;
    ms += d; worst = Math.max(worst, d); peak = Math.max(peak, sim.activeCount);
}
const c = 0.01, bx = Math.round(SHOT.text.w / c), bz = Math.round(SHOT.text.h / c);
const top = new Float64Array(bx * bz);
let side = 0;
for (let p = 0; p < sim.count; p++) {
    const i = Math.floor((sim.x[p] - (cx - SHOT.text.w / 2)) / c), k = Math.floor((sim.z[p] - (cz - SHOT.text.h / 2)) / c);
    if (i >= 0 && i < bx && k >= 0 && k < bz) top[i + k * bx] = Math.max(top[i + k * bx], sim.y[p] - sim.lo);
}
let bare = 0;
for (const h of top) if (h < SHOT.dusting) bare++;
// Rows of the band from far (−z) to near (+z): share bare per row.
const rows: string[] = [];
for (let k = 0; k < bz; k += 2) { let b = 0; for (let i = 0; i < bx; i++) if (top[i + k * bx] < SHOT.dusting) b++; rows.push((b / bx * 100).toFixed(0)); }
console.log(`lean ${SHOT.lean} yaw ${SHOT.yaw}: ${sim.count} particles, bare ${(100 * bare / top.length).toFixed(0)}% of text band, rows far→near ${rows.join(' ')}`);
console.log(`frame avg ${(ms / (TIMELINE.exit * 60)).toFixed(1)} ms, worst ${worst.toFixed(1)}, peak awake ${peak}, blewUp ${sim.blewUp}`);
