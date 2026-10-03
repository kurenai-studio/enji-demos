/**
 * Forest layout: instances on a jittered grid over rolling terrain, stored as
 * structure-of-arrays, and bucketed into square cells for culling and for the
 * merged-chunk path.
 */
import { mulberry32, SPECIES, valueNoise } from './Trees';

/** Trees per square metre (a dense forest: one per 3 m × 3 m). */
export const DENSITY = 0.11;
export const CELL = 32;

/** Smooth at the ground mesh's ~5 m spacing, so trees sit on the triangles. */
export function terrainHeight(x: number, z: number): number {
    return 6 * valueNoise(x / 140, 0, z / 140, 11) + 2.2 * valueNoise(x / 45, 0, z / 45, 12);
}

export interface Forest {
    count: number;
    /** Side of the square the forest covers, centred on the origin. */
    size: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    yaw: Float32Array;
    scale: Float32Array;
    /** Index into SPECIES. */
    species: Uint8Array;
    /** Per-instance brightness variation, 0.85..1.15. */
    tint: Float32Array;
    cells: Cell[];
    /** Cells per side. */
    cellsPerSide: number;
}

export interface Cell {
    /** Instance indices in this cell. */
    items: Uint32Array;
    min: [number, number, number];
    max: [number, number, number];
}

/** Species mix: conifers, broadleaves, rocks. */
const MIX = [0.5, 0.35, 0.15];

/** A species' bounding sphere about (0, centerY, 0) and its top, object units. */
export interface SpeciesExtent {
    radius: number;
    centerY: number;
    top: number;
}

/** Cell boxes enclose every tree's bounding sphere, so a culled cell holds no visible sphere. */
export function makeForest(count: number, seed: number, extents: readonly SpeciesExtent[]): Forest {
    const size = Math.sqrt(count / DENSITY);
    const side = Math.ceil(Math.sqrt(count));
    const spacing = size / side;
    const rnd = mulberry32(seed);
    const f: Forest = {
        count, size,
        x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count),
        yaw: new Float32Array(count), scale: new Float32Array(count), species: new Uint8Array(count),
        tint: new Float32Array(count), cells: [], cellsPerSide: Math.ceil(size / CELL),
    };
    // Visit the grid in a shuffled order so any prefix is spread over the area.
    const slots = Array.from({ length: side * side }, (_, i) => i);
    for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    for (let i = 0; i < count; i++) {
        const gx = slots[i] % side, gz = Math.floor(slots[i] / side);
        const x = -size / 2 + (gx + 0.15 + 0.7 * rnd()) * spacing;
        const z = -size / 2 + (gz + 0.15 + 0.7 * rnd()) * spacing;
        f.x[i] = x;
        f.z[i] = z;
        f.y[i] = terrainHeight(x, z) - 0.05;
        f.yaw[i] = rnd() * Math.PI * 2;
        const r = rnd();
        // Clumps: a low-frequency field shifts the mix between conifers and broadleaves.
        const clump = valueNoise(x / 60, 0, z / 60, 21) * 0.3;
        f.species[i] = r < MIX[0] + clump ? 0 : r < MIX[0] + MIX[1] + clump * 0.5 ? 1 : 2;
        f.scale[i] = f.species[i] === 2 ? 0.6 + 1.2 * rnd() : 0.75 + 0.55 * rnd();
        f.tint[i] = 0.85 + 0.3 * rnd();
    }
    const n = f.cellsPerSide;
    const lists: number[][] = Array.from({ length: n * n }, () => []);
    for (let i = 0; i < count; i++) lists[cellIndex(f, f.x[i], f.z[i])].push(i);
    f.cells = lists.map((items) => {
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (const i of items) {
            const e = extents[f.species[i]], s = f.scale[i];
            const r = e.radius * s;
            const bottom = Math.min(-0.5, (e.centerY - e.radius) * s);
            const top = Math.max(e.top, e.centerY + e.radius) * s;
            min[0] = Math.min(min[0], f.x[i] - r); max[0] = Math.max(max[0], f.x[i] + r);
            min[1] = Math.min(min[1], f.y[i] + bottom); max[1] = Math.max(max[1], f.y[i] + top);
            min[2] = Math.min(min[2], f.z[i] - r); max[2] = Math.max(max[2], f.z[i] + r);
        }
        return { items: Uint32Array.from(items), min, max };
    });
    return f;
}

export function cellIndex(f: Forest, x: number, z: number): number {
    const n = f.cellsPerSide;
    const cx = Math.min(n - 1, Math.max(0, Math.floor((x + f.size / 2) / CELL)));
    const cz = Math.min(n - 1, Math.max(0, Math.floor((z + f.size / 2) / CELL)));
    return cz * n + cx;
}

export const SPECIES_COUNT = SPECIES.length;
