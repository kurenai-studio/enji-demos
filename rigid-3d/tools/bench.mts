// Step time and outcome per scene and solver: node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts
import { buildScene, SCENES } from '../assets/game/rigid/Scenes.ts';
import { Solver, SOLVER_NAMES, World } from '../assets/game/rigid/World.ts';

const H = 1 / 60;
const SECONDS = 8;

console.log('| scene | solver | median step | p95 step | contacts (end) | outcome after 8 s | peak overlap |');
console.log('|---|---|---|---|---|---|---|');
for (const scene of SCENES) {
    for (const solver of [Solver.Naive, Solver.Sequential, Solver.Soft]) {
        const w = new World();
        w.solver = solver;
        const info = buildScene(w, scene);
        const times: number[] = [];
        let peak = 0;
        for (let i = 0; i < SECONDS * 60; i++) {
            w.step(H);
            times.push(w.stats.stepMs);
            peak = Math.max(peak, w.stats.maxPenetration);
        }
        times.sort((a, b) => a - b);
        const st = w.stats;
        const outcome = info.groups
            .map((label, g) => (label ? `${label} ${st.groupMoved[g]}/${st.groupTotal[g]}` : ''))
            .filter(Boolean)
            .join(', ') || '—';
        console.log(`| ${scene} | ${SOLVER_NAMES[solver]} | ${times[times.length >> 1].toFixed(2)} ms | ${times[Math.floor(times.length * 0.95)].toFixed(2)} ms | ${st.contacts} | ${outcome} | ${(peak * 1000).toFixed(0)} mm |`);
    }
}
