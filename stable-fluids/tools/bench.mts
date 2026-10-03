// Bench: node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts [nx ny seconds]
// Every scene with both advection schemes and three pressure settings on the
// demo grid: step cost, where it goes, how much divergence the pressure solve
// leaves, and how much swirl survives. Prints a markdown table.
import { Advection, FluidGrid } from '../assets/game/fluid/FluidGrid';
import { PressureSolver, type PressureKind } from '../assets/game/fluid/Pressure';
import { buildScene, SCENES } from '../assets/game/fluid/Scenes';

const nx = Number(process.argv[2] ?? 160);
const ny = Number(process.argv[3] ?? 80);
const seconds = Number(process.argv[4] ?? 6);
const steps = Math.round(seconds * 60);
const WARMUP = 60;

const pressures: { kind: PressureKind; iterations: number; name: string }[] = [
    { kind: PressureSolver.MGPCG, iterations: 0, name: 'MGPCG' },
    { kind: PressureSolver.Jacobi, iterations: 40, name: 'Jacobi 40' },
    { kind: PressureSolver.Jacobi, iterations: 200, name: 'Jacobi 200' },
];

function median(xs: number[]): number {
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

console.log(`grid ${nx}×${ny}, ${seconds} s per run (+1 s warm-up), dt 1/60\n`);
console.log('| scene | advection | pressure | step ms | advect ms | pressure ms | iterations | mean max\\|∇·u\\| | swirl (½Σω²) |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const scene of SCENES) {
    for (const advection of [Advection.SemiLagrangian, Advection.MacCormack]) {
        for (const pr of pressures) {
            const g = new FluidGrid(nx, ny);
            g.params.advection = advection;
            g.params.pressure = pr.kind;
            g.params.jacobiIterations = pr.iterations;
            const s = buildScene(scene, g);
            const step: number[] = [];
            const adv: number[] = [];
            const prs: number[] = [];
            let iters = 0;
            let div = 0;
            for (let k = 0; k < WARMUP + steps; k++) {
                g.step((grid) => s.drive(grid));
                if (k < WARMUP) continue;
                step.push(g.stats.stepMs);
                adv.push(g.stats.advectMs);
                prs.push(g.stats.pressureMs);
                iters += g.stats.pressureIterations;
                div += g.stats.maxDivergence;
            }
            const name = advection === Advection.MacCormack ? 'MacCormack' : 'semi-Lagrangian';
            console.log(
                `| ${scene} | ${name} | ${pr.name} | ${median(step).toFixed(2)} | ${median(adv).toFixed(2)} | ${median(prs).toFixed(2)} | ${(iters / steps).toFixed(1)} | ${(div / steps).toExponential(1)} | ${(g.stats.enstrophy / 1000).toFixed(1)}k |`,
            );
        }
    }
}
