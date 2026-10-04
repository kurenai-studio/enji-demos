import type { SnowSim } from './SnowSim';

/** Small deterministic hash noise, so every reset builds the same drift. */
function hash(i: number, j: number): number {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number): number {
    const i = Math.floor(x), j = Math.floor(z);
    const fx = x - i, fz = z - j;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export interface Bed {
    /** Mean snow depth (m) and the drift amplitude on top of it. */
    depth: number;
    drift: number;
    /** Snow piled against the back wall, as a fraction of the tray depth. */
    bank: number;
}

export const BEDS: Record<string, Bed> = {
    drift: { depth: 0.24, drift: 0.04, bank: 0.06 },
    flat: { depth: 0.25, drift: 0, bank: 0 },
};

/** Snow height above the tray floor at (u, w) ∈ [0, 1]² across the tray. */
export function bedHeight(bed: Bed, u: number, w: number, width: number, length: number): number {
    const n = valueNoise(u * width * 6, w * length * 6) * 0.6 + valueNoise(u * width * 13 + 7, w * length * 13 + 3) * 0.4;
    const bank = bed.bank * Math.max(0, 1 - w * 2.2) ** 2;
    return bed.depth + bed.drift * (n - 0.5) * 2 + bank;
}

/**
 * Fills the tray with snow on a jittered lattice of `perCell`³ particles per
 * grid cell, up to the bed height. Returns the particle count.
 */
export function fillBed(sim: SnowSim, bed: Bed, perCell: number): number {
    sim.clear();
    sim.setSpacing(perCell);
    const s = sim.dx / perCell;
    const x0 = sim.lo, x1 = sim.hiX, z0 = sim.lo, z1 = sim.hiZ, y0 = sim.lo;
    const width = x1 - x0, length = z1 - z0;
    let seed = 1;
    const rand = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let k = 0; k < Math.floor(length / s); k++) {
        for (let i = 0; i < Math.floor(width / s); i++) {
            const px = x0 + (i + 0.5) * s, pz = z0 + (k + 0.5) * s;
            const top = y0 + bedHeight(bed, (px - x0) / width, (pz - z0) / length, width, length);
            for (let j = 0; ; j++) {
                const py = y0 + (j + 0.5) * s;
                if (py > top) break;
                if (sim.add(px + (rand() - 0.5) * s * 0.6, py + (rand() - 0.5) * s * 0.6, pz + (rand() - 0.5) * s * 0.6) < 0) return sim.count;
            }
        }
    }
    return sim.count;
}

/** Capacity needed by `fillBed` (the drift only adds where the noise is high, so this is an upper bound). */
export function bedCapacity(sim: { dx: number; nx: number; nz: number }, bed: Bed, perCell: number, border: number): number {
    const s = sim.dx / perCell;
    const width = (sim.nx - 2 * border) * sim.dx, length = (sim.nz - 2 * border) * sim.dx;
    const top = bed.depth + bed.drift + bed.bank;
    return Math.ceil(width / s) * Math.ceil(length / s) * Math.ceil(top / s + 1);
}
