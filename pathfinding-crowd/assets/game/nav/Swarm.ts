import { Crowd, type CrowdParams, DEFAULT_PARAMS } from './Crowd';
import { FlowField } from './FlowField';
import { type NavMap, rng } from './Grid';
import { AStar, expandJumps, Jps } from './Search';
import { smoothPath } from './Smooth';

export type Pathing = 'flow' | 'astar' | 'jps';
export type Scenario = 'swap' | 'stream';

/** Agents count as arrived (and turn round) this close to their target. */
export const ARRIVE = 2.5;
const WAYPOINT_REACHED = 0.7;
const LATTICE = 0.72;

/**
 * Two scenarios. Swap: two groups start at the two targets and walk to the
 * other one, turning round on arrival, so they keep meeting head-on in doors
 * and corridors. Stream: everyone walks from target 0 to target 1 and is put
 * back at target 0 on arrival. Steering comes from one flow field per
 * target (rebuilt with a congestion term), or from a smoothed A* / JPS path
 * per agent; paths are queued and searched under a per-frame time budget.
 */
export class Swarm {
    readonly crowd: Crowd;
    readonly fields: [FlowField, FlowField];
    /** Target each agent is walking to (0 or 1). */
    readonly heading: Uint8Array;
    /** Group (the target it started at), for colour. */
    readonly group: Uint8Array;
    readonly paths: (number[] | null)[];
    readonly pathPos: Int32Array;
    readonly targets: [[number, number], [number, number]];
    pathing: Pathing = 'flow';
    /** Milliseconds of path searches allowed per frame. */
    searchBudgetMs = 2;
    readonly queue: number[] = [];
    private readonly queued: Uint8Array;
    private readonly astar: AStar;
    private readonly jps: Jps;
    private readonly random = rng(7);
    private frame = 0;
    private readonly dir: [number, number] = [0, 0];

    /** Extra step cost per opposing agent in a cell; 0 gives plain shortest-path fields. */
    congestionWeight = 2;
    /** Seconds between rebuilds of each congestion-aware field (they alternate). */
    congestionPeriod = 0.5;
    /** Congestion cost per cell from the last field rebuild (see splatOpposing). */
    readonly density: Float32Array;
    private sinceRebuild = 0;
    private nextField = 0;
    scenario: Scenario = 'swap';
    private source: [number, number][] = [];
    private spawnCount = 0;

    arrivals = 0;
    fieldMs = [0, 0];
    lastSearchMs = 0;
    lastSearches = 0;
    totalExpanded = 0;

    readonly map: NavMap;
    readonly capacity: number;

    constructor(map: NavMap, capacity: number, params: CrowdParams = DEFAULT_PARAMS) {
        this.map = map;
        this.capacity = capacity;
        this.crowd = new Crowd(map.grid, capacity, params);
        this.fields = [new FlowField(map.grid), new FlowField(map.grid)];
        this.heading = new Uint8Array(capacity);
        this.group = new Uint8Array(capacity);
        this.paths = new Array(capacity).fill(null);
        this.pathPos = new Int32Array(capacity);
        this.queued = new Uint8Array(capacity);
        this.astar = new AStar(map.grid);
        this.jps = new Jps(map.grid);
        this.targets = [[...map.targets[0]], [...map.targets[1]]];
        this.density = new Float32Array(map.grid.w * map.grid.h);
        for (let t = 0; t < 2; t++) this.rebuildField(t);
    }

    rebuildField(t: number): void {
        const [x, y] = this.targets[t];
        let congestion: Float32Array | undefined;
        if (this.congestionWeight > 0 && this.crowd.count) {
            congestion = this.density;
            this.splatOpposing(t);
        }
        const r = this.fields[t].build(x, y, this.crowd.params.radius, congestion);
        this.fieldMs[t] = r.dijkstraMs + r.sightMs;
    }

    /**
     * Density of agents walking away from target t (the ones that would
     * meet this field's walkers head-on; in a stream, everyone), bilinearly
     * splatted to cells and scaled by the congestion weight.
     */
    splatOpposing(t: number): void {
        const grid = this.map.grid;
        const d = this.density;
        const crowd = this.crowd;
        d.fill(0);
        const k = this.congestionWeight;
        for (let i = 0; i < crowd.count; i++) {
            if (this.scenario === 'swap' && this.heading[i] === t) continue;
            const fx = crowd.px[i] - 0.5, fy = crowd.py[i] - 0.5;
            const x0 = Math.floor(fx), y0 = Math.floor(fy);
            const tx = fx - x0, ty = fy - y0;
            for (let c = 0; c < 4; c++) {
                const x = x0 + (c & 1), y = y0 + (c >> 1);
                if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
                d[y * grid.w + x] += k * ((c & 1) ? tx : 1 - tx) * ((c >> 1) ? ty : 1 - ty);
            }
        }
    }

    setTarget(t: number, x: number, y: number): void {
        const grid = this.map.grid;
        const c = grid.nearestFree(x, y);
        const cx = c % grid.w;
        this.targets[t] = [cx + 0.5, (c - cx) / grid.w + 0.5];
        this.rebuildField(t);
        for (let i = 0; i < this.crowd.count; i++) if (this.heading[i] === t) this.requestPath(i);
    }

    /** Lattice points whose disc is clear of walls, ordered by path distance from target t. */
    private spawnPoints(t: number): [number, number][] {
        const grid = this.map.grid;
        const r = this.crowd.params.radius;
        const f = this.fields[t];
        const points: [number, number, number][] = [];
        for (let y = LATTICE / 2; y < grid.h; y += LATTICE) {
            for (let x = LATTICE / 2; x < grid.w; x += LATTICE) {
                let ok = true;
                for (let cy = Math.floor(y - r); cy <= Math.floor(y + r) && ok; cy++)
                    for (let cx = Math.floor(x - r); cx <= Math.floor(x + r) && ok; cx++) ok = grid.free(cx, cy);
                const c = f.cost[Math.floor(y) * grid.w + Math.floor(x)];
                if (ok && Number.isFinite(c)) points.push([x, y, c + 0.01 * Math.hypot(x - this.targets[t][0], y - this.targets[t][1])]);
            }
        }
        points.sort((a, b) => a[2] - b[2]);
        return points.map(([x, y]) => [x, y]);
    }

    /**
     * Places `count` agents. Swap: half around each target, each walking to
     * the other one. Stream: all around target 0, walking to target 1.
     */
    spawn(count: number): void {
        this.crowd.count = 0;
        this.queue.length = 0;
        this.queued.fill(0);
        this.arrivals = 0;
        this.spawnCount = count;
        for (let t = 0; t < 2; t++) this.rebuildField(t);
        const near0 = this.spawnPoints(0);
        this.source = near0;
        if (this.scenario === 'stream') {
            for (let k = 0; k < Math.min(count, near0.length, this.capacity); k++) this.place(near0[k], 0);
        } else {
            const near1 = this.spawnPoints(1);
            const taken = new Set<string>();
            const half = [Math.ceil(count / 2), Math.floor(count / 2)];
            for (let t = 0; t < 2; t++) {
                let placed = 0;
                for (const p of t ? near1 : near0) {
                    if (placed >= half[t] || this.crowd.count >= this.capacity) break;
                    const key = `${p[0]},${p[1]}`;
                    if (taken.has(key)) continue;
                    taken.add(key);
                    this.place(p, t);
                    placed++;
                }
            }
        }
        for (let i = 0; i < this.crowd.count; i++) this.requestPath(i);
    }

    private place(p: [number, number], t: number): void {
        const i = this.crowd.add(p[0], p[1]);
        this.group[i] = t;
        this.heading[i] = 1 - t;
        this.paths[i] = null;
    }

    /** Stream: moves agent i to a free spot near target 0 (none free: it stays put this frame). */
    private respawn(i: number): boolean {
        const crowd = this.crowd;
        const minSq = (2.1 * crowd.params.radius) ** 2;
        const range = Math.min(this.source.length, Math.max(16, this.spawnCount));
        for (let tries = 0; tries < 12; tries++) {
            const [x, y] = this.source[Math.floor(this.random() * range)];
            let clear = true;
            for (let j = 0; j < crowd.count && clear; j++) {
                const dx = crowd.px[j] - x, dy = crowd.py[j] - y;
                if (dx * dx + dy * dy < minSq) clear = false;
            }
            if (!clear) continue;
            crowd.px[i] = x; crowd.py[i] = y;
            crowd.vx[i] = crowd.vy[i] = 0;
            this.group[i] ^= 1;
            return true;
        }
        return false;
    }

    requestPath(i: number): void {
        this.paths[i] = null;
        if (this.pathing === 'flow' || this.queued[i]) return;
        this.queued[i] = 1;
        this.queue.push(i);
    }

    setPathing(p: Pathing): void {
        this.pathing = p;
        this.queue.length = 0;
        this.queued.fill(0);
        for (let i = 0; i < this.crowd.count; i++) this.requestPath(i);
    }

    /** One path for agent i to a random free spot near its target. */
    private searchPath(i: number): void {
        const grid = this.map.grid;
        const crowd = this.crowd;
        const [tx, ty] = this.targets[this.heading[i]];
        const a = this.random() * Math.PI * 2, d = this.random() * (ARRIVE - 0.8);
        const goal = grid.nearestFree(tx + Math.cos(a) * d, ty + Math.sin(a) * d);
        const start = grid.nearestFree(crowd.px[i], crowd.py[i]);
        const searcher = this.pathing === 'jps' ? this.jps : this.astar;
        const res = searcher.find(start, goal);
        if (!res) { this.paths[i] = null; return; }
        this.totalExpanded += res.expanded;
        const cells = this.pathing === 'jps' ? expandJumps(grid, res.cells) : res.cells;
        const gx = goal % grid.w;
        this.paths[i] = smoothPath(grid, cells, [crowd.px[i], crowd.py[i]], [gx + 0.5, (goal - gx) / grid.w + 0.5], crowd.params.radius);
        this.pathPos[i] = 1;
    }

    private runQueue(): void {
        const t0 = performance.now();
        let n = 0;
        while (this.queue.length && performance.now() - t0 < this.searchBudgetMs) {
            const i = this.queue.shift()!;
            this.queued[i] = 0;
            this.searchPath(i);
            n++;
        }
        this.lastSearches = n;
        this.lastSearchMs = performance.now() - t0;
    }

    update(dt: number): void {
        const crowd = this.crowd;
        const grid = this.map.grid;
        const speed = crowd.params.maxSpeed;
        this.frame++;
        if (this.pathing !== 'flow') this.runQueue();
        else if (this.congestionWeight > 0) {
            this.sinceRebuild += dt;
            const stream = this.scenario === 'stream';
            if (this.sinceRebuild >= this.congestionPeriod / (stream ? 1 : 2)) {
                this.sinceRebuild = 0;
                this.rebuildField(stream ? 1 : this.nextField);
                this.nextField = 1 - this.nextField;
            }
        }
        for (let i = 0; i < crowd.count; i++) {
            const t = this.heading[i];
            if (Math.hypot(crowd.px[i] - this.targets[t][0], crowd.py[i] - this.targets[t][1]) < ARRIVE) {
                if (this.scenario === 'swap') {
                    this.heading[i] = 1 - t;
                    this.arrivals++;
                    this.requestPath(i);
                } else if (this.respawn(i)) {
                    this.arrivals++;
                    this.requestPath(i);
                }
            }
            const x = crowd.px[i], y = crowd.py[i];
            let dx = 0, dy = 0;
            if (this.pathing === 'flow') {
                this.fields[this.heading[i]].sample(x, y, this.dir);
                dx = this.dir[0]; dy = this.dir[1];
            } else {
                const path = this.paths[i];
                if (path) {
                    let k = this.pathPos[i];
                    while (k < path.length / 2 - 1 && Math.hypot(path[2 * k] - x, path[2 * k + 1] - y) < WAYPOINT_REACHED) k++;
                    // Look one waypoint ahead so agents cut the corner once it is in view.
                    if (k < path.length / 2 - 1 && (i + this.frame) % 8 === 0 && grid.capsuleClear(x, y, path[2 * k + 2], path[2 * k + 3], crowd.params.radius)) k++;
                    this.pathPos[i] = k;
                    dx = path[2 * k] - x; dy = path[2 * k + 1] - y;
                    const l = Math.hypot(dx, dy);
                    if (l > 1e-6) { dx /= l; dy /= l; }
                    // Pushed off the path behind a wall: ask for a new one.
                    if ((i + this.frame) % 30 === 0 && !grid.segmentClear(x, y, path[2 * k], path[2 * k + 1])) this.requestPath(i);
                }
            }
            crowd.prefX[i] = dx * speed;
            crowd.prefY[i] = dy * speed;
        }
        crowd.step(dt);
    }
}
