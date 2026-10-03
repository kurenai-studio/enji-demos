// Node tests for the navigation stack: A* and JPS optimality on both maps,
// path smoothing, flow fields, ORCA avoidance and the full swap scenario.
// node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { Crowd, DEFAULT_PARAMS } from '../assets/game/nav/Crowd.ts';
import { FlowField } from '../assets/game/nav/FlowField.ts';
import { Grid, mazeMap, type NavMap, roomsMap, rng, SQRT2 } from '../assets/game/nav/Grid.ts';
import { AStar, cellPathCost, expandJumps, Jps } from '../assets/game/nav/Search.ts';
import { polylineLength, smoothPath } from '../assets/game/nav/Smooth.ts';
import { ARRIVE, type Pathing, type Scenario, Swarm } from '../assets/game/nav/Swarm.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failed++;
}

const maps: NavMap[] = [roomsMap(), mazeMap()];

function freeCells(g: Grid): number[] {
    const out: number[] = [];
    for (let i = 0; i < g.w * g.h; i++) if (!g.blocked[i]) out.push(i);
    return out;
}

/** Valid 8-connected cell path: free cells, unit steps, no corner cutting. */
function validCellPath(g: Grid, cells: number[]): boolean {
    for (let k = 0; k < cells.length; k++) {
        if (g.blocked[cells[k]]) return false;
        if (k === 0) continue;
        const ax = cells[k - 1] % g.w, ay = (cells[k - 1] - ax) / g.w;
        const bx = cells[k] % g.w, by = (cells[k] - bx) / g.w;
        const dx = bx - ax, dy = by - ay;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
        if (dx && dy && (!g.free(ax + dx, ay) || !g.free(ax, ay + dy))) return false;
    }
    return true;
}

// ---------------------------------------------------------------- maps
for (const m of maps) {
    const g = m.grid;
    const f = new FlowField(g);
    f.build(m.targets[1][0], m.targets[1][1], DEFAULT_PARAMS.radius);
    const free = freeCells(g);
    const reachable = free.filter((i) => Number.isFinite(f.cost[i])).length;
    const startCell = Math.floor(m.targets[0][1]) * g.w + Math.floor(m.targets[0][0]);
    check(`${m.name}: every free cell reachable, targets connected`, reachable === free.length && Number.isFinite(f.cost[startCell]),
        `${free.length} free of ${g.w * g.h}, target to target ${f.cost[startCell].toFixed(1)} m`);
}

// ---------------------------------------------------------------- A* vs Dijkstra, JPS vs A*
for (const m of maps) {
    const g = m.grid;
    const free = freeCells(g);
    const r = rng(3);
    const pick = (): number => free[Math.floor(r() * free.length)];
    const astar = new AStar(g), jps = new Jps(g);
    const field = new FlowField(g);

    let worstDijkstra = 0;
    for (let q = 0; q < 40; q++) {
        const goal = pick();
        const gx = goal % g.w;
        field.build(gx + 0.5, (goal - gx) / g.w + 0.5, DEFAULT_PARAMS.radius);
        for (let k = 0; k < 10; k++) {
            const start = pick();
            const res = astar.find(start, goal)!;
            worstDijkstra = Math.max(worstDijkstra, Math.abs(res.cost - field.cost[start]));
        }
    }
    check(`${m.name}: A* cost = Dijkstra cost (400 queries)`, worstDijkstra < 1e-9, `worst difference ${worstDijkstra.toExponential(1)}`);

    const queries: [number, number][] = [];
    for (let q = 0; q < 500; q++) queries.push([pick(), pick()]);
    let worst = 0, badPaths = 0, expA = 0, expJ = 0, jumpPoints = 0;
    for (const [s, t] of queries) {
        const a = astar.find(s, t)!, j = jps.find(s, t)!;
        worst = Math.max(worst, Math.abs(a.cost - j.cost));
        const cells = expandJumps(g, j.cells);
        if (!validCellPath(g, a.cells) || !validCellPath(g, cells) || cells[0] !== s || cells[cells.length - 1] !== t
            || Math.abs(cellPathCost(g, cells) - j.cost) > 1e-9) badPaths++;
        expA += a.expanded; expJ += j.expanded; jumpPoints += j.cells.length;
    }
    check(`${m.name}: JPS cost = A* cost, paths valid (500 queries)`, worst < 1e-9 && badPaths === 0,
        `worst ${worst.toExponential(1)}, ${badPaths} bad paths, ${(jumpPoints / 500).toFixed(1)} jump points per path`);
    check(`${m.name}: JPS expands fewer nodes`, expJ < expA, `A* ${(expA / 500).toFixed(0)} vs JPS ${(expJ / 500).toFixed(0)} per query (${(expA / expJ).toFixed(1)}×)`);

    const time = (fn: () => void): number => {
        for (let k = 0; k < 2; k++) fn();
        const t0 = performance.now();
        fn();
        return ((performance.now() - t0) * 1000) / queries.length;
    };
    const ta = time(() => { for (const [s, t] of queries) astar.find(s, t); });
    const tj = time(() => { for (const [s, t] of queries) jps.find(s, t); });
    check(`${m.name}: timing per query`, true, `A* ${ta.toFixed(0)} µs, JPS ${tj.toFixed(0)} µs (${(ta / tj).toFixed(1)}×)`);
}

// ---------------------------------------------------------------- smoothing
for (const m of maps) {
    const g = m.grid;
    const free = freeCells(g);
    const r = rng(9);
    const astar = new AStar(g);
    const rad = DEFAULT_PARAMS.radius;
    let worseCount = 0, unclear = 0, endsWrong = 0, sumGrid = 0, sumSmooth = 0, sumPts = 0, sumCells = 0, n = 0;
    while (n < 300) {
        const s = free[Math.floor(r() * free.length)], t = free[Math.floor(r() * free.length)];
        const res = astar.find(s, t)!;
        if (res.cells.length < 3) continue;
        const sx = s % g.w, tx = t % g.w;
        const start: [number, number] = [sx + 0.5, (s - sx) / g.w + 0.5], goal: [number, number] = [tx + 0.5, (t - tx) / g.w + 0.5];
        const pts = smoothPath(g, res.cells, start, goal, rad);
        const L = polylineLength(pts);
        if (L > res.cost + 1e-9) worseCount++;
        if (pts[0] !== start[0] || pts[1] !== start[1] || pts[pts.length - 2] !== goal[0] || pts[pts.length - 1] !== goal[1]) endsWrong++;
        for (let k = 2; k < pts.length; k += 2) {
            // Consecutive smoothed points are either grid neighbours (always walkable) or passed the capsule test.
            const neighbours = Math.abs(pts[k] - pts[k - 2]) <= 1 && Math.abs(pts[k + 1] - pts[k - 1]) <= 1;
            if (!neighbours && !g.capsuleClear(pts[k - 2], pts[k - 1], pts[k], pts[k + 1], rad)) unclear++;
        }
        sumGrid += res.cost; sumSmooth += L; sumPts += pts.length / 2; sumCells += res.cells.length; n++;
    }
    check(`${m.name}: smoothed path never longer, every segment clear for a 0.3 m disc`, worseCount === 0 && unclear === 0 && endsWrong === 0,
        `${(100 * (1 - sumSmooth / sumGrid)).toFixed(1)}% shorter on average, ${(sumCells / n).toFixed(0)} cells → ${(sumPts / n).toFixed(1)} waypoints`);
}

// ---------------------------------------------------------------- flow field
for (const m of maps) {
    const g = m.grid;
    const free = freeCells(g);
    const r = rng(21);
    const field = new FlowField(g);
    const [gx, gy] = m.targets[1];
    const t0 = performance.now();
    const b = field.build(gx, gy, DEFAULT_PARAMS.radius);
    const buildMs = performance.now() - t0;
    let zero = 0;
    for (const i of free) if (Math.hypot(field.dir[2 * i], field.dir[2 * i + 1]) < 0.5) zero++;

    // One agent at a time, steered only by the field, walls as in the crowd.
    const dt = 1 / 30;
    let arrived = 0, worstPen = 0, ratioSum = 0;
    const N = 200;
    const out: [number, number] = [0, 0];
    for (let q = 0; q < N; q++) {
        const c = free[Math.floor(r() * free.length)];
        const cx = c % g.w;
        const crowd = new Crowd(g, 1);
        crowd.add(cx + 0.5, (c - cx) / g.w + 0.5);
        const budget = (3 * field.cost[c]) / DEFAULT_PARAMS.maxSpeed + 5;
        let walked = 0;
        for (let t = 0; t < budget; t += dt) {
            if (Math.hypot(crowd.px[0] - gx, crowd.py[0] - gy) < 0.5) { arrived++; break; }
            field.sample(crowd.px[0], crowd.py[0], out);
            crowd.prefX[0] = out[0] * DEFAULT_PARAMS.maxSpeed;
            crowd.prefY[0] = out[1] * DEFAULT_PARAMS.maxSpeed;
            const ox = crowd.px[0], oy = crowd.py[0];
            crowd.step(dt);
            walked += Math.hypot(crowd.px[0] - ox, crowd.py[0] - oy);
            worstPen = Math.max(worstPen, crowd.wallPenetration());
        }
        ratioSum += walked / Math.max(1, field.cost[c]);
    }
    check(`${m.name}: following the flow field reaches the goal from 200 random starts`, arrived === N && worstPen < 0.02,
        `${arrived}/${N}, walked ${(ratioSum / N).toFixed(3)}× the grid path cost, wall penetration ${worstPen.toFixed(3)} m`);
    check(`${m.name}: flow field build`, zero === 1, `${buildMs.toFixed(2)} ms (Dijkstra ${b.dijkstraMs.toFixed(2)} + line of sight ${b.sightMs.toFixed(2)}), ${(100 * b.sightCells / free.length).toFixed(0)}% of cells see the goal`);
}

// ---------------------------------------------------------------- ORCA
function antipodal(n: number, R: number, avoidance: boolean, seconds: number): { deepest: number; arrived: number; time: number; stepUs: number } {
    const g = new Grid(80, 80);
    const crowd = new Crowd(g, n);
    crowd.avoidance = avoidance;
    const goals: [number, number][] = [];
    for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        crowd.add(40 + R * Math.cos(a), 40 + R * Math.sin(a));
        goals.push([40 - R * Math.cos(a), 40 - R * Math.sin(a)]);
    }
    const dt = 1 / 30;
    let deepest = 0, time = -1, stepMs = 0, steps = 0;
    for (let t = 0; t < seconds; t += dt) {
        let all = true;
        for (let i = 0; i < n; i++) {
            const dx = goals[i][0] - crowd.px[i], dy = goals[i][1] - crowd.py[i];
            const l = Math.hypot(dx, dy);
            if (l > 0.05) all = false;
            const s = Math.min(DEFAULT_PARAMS.maxSpeed, l / dt) / (l || 1);
            crowd.prefX[i] = dx * s; crowd.prefY[i] = dy * s;
        }
        if (all && time < 0) time = t;
        const t0 = performance.now();
        crowd.step(dt);
        stepMs += performance.now() - t0; steps++;
        deepest = Math.max(deepest, crowd.overlaps().deepest);
    }
    let arrived = 0;
    for (let i = 0; i < n; i++) if (Math.hypot(goals[i][0] - crowd.px[i], goals[i][1] - crowd.py[i]) < 0.2) arrived++;
    return { deepest, arrived, time, stepUs: (stepMs * 1000) / steps / n };
}
{
    const head = antipodal(2, 8, true, 15);
    check('ORCA: two agents head-on pass without touching', head.deepest < 0.005 && head.arrived === 2, `deepest overlap ${head.deepest.toFixed(4)} m, both arrive in ${head.time.toFixed(1)} s`);
    const on = antipodal(32, 10, true, 40);
    const off = antipodal(32, 10, false, 40);
    check('ORCA: 32 agents across a circle, all arrive, deepest overlap < 10% of a diameter', on.arrived === 32 && on.deepest < 0.06,
        `deepest ${on.deepest.toFixed(4)} m (2r = 0.6), all in ${on.time.toFixed(1)} s; without avoidance deepest ${off.deepest.toFixed(2)} m`);
    const big = antipodal(200, 25, true, 60);
    check('ORCA: 200 agents across a circle, all arrive, deepest overlap < 20% of a diameter', big.arrived === 200 && big.deepest < 0.12,
        `deepest ${big.deepest.toFixed(4)} m, all in ${big.time.toFixed(1)} s, ${big.stepUs.toFixed(1)} µs per agent per step`);
}

// ---------------------------------------------------------------- scenarios
function run(m: NavMap, scenario: Scenario, count: number, pathing: Pathing, congestion: number, seconds: number) {
    const s = new Swarm(m, count);
    s.scenario = scenario;
    s.congestionWeight = congestion;
    s.setPathing(pathing);
    s.spawn(count);
    s.searchBudgetMs = 1e9;
    const dt = 1 / 30;
    let pen = 0, deepest = 0, overlapSum = 0, samples = 0, ms = 0, steps = 0;
    for (let t = 0; t < seconds; t += dt) {
        const t0 = performance.now();
        s.update(dt);
        ms += performance.now() - t0; steps++;
        pen = Math.max(pen, s.crowd.wallPenetration());
        if (steps % 10 === 0) {
            const o = s.crowd.overlaps(0.03);
            deepest = Math.max(deepest, o.deepest);
            overlapSum += o.pairs; samples++;
        }
    }
    return { pen, deepest, pairs: overlapSum / samples, arrivals: s.arrivals, ms: ms / steps, expanded: s.totalExpanded };
}
{
    const T = 60;
    const swapOn = run(maps[0], 'swap', 400, 'flow', 2, T);
    const swapOff = run(maps[0], 'swap', 400, 'flow', 0, T);
    const swapJps = run(maps[0], 'swap', 400, 'jps', 0, T);
    const line = (r: ReturnType<typeof run>): string =>
        `${r.arrivals} arrivals, wall penetration ${r.pen.toFixed(3)} m, deepest overlap ${r.deepest.toFixed(3)} m, ${r.pairs.toFixed(1)} pairs > 3 cm, ${r.ms.toFixed(2)} ms per step`;
    check(`Rooms swap, 400 agents, ${T} s, congestion-aware flow fields`, swapOn.pen < 0.02 && swapOn.arrivals > 200, line(swapOn));
    check('  … beats plain flow fields and per-agent JPS paths, which jam in the doors', swapOn.arrivals > 3 * swapOff.arrivals && swapOn.arrivals > 3 * swapJps.arrivals,
        `plain fields: ${line(swapOff)}; JPS: ${line(swapJps)}`);
    const T2 = 90;
    const streamOn = run(maps[1], 'stream', 400, 'flow', 2, T2);
    const streamOff = run(maps[1], 'stream', 400, 'flow', 0, T2);
    const streamJps = run(maps[1], 'stream', 400, 'jps', 0, T2);
    check(`Maze stream, 400 agents, ${T2} s: everyone stays out of the walls`,
        Math.max(streamOn.pen, streamOff.pen, streamJps.pen) < 0.02 && Math.min(streamOn.arrivals, streamOff.arrivals, streamJps.arrivals) > 100,
        `congestion-aware fields: ${line(streamOn)}; plain fields: ${line(streamOff)}; JPS: ${line(streamJps)}, ${(streamJps.expanded / Math.max(1, streamJps.arrivals)).toFixed(0)} nodes expanded per path`);
}

check('constants', ARRIVE > 2 * DEFAULT_PARAMS.radius && SQRT2 > 1);
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
