// Headless run of every scene with both contact models:
//   node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts [seconds]
// Reports solver cost per 60 Hz step (median, 95th percentile, worst), Newton
// iterations, the smallest contact distance, crossing boundary edges, and a
// per-scene outcome.
import { type BodyDef, type ContactModel, DEFAULT_PARAMS, IpcWorld } from '../assets/game/ipc/IpcWorld';
import { buildScene, RIGID_AS_FEM, rigidAsFem, SCENE_NAMES } from '../assets/game/ipc/Scenes';

const seconds = Number(process.argv[2] ?? 6);

function centre(world: IpcWorld, body: number): [number, number] {
    const b = world.bodies[body];
    let x = 0;
    let y = 0;
    for (let i = b.start; i < b.start + b.count; i++) {
        x += world.x[2 * i];
        y += world.x[2 * i + 1];
    }
    return [x / b.count, y / b.count];
}

interface Track {
    thinnest: number;
    tunnelled: number;
    sides: Record<number, number>;
}

/** What the scene is there to show. */
function outcome(scene: number, world: IpcWorld, track: Track): string {
    const last = world.bodies.length - 1;
    if (scene === 1) {
        // Thinnest the jelly ball (index 5, right after the plate) gets while the plate is down.
        const b = world.bodies[5];
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = b.start; i < b.start + b.count; i++) {
            lo = Math.min(lo, world.x[2 * i + 1]);
            hi = Math.max(hi, world.x[2 * i + 1]);
        }
        track.thinnest = Math.min(track.thinnest, hi - lo);
        return `ball squashed to ${(track.thinnest * 100).toFixed(1)} cm of 30`;
    }
    if (scene === 2) {
        // A tunnel: at the bullet's height the bullet is left of a slab one step and right of it the next.
        const [bx, by] = centre(world, last);
        for (let s = last - 3; s < last; s++) {
            const side = sideOf(world, s, bx, by);
            const before = track.sides[s];
            if (before === -1 && side === 1) track.tunnelled++;
            track.sides[s] = side;
        }
        return track.tunnelled ? `bullet went through ${track.tunnelled} slab${track.tunnelled > 1 ? 's' : ''}` : 'bullet stopped by the slabs';
    }
    return '';
}

/** −1 / 1 if (px, py) is left / right of the body's outline on the horizontal line through it, 0 if inside or not level with it. */
function sideOf(world: IpcWorld, body: number, px: number, py: number): number {
    const b = world.bodies[body];
    const x = world.x;
    let lo = Infinity;
    let hi = -Infinity;
    for (let e = b.edgeStart; e < b.edgeStart + b.edgeCount; e++) {
        const i = world.edges[2 * e];
        const j = world.edges[2 * e + 1];
        const y0 = x[2 * i + 1];
        const y1 = x[2 * j + 1];
        if ((y0 - py) * (y1 - py) > 0 || y0 === y1) continue;
        const t = (py - y0) / (y1 - y0);
        const cx = x[2 * i] + t * (x[2 * j] - x[2 * i]);
        lo = Math.min(lo, cx);
        hi = Math.max(hi, cx);
    }
    if (lo > hi) return 0;
    return px < lo ? -1 : px > hi ? 1 : 0;
}

console.log(`${seconds} s per run at 60 Hz, Node ${process.version}`);
for (let s = 0; s < SCENE_NAMES.length; s++) {
    for (const model of ['ipc', 'penalty'] as ContactModel[]) {
        const world = new IpcWorld(buildScene(s).bodies, model);
        const times: number[] = [];
        let newton = 0;
        let maxNewton = 0;
        let capped = 0;
        let minDistance = Infinity;
        let crossingSteps = 0;
        let maxCrossings = 0;
        const track: Track = { thinnest: Infinity, tunnelled: 0, sides: {} };
        const steps = Math.round(seconds * 60);
        for (let i = 0; i < steps; i++) {
            world.step();
            times.push(world.stats.ms);
            newton += world.stats.newton;
            maxNewton = Math.max(maxNewton, world.stats.newton);
            if (!world.stats.converged) capped++;
            minDistance = Math.min(minDistance, world.stats.minDistance);
            const c = world.countCrossings();
            if (c > 0) crossingSteps++;
            maxCrossings = Math.max(maxCrossings, c);
            outcome(s, world, track);
        }
        times.sort((a, b) => a - b);
        const pct = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
        console.log(
            `${SCENE_NAMES[s].padEnd(8)} ${model.padEnd(7)} ${world.vertexCount} verts  step ${pct(0.5)} ms (p95 ${pct(0.95)}, worst ${times[times.length - 1].toFixed(1)})` +
            `  Newton ${(newton / steps).toFixed(1)}/step (max ${maxNewton}, capped ${capped})` +
            `  min gap ${(minDistance * 1000).toFixed(3)} mm  crossing in ${crossingSteps} steps (max ${maxCrossings})  ${outcome(s, world, track)}`,
        );
    }
}

// Crates with IPC: rigid bodies as affine bodies (several orthogonality stiffnesses) or as stiff FEM.
console.log('\nCrates, IPC: rigid bodies as ABD or as stiff FEM');
const crateDefs = buildScene(SCENE_NAMES.indexOf('Crates')).bodies;
const rigidIndices = crateDefs.map((d, i) => (d.rigid ? i : -1)).filter((i) => i >= 0);
const runs: [string, BodyDef[], number][] = [
    ...[1e6, 1e7, 1e8].map((k): [string, BodyDef[], number] => [`ABD κ ${k.toExponential(0)}`, crateDefs, k]),
    [`FEM E ${RIGID_AS_FEM.young.toExponential(0)}`, rigidAsFem(crateDefs), DEFAULT_PARAMS.abdStiffness],
];
for (const [name, defs, kappa] of runs) {
    const world = new IpcWorld(defs, 'ipc', { ...DEFAULT_PARAMS, abdStiffness: kappa });
    const times: number[] = [];
    let newton = 0;
    let cg = 0;
    let strain = 0;
    let crossings = 0;
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps; i++) {
        world.step();
        times.push(world.stats.ms);
        newton += world.stats.newton;
        cg += world.stats.cg;
        crossings += world.countCrossings();
        for (const k of rigidIndices) {
            const b = world.bodies[k];
            for (let t = b.triStart; t < b.triStart + b.triCount; t++) strain = Math.max(strain, world.strain(t));
        }
    }
    times.sort((a, b) => a - b);
    const pct = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
    console.log(
        `${name.padEnd(12)} ${2 * world.dofCount} unknowns  step ${pct(0.5)} ms (p95 ${pct(0.95)})  Newton ${(newton / steps).toFixed(1)}/step  CG ${(cg / steps).toFixed(0)}/step` +
        `  max rigid strain ${strain.toExponential(1)}  crossings ${crossings}`,
    );
}
