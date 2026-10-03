// Checks: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
// Projection accuracy for both pressure solvers, symmetry of the multigrid
// preconditioner (CG needs it), boundedness of MacCormack, obstacle boundary
// conditions, and that every scene runs without blowing up.
import { Advection, type AdvectionKind, FluidGrid, Side } from '../assets/game/fluid/FluidGrid';
import { PressureSolver } from '../assets/game/fluid/Pressure';
import { buildScene, SCENES } from '../assets/game/fluid/Scenes';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

let seed = 7;
function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}

function randomVelocity(g: FluidGrid, scale: number): void {
    for (let i = 0; i < g.u.length; i++) g.u[i] = (rand() * 2 - 1) * scale;
    for (let i = 0; i < g.v.length; i++) g.v[i] = (rand() * 2 - 1) * scale;
}

function maxDiv(g: FluidGrid): number {
    const d = new Float64Array(g.nx * g.ny);
    g.computeDivergence(d);
    let m = 0;
    for (let c = 0; c < d.length; c++) m = Math.max(m, Math.abs(d[c]));
    return m;
}

/** Fresh grid with the step's obstacle pass done, ready for a bare projection. */
function projectionGrid(nx: number, ny: number, open: boolean): FluidGrid {
    const g = new FluidGrid(nx, ny);
    if (open) g.sides.splice(0, 4, Side.Inflow, Side.Open, Side.Wall, Side.Wall);
    g.inflow = 5;
    g.obstacles.push({ x: nx * 0.3, y: ny * 0.5, r: ny * 0.12, vx: 2, vy: -1 });
    g.step(); // rasterizes the obstacle
    return g;
}

// Projection: MGPCG removes divergence to solver tolerance; Jacobi leaves most of it.
for (const open of [true, false]) {
    const label = open ? 'open' : 'closed';
    const g = projectionGrid(128, 64, open);
    seed = 11;
    randomVelocity(g, 10);
    g.applyBoundary();
    const before = maxDiv(g);
    g.params.pressure = PressureSolver.MGPCG;
    g.pressure.reset();
    g.project();
    const mg = maxDiv(g);
    const iters = g.stats.pressureIterations;
    check(`MGPCG projection (${label})`, mg < 1e-3 * before, `max|div| ${before.toFixed(2)} → ${mg.toExponential(1)} in ${iters} iterations`);
    check(`MGPCG converges in ≤ 25 iterations (${label})`, iters <= 25, `${iters}`);

    seed = 11;
    randomVelocity(g, 10);
    g.applyBoundary();
    g.params.pressure = PressureSolver.Jacobi;
    g.params.jacobiIterations = 40;
    g.pressure.reset();
    g.project();
    const jac = maxDiv(g);
    check(`Jacobi ×40 is far less accurate (${label})`, jac > 100 * mg, `max|div| → ${jac.toExponential(1)}`);
}

// The V-cycle preconditioner must be symmetric positive definite for CG.
{
    const g = projectionGrid(96, 48, true);
    const pr = g.pressure;
    const n = g.nx * g.ny;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const mx = new Float64Array(n);
    const my = new Float64Array(n);
    const diag = pr.levels[0].diag;
    for (let c = 0; c < n; c++) {
        x[c] = diag[c] ? rand() - 0.5 : 0;
        y[c] = diag[c] ? rand() - 0.5 : 0;
    }
    pr.precondition(x, mx);
    pr.precondition(y, my);
    let a = 0;
    let b = 0;
    let xmx = 0;
    let norm = 0;
    for (let c = 0; c < n; c++) {
        a += mx[c] * y[c];
        b += x[c] * my[c];
        xmx += x[c] * mx[c];
        norm += Math.abs(mx[c] * y[c]);
    }
    check('preconditioner symmetric', Math.abs(a - b) <= 1e-10 * norm, `|⟨Mx,y⟩ − ⟨x,My⟩| / Σ|·| = ${(Math.abs(a - b) / norm).toExponential(1)}`);
    check('preconditioner positive', xmx > 0, `⟨x,Mx⟩ = ${xmx.toFixed(3)}`);
}

// Faces touching the moving obstacle carry its velocity after a full step.
{
    const g = projectionGrid(96, 48, true);
    seed = 3;
    randomVelocity(g, 5);
    g.step();
    const { nx, ny, solid } = g;
    let worst = 0;
    for (let j = 0; j < ny; j++) {
        for (let i = 1; i < nx; i++) {
            const c = i + j * nx;
            if (solid[c] !== solid[c - 1]) worst = Math.max(worst, Math.abs(g.u[i + j * (nx + 1)] - 2));
        }
    }
    for (let j = 1; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const c = i + j * nx;
            if (solid[c] !== solid[c - nx]) worst = Math.max(worst, Math.abs(g.v[c] + 1));
        }
    }
    check('obstacle faces move with the obstacle', worst < 1e-5, `max error ${worst.toExponential(1)}`);
}

// Advection: constants stay constant, MacCormack makes no new extrema, and it
// keeps a moving blob sharper than semi-Lagrangian.
function blobRun(kind: AdvectionKind): { peak: number; cx: number } {
    const g = new FluidGrid(128, 32);
    g.sides.splice(0, 4, Side.Inflow, Side.Open, Side.Wall, Side.Wall);
    g.inflow = 10;
    g.params.advection = kind;
    g.u.fill(10);
    g.splat(20, 16, 3, 0, 0, 1, 1, 1);
    for (let s = 0; s < 240; s++) g.step();
    let peak = 0;
    let mass = 0;
    let mx = 0;
    for (let j = 0; j < g.ny; j++) {
        for (let i = 0; i < g.nx; i++) {
            const d = g.r[i + j * g.nx];
            peak = Math.max(peak, d);
            mass += d;
            mx += d * (i + 0.5);
        }
    }
    return { peak, cx: mx / mass };
}
{
    const sl = blobRun(Advection.SemiLagrangian);
    const mc = blobRun(Advection.MacCormack);
    check('blob travels 40 cells in 4 s (SL)', Math.abs(sl.cx - 60) < 1.5, `centroid x ${sl.cx.toFixed(2)}`);
    check('blob travels 40 cells in 4 s (MacCormack)', Math.abs(mc.cx - 60) < 1.5, `centroid x ${mc.cx.toFixed(2)}`);
    check('MacCormack keeps the blob sharper', mc.peak > sl.peak * 1.3, `peak SL ${sl.peak.toFixed(3)} vs MacCormack ${mc.peak.toFixed(3)}`);
}
for (const kind of [Advection.SemiLagrangian, Advection.MacCormack]) {
    const name = kind === Advection.MacCormack ? 'MacCormack' : 'SL';
    const g = new FluidGrid(64, 64);
    g.params.advection = kind;
    for (let j = 0; j < 64; j++) {
        for (let i = 0; i <= 64; i++) g.u[i + j * 65] = 20 * Math.sin((Math.PI * (j + 0.5)) / 64) * Math.sin((Math.PI * i) / 64);
    }
    g.project();
    g.r.fill(0.7);
    for (let c = 0; c < g.g.length; c++) g.g[c] = rand();
    for (let s = 0; s < 120; s++) g.step();
    let rErr = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < g.r.length; c++) {
        rErr = Math.max(rErr, Math.abs(g.r[c] - 0.7));
        lo = Math.min(lo, g.g[c]);
        hi = Math.max(hi, g.g[c]);
    }
    check(`constant dye stays constant (${name})`, rErr < 1e-5, `max error ${rErr.toExponential(1)}`);
    check(`no new extrema (${name})`, lo >= 0 && hi <= 1, `range [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
}

// Every scene, both advection schemes, both pressure solvers: 10 s without blowing up.
for (const scene of SCENES) {
    for (const kind of [Advection.SemiLagrangian, Advection.MacCormack]) {
        for (const pressure of [PressureSolver.MGPCG, PressureSolver.Jacobi]) {
            const g = new FluidGrid(96, 48);
            g.params.advection = kind;
            g.params.pressure = pressure;
            g.params.vorticity = 0.3;
            const s = buildScene(scene, g);
            let finite = true;
            let speed = 0;
            for (let k = 0; k < 600; k++) {
                g.step((grid) => s.drive(grid));
                speed = Math.max(speed, g.stats.maxSpeed);
            }
            for (let c = 0; c < g.r.length; c++) if (!Number.isFinite(g.r[c])) finite = false;
            for (let c = 0; c < g.u.length; c++) if (!Number.isFinite(g.u[c])) finite = false;
            const label = `${scene} ${kind === Advection.MacCormack ? 'MC' : 'SL'} ${pressure === PressureSolver.MGPCG ? 'MGPCG' : 'Jacobi'}`;
            check(`stable: ${label}`, finite && speed < 2 * 48, `max speed ${speed.toFixed(1)} cells/s, last div ${g.stats.maxDivergence.toExponential(1)}`);
        }
    }
}

// Shedding: with MacCormack the wake behind the cylinder swings (probe v changes sign).
{
    for (const kind of [Advection.SemiLagrangian, Advection.MacCormack]) {
        const g = new FluidGrid(160, 80);
        g.params.advection = kind;
        const s = buildScene('tunnel', g);
        let flips = 0;
        let last = 0;
        let amp = 0;
        for (let k = 0; k < 1500; k++) {
            g.step((grid) => s.drive(grid));
            if (k < 600) continue;
            const v = g.v[Math.round(0.5 * g.nx) + Math.round(0.5 * g.ny) * g.nx];
            amp = Math.max(amp, Math.abs(v));
            if (v * last < 0 && Math.abs(v) > 0.5) flips++;
            if (Math.abs(v) > 0.5) last = v;
        }
        const name = kind === Advection.MacCormack ? 'MacCormack' : 'SL';
        if (kind === Advection.MacCormack) check(`vortex street (${name})`, flips >= 4, `${flips} wake swings in 15 s, |v| up to ${amp.toFixed(1)} cells/s`);
        else console.log(`info vortex street (${name})  ${flips} wake swings in 15 s, |v| up to ${amp.toFixed(1)} cells/s`);
    }
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
