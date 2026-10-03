/**
 * Billboard impostors: each species is rendered from FRAMES azimuths into an
 * atlas (albedo rows, then normal rows). At run time a camera-facing quad picks
 * the two frames nearest the view direction and blends them.
 *
 * Mipmaps keep alpha-test coverage (Castaño 2010): averaging alpha pulls
 * sparse foliage below the 1/2 test threshold, so distant trees would thin
 * out and vanish. Each level's alpha in each cell is scaled by the k that makes
 * the fraction of texels with k α >= 1/2 equal level 0's.
 */

export const FRAMES = 8;
export const CELL_PX = 128;

/** Frame coordinate in [0, FRAMES) for a tree with `yaw` seen from horizontal direction (tx, tz) (tree to camera). */
export function viewFrame(tx: number, tz: number, yaw: number): number {
    const step = (Math.PI * 2) / FRAMES;
    const a = (Math.atan2(tx, tz) - yaw) / step;
    return ((a % FRAMES) + FRAMES) % FRAMES;
}

/** Yaw applied to the copy baked into frame k: frame k then shows the object from object-space azimuth k · 2π / FRAMES. */
export function bakeYaw(k: number): number {
    return (-k * Math.PI * 2) / FRAMES;
}

export interface ImpostorDims {
    /** Side of the square the cell covers, in object units. */
    size: number;
    /** Object-space height of the cell centre. */
    centerY: number;
}

export function impostorDims(min: readonly number[], max: readonly number[]): ImpostorDims {
    const r = Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2]));
    // The tree turns inside the cell, so its horizontal extent is the radius around the axis.
    const size = Math.max(2 * r, max[1] - min[1]) * 1.06;
    return { size, centerY: (min[1] + max[1]) / 2 };
}

export interface MipChain {
    width: number[];
    height: number[];
    data: Uint8Array[];
    /** Alpha scale applied per level per cell (row-major cells); 1 at level 0. */
    scale: number[][];
}

/** Fills transparent texels' colour from opaque neighbours (per cell), so filtering never pulls in the background. */
export function dilate(rgba: Uint8Array, w: number, h: number, cell: number, passes = 12): void {
    const filled = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) filled[i] = rgba[i * 4 + 3] > 0 ? 1 : 0;
    const next = new Uint8Array(w * h);
    for (let p = 0; p < passes; p++) {
        let changed = 0;
        next.set(filled);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (filled[i]) continue;
            let r = 0, g = 0, b = 0, n = 0;
            const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                if (Math.floor(nx / cell) !== cx || Math.floor(ny / cell) !== cy) continue;
                const j = ny * w + nx;
                if (!filled[j]) continue;
                r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; n++;
            }
            if (n) {
                rgba[i * 4] = Math.round(r / n); rgba[i * 4 + 1] = Math.round(g / n); rgba[i * 4 + 2] = Math.round(b / n);
                next[i] = 1;
                changed++;
            }
        }
        filled.set(next);
        if (!changed) break;
    }
}

/** Fraction of a cell's texels with k α >= 1/2: what the alpha test keeps. */
function coverage(data: Uint8Array, w: number, x0: number, y0: number, cell: number, k: number): number {
    let n = 0;
    for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) if (k * data[(y * w + x) * 4 + 3] >= 127.5) n++;
    return n / (cell * cell);
}

/**
 * Builds the mip chain down to `minCell` pixels per cell. Colour is averaged
 * weighted by alpha; alpha is averaged, then (when `preserveCoverage`) scaled
 * per cell. `alphaRows` limits the scaling to the albedo rows.
 */
export function buildMips(level0: Uint8Array, w: number, h: number, cell: number, minCell: number, preserveCoverage: boolean, alphaRows: number): MipChain {
    const cellsX = w / cell, cellsY = h / cell;
    const chain: MipChain = { width: [w], height: [h], data: [level0], scale: [new Array(cellsX * cellsY).fill(1)] };
    const target: number[] = [];
    for (let cy = 0; cy < cellsY; cy++) for (let cx = 0; cx < cellsX; cx++) target.push(coverage(level0, w, cx * cell, cy * cell, cell, 1));
    let src = level0, sw = w, sh = h, c = cell;
    while (c > minCell) {
        const dw = sw / 2, dh = sh / 2;
        const raw = new Uint8Array(dw * dh * 4);
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
            let r = 0, g = 0, b = 0, a = 0, pr = 0, pg = 0, pb = 0;
            for (let k = 0; k < 4; k++) {
                const o = ((y * 2 + (k >> 1)) * sw + x * 2 + (k & 1)) * 4;
                const al = src[o + 3];
                r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al;
                pr += src[o]; pg += src[o + 1]; pb += src[o + 2];
            }
            const o = (y * dw + x) * 4;
            if (a > 0) { raw[o] = Math.round(r / a); raw[o + 1] = Math.round(g / a); raw[o + 2] = Math.round(b / a); }
            else { raw[o] = Math.round(pr / 4); raw[o + 1] = Math.round(pg / 4); raw[o + 2] = Math.round(pb / 4); }
            raw[o + 3] = Math.round(a / 4);
        }
        c /= 2;
        const out = Uint8Array.from(raw);
        const scales: number[] = [];
        for (let cy = 0; cy < cellsY; cy++) for (let cx = 0; cx < cellsX; cx++) {
            let k = 1;
            if (preserveCoverage && cy < alphaRows && target[cy * cellsX + cx] > 0) {
                const t = target[cy * cellsX + cx];
                let lo = 0.5, hi = 16;
                for (let it = 0; it < 20; it++) {
                    const mid = (lo + hi) / 2;
                    if (coverage(raw, dw, cx * c, cy * c, c, mid) < t) lo = mid; else hi = mid;
                }
                // Coverage is a step function of k: take whichever bracket end lands nearer.
                const below = coverage(raw, dw, cx * c, cy * c, c, lo), above = coverage(raw, dw, cx * c, cy * c, c, hi);
                k = Math.abs(below - t) < Math.abs(above - t) ? lo : hi;                for (let y = cy * c; y < (cy + 1) * c; y++) for (let x = cx * c; x < (cx + 1) * c; x++) {
                    const o = (y * dw + x) * 4 + 3;
                    out[o] = Math.min(255, Math.round(raw[o] * k));
                }
            }
            scales.push(k);
        }
        chain.width.push(dw); chain.height.push(dh); chain.data.push(out); chain.scale.push(scales);
        // The next level averages the unscaled alpha, as in Castaño's method.
        src = raw; sw = dw; sh = dh;
    }
    return chain;
}

/** Coverage of one cell at one level, as the alpha test sees it. */
export function cellCoverage(chain: MipChain, level: number, cx: number, cy: number, cell0: number): number {
    const c = cell0 >> level;
    return coverage(chain.data[level], chain.width[level], cx * c, cy * c, c, 1);
}
