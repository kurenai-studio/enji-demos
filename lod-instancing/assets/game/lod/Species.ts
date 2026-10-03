/**
 * Each species with its three mesh levels (QEM-simplified from level 0) and
 * the numbers the culling, LOD and impostor code need.
 */
import { bounds, triangleCount, vertexCount, type Bounds, type Geo } from './Geometry';
import { impostorDims, type ImpostorDims } from './Impostor';
import { simplifyQem } from './Simplify';
import { makeSpecies, SPECIES, type Species } from './Trees';

/** Triangle budget of levels 1 and 2 relative to level 0. */
export const LEVEL_FRACTIONS = [1, 0.25, 0.08];
/** 16-bit indices: a mesh holds at most this many vertices. */
export const MAX_VERTICES = 65535;

export interface SpeciesAssets {
    name: Species;
    levels: Geo[];
    bounds: Bounds;
    /** Bounding sphere about (0, centerY, 0), for culling and screen size. */
    radius: number;
    centerY: number;
    top: number;
    impostor: ImpostorDims;
}

export function buildSpecies(seed = 3): SpeciesAssets[] {
    return SPECIES.map((name, s) => {
        const g0 = makeSpecies(name, seed + s * 101);
        const levels = LEVEL_FRACTIONS.map((f, k) => (k === 0 ? g0 : simplifyQem(g0, Math.round(triangleCount(g0) * f))));
        const b = bounds(g0.positions);
        // Sphere centred on the trunk axis (instances rotate about it).
        const centerY = b.center[1];
        let r2 = 0;
        for (let i = 0; i < g0.positions.length; i += 3) {
            r2 = Math.max(r2, g0.positions[i] ** 2 + (g0.positions[i + 1] - centerY) ** 2 + g0.positions[i + 2] ** 2);
        }
        return { name, levels, bounds: b, radius: Math.sqrt(r2), centerY, top: b.max[1], impostor: impostorDims(b.min, b.max) };
    });
}

/** Copies of a level that fit one 16-bit mesh. */
export function copiesPerChunk(g: Geo): number {
    return Math.max(1, Math.floor((MAX_VERTICES + 1) / vertexCount(g)));
}
