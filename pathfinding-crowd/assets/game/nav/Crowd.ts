import { type Grid, rng } from './Grid';
import { agentLine, type Line, makeLines, solveVelocity, wallLine } from './Orca';

export interface CrowdParams {
    radius: number;
    maxSpeed: number;
    neighbourDist: number;
    maxNeighbours: number;
    timeHorizon: number;
    timeHorizonObst: number;
}

export const DEFAULT_PARAMS: CrowdParams = {
    radius: 0.3,
    maxSpeed: 2.2,
    neighbourDist: 2,
    maxNeighbours: 10,
    timeHorizon: 1.5,
    timeHorizonObst: 0.6,
};

/**
 * Disc agents on a grid map. Each step: bin agents into a uniform hash with
 * cells of `neighbourDist`, find each agent's nearest neighbours, solve ORCA
 * for a velocity near its preferred one (walls as hard constraints), move,
 * then push anyone still inside a wall cell back out.
 */
export class Crowd {
    readonly px: Float32Array;
    readonly py: Float32Array;
    readonly vx: Float32Array;
    readonly vy: Float32Array;
    /** Preferred velocity, set by the navigation layer before each step. */
    readonly prefX: Float32Array;
    readonly prefY: Float32Array;
    count = 0;
    avoidance = true;

    private readonly bw: number;
    private readonly bh: number;
    private readonly bucketStart: Int32Array;
    private readonly bucketCursor: Int32Array;
    private readonly bucketItems: Int32Array;
    private readonly agentBucket: Int32Array;
    private readonly lines: Line[] = makeLines(64);
    private readonly nbIdx = new Int32Array(64);
    private readonly nbDist = new Float32Array(64);
    private readonly newVx: Float32Array;
    private readonly newVy: Float32Array;
    private readonly out = { x: 0, y: 0 };
    private readonly jitter = rng(1);

    readonly grid: Grid;
    readonly capacity: number;
    readonly params: CrowdParams;

    constructor(grid: Grid, capacity: number, params: CrowdParams = DEFAULT_PARAMS) {
        this.grid = grid;
        this.capacity = capacity;
        this.params = params;
        this.px = new Float32Array(capacity);
        this.py = new Float32Array(capacity);
        this.vx = new Float32Array(capacity);
        this.vy = new Float32Array(capacity);
        this.prefX = new Float32Array(capacity);
        this.prefY = new Float32Array(capacity);
        this.newVx = new Float32Array(capacity);
        this.newVy = new Float32Array(capacity);
        this.bw = Math.ceil(grid.w / params.neighbourDist);
        this.bh = Math.ceil(grid.h / params.neighbourDist);
        this.bucketStart = new Int32Array(this.bw * this.bh + 1);
        this.bucketCursor = new Int32Array(this.bw * this.bh);
        this.bucketItems = new Int32Array(capacity);
        this.agentBucket = new Int32Array(capacity);
    }

    add(x: number, y: number): number {
        const i = this.count++;
        this.px[i] = x; this.py[i] = y;
        this.vx[i] = this.vy[i] = this.prefX[i] = this.prefY[i] = 0;
        return i;
    }

    /** Counting sort of agents into hash buckets. */
    private bin(): void {
        const s = this.params.neighbourDist;
        const start = this.bucketStart;
        start.fill(0);
        for (let i = 0; i < this.count; i++) {
            const bx = Math.min(this.bw - 1, Math.max(0, Math.floor(this.px[i] / s)));
            const by = Math.min(this.bh - 1, Math.max(0, Math.floor(this.py[i] / s)));
            const b = by * this.bw + bx;
            this.agentBucket[i] = b;
            start[b + 1]++;
        }
        for (let b = 0; b < this.bw * this.bh; b++) start[b + 1] += start[b];
        const cursor = this.bucketCursor;
        cursor.set(start.subarray(0, this.bw * this.bh));
        for (let i = 0; i < this.count; i++) this.bucketItems[cursor[this.agentBucket[i]]++] = i;
    }

    /** The up-to-`maxNeighbours` nearest agents within `neighbourDist`, nearest first; returns how many. */
    private neighbours(i: number): number {
        const { neighbourDist, maxNeighbours } = this.params;
        const rSq = neighbourDist * neighbourDist;
        const x = this.px[i], y = this.py[i];
        const b = this.agentBucket[i];
        const bx = b % this.bw, by = (b - bx) / this.bw;
        let n = 0;
        for (let yy = Math.max(0, by - 1); yy <= Math.min(this.bh - 1, by + 1); yy++) {
            for (let xx = Math.max(0, bx - 1); xx <= Math.min(this.bw - 1, bx + 1); xx++) {
                const bb = yy * this.bw + xx;
                for (let k = this.bucketStart[bb]; k < this.bucketStart[bb + 1]; k++) {
                    const j = this.bucketItems[k];
                    if (j === i) continue;
                    const dx = this.px[j] - x, dy = this.py[j] - y;
                    const d = dx * dx + dy * dy;
                    if (d >= rSq) continue;
                    if (n === maxNeighbours && d >= this.nbDist[n - 1]) continue;
                    let p = n < maxNeighbours ? n++ : n - 1;
                    while (p > 0 && this.nbDist[p - 1] > d) {
                        this.nbIdx[p] = this.nbIdx[p - 1]; this.nbDist[p] = this.nbDist[p - 1];
                        p--;
                    }
                    this.nbIdx[p] = j; this.nbDist[p] = d;
                }
            }
        }
        return n;
    }

    /**
     * Wall half-planes for agent i into lines[0..); returns how many. Every
     * blocked cell within reach contributes the closest point of its square,
     * except when that point lies on the side of a blocked cell nearer the
     * agent: along a straight wall only the cell straight across counts, so
     * an agent can still slide along the wall at full speed.
     */
    private wallLines(i: number): number {
        const grid = this.grid;
        const { radius, maxSpeed, timeHorizonObst } = this.params;
        const reach = radius + maxSpeed * timeHorizonObst;
        const x = this.px[i], y = this.py[i];
        const x0 = Math.floor(x - reach), x1 = Math.floor(x + reach);
        const y0 = Math.floor(y - reach), y1 = Math.floor(y + reach);
        let n = 0;
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                if (grid.free(cx, cy)) continue;
                const qx = Math.min(cx + 1, Math.max(cx, x)), qy = Math.min(cy + 1, Math.max(cy, y));
                const dx = qx - x, dy = qy - y;
                if (dx * dx + dy * dy > reach * reach) continue;
                if (qx !== x && !grid.free(cx + (x > cx ? 1 : -1), cy)) continue;
                if (qy !== y && !grid.free(cx, cy + (y > cy ? 1 : -1))) continue;
                if (n === 24) return n;
                wallLine(this.lines[n++], dx, dy, radius, timeHorizonObst);
            }
        }
        return n;
    }

    step(dt: number): void {
        const { radius, maxSpeed, timeHorizon } = this.params;
        const count = this.count;
        if (this.avoidance) {
            this.bin();
            for (let i = 0; i < count; i++) {
                const numObst = this.wallLines(i);
                let n = numObst;
                const nb = this.neighbours(i);
                const vx = this.vx[i], vy = this.vy[i];
                for (let k = 0; k < nb; k++) {
                    const j = this.nbIdx[k];
                    agentLine(this.lines[n++], vx, vy, this.px[j] - this.px[i], this.py[j] - this.py[i],
                        vx - this.vx[j], vy - this.vy[j], 2 * radius, timeHorizon, dt);
                }
                // A tiny random nudge breaks exactly symmetric standoffs (as in the RVO2 examples).
                const a = this.jitter() * 2 * Math.PI, m = 0.01 * maxSpeed;
                solveVelocity(this.lines, n, numObst, maxSpeed, this.prefX[i] + m * Math.cos(a), this.prefY[i] + m * Math.sin(a), this.out);
                this.newVx[i] = this.out.x;
                this.newVy[i] = this.out.y;
            }
        } else {
            for (let i = 0; i < count; i++) {
                const numObst = this.wallLines(i);
                solveVelocity(this.lines, numObst, numObst, maxSpeed, this.prefX[i], this.prefY[i], this.out);
                this.newVx[i] = this.out.x;
                this.newVy[i] = this.out.y;
            }
        }
        for (let i = 0; i < count; i++) {
            this.vx[i] = this.newVx[i];
            this.vy[i] = this.newVy[i];
            this.px[i] += this.vx[i] * dt;
            this.py[i] += this.vy[i] * dt;
            this.pushOut(i);
        }
    }

    /** Moves agent i out of any wall square it overlaps. */
    private pushOut(i: number): void {
        const grid = this.grid;
        const r = this.params.radius;
        for (let pass = 0; pass < 2; pass++) {
            const x = this.px[i], y = this.py[i];
            let moved = false;
            for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
                for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
                    if (grid.free(cx, cy)) continue;
                    const qx = Math.min(cx + 1, Math.max(cx, this.px[i])), qy = Math.min(cy + 1, Math.max(cy, this.py[i]));
                    let dx = this.px[i] - qx, dy = this.py[i] - qy;
                    const d = Math.hypot(dx, dy);
                    if (d >= r) continue;
                    if (d < 1e-6) {
                        // Centre inside the square: leave by the nearest side.
                        const l = this.px[i] - cx, rr = cx + 1 - this.px[i], t = this.py[i] - cy, b = cy + 1 - this.py[i];
                        const m = Math.min(l, rr, t, b);
                        dx = m === l ? -1 : m === rr ? 1 : 0;
                        dy = m === t ? -1 : m === b ? 1 : 0;
                        if (dx && dy) dy = 0;
                        this.px[i] += dx * (m + r);
                        this.py[i] += dy * (m + r);
                    } else {
                        this.px[i] += (dx / d) * (r - d);
                        this.py[i] += (dy / d) * (r - d);
                    }
                    moved = true;
                }
            }
            if (!moved) break;
        }
    }

    /** Deepest wall penetration over all agents (0 when everyone is clear). */
    wallPenetration(): number {
        const grid = this.grid;
        const r = this.params.radius;
        let worst = 0;
        for (let i = 0; i < this.count; i++) {
            const x = this.px[i], y = this.py[i];
            for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
                for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
                    if (grid.free(cx, cy)) continue;
                    const qx = Math.min(cx + 1, Math.max(cx, x)), qy = Math.min(cy + 1, Math.max(cy, y));
                    const inside = x > cx && x < cx + 1 && y > cy && y < cy + 1;
                    const d = Math.hypot(x - qx, y - qy);
                    worst = Math.max(worst, inside ? r + 0.5 : r - d);
                }
            }
        }
        return Math.max(0, worst);
    }

    /** Pairs closer than 2r − tolerance, and the deepest overlap (brute force over the hash). */
    overlaps(tolerance = 1e-3): { pairs: number; deepest: number } {
        this.bin();
        const r2 = 2 * this.params.radius;
        let pairs = 0, deepest = 0;
        for (let i = 0; i < this.count; i++) {
            const b = this.agentBucket[i];
            const bx = b % this.bw, by = (b - bx) / this.bw;
            for (let yy = Math.max(0, by - 1); yy <= Math.min(this.bh - 1, by + 1); yy++) {
                for (let xx = Math.max(0, bx - 1); xx <= Math.min(this.bw - 1, bx + 1); xx++) {
                    const bb = yy * this.bw + xx;
                    for (let k = this.bucketStart[bb]; k < this.bucketStart[bb + 1]; k++) {
                        const j = this.bucketItems[k];
                        if (j <= i) continue;
                        const d = Math.hypot(this.px[j] - this.px[i], this.py[j] - this.py[i]);
                        if (d < r2 - tolerance) pairs++;
                        deepest = Math.max(deepest, r2 - d);
                    }
                }
            }
        }
        return { pairs, deepest: Math.max(0, deepest) };
    }
}
