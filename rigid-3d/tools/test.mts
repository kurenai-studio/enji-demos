// Headless checks for the rigid body solver: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { collide, ContactBuffer } from '../assets/game/rigid/Collide.ts';
import { quat, quatFromEuler, v3 } from '../assets/game/rigid/Math3.ts';
import { Shape } from '../assets/game/rigid/RigidBody.ts';
import { buildScene } from '../assets/game/rigid/Scenes.ts';
import type { SceneName } from '../assets/game/rigid/Scenes.ts';
import { Solver, SOLVER_NAMES, World } from '../assets/game/rigid/World.ts';

const H = 1 / 60;
let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) failures++;
}

function contacts(rotA: [number, number, number], posA: [number, number, number], rotB: [number, number, number], posB: [number, number, number]): ContactBuffer {
    const w = new World();
    const deg = Math.PI / 180;
    const a = w.add({ shape: Shape.Box, half: v3(0.5, 0.5, 0.5), position: v3(...posA), rotation: quatFromEuler(quat(), rotA[0] * deg, rotA[1] * deg, rotA[2] * deg), density: 1 });
    const b = w.add({ shape: Shape.Box, half: v3(0.5, 0.5, 0.5), position: v3(...posB), rotation: quatFromEuler(quat(), rotB[0] * deg, rotB[1] * deg, rotB[2] * deg), density: 1 });
    const buf = new ContactBuffer();
    collide(a, b, 0.02, buf);
    return buf;
}

// ---- narrow phase
{
    const c = contacts([0, 0, 0], [0, 0, 0], [0, 0, 0], [0.2, 0.99, 0.1]);
    check('box on box: face contact', c.count === 4 && c.normal.y > 0.999 && c.points.slice(0, 4).every((p) => Math.abs(p.s + 0.01) < 1e-6),
        `count ${c.count} n.y ${c.normal.y.toFixed(3)} s ${c.points[0].s.toFixed(4)}`);
    const r = contacts([0, 0, 0], [0, 0, 0], [0, 45, 0], [0, 0.99, 0]);
    check('twisted box on box: clipped octagon reduced to 4', r.count === 4 && r.normal.y > 0.999, `count ${r.count}`);
    const below = contacts([0, 0, 0], [0, 1.0, 0], [0, 0, 0], [0, 0, 0]);
    check('normal points from A to B', below.count === 4 && below.normal.y < -0.999, `n.y ${below.normal.y.toFixed(3)}`);
    // Edge down onto edge up, crossed at right angles.
    const e = contacts([0, 0, 45], [0, 0, 0], [45, 0, 0], [0, Math.SQRT2 - 0.01, 0]);
    check('crossed edges: one edge-edge point', e.count === 1 && e.normal.y > 0.99 && Math.abs(e.points[0].s + 0.01) < 1e-4,
        `count ${e.count} n.y ${e.normal.y.toFixed(3)} s ${e.points[0]?.s.toFixed(4)}`);
    const far = contacts([0, 0, 0], [0, 0, 0], [10, 20, 30], [0, 1.6, 0]);
    check('separated boxes: no contact', far.count === 0, `count ${far.count}`);
}

// ---- single bodies
for (const solver of [Solver.Sequential, Solver.Soft]) {
    const w = new World();
    w.solver = solver;
    buildEmpty(w);
    const box = w.add({ shape: Shape.Box, half: v3(0.2, 0.2, 0.2), position: v3(0, 0.5, 0), density: 500 });
    for (let i = 0; i < 120; i++) w.step(H);
    const speed = Math.hypot(box.v.x, box.v.y, box.v.z);
    check(`${SOLVER_NAMES[solver]}: dropped box comes to rest`, speed < 0.01 && Math.abs(box.p.y - 0.2) < 0.01,
        `y ${box.p.y.toFixed(4)} speed ${speed.toExponential(1)}`);

    const s = new World();
    s.solver = solver;
    buildEmpty(s);
    const slider = s.add({ shape: Shape.Box, half: v3(0.2, 0.2, 0.2), position: v3(0, 0.2, 0), velocity: v3(3, 0, 0), density: 500, friction: 0.6 });
    for (let i = 0; i < 120; i++) s.step(H);
    const expected = 9 / (2 * 0.6 * 9.81);
    check(`${SOLVER_NAMES[solver]}: Coulomb friction stops a sliding box at v²/2μg`, Math.abs(slider.p.x - expected) < 0.08 * expected && Math.abs(slider.v.x) < 0.01,
        `slid ${slider.p.x.toFixed(3)} m, expected ${expected.toFixed(3)} m`);
}

// ---- scenes
function run(name: SceneName, solver: Solver, seconds: number): World {
    const w = new World();
    w.solver = solver;
    buildScene(w, name);
    let maxPen = 0;
    for (let i = 0; i < seconds * 60; i++) {
        w.step(H);
        maxPen = Math.max(maxPen, w.stats.maxPenetration);
    }
    (w as World & { peak: number }).peak = maxPen;
    return w;
}
const peak = (w: World): number => (w as World & { peak: number }).peak;
const finite = (w: World): boolean => w.bodies.every((b) => Number.isFinite(b.p.x + b.p.y + b.p.z + b.q.w));

// Group 1 is the pyramid, group 2 the ten-cube tower.
const stacks = [Solver.Naive, Solver.Sequential, Solver.Soft].map((solver) => {
    const w = run('stack', solver, 8);
    const st = w.stats;
    console.log(`      stack/${SOLVER_NAMES[solver]}: pyramid moved ${st.groupMoved[1]}/${st.groupTotal[1]}, tower moved ${st.groupMoved[2]}/${st.groupTotal[2]}, peak overlap ${(peak(w) * 1000).toFixed(1)} mm`);
    return w;
});
check('Naive impulses: the pyramid falls apart', stacks[0].stats.groupMoved[1] > 10, `${stacks[0].stats.groupMoved[1]} of 28 moved`);
check('Sequential impulses: the pyramid stands for 8 s', stacks[1].stats.groupMoved[1] === 0 && finite(stacks[1]), `${stacks[1].stats.groupMoved[1]} moved`);
check('Soft step: pyramid and tower stand for 8 s', stacks[2].stats.moved === 0 && finite(stacks[2]),
    `${stacks[2].stats.moved} moved, max drift ${(stacks[2].stats.maxDrift * 100).toFixed(2)} cm`);
for (const solver of [Solver.Sequential, Solver.Soft]) {
    const w = run('domino', solver, 10);
    check(`${SOLVER_NAMES[solver]}: all dominoes topple`, w.stats.moved === w.stats.tracked && finite(w), `${w.stats.moved}/${w.stats.tracked}`);
    const p = run('pile', solver, 8);
    const inside = p.bodies.every((b) => b.isStatic || (Math.abs(b.p.x) < 1.35 && Math.abs(b.p.z) < 1.35 && b.p.y > 0));
    const speed = Math.max(...p.bodies.map((b) => Math.hypot(b.v.x, b.v.y, b.v.z)));
    check(`${SOLVER_NAMES[solver]}: pile settles inside the bin`, inside && finite(p) && speed < 0.3 && peak(p) < 0.05,
        `max speed ${speed.toFixed(3)} m/s, peak overlap ${(peak(p) * 1000).toFixed(1)} mm, final overlap ${(p.stats.maxPenetration * 1000).toFixed(1)} mm`);
}

function buildEmpty(w: World): void {
    w.add({ shape: Shape.Plane, position: v3(0, 0, 0), density: 0 });
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
