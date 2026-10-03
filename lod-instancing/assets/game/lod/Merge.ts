/**
 * Static batching for the merged path: every tree of a cell, at one level,
 * pre-transformed into a single vertex buffer (what BatchingUtility does,
 * without the scene nodes).
 */
import type { Forest } from './Forest';
import type { Geo } from './Geometry';

export interface Merged {
    positions: Float32Array;
    normals: Float32Array;
    /** rgba; a = 1. */
    colors: Float32Array;
    indices: Uint32Array;
}

/** `geos[s]` is the mesh of species s at the wanted level. */
export function mergeTrees(f: Forest, items: ArrayLike<number>, geos: readonly Geo[]): Merged {
    let nv = 0, ni = 0;
    for (let j = 0; j < items.length; j++) {
        const g = geos[f.species[items[j]]];
        nv += g.positions.length / 3;
        ni += g.indices.length;
    }
    const out: Merged = {
        positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3),
        colors: new Float32Array(nv * 4), indices: new Uint32Array(ni),
    };
    let v = 0, k = 0;
    for (let j = 0; j < items.length; j++) {
        const i = items[j];
        const g = geos[f.species[i]];
        const c = Math.cos(f.yaw[i]), sn = Math.sin(f.yaw[i]), s = f.scale[i], t = f.tint[i];
        const n = g.positions.length / 3;
        for (let q = 0; q < n; q++) {
            const px = g.positions[q * 3], py = g.positions[q * 3 + 1], pz = g.positions[q * 3 + 2];
            const nx = g.normals[q * 3], ny = g.normals[q * 3 + 1], nz = g.normals[q * 3 + 2];
            const o = (v + q) * 3;
            out.positions[o] = f.x[i] + (px * c + pz * sn) * s;
            out.positions[o + 1] = f.y[i] + py * s;
            out.positions[o + 2] = f.z[i] + (-px * sn + pz * c) * s;
            out.normals[o] = nx * c + nz * sn;
            out.normals[o + 1] = ny;
            out.normals[o + 2] = -nx * sn + nz * c;
            const oc = (v + q) * 4;
            out.colors[oc] = g.colors[q * 3] * t;
            out.colors[oc + 1] = g.colors[q * 3 + 1] * t;
            out.colors[oc + 2] = g.colors[q * 3 + 2] * t;
            out.colors[oc + 3] = 1;
        }
        for (let q = 0; q < g.indices.length; q++) out.indices[k + q] = g.indices[q] + v;
        v += n;
        k += g.indices.length;
    }
    return out;
}

/** Billboards for a cell: the shader turns each quad to the camera. */
export interface MergedQuads {
    /** Tree base, repeated for the four corners. */
    positions: Float32Array;
    /** (corner u in -0.5..0.5, corner v in 0..1, species, 0). */
    corners: Float32Array;
    /** (scale, cos yaw, sin yaw, tint). */
    params: Float32Array;
    indices: Uint32Array;
}

export function mergeQuads(f: Forest, items: ArrayLike<number>): MergedQuads {
    const n = items.length;
    const out: MergedQuads = {
        positions: new Float32Array(n * 12), corners: new Float32Array(n * 16),
        params: new Float32Array(n * 16), indices: new Uint32Array(n * 6),
    };
    const uv = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    for (let j = 0; j < n; j++) {
        const i = items[j];
        for (let q = 0; q < 4; q++) {
            const v = j * 4 + q;
            out.positions.set([f.x[i], f.y[i], f.z[i]], v * 3);
            out.corners.set([uv[q][0], uv[q][1], f.species[i], 0], v * 4);
            out.params.set([f.scale[i], Math.cos(f.yaw[i]), Math.sin(f.yaw[i]), f.tint[i]], v * 4);
        }
        out.indices.set([j * 4, j * 4 + 1, j * 4 + 2, j * 4, j * 4 + 2, j * 4 + 3], j * 6);
    }
    return out;
}
