/**
 * Per-instance LOD selection for the GPU path, and per-cell selection for the
 * merged path.
 *
 * Screen size s = r / (d tan(fov/2)) is the bounding sphere's radius as a
 * fraction of half the viewport height. Level k is used while
 * T[k] <= s < T[k-1]. A level only changes once s is past the boundary by
 * the hysteresis margin h, so an instance sitting on a boundary does not
 * flicker. A change starts a cross-fade: both levels are drawn for
 * `fadeSeconds`, with complementary screen-door masks (see `keeps`).
 */
import { classifyBox, INSIDE, OUTSIDE, sphereVisible, type Planes } from './Culling';
import type { Forest } from './Forest';

/** Levels 0..2 are meshes; 3 is the billboard impostor. */
export const LOD_LEVELS = 4;
export const IMPOSTOR = 3;

export interface LodSettings {
    /** Screen-size boundaries between levels 0|1, 1|2 and 2|3. */
    thresholds: [number, number, number];
    /** Relative margin past a boundary before switching. */
    hysteresis: number;
    /** 0 pops. */
    fadeSeconds: number;
    /** Multiplies the screen size: above 1 keeps detail longer. */
    bias: number;
    /** False draws level 0 everywhere. */
    enabled: boolean;
    /** False keeps level 2 out to the far distance. */
    impostors: boolean;
    maxDistance: number;
}

export const DEFAULT_LOD: LodSettings = {
    thresholds: [0.28, 0.1, 0.035],
    hysteresis: 0.1,
    fadeSeconds: 0.4,
    bias: 1,
    enabled: true,
    impostors: true,
    maxDistance: 420,
};

export function screenSize(radius: number, distance: number, projScale: number): number {
    return (radius * projScale) / Math.max(distance, 1e-6);
}

/** The level for screen size s, ignoring history. */
export function rawLevel(s: number, set: LodSettings): number {
    if (!set.enabled) return 0;
    const t = set.thresholds;
    const last = set.impostors ? IMPOSTOR : IMPOSTOR - 1;
    let k = 0;
    while (k < last && s < t[k]) k++;
    return k;
}

/** Moves from `current` towards the level for s, crossing a boundary only past the margin. */
export function stepLevel(current: number, s: number, set: LodSettings): number {
    if (!set.enabled) return 0;
    const t = set.thresholds, h = set.hysteresis;
    const last = set.impostors ? IMPOSTOR : IMPOSTOR - 1;
    let k = Math.min(current, last);
    while (k > 0 && s >= t[k - 1] * (1 + h)) k--;
    while (k < last && s < t[k] * (1 - h)) k++;
    return k;
}

/**
 * Screen-door mask shared by the two levels in a cross-fade. `code` in (0, 1]
 * keeps fragments whose dither value d (in [0, 1)) is below it; a negative
 * code keeps d >= -code. The incoming level gets f, the outgoing one -f, so
 * every pixel is drawn by exactly one of them.
 */
export function keeps(code: number, d: number): boolean {
    return code > 0 ? d < code : d >= -code;
}

/** 4×4 Bayer matrix, values (i + 0.5) / 16. Mirrors bayer4() in lod-common.chunk. */
export function bayer4(x: number, y: number): number {
    const m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    return (m[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
}

export interface LodFrameStats {
    visible: number;
    /** Instances drawn per level (an instance mid-fade counts in both). */
    perLevel: Int32Array;
    fading: number;
    cellsOutside: number;
    cellsInside: number;
    cellsPartial: number;
    sphereTests: number;
}

/**
 * The CPU half of the GPU path: culls cells then instances, picks levels with
 * hysteresis, advances fades and writes a compact list of (instance, code)
 * entries grouped in buckets (species × level). Trees mid-fade go to a second
 * set of buckets, `steadyBuckets` on, so that only their draws need the
 * dither discard (which costs early depth testing).
 */
export class LodSystem {
    readonly level: Int8Array;
    readonly previous: Int8Array;
    readonly fade: Float32Array;
    /** Buckets [0, steadyBuckets) hold code 1 entries, the rest the fading ones. */
    readonly steadyBuckets: number;
    readonly buckets: number;
    /** Entries per bucket this frame. */
    readonly counts: Int32Array;
    /** First entry of each bucket in `entries`. */
    readonly offsets: Int32Array;
    /** Pairs (instance index, code), bucket after bucket. */
    entries: Float32Array;
    total = 0;
    readonly stats: LodFrameStats;
    private readonly bucketOf: Int16Array;
    private readonly codeOf: Float32Array;
    private readonly bucketOf2: Int16Array;
    private readonly codeOf2: Float32Array;
    private readonly order: Int32Array;

    readonly forest: Forest;
    /** Per species: bounding radius and sphere-centre height, object units. */
    readonly radius: readonly number[];
    readonly centerY: readonly number[];

    constructor(forest: Forest, radius: readonly number[], centerY: readonly number[], species: number) {
        this.forest = forest;
        this.radius = radius;
        this.centerY = centerY;
        const n = forest.count;
        this.level = new Int8Array(n).fill(-1);
        this.previous = new Int8Array(n).fill(-1);
        this.fade = new Float32Array(n).fill(1);
        this.steadyBuckets = species * LOD_LEVELS;
        this.buckets = this.steadyBuckets * 2;
        this.counts = new Int32Array(this.buckets);
        this.offsets = new Int32Array(this.buckets);
        this.entries = new Float32Array(n * 4);
        this.bucketOf = new Int16Array(n);
        this.codeOf = new Float32Array(n);
        this.bucketOf2 = new Int16Array(n);
        this.codeOf2 = new Float32Array(n);
        this.order = new Int32Array(n);
        this.stats = { visible: 0, perLevel: new Int32Array(LOD_LEVELS), fading: 0, cellsOutside: 0, cellsInside: 0, cellsPartial: 0, sphereTests: 0 };
    }

    update(planes: Planes, cx: number, cy: number, cz: number, projScale: number, dt: number, set: LodSettings): void {
        const f = this.forest;
        const st = this.stats;
        st.visible = 0; st.fading = 0; st.cellsOutside = 0; st.cellsInside = 0; st.cellsPartial = 0; st.sphereTests = 0;
        st.perLevel.fill(0);
        this.counts.fill(0);
        const step = set.fadeSeconds > 0 ? dt / set.fadeSeconds : 1;
        const maxD2 = set.maxDistance * set.maxDistance;
        let nOrder = 0;
        const seen = this.level;
        for (const cell of f.cells) {
            if (cell.items.length === 0) continue;
            const dx = Math.max(cell.min[0] - cx, 0, cx - cell.max[0]);
            const dz = Math.max(cell.min[2] - cz, 0, cz - cell.max[2]);
            let cls = dx * dx + dz * dz > maxD2 ? OUTSIDE : classifyBox(planes, cell.min, cell.max);
            if (cls === OUTSIDE) {
                st.cellsOutside++;
                for (let j = 0; j < cell.items.length; j++) seen[cell.items[j]] = -1;
                continue;
            }
            if (cls === INSIDE) st.cellsInside++; else st.cellsPartial++;
            for (let j = 0; j < cell.items.length; j++) {
                const i = cell.items[j];
                const sp = f.species[i];
                const r = this.radius[sp] * f.scale[i];
                const x = f.x[i], y = f.y[i] + this.centerY[sp] * f.scale[i], z = f.z[i];
                const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz);
                if (d2 > maxD2) { seen[i] = -1; continue; }
                if (cls !== INSIDE) {
                    st.sphereTests++;
                    if (!sphereVisible(planes, x, y, z, r)) { seen[i] = -1; continue; }
                }
                const s = screenSize(r, Math.sqrt(d2), projScale) * set.bias;
                let lv = this.level[i];
                if (lv < 0) {
                    lv = rawLevel(s, set);
                    this.level[i] = lv;
                    this.previous[i] = lv;
                    this.fade[i] = 1;
                } else {
                    const next = stepLevel(lv, s, set);
                    if (next !== lv) {
                        // A change during a fade restarts from the level being shown most.
                        this.previous[i] = this.fade[i] >= 0.5 ? lv : this.previous[i];
                        this.level[i] = next;
                        this.fade[i] = this.previous[i] === next ? 1 : 0;
                        lv = next;
                    }
                    if (this.fade[i] < 1) this.fade[i] = Math.min(1, this.fade[i] + step);
                }
                const fd = this.fade[i];
                const fadeBase = fd < 1 ? this.steadyBuckets : 0;
                const b = fadeBase + sp * LOD_LEVELS + lv;
                this.bucketOf[i] = b;
                this.codeOf[i] = fd < 1 ? Math.max(fd, 1e-3) : 1;
                this.counts[b]++;
                st.perLevel[lv]++;
                if (fd < 1) {
                    const b2 = fadeBase + sp * LOD_LEVELS + this.previous[i];
                    this.bucketOf2[i] = b2;
                    this.codeOf2[i] = -Math.max(fd, 1e-3);
                    this.counts[b2]++;
                    st.perLevel[this.previous[i]]++;
                    st.fading++;
                } else {
                    this.bucketOf2[i] = -1;
                }
                this.order[nOrder++] = i;
            }
        }
        st.visible = nOrder;
        let acc = 0;
        for (let b = 0; b < this.buckets; b++) { this.offsets[b] = acc; acc += this.counts[b]; }
        this.total = acc;
        if (this.entries.length < acc * 2) this.entries = new Float32Array(acc * 4);
        const cursor = Int32Array.from(this.offsets);
        const e = this.entries;
        for (let k = 0; k < nOrder; k++) {
            const i = this.order[k];
            let o = cursor[this.bucketOf[i]]++ * 2;
            e[o] = i; e[o + 1] = this.codeOf[i];
            const b2 = this.bucketOf2[i];
            if (b2 >= 0) {
                o = cursor[b2]++ * 2;
                e[o] = i; e[o + 1] = this.codeOf2[i];
            }
        }
    }
}

/** Merged path: one level per cell, from the nearest point of its box and the largest tree radius. */
export function cellLevel(distance: number, maxRadius: number, projScale: number, set: LodSettings): number {
    return rawLevel(screenSize(maxRadius, distance, projScale) * set.bias, set);
}
