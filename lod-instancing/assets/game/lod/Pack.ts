/**
 * Layouts of the two RGBA32F textures the GPU path reads in its vertex shaders
 * (lod-common.chunk mirrors every function here).
 *
 * Instance texture, static: two texels per instance,
 *   (x, y, z, scale) and (cos yaw, sin yaw, tint, species).
 * List texture, rewritten each frame: row 0 holds one header texel per bucket,
 *   (first entry, entry count, 0, 0); entries follow from row 1, two per texel,
 *   each (instance index, fade code).
 */
import type { Forest } from './Forest';
import type { LodSystem } from './Lod';

export const TEX_WIDTH = 1024;
/** Entries before the first real one: row 0 is the header. */
export const HEADER_ENTRIES = TEX_WIDTH * 2;

export function instanceTextureRows(count: number): number {
    return Math.max(1, Math.ceil((count * 2) / TEX_WIDTH));
}

export function packInstances(f: Forest): Float32Array {
    const data = new Float32Array(instanceTextureRows(f.count) * TEX_WIDTH * 4);
    for (let i = 0; i < f.count; i++) {
        const o = i * 8;
        data[o] = f.x[i]; data[o + 1] = f.y[i]; data[o + 2] = f.z[i]; data[o + 3] = f.scale[i];
        data[o + 4] = Math.cos(f.yaw[i]); data[o + 5] = Math.sin(f.yaw[i]); data[o + 6] = f.tint[i]; data[o + 7] = f.species[i];
    }
    return data;
}

/** Rows needed for `entries` list entries plus the header. */
export function listTextureRows(entries: number): number {
    return 1 + Math.ceil(entries / 2 / TEX_WIDTH);
}

/** Writes the header and entries; returns the number of rows that changed. */
export function packList(sys: LodSystem, data: Float32Array): number {
    for (let b = 0; b < sys.buckets; b++) {
        data[b * 4] = HEADER_ENTRIES + sys.offsets[b];
        data[b * 4 + 1] = sys.counts[b];
    }
    data.set(sys.entries.subarray(0, sys.total * 2), HEADER_ENTRIES * 2);
    return listTextureRows(sys.total);
}

/** What the vertex shader reads for copy `local` of bucket `bucket`: null when past the count. */
export function readEntry(data: Float32Array, bucket: number, local: number): [number, number] | null {
    const first = data[bucket * 4], count = data[bucket * 4 + 1];
    if (local >= count) return null;
    const e = first + local;
    const texel = Math.floor(e / 2);
    const o = texel * 4 + (e % 2 < 0.5 ? 0 : 2);
    return [data[o], data[o + 1]];
}

/** Object to world for the GPU path: scale, rotate about +Y by yaw (Cocos convention), translate. */
export function instancePoint(data: Float32Array, index: number, px: number, py: number, pz: number): [number, number, number] {
    const o = index * 8;
    const s = data[o + 3], c = data[o + 4], sn = data[o + 5];
    return [data[o] + (px * c + pz * sn) * s, data[o + 1] + py * s, data[o + 2] + (-px * sn + pz * c) * s];
}
