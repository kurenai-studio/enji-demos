// Headless check of both solvers: runs a scene for a few simulated seconds per
// setting and reports cost and sanity numbers.
//   node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts [scene] [width] [height] [seconds]
import { ELASTIC, LIQUID, type MpmWorld } from '../assets/game/mpm/MpmWorld.ts';
import { MpmSim, passesPerFrame, type SolverSetting } from '../assets/game/mpm/MpmSim.ts';
import { SCENE_NAMES } from '../assets/game/mpm/Scenes.ts';

const scene = Number(process.argv[2] ?? 0) || 0;
const width = Number(process.argv[3] ?? 96);
const height = Number(process.argv[4] ?? 128);
const seconds = Number(process.argv[5] ?? 4);

const settings: SolverSetting[] = [
    { kind: 'pb', rate: 60, iterations: 5 },
    { kind: 'pb', rate: 60, iterations: 10 },
    { kind: 'pb', rate: 120, iterations: 5 },
    { kind: 'pb', rate: 240, iterations: 5 },
    { kind: 'pb', rate: 240, iterations: 10 },
    { kind: 'mls', rate: 300, iterations: 1 },
    { kind: 'mls', rate: 600, iterations: 1 },
    { kind: 'mls', rate: 1200, iterations: 1 },
    { kind: 'mls', rate: 1800, iterations: 1 },
    { kind: 'mls', rate: 2400, iterations: 1 },
];

function stats(w: MpmWorld): string {
    let nan = 0;
    let liquid = 0;
    let jSum = 0;
    let jelly = 0;
    let detErr = 0;
    const ys: number[] = [];
    for (let i = 0; i < w.count; i++) {
        if (!Number.isFinite(w.px[i]) || !Number.isFinite(w.py[i])) nan++;
        if (w.material[i] === LIQUID) {
            liquid++;
            jSum += w.jac[i];
            ys.push(w.py[i]);
        } else if (w.material[i] === ELASTIC) {
            jelly++;
            detErr += Math.abs(w.f00[i] * w.f11[i] - w.f01[i] * w.f10[i] - 1);
        }
    }
    ys.sort((a, b) => a - b);
    const top = ys.length ? ys[Math.floor(ys.length * 0.98)] : 0;
    const parts = [`nan ${nan}`];
    if (liquid) parts.push(`liquid J ${(jSum / liquid).toFixed(3)} top ${top.toFixed(1)}`);
    if (jelly) parts.push(`jelly |detF-1| ${(detErr / jelly).toFixed(3)}`);
    if (w.blewUp) parts.push('BLEW UP');
    return parts.join(' · ');
}

const only = process.env.ONLY;
const custom: Record<string, (w: MpmWorld) => void> = {
    liquid: (w) => { w.clear(); w.addBlock(LIQUID, 0, 0, 0.42 * w.width, 0.6 * w.height); },
    jelly: (w) => { w.clear(); w.addBlock(ELASTIC, 0.35 * w.width, 0.5 * w.height, 0.65 * w.width, 0.5 * w.height + 0.3 * w.width); },
};
const sceneArg = process.argv[2] ?? '0';
console.log(`${custom[sceneArg] ? sceneArg : SCENE_NAMES[scene]} on ${width}×${height}, ${seconds} s simulated`);
for (const s of settings) {
    if (only && !only.split(',').includes(s.kind)) continue;
    const sim = new MpmSim();
    sim.scene = custom[sceneArg] ? 0 : scene;
    sim.configure([s], width, height);
    if (custom[sceneArg]) custom[sceneArg](sim.worlds[0]);
    const frames = Math.round(seconds * 60);
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) sim.step();
    const ms = (performance.now() - t0) / frames;
    const passes = passesPerFrame(s);
    const label = s.kind === 'pb' ? `PB-MPM ${s.rate} Hz × ${s.iterations}` : `MLS-MPM ${s.rate} Hz`;
    console.log(`${label.padEnd(20)} ${String(passes).padStart(3)} passes  ${ms.toFixed(2).padStart(6)} ms/frame  ${(ms / passes * 1000 / sim.particleCount * 1000).toFixed(0)} ns/particle-pass  ${sim.particleCount} p  ${stats(sim.worlds[0])}`);
}
