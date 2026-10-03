// Headless benchmark: node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts [iterations]
// Runs the dam break from MainView for 6 s at 60 Hz at every quality level and
// reports the solver and surface mesher cost per frame (median and fastest, as
// the machine may be busy), how far the front got, and the density error after
// the water has settled.
import { PBFSolver } from '../assets/game/water/PBFSolver';
import { applyQuality, QUALITY } from '../assets/game/water/Quality';
import { SurfaceMesher } from '../assets/game/water/SurfaceMesher';

const TANK_MIN: [number, number, number] = [-1, 0, -0.45];
const TANK_MAX: [number, number, number] = [1, 1.3, 0.45];
const DAM_X1 = -0.2;
const DAM_Y1 = 0.95;
const FRAMES = 360;
const iterations = Number(process.argv[2] ?? 3);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

for (const q of QUALITY) {
    const solver = new PBFSolver(8000, q.kernel, q.spacing, { min: TANK_MIN, max: TANK_MAX });
    applyQuality(solver, q);
    solver.iterations = iterations;
    solver.vorticity = 0;
    solver.addBlock(TANK_MIN[0], TANK_MIN[1], TANK_MIN[2], DAM_X1, DAM_Y1, TANK_MAX[2]);
    const mesher = new SurfaceMesher([TANK_MIN[0], TANK_MIN[1], TANK_MIN[2]], [TANK_MAX[0], TANK_MAX[1] + 0.35, TANK_MAX[2]], q.meshCell, q.meshRadius);

    const sim: number[] = [];
    const mesh: number[] = [];
    let settledError = 0;
    let frontAt05 = 0;
    let maxHeight = 0;
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
        if (f === 29) {
            for (let i = 0; i < solver.count; i++) frontAt05 = Math.max(frontAt05, solver.x[i]);
        }
        if (f >= FRAMES - 60) settledError += solver.avgDensityError / 60;
    }
    for (let i = 0; i < solver.count; i++) maxHeight = Math.max(maxHeight, solver.y[i]);
    const finite = solver.x.subarray(0, solver.count).every(Number.isFinite);
    console.log(
        `${q.name.padEnd(6)} spacing ${q.spacing}  particles ${solver.count}  neighbours ${solver.avgNeighbors.toFixed(1)}  ` +
        `sim ${median(sim).toFixed(1)} ms (fastest ${Math.min(...sim).toFixed(1)})  mesh ${median(mesh).toFixed(1)} ms (fastest ${Math.min(...mesh).toFixed(1)})  ` +
        `front at 0.5 s x=${frontAt05.toFixed(2)}  settled depth ${maxHeight.toFixed(2)} m  density error ${(settledError * 100).toFixed(1)}%` +
        (finite ? '' : '  NaN!'),
    );
}
