import { type Grid, octile } from './Grid';
import { Heap } from './Search';

/**
 * A flow field to one goal: Dijkstra from the goal over the whole grid gives
 * every cell its path cost (the integration field); every cell then points
 * at its next cell on a shortest path, or straight at the goal where a disc
 * of `radius` has a clear run to it (the line-of-sight pass of Emerson,
 * Game AI Pro 2013), which removes the 45° zig-zag of 8-way directions.
 * Agents read it with bilinear interpolation. One build serves any number
 * of agents walking to that goal.
 */
export class FlowField {
    readonly cost: Float64Array;
    /** Unit direction per cell, (0, 0) where blocked or unreachable. */
    readonly dir: Float32Array;
    /** 1 where the cell sees the goal. */
    readonly sight: Uint8Array;
    goalX = 0;
    goalY = 0;
    private readonly heap = new Heap();
    private readonly nCells = new Int32Array(8);
    private readonly nCosts = new Float64Array(8);

    readonly grid: Grid;

    constructor(grid: Grid) {
        this.grid = grid;
        const n = grid.w * grid.h;
        this.cost = new Float64Array(n);
        this.dir = new Float32Array(2 * n);
        this.sight = new Uint8Array(n);
    }

    /**
     * Rebuilds for the goal at (gx, gy); returns { dijkstraMs, sightMs, sightCells }.
     * `congestion` (optional, per cell) scales the cost of stepping through a
     * cell by 1 + congestion, so the field routes round crowded cells (the
     * density term of Treuille et al. 2006, Continuum Crowds). With it, a
     * cell only points straight at the goal if its cost shows no detour and
     * no congestion on the way.
     */
    build(gx: number, gy: number, radius: number, congestion?: Float32Array): { dijkstraMs: number; sightMs: number; sightCells: number } {
        const grid = this.grid;
        const w = grid.w;
        const n = w * grid.h;
        this.goalX = gx;
        this.goalY = gy;
        const t0 = performance.now();
        this.cost.fill(Infinity);
        const goal = grid.nearestFree(gx, gy);
        this.cost[goal] = 0;
        this.heap.clear();
        this.heap.push(goal, 0);
        while (this.heap.size > 0) {
            const c = this.heap.pop();
            const g = this.heap.lastKey;
            if (g > this.cost[c]) continue;
            const k = grid.neighbours(c, this.nCells, this.nCosts);
            for (let j = 0; j < k; j++) {
                const m = this.nCells[j];
                const cost = g + this.nCosts[j] * (congestion ? 1 + 0.5 * (congestion[c] + congestion[m]) : 1);
                if (cost < this.cost[m]) {
                    this.cost[m] = cost;
                    this.heap.push(m, cost);
                }
            }
        }
        const t1 = performance.now();
        let sightCells = 0;
        const goalX = goal % w, goalY = (goal - goalX) / w;
        for (let i = 0; i < n; i++) {
            this.dir[2 * i] = this.dir[2 * i + 1] = 0;
            this.sight[i] = 0;
            if (!Number.isFinite(this.cost[i]) || i === goal) continue;
            const x = i % w, y = (i - x) / w;
            const cx = x + 0.5, cy = y + 0.5;
            let dx: number, dy: number;
            if ((!congestion || this.cost[i] <= octile(x - goalX, y - goalY) + 1e-6) && grid.capsuleClear(cx, cy, gx, gy, radius)) {
                dx = gx - cx; dy = gy - cy;
                this.sight[i] = 1;
                sightCells++;
            } else {
                const k = grid.neighbours(i, this.nCells, this.nCosts);
                let best = -1, bestCost = Infinity;
                for (let j = 0; j < k; j++) {
                    const c = this.cost[this.nCells[j]] + this.nCosts[j];
                    if (c < bestCost) { bestCost = c; best = this.nCells[j]; }
                }
                const bx = best % w;
                dx = bx - x; dy = (best - bx) / w - y;
            }
            const l = Math.hypot(dx, dy) || 1;
            this.dir[2 * i] = dx / l;
            this.dir[2 * i + 1] = dy / l;
        }
        if (goal >= 0) {
            const x = goal % w;
            const dx = gx - (x + 0.5), dy = gy - ((goal - x) / w + 0.5);
            const l = Math.hypot(dx, dy);
            if (l > 1e-6) { this.dir[2 * goal] = dx / l; this.dir[2 * goal + 1] = dy / l; }
            this.sight[goal] = 1;
        }
        return { dijkstraMs: t1 - t0, sightMs: performance.now() - t1, sightCells };
    }

    /** Direction at (x, y): bilinear blend of the four nearest cell directions (blocked cells left out), normalised. */
    sample(x: number, y: number, out: [number, number]): void {
        const grid = this.grid;
        const w = grid.w;
        const fx = x - 0.5, fy = y - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        let sx = 0, sy = 0;
        for (let k = 0; k < 4; k++) {
            const cx = x0 + (k & 1), cy = y0 + (k >> 1);
            if (cx < 0 || cy < 0 || cx >= w || cy >= grid.h) continue;
            const i = cy * w + cx;
            if (grid.blocked[i] || !Number.isFinite(this.cost[i])) continue;
            const wt = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
            sx += this.dir[2 * i] * wt;
            sy += this.dir[2 * i + 1] * wt;
        }
        const l = Math.hypot(sx, sy);
        if (l < 1e-6) {
            // Fall back to the cell the agent stands in.
            const i = Math.floor(y) * w + Math.floor(x);
            out[0] = this.dir[2 * i] || 0;
            out[1] = this.dir[2 * i + 1] || 0;
            return;
        }
        out[0] = sx / l;
        out[1] = sy / l;
    }
}
