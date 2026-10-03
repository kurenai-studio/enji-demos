/** Small deterministic PRNG (mulberry32), so the tests and the demo build the same maps. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const SQRT2 = Math.SQRT2;

/** Octile distance: the cost of the best 8-connected path on an empty grid. */
export function octile(dx: number, dy: number): number {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    return Math.max(ax, ay) + (SQRT2 - 1) * Math.min(ax, ay);
}

/**
 * A walkable / blocked grid of 1 m cells. Cell (x, y) covers [x, x + 1) ×
 * [y, y + 1); its index is y·w + x. Moves go to the 8 neighbours, diagonals
 * only when both cells beside the diagonal are free (no corner cutting).
 */
export class Grid {
    readonly w: number;
    readonly h: number;
    readonly blocked: Uint8Array;

    constructor(w: number, h: number) {
        this.w = w;
        this.h = h;
        this.blocked = new Uint8Array(w * h);
    }

    free(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.w && y < this.h && this.blocked[y * this.w + x] === 0;
    }

    fill(x0: number, y0: number, x1: number, y1: number, value = 1): void {
        for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) {
            for (let x = Math.max(0, x0); x < Math.min(this.w, x1); x++) this.blocked[y * this.w + x] = value;
        }
    }

    /**
     * Neighbours of cell `i` and their step costs into `cells` / `costs`;
     * returns how many. Diagonals need both orthogonal cells free.
     */
    neighbours(i: number, cells: Int32Array, costs: Float64Array): number {
        const w = this.w;
        const x = i % w, y = (i - x) / w;
        let n = 0;
        const e = this.free(x + 1, y), we = this.free(x - 1, y), s = this.free(x, y + 1), nn = this.free(x, y - 1);
        if (e) { cells[n] = i + 1; costs[n++] = 1; }
        if (we) { cells[n] = i - 1; costs[n++] = 1; }
        if (s) { cells[n] = i + w; costs[n++] = 1; }
        if (nn) { cells[n] = i - w; costs[n++] = 1; }
        if (e && s && this.free(x + 1, y + 1)) { cells[n] = i + w + 1; costs[n++] = SQRT2; }
        if (e && nn && this.free(x + 1, y - 1)) { cells[n] = i - w + 1; costs[n++] = SQRT2; }
        if (we && s && this.free(x - 1, y + 1)) { cells[n] = i + w - 1; costs[n++] = SQRT2; }
        if (we && nn && this.free(x - 1, y - 1)) { cells[n] = i - w - 1; costs[n++] = SQRT2; }
        return n;
    }

    /**
     * Whether the segment a → b (continuous coordinates) crosses only free
     * cells: every cell it passes through is visited (Amanatides & Woo), and
     * where it passes exactly through a cell corner both cells beside the
     * corner must be free.
     */
    segmentClear(ax: number, ay: number, bx: number, by: number): boolean {
        let x = Math.floor(ax), y = Math.floor(ay);
        const ex = Math.floor(bx), ey = Math.floor(by);
        if (!this.free(x, y)) return false;
        const dx = bx - ax, dy = by - ay;
        const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
        const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
        const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
        let tx = dx !== 0 ? (dx > 0 ? x + 1 - ax : ax - x) * tdx : Infinity;
        let ty = dy !== 0 ? (dy > 0 ? y + 1 - ay : ay - y) * tdy : Infinity;
        let steps = Math.abs(ex - x) + Math.abs(ey - y);
        while (steps-- > 0) {
            if (Math.abs(tx - ty) < 1e-9) {
                if (!this.free(x + sx, y) || !this.free(x, y + sy)) return false;
                x += sx; y += sy; tx += tdx; ty += tdy;
                steps--;
            } else if (tx < ty) { x += sx; tx += tdx; } else { y += sy; ty += tdy; }
            if (!this.free(x, y)) return false;
        }
        return true;
    }

    /**
     * Whether a disc of `radius` can slide from a to b: the centre line and
     * the two lines offset by ±radius sideways are all clear.
     */
    capsuleClear(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
        const dx = bx - ax, dy = by - ay;
        const l = Math.hypot(dx, dy);
        if (l < 1e-9) return this.free(Math.floor(ax), Math.floor(ay));
        const ox = (-dy / l) * radius, oy = (dx / l) * radius;
        return this.segmentClear(ax, ay, bx, by)
            && this.segmentClear(ax + ox, ay + oy, bx + ox, by + oy)
            && this.segmentClear(ax - ox, ay - oy, bx - ox, by - oy);
    }

    /** Nearest free cell to (x, y) by ring search, or -1. */
    nearestFree(x: number, y: number): number {
        const cx = Math.floor(x), cy = Math.floor(y);
        for (let r = 0; r < Math.max(this.w, this.h); r++) {
            for (let yy = cy - r; yy <= cy + r; yy++) {
                for (let xx = cx - r; xx <= cx + r; xx++) {
                    if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy)) !== r) continue;
                    if (this.free(xx, yy)) return yy * this.w + xx;
                }
            }
        }
        return -1;
    }
}

export interface NavMap {
    name: string;
    grid: Grid;
    /** The two targets the groups walk between (cell-centre coordinates). */
    targets: [[number, number], [number, number]];
}

export const MAP_W = 80;
export const MAP_H = 56;

/**
 * Six rooms in a 3 × 2 layout, 1 m walls with 3 m doors, and pillars and
 * crates inside the rooms. The targets are in the left and right rooms, so
 * both groups must pass through the doors of the middle rooms.
 */
export function roomsMap(seed = 5): NavMap {
    const g = new Grid(MAP_W, MAP_H);
    const r = rng(seed);
    g.fill(0, 0, MAP_W, 1); g.fill(0, MAP_H - 1, MAP_W, MAP_H); g.fill(0, 0, 1, MAP_H); g.fill(MAP_W - 1, 0, MAP_W, MAP_H);
    const xs = [27, 53];
    const ym = 28;
    for (const x of xs) {
        g.fill(x, 0, x + 1, MAP_H);
        // Two doors per vertical wall, one per row of rooms.
        for (const d of [8 + Math.floor(r() * 12), 34 + Math.floor(r() * 12)]) g.fill(x, d, x + 1, d + 3, 0);
    }
    g.fill(0, ym, MAP_W, ym + 1);
    for (const [x0, x1] of [[1, 27], [28, 53], [54, 79]]) {
        const d = x0 + 4 + Math.floor(r() * (x1 - x0 - 11));
        g.fill(d, ym, d + 3, ym + 1, 0);
    }
    // Pillars and crates, kept off the doors.
    for (let k = 0; k < 70; k++) {
        const x = 3 + Math.floor(r() * (MAP_W - 7));
        const y = 3 + Math.floor(r() * (MAP_H - 7));
        const s = 1 + Math.floor(r() * 2);
        let nearWall = false;
        for (const wx of xs) if (Math.abs(x - wx) < 4 || Math.abs(x + s - wx) < 4) nearWall = true;
        if (Math.abs(y - ym) < 4 || Math.abs(y + s - ym) < 4) nearWall = true;
        if (Math.hypot(x - 12, y - 28) < 7 || Math.hypot(x - 67, y - 28) < 7) nearWall = true;
        if (!nearWall) g.fill(x, y, x + s, y + s);
    }
    return { name: 'Rooms', grid: g, targets: [[8.5, 14.5], [71.5, 42.5]] };
}

/**
 * A maze from a randomized depth-first search on a coarse grid: corridors
 * 3 m wide, walls 1 m, a few extra openings so there is more than one route.
 */
export function mazeMap(seed = 11): NavMap {
    const cell = 4;
    const cw = Math.floor((MAP_W - 1) / cell), ch = Math.floor((MAP_H - 1) / cell);
    const g = new Grid(MAP_W, MAP_H);
    g.fill(0, 0, MAP_W, MAP_H);
    const r = rng(seed);
    const seen = new Uint8Array(cw * ch);
    const open = (cx: number, cy: number): void => g.fill(cx * cell + 1, cy * cell + 1, cx * cell + cell, cy * cell + cell, 0);
    const stack = [0];
    seen[0] = 1;
    open(0, 0);
    while (stack.length) {
        const c = stack[stack.length - 1];
        const cx = c % cw, cy = (c - cx) / cw;
        const options: [number, number][] = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && !seen[ny * cw + nx]) options.push([dx, dy]);
        }
        if (!options.length) { stack.pop(); continue; }
        const [dx, dy] = options[Math.floor(r() * options.length)];
        const nx = cx + dx, ny = cy + dy;
        seen[ny * cw + nx] = 1;
        open(nx, ny);
        // Knock out the wall between the two coarse cells.
        g.fill(Math.min(cx, nx) * cell + 1 + (dx ? cell - 1 : 0), Math.min(cy, ny) * cell + 1 + (dy ? cell - 1 : 0),
            Math.min(cx, nx) * cell + cell + (dx ? 1 : 0), Math.min(cy, ny) * cell + cell + (dy ? 1 : 0), 0);
        stack.push(ny * cw + nx);
    }
    for (let k = 0; k < 18; k++) {
        const cx = 1 + Math.floor(r() * (cw - 2)), cy = 1 + Math.floor(r() * (ch - 2));
        if (r() < 0.5) g.fill(cx * cell + cell, cy * cell + 1, cx * cell + cell + 1, cy * cell + cell, 0);
        else g.fill(cx * cell + 1, cy * cell + cell, cx * cell + cell, cy * cell + cell + 1, 0);
    }
    // 40 m apart in a straight line, about 130 m along the corridors.
    return { name: 'Maze', grid: g, targets: [[9 * cell + 2.5, 2.5], [3 * cell + 2.5, 8 * cell + 2.5]] };
}
