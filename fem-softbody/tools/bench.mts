// Headless checks for FemBody with the demo's meshes: linear vs co-rotated FEM
// on the cantilever beams and the spinning cubes, a jelly block settling on the
// ground, and step cost per mesh and CG iteration count.
// Run from fem-softbody/: node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts [beam|spin|drop|cost]
import { FemBody, type BlockLayout } from '../assets/game/fem/FemBody';

const which = process.argv[2] ?? 'all';
const dt = 1 / 60;

const BEAMS: [string, number, number, number][] = [['full', 15, 3, 0.08], ['lite', 10, 2, 0.12]];

function beam(mesh: string, nx: number, n: number, cell: number, corotated: boolean): void {
    const body = new FemBody({ nx, ny: n, nz: n, cell, origin: [-0.6, 1.2 - (n * cell) / 2, 0], fixed: (i) => i === 0 });
    body.youngModulus = 4e5;
    body.rebuildStiffness();
    body.corotated = corotated;
    const tip = nx + (nx + 1) * ((n >> 1) + (n + 1) * (n >> 1));
    const y0 = body.rest[tip * 3 + 1];
    for (let f = 0; f < 300; f++) body.step(dt);
    const length = Math.hypot(body.x[tip * 3] + 0.6, body.x[tip * 3 + 1] - y0);
    console.log(
        `beam ${mesh} ${corotated ? 'corot ' : 'linear'}  tip drop ${((y0 - body.x[tip * 3 + 1]) * 100).toFixed(0)} cm` +
        `  root-to-tip ${(length * 100).toFixed(0)} cm (rest 120)  volume ${(body.volumeRatio * 100).toFixed(0)}%`,
    );
}

function spin(n: number, cell: number, corotated: boolean): void {
    const body = new FemBody({ nx: n, ny: n, nz: n, cell, origin: [0, 0, 0] });
    body.youngModulus = 1e5;
    body.rebuildStiffness();
    body.gravity = 0;
    body.massDamping = 0;
    body.corotated = corotated;
    const c = (n * cell) / 2;
    body.setRigidVelocity(0, 0, 0, 0.36, 1.5, 0.18, c, c, c);
    const marks: string[] = [];
    for (let f = 1; f <= 108; f++) {
        body.step(dt);
        if (f % 36 === 0) marks.push(`${(f / 60).toFixed(1)} s ${(body.volumeRatio * 100).toFixed(0)}%`);
    }
    console.log(`spin ${n}^3 ${corotated ? 'corot ' : 'linear'}  volume ${marks.join('  ')}`);
}

function drop(E: number): void {
    const body = new FemBody({ nx: 4, ny: 4, nz: 4, cell: 0.09, origin: [-0.18, 0.05, -0.18] });
    body.youngModulus = E;
    body.rebuildStiffness();
    for (let f = 0; f < 180; f++) body.step(dt);
    let top = -Infinity;
    for (let i = 0; i < body.nodeCount; i++) top = Math.max(top, body.x[i * 3 + 1]);
    const theory = (1000 * 9.81 * 0.36 * 0.36) / (2 * E);
    console.log(
        `settle E=${E.toExponential(0)}  sag ${((0.36 - top) * 100).toFixed(1)} cm (column under own weight: ${(theory * 100).toFixed(1)} cm)` +
        `  volume ${(body.volumeRatio * 100).toFixed(0)}%`,
    );
}

function cost(name: string, layouts: BlockLayout[], iterations: number): void {
    const bodies = layouts.map((layout) => {
        const body = new FemBody(layout);
        body.cgIterations = iterations;
        body.cgTolerance = 0;
        return body;
    });
    const step = () => { for (const b of bodies) b.step(dt); };
    for (let f = 0; f < 30; f++) step();
    let best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
        const t0 = performance.now();
        for (let f = 0; f < 20; f++) step();
        best = Math.min(best, (performance.now() - t0) / 20);
    }
    const tets = bodies.reduce((s, b) => s + b.tetCount, 0);
    console.log(`cost ${name} ${tets} tets  CG ${iterations}  ${best.toFixed(2)} ms/frame`);
}

function cube(n: number, cell: number, x: number): BlockLayout {
    return { nx: n, ny: n, nz: n, cell, origin: [x, 0.5, 0] };
}

if (which === 'all' || which === 'beam') {
    for (const [mesh, nx, n, cell] of BEAMS) for (const c of [false, true]) beam(mesh, nx, n, cell, c);
}
if (which === 'all' || which === 'spin') {
    for (const [n, cell] of [[5, 0.08], [3, 0.13]]) for (const c of [false, true]) spin(n, cell, c);
}
if (which === 'all' || which === 'drop') for (const E of [1e4, 3e4, 1e5]) drop(E);
if (which === 'all' || which === 'cost') {
    for (const it of [10, 20]) {
        for (const [mesh, nx, n, cell] of BEAMS) {
            const beamLayout = (z: number): BlockLayout => ({ nx, ny: n, nz: n, cell, origin: [-0.6, 1.1, z], fixed: (i) => i === 0 });
            cost(`beams ${mesh}`, [beamLayout(-0.4), beamLayout(0.4)], it);
        }
        cost('jelly full', [cube(4, 0.08, -0.6), cube(4, 0.08, 0), cube(4, 0.08, 0.6)], it);
        cost('jelly lite', [cube(3, 0.11, -0.6), cube(3, 0.11, 0), cube(3, 0.11, 0.6)], it);
    }
}
