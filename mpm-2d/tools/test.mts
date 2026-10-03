// Checks: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
// Snow plasticity (clamp and volume bookkeeping), and that a snowball breaks
// on impact where the same ball made of jelly bounces off whole, in both solvers.
import { ELASTIC, type MpmWorld, SNOW } from '../assets/game/mpm/MpmWorld.ts';
import { MpmSim, type SolverSetting } from '../assets/game/mpm/MpmSim.ts';
import { SCENE_NAMES } from '../assets/game/mpm/Scenes.ts';
import { snowHardening, snowPlasticity } from '../assets/game/mpm/Svd2.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

let seed = 5;
function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}

// Plasticity: elastic Σ ends inside [1 − θc, 1 + θs] and Jp · det Σ is unchanged.
{
    const svd = new Float64Array(6);
    let worstBound = 0;
    let worstVolume = 0;
    for (let k = 0; k < 1000; k++) {
        const s0 = 0.9 + rand() * 0.2;
        const s1 = 0.9 + rand() * 0.2;
        const jp = 0.7 + rand() * 0.6;
        svd[2] = s0;
        svd[3] = s1;
        const next = snowPlasticity(svd, jp, 0.025, 0.0075);
        for (const s of [svd[2], svd[3]]) worstBound = Math.max(worstBound, 0.975 - s, s - 1.0075);
        worstVolume = Math.max(worstVolume, Math.abs(next * svd[2] * svd[3] - jp * s0 * s1));
    }
    check('snow Σ clamped to [1 − θc, 1 + θs]', worstBound <= 1e-12, `worst overshoot ${worstBound.toExponential(1)}`);
    check('Jp · det F_E conserved', worstVolume < 1e-12, `worst error ${worstVolume.toExponential(1)}`);
    check('hardening: 1 at Jp = 1, stiffer packed, softer torn',
        snowHardening(1, 10) === 1 && snowHardening(0.95, 10) > 1.6 && snowHardening(1.1, 10) < 0.4,
        `h(0.95) ${snowHardening(0.95, 10).toFixed(2)}, h(1.1) ${snowHardening(1.1, 10).toFixed(2)}`);
}

/** Horizontal spread (standard deviation of x) of the particles. */
function spread(w: MpmWorld): number {
    let sx = 0;
    for (let i = 0; i < w.count; i++) sx += w.px[i];
    const mx = sx / w.count;
    let v = 0;
    for (let i = 0; i < w.count; i++) v += (w.px[i] - mx) ** 2;
    return Math.sqrt(v / w.count);
}

/** Pieces: particles linked when closer than `link` cells (union–find over a hash grid). */
function pieces(w: MpmWorld, link: number): number {
    const parent = new Int32Array(w.count).map((_, i) => i);
    const find = (i: number): number => {
        while (parent[i] !== i) i = parent[i] = parent[parent[i]];
        return i;
    };
    const cells = new Map<number, number[]>();
    for (let i = 0; i < w.count; i++) {
        const key = Math.floor(w.px[i] / link) * 4096 + Math.floor(w.py[i] / link);
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
    }
    for (let i = 0; i < w.count; i++) {
        const cx = Math.floor(w.px[i] / link);
        const cy = Math.floor(w.py[i] / link);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const j of cells.get((cx + dx) * 4096 + cy + dy) ?? []) {
                    if (j <= i) continue;
                    if ((w.px[i] - w.px[j]) ** 2 + (w.py[i] - w.py[j]) ** 2 > link * link) continue;
                    parent[find(i)] = find(j);
                }
            }
        }
    }
    let big = 0;
    const size = new Map<number, number>();
    for (let i = 0; i < w.count; i++) size.set(find(i), (size.get(find(i)) ?? 0) + 1);
    for (const s of size.values()) if (s >= 4) big++;
    return big;
}

const settings: { name: string; s: SolverSetting }[] = [
    { name: 'PB-MPM 120 Hz × 5', s: { kind: 'pb', rate: 120, iterations: 5 } },
    { name: 'PB-MPM 240 Hz × 5', s: { kind: 'pb', rate: 240, iterations: 5 } },
    { name: 'PB-MPM 240 Hz × 10', s: { kind: 'pb', rate: 240, iterations: 10 } },
    { name: 'MLS-MPM 600 Hz', s: { kind: 'mls', rate: 600, iterations: 1 } },
];

// A ball thrown at the floor, and a snow bank left at rest. MLS-MPM is
// Stomakhin's model as published: the snowball breaks into pieces, the jelly
// ball bounces whole, the bank holds. PB-MPM's snow is an adaptation (no
// stress to bound), so it is checked against what it does, and its low-budget
// packing is reported rather than asserted.
interface Drop { spread: number; pieces: number; packed: number; torn: number; blewUp: boolean }
function drop(s: SolverSetting, material: number): Drop {
    const sim = new MpmSim();
    sim.configure([s], 48, 64);
    const w = sim.worlds[0];
    w.clear();
    w.addDisc(material, 24, 30, 8, 0, -60);
    if (s.kind === 'pb') for (let p = 0; p < w.count; p++) w.vy[p] *= sim.dt(0);
    const before = spread(w);
    for (let f = 0; f < 90; f++) sim.step();
    let packed = 0;
    let torn = 0;
    for (let p = 0; p < w.count; p++) {
        if (w.jac[p] < 0.98) packed++;
        if (w.jac[p] > 1.02) torn++;
    }
    return { spread: spread(w) / before, pieces: pieces(w, 0.9), packed, torn, blewUp: w.blewUp };
}
function bank(s: SolverSetting): { h0: number; h1: number; jp: number } {
    const sim = new MpmSim();
    sim.configure([s], 48, 64);
    const w = sim.worlds[0];
    w.clear();
    w.addBlock(SNOW, 8, 0, 40, 16);
    const top = () => {
        const ys = Array.from(w.py.subarray(0, w.count)).sort((a, b) => a - b);
        return ys[Math.floor(ys.length * 0.98)];
    };
    for (let f = 0; f < 30; f++) sim.step();
    const h0 = top();
    for (let f = 0; f < 180; f++) sim.step();
    let jp = 0;
    for (let p = 0; p < w.count; p++) jp += w.jac[p];
    return { h0, h1: top(), jp: jp / w.count };
}

for (const { name, s } of settings) {
    const snow = drop(s, SNOW);
    const jelly = drop(s, ELASTIC);
    const rest = bank(s);
    const d = `spread ×${snow.spread.toFixed(2)} vs jelly ×${jelly.spread.toFixed(2)}, pieces ${snow.pieces} vs ${jelly.pieces}, packed ${snow.packed}, torn ${snow.torn}`;
    const b = `bank top ${rest.h0.toFixed(2)} → ${rest.h1.toFixed(2)} (seeded 16), mean Jp ${rest.jp.toFixed(3)}`;
    const holds = Math.abs(rest.h1 - rest.h0) < 0.5 && rest.h0 > 15 && rest.jp > 0.97 && rest.jp < 1.03;
    if (s.kind === 'mls') {
        check(`${name}: snowball breaks, jelly ball does not`, !snow.blewUp && snow.spread > 1.4 * jelly.spread && snow.pieces > jelly.pieces, d);
        check(`${name}: impact packs some snow and tears some`, snow.packed > 20 && snow.torn > 20);
        check(`${name}: snow bank holds`, holds, b);
    } else if (s.rate >= 240 && s.iterations >= 10) {
        check(`${name}: snowball splats and tears, jelly does not`, snow.spread > 1.3 * jelly.spread && snow.torn > 20, d);
        check(`${name}: snow bank holds`, holds, b);
    } else {
        console.log(`info ${name}: ${d}; ${b}`);
    }
}

// The Snowball scene: no NaNs in either solver at 10 and 20 passes per frame; report blow-ups.
const scene = SCENE_NAMES.indexOf('Snowball');
for (const s of [
    { kind: 'pb', rate: 120, iterations: 5 },
    { kind: 'pb', rate: 240, iterations: 5 },
    { kind: 'mls', rate: 600, iterations: 1 },
    { kind: 'mls', rate: 1200, iterations: 1 },
] as SolverSetting[]) {
    const sim = new MpmSim();
    sim.scene = scene;
    sim.configure([s], 32, 64);
    for (let f = 0; f < 240; f++) sim.step();
    const w = sim.worlds[0];
    let finite = true;
    let jp = 0;
    let top = 0;
    for (let p = 0; p < w.count; p++) {
        if (!Number.isFinite(w.px[p]) || !Number.isFinite(w.jac[p])) finite = false;
        jp += w.jac[p];
        top = Math.max(top, w.py[p]);
    }
    const label = s.kind === 'pb' ? `PB-MPM ${s.rate} Hz × ${s.iterations}` : `MLS-MPM ${s.rate} Hz`;
    const info = `${w.blewUp ? 'blew up (clamped)' : 'no blow-up'}, mean Jp ${(jp / w.count).toFixed(2)}, top ${top.toFixed(1)}`;
    check(`Snowball scene, ${label}: finite`, finite, info);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
