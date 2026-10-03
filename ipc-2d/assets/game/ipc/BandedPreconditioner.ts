/**
 * Block-diagonal preconditioner with one exact block per body: each body's
 * stiffness block (2×2-block CSR over vertices, plus extra diagonal blocks)
 * is reordered by reverse Cuthill-McKee and factorised as a banded Cholesky.
 * Contacts between bodies are left to the conjugate gradient iterations.
 */
export interface DofRange {
    /** First vertex dof index and vertex count; a body's dofs are contiguous. */
    start: number;
    count: number;
}

interface Block {
    start: number;
    count: number;
    /** local scalar index → position in band order, and its inverse. */
    order: Int32Array;
    position: Int32Array;
    band: number;
    L: Float64Array;
    work: Float64Array;
}

export class BandedPreconditioner {
    private readonly blocks: Block[] = [];
    private readonly rowStart: Int32Array;
    private readonly col: Int32Array;

    constructor(ranges: readonly DofRange[], rowStart: Int32Array, col: Int32Array) {
        this.rowStart = rowStart;
        this.col = col;
        for (const r of ranges) {
            const vertexOrder = reverseCuthillMcKee(r.start, r.count, rowStart, col);
            const vertexPosition = new Int32Array(r.count);
            for (let k = 0; k < r.count; k++) vertexPosition[vertexOrder[k]] = k;
            let bandV = 0;
            for (let i = 0; i < r.count; i++) {
                const gi = r.start + i;
                for (let s = rowStart[gi]; s < rowStart[gi + 1]; s++) {
                    bandV = Math.max(bandV, Math.abs(vertexPosition[i] - vertexPosition[col[s] - r.start]));
                }
            }
            const n = 2 * r.count;
            const order = new Int32Array(n);
            const position = new Int32Array(n);
            for (let i = 0; i < r.count; i++) {
                for (let c = 0; c < 2; c++) {
                    const p = 2 * vertexPosition[i] + c;
                    position[2 * i + c] = p;
                    order[p] = 2 * i + c;
                }
            }
            const band = 2 * bandV + 1;
            this.blocks.push({ start: r.start, count: r.count, order, position, band, L: new Float64Array(n * (band + 1)), work: new Float64Array(n) });
        }
    }

    /** Factorises every block of the CSR matrix `val` plus `diag` (4 values per vertex dof). */
    factor(val: Float64Array, diag: Float64Array): void {
        const rowStart = this.rowStart;
        const col = this.col;
        for (const b of this.blocks) {
            const L = b.L;
            const w = b.band + 1;
            L.fill(0);
            for (let i = 0; i < b.count; i++) {
                const gi = b.start + i;
                for (let s = rowStart[gi]; s < rowStart[gi + 1]; s++) {
                    const j = col[s] - b.start;
                    for (let ci = 0; ci < 2; ci++) {
                        const pi = b.position[2 * i + ci];
                        for (let cj = 0; cj < 2; cj++) {
                            const pj = b.position[2 * j + cj];
                            if (pj > pi) continue;
                            L[pi * w + pj - pi + b.band] += val[4 * s + ci * 2 + cj];
                        }
                    }
                }
                for (let ci = 0; ci < 2; ci++) {
                    const pi = b.position[2 * i + ci];
                    for (let cj = 0; cj < 2; cj++) {
                        const pj = b.position[2 * i + cj];
                        if (pj > pi) continue;
                        L[pi * w + pj - pi + b.band] += diag[4 * gi + ci * 2 + cj];
                    }
                }
            }
            const n = 2 * b.count;
            const band = b.band;
            for (let i = 0; i < n; i++) {
                const row = i * w - i + band;
                const k0 = Math.max(0, i - band);
                for (let j = k0; j <= i; j++) {
                    const rowJ = j * w - j + band;
                    let sum = L[row + j];
                    for (let k = k0; k < j; k++) sum -= L[row + k] * L[rowJ + k];
                    if (j === i) L[row + i] = Math.sqrt(Math.max(sum, 1e-300));
                    else L[row + j] = sum / L[rowJ + j];
                }
            }
        }
    }

    /** z = M⁻¹ r over vertex-dof-indexed vectors (2 values per vertex dof). */
    apply(r: Float64Array, z: Float64Array): void {
        for (const b of this.blocks) {
            const L = b.L;
            const w = b.band + 1;
            const band = b.band;
            const y = b.work;
            const n = 2 * b.count;
            const base = 2 * b.start;
            for (let i = 0; i < n; i++) {
                const row = i * w - i + band;
                let sum = r[base + b.order[i]];
                for (let k = Math.max(0, i - band); k < i; k++) sum -= L[row + k] * y[k];
                y[i] = sum / L[row + i];
            }
            for (let i = n - 1; i >= 0; i--) {
                let sum = y[i];
                const kMax = Math.min(n - 1, i + band);
                for (let k = i + 1; k <= kMax; k++) sum -= L[k * w - k + band + i] * y[k];
                y[i] = sum / L[i * w - i + band + i];
            }
            for (let i = 0; i < n; i++) z[base + b.order[i]] = y[i];
        }
    }
}

/** Vertex order (local indices) with a small bandwidth, by BFS from a peripheral vertex. */
function reverseCuthillMcKee(start: number, count: number, rowStart: Int32Array, col: Int32Array): Int32Array {
    const degree = (i: number) => rowStart[start + i + 1] - rowStart[start + i];
    const bfs = (root: number, out: number[] | null): number => {
        const level = new Int32Array(count).fill(-1);
        const queue = [root];
        level[root] = 0;
        let last = root;
        for (let q = 0; q < queue.length; q++) {
            const i = queue[q];
            last = i;
            out?.push(i);
            const next: number[] = [];
            for (let s = rowStart[start + i]; s < rowStart[start + i + 1]; s++) {
                const j = col[s] - start;
                if (level[j] < 0) {
                    level[j] = level[i] + 1;
                    next.push(j);
                }
            }
            next.sort((a, b) => degree(a) - degree(b));
            queue.push(...next);
        }
        return last;
    };
    let root = 0;
    for (let i = 1; i < count; i++) if (degree(i) < degree(root)) root = i;
    // Two sweeps move the root to (nearly) the far end of the mesh.
    root = bfs(bfs(root, null), null);
    const order: number[] = [];
    bfs(root, order);
    return Int32Array.from(order.reverse());
}
