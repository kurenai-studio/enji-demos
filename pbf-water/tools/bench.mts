// Headless benchmark: node --experimental-strip-types tools/bench.mts
// Runs the dam break from MainView for 6 s at 60 Hz for each solver iteration
// level and reports the solver and surface mesher cost per frame and the
// density error after the water has settled.
import { PBFSolver } from '../assets/game/water/PBFSolver.ts';
import { SurfaceMesher } from '../assets/game/water/SurfaceMesher.ts';

const TANK_MIN: [number, number, number] = [-1, 0, -0.45];
const TANK_MAX: [number, number, number] = [1, 1.3, 0.45];
const KERNEL_H = 0.1;
const SPACING = 0.05;
const FRAMES = 360;

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

for (const iterations of [2, 3, 4, 6]) {
    const solver = new PBFSolver(8000, KERNEL_H, SPACING, { min: TANK_MIN, max: TANK_MAX });
    solver.iterations = iterations;
    solver.vorticity = 0;
    solver.addBlock(TANK_MIN[0], TANK_MIN[1], TANK_MIN[2], -0.2, 0.95, TANK_MAX[2]);
    const mesher = new SurfaceMesher([TANK_MIN[0], TANK_MIN[1], TANK_MIN[2]], [TANK_MAX[0], TANK_MAX[1] + 0.35, TANK_MAX[2]], 0.045, 0.09);

    const sim: number[] = [];
    const mesh: number[] = [];
    let settledError = 0;
    for (let f = 0; f < FRAMES; f++) {
        const t0 = performance.now();
        solver.step(1 / 60);
        const t1 = performance.now();
        mesher.splat(solver.x, solver.y, solver.z, solver.count, ...TANK_MIN, TANK_MAX[0], TANK_MAX[1] + 0.35, TANK_MAX[2]);
        mesher.blur();
        mesher.extract();
        const t2 = performance.now();
        if (f >= 30) {
            sim.push(t1 - t0);
            mesh.push(t2 - t1);
        }
        if (f >= FRAMES - 60) settledError += solver.avgDensityError / 60;
    }
    sim.sort((a, b) => a - b);
    mesh.sort((a, b) => a - b);
    const finite = solver.x.subarray(0, solver.count).every(Number.isFinite);
    console.log(
        `iters ${iterations}  particles ${solver.count}  neighbours ${solver.avgNeighbors.toFixed(1)}  ` +
        `sim avg ${mean(sim).toFixed(1)} ms p95 ${percentile(sim, 0.95).toFixed(1)} ms  ` +
        `mesh avg ${mean(mesh).toFixed(1)} ms  tris ${mesher.indexCount / 3}  ` +
        `settled density error ${(settledError * 100).toFixed(1)}%` + (finite ? '' : '  NaN!'),
    );
}
