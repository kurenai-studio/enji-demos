import { type Grid, octile, SQRT2 } from './Grid';

/** Binary min-heap of cell indices keyed by a float priority; duplicates allowed (lazy decrease-key). */
export class Heap {
    private cells = new Int32Array(1024);
    private keys = new Float64Array(1024);
    size = 0;

    clear(): void {
        this.size = 0;
    }

    push(cell: number, key: number): void {
        if (this.size === this.cells.length) {
            const c = new Int32Array(this.size * 2); c.set(this.cells); this.cells = c;
            const k = new Float64Array(this.size * 2); k.set(this.keys); this.keys = k;
        }
        let i = this.size++;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.keys[p] <= key) break;
            this.cells[i] = this.cells[p]; this.keys[i] = this.keys[p];
            i = p;
        }
        this.cells[i] = cell; this.keys[i] = key;
    }

    /** Removes the smallest; returns its cell (its key is left in `lastKey`). */
    pop(): number {
        const top = this.cells[0];
        this.lastKey = this.keys[0];
        const cell = this.cells[--this.size], key = this.keys[this.size];
        let i = 0;
        for (;;) {
            let c = 2 * i + 1;
            if (c >= this.size) break;
            if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
            if (this.keys[c] >= key) break;
            this.cells[i] = this.cells[c]; this.keys[i] = this.keys[c];
            i = c;
        }
        this.cells[i] = cell; this.keys[i] = key;
        return top;
    }

    lastKey = 0;
}

export interface PathResult {
    /** Cells from start to goal: every cell for A*, the jump points for JPS. */
    cells: number[];
    cost: number;
    /** Nodes taken off the open list and expanded. */
    expanded: number;
}

/**
 * Per-search scratch shared by A* and JPS: g costs, parents and a
 * generation stamp per cell, so a new search needs no clearing.
 */
abstract class GridSearch {
    protected readonly g: Float64Array;
    protected readonly parent: Int32Array;
    protected readonly seen: Uint32Array;
    protected readonly closed: Uint32Array;
    protected readonly heap = new Heap();
    protected gen = 0;
    protected gx = 0;
    protected gy = 0;
    /** Cells expanded by the last search, when `record` is set. */
    readonly expandedCells: number[] = [];
    record = false;

    protected readonly grid: Grid;

    constructor(grid: Grid) {
        this.grid = grid;
        const n = grid.w * grid.h;
        this.g = new Float64Array(n);
        this.parent = new Int32Array(n);
        this.seen = new Uint32Array(n);
        this.closed = new Uint32Array(n);
    }

    protected h(i: number): number {
        const x = i % this.grid.w;
        return octile(x - this.gx, (i - x) / this.grid.w - this.gy);
    }

    protected open(cell: number, from: number, cost: number): void {
        if (this.closed[cell] === this.gen) return;
        if (this.seen[cell] === this.gen && this.g[cell] <= cost) return;
        this.seen[cell] = this.gen;
        this.g[cell] = cost;
        this.parent[cell] = from;
        // Ties on f go to the node with the larger g (deeper), which keeps A* from fanning out.
        this.heap.push(cell, cost + this.h(cell) * (1 + 1e-7));
    }

    find(start: number, goal: number): PathResult | null {
        const grid = this.grid;
        if (grid.blocked[start] || grid.blocked[goal]) return null;
        this.gen++;
        this.gx = goal % grid.w;
        this.gy = (goal - this.gx) / grid.w;
        this.heap.clear();
        this.expandedCells.length = 0;
        this.open(start, -1, 0);
        let expanded = 0;
        while (this.heap.size > 0) {
            const cell = this.heap.pop();
            if (this.closed[cell] === this.gen) continue;
            this.closed[cell] = this.gen;
            expanded++;
            if (this.record) this.expandedCells.push(cell);
            if (cell === goal) {
                const cells: number[] = [];
                for (let c = goal; c !== -1; c = this.parent[c]) cells.push(c);
                cells.reverse();
                return { cells, cost: this.g[goal], expanded };
            }
            this.expand(cell, goal);
        }
        return null;
    }

    protected abstract expand(cell: number, goal: number): void;
}

/** A* with the octile heuristic over the 8-connected grid. */
export class AStar extends GridSearch {
    private readonly nCells = new Int32Array(8);
    private readonly nCosts = new Float64Array(8);

    protected expand(cell: number): void {
        const n = this.grid.neighbours(cell, this.nCells, this.nCosts);
        const g = this.g[cell];
        for (let k = 0; k < n; k++) this.open(this.nCells[k], cell, g + this.nCosts[k]);
    }
}

/**
 * Jump point search (Harabor & Grastien 2011) for 8-connected grids without
 * corner cutting. From each expanded node it only follows the directions
 * that symmetry pruning leaves open, and "jumps" along each until it meets
 * the goal or a node with a forced neighbour (an opening that no equally
 * short path could reach without passing through that node); only those jump
 * points go on the open list. Paths are as short as A*'s.
 */
export class Jps extends GridSearch {
    private readonly dirs = new Int8Array(16);

    protected expand(cell: number, goal: number): void {
        const grid = this.grid;
        const w = grid.w;
        const x = cell % w, y = (cell - x) / w;
        const n = this.prunedDirections(x, y, this.parent[cell]);
        const g = this.g[cell];
        for (let k = 0; k < n; k++) {
            const jp = this.jump(x + this.dirs[2 * k], y + this.dirs[2 * k + 1], this.dirs[2 * k], this.dirs[2 * k + 1], goal);
            if (jp < 0) continue;
            const jx = jp % w;
            this.open(jp, cell, g + octile(jx - x, (jp - jx) / w - y));
        }
    }

    /** Directions to search from (x, y) given its parent, into `dirs`; returns how many. */
    private prunedDirections(x: number, y: number, parent: number): number {
        const grid = this.grid;
        const d = this.dirs;
        let n = 0;
        const push = (dx: number, dy: number): void => { d[2 * n] = dx; d[2 * n + 1] = dy; n++; };
        if (parent < 0) {
            for (const [dx, dy] of DIRS8) {
                if (!grid.free(x + dx, y + dy)) continue;
                if (dx && dy && !(grid.free(x + dx, y) && grid.free(x, y + dy))) continue;
                push(dx, dy);
            }
            return n;
        }
        const px = parent % grid.w, py = (parent - px) / grid.w;
        const dx = Math.sign(x - px), dy = Math.sign(y - py);
        if (dx && dy) {
            const fx = grid.free(x + dx, y), fy = grid.free(x, y + dy);
            if (fy) push(0, dy);
            if (fx) push(dx, 0);
            if (fx && fy && grid.free(x + dx, y + dy)) push(dx, dy);
        } else if (dx) {
            const next = grid.free(x + dx, y), up = grid.free(x, y + 1), down = grid.free(x, y - 1);
            if (next) {
                push(dx, 0);
                if (up && grid.free(x + dx, y + 1)) push(dx, 1);
                if (down && grid.free(x + dx, y - 1)) push(dx, -1);
            }
            if (up) push(0, 1);
            if (down) push(0, -1);
        } else {
            const next = grid.free(x, y + dy), right = grid.free(x + 1, y), left = grid.free(x - 1, y);
            if (next) {
                push(0, dy);
                if (right && grid.free(x + 1, y + dy)) push(1, dy);
                if (left && grid.free(x - 1, y + dy)) push(-1, dy);
            }
            if (right) push(1, 0);
            if (left) push(-1, 0);
        }
        return n;
    }

    /** Walks from (x, y) in direction (dx, dy); returns the first jump point, or -1. */
    private jump(x: number, y: number, dx: number, dy: number, goal: number): number {
        const grid = this.grid;
        const w = grid.w;
        for (;;) {
            if (!grid.free(x, y)) return -1;
            const i = y * w + x;
            if (i === goal) return i;
            if (dx && dy) {
                if (this.jump(x + dx, y, dx, 0, goal) >= 0 || this.jump(x, y + dy, 0, dy, goal) >= 0) return i;
                // The next diagonal step must not cut a corner.
                if (!grid.free(x + dx, y) || !grid.free(x, y + dy)) return -1;
            } else if (dx) {
                if ((grid.free(x, y - 1) && !grid.free(x - dx, y - 1)) || (grid.free(x, y + 1) && !grid.free(x - dx, y + 1))) return i;
            } else {
                if ((grid.free(x - 1, y) && !grid.free(x - 1, y - dy)) || (grid.free(x + 1, y) && !grid.free(x + 1, y - dy))) return i;
            }
            x += dx;
            y += dy;
        }
    }
}

const DIRS8: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Expands a JPS path (jump points joined by straight or diagonal runs) into every cell. */
export function expandJumps(grid: Grid, jumps: number[]): number[] {
    if (!jumps.length) return [];
    const out = [jumps[0]];
    const w = grid.w;
    for (let k = 1; k < jumps.length; k++) {
        let x = jumps[k - 1] % w, y = (jumps[k - 1] - x) / w;
        const tx = jumps[k] % w, ty = (jumps[k] - tx) / w;
        const dx = Math.sign(tx - x), dy = Math.sign(ty - y);
        while (x !== tx || y !== ty) {
            x += dx; y += dy;
            out.push(y * w + x);
        }
    }
    return out;
}

/** Length of a cell path walked centre to centre. */
export function cellPathCost(grid: Grid, cells: number[]): number {
    let c = 0;
    for (let k = 1; k < cells.length; k++) {
        const ax = cells[k - 1] % grid.w, ay = (cells[k - 1] - ax) / grid.w;
        const bx = cells[k] % grid.w, by = (cells[k] - bx) / grid.w;
        c += Math.abs(ax - bx) + Math.abs(ay - by) === 2 ? SQRT2 : Math.hypot(ax - bx, ay - by);
    }
    return c;
}
