import { gfx, Mesh, utils, Vec3 } from 'cc';
import { computeNormals, vertexCount, type Bounds, type Geo } from './Geometry';
import { terrainHeight } from './Forest';
import type { Merged, MergedQuads } from './Merge';
import { MAX_VERTICES } from './Species';
import { valueNoise } from './Trees';

const HUGE = 1e5;

interface Stream {
    name: string;
    /** Floats per vertex (1–4). */
    size: number;
    data: Float32Array;
}

const FLOAT_FORMATS = [gfx.Format.R32F, gfx.Format.RG32F, gfx.Format.RGB32F, gfx.Format.RGBA32F];

/**
 * Interleaved float vertices and 16-bit indices written straight into the
 * mesh buffer: MeshUtils.createMesh goes through plain arrays and writes
 * attribute by attribute, about 10× slower for a 100K-vertex batch.
 */
function interleavedMesh(streams: Stream[], indices: ArrayLike<number>, min: readonly number[], max: readonly number[]): Mesh {
    const nv = streams[0].data.length / streams[0].size;
    if (nv > MAX_VERTICES + 1) throw new Error(`${nv} vertices exceed 16-bit indices`);
    const stride = streams.reduce((s, a) => s + a.size, 0);
    const vbBytes = nv * stride * 4;
    const buffer = new ArrayBuffer(vbBytes + indices.length * 2);
    const vb = new Float32Array(buffer, 0, nv * stride);
    let offset = 0;
    for (const s of streams) {
        const d = s.data;
        for (let v = 0, o = offset, i = 0; v < nv; v++, o += stride) for (let c = 0; c < s.size; c++) vb[o + c] = d[i++];
        offset += s.size;
    }
    new Uint16Array(buffer, vbBytes, indices.length).set(indices);
    const mesh = new Mesh();
    mesh.reset({
        struct: {
            vertexBundles: [{
                view: { offset: 0, length: vbBytes, count: nv, stride: stride * 4 },
                attributes: streams.map((s) => new gfx.Attribute(s.name, FLOAT_FORMATS[s.size - 1])),
            }],
            primitives: [{
                primitiveMode: gfx.PrimitiveMode.TRIANGLE_LIST,
                vertexBundelIndices: [0],
                indexView: { offset: vbBytes, length: indices.length * 2, count: indices.length, stride: 2 },
            }],
            minPosition: new Vec3(min[0], min[1], min[2]),
            maxPosition: new Vec3(max[0], max[1], max[2]),
        },
        data: new Uint8Array(buffer),
    });
    return mesh;
}

function rgba(rgb: Float32Array, scale = 1): number[] {
    const out = new Array<number>((rgb.length / 3) * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        out[j] = rgb[i] * scale; out[j + 1] = rgb[i + 1] * scale; out[j + 2] = rgb[i + 2] * scale; out[j + 3] = 1;
    }
    return out;
}

/** One tree level as a node mesh. */
export function geoMesh(g: Geo, b: Bounds): Mesh {
    return utils.MeshUtils.createMesh({
        positions: Array.from(g.positions),
        normals: Array.from(g.normals),
        colors: rgba(g.colors),
        indices: Array.from(g.indices),
        minPos: new Vec3(b.min[0], b.min[1], b.min[2]),
        maxPos: new Vec3(b.max[0], b.max[1], b.max[2]),
    });
}

/** `copies` copies of a level, each vertex tagged with its copy index (GPU path). Never culled by the engine. */
export function chunkMesh(g: Geo, copies: number): Mesh {
    const nv = vertexCount(g);
    if (nv * copies > MAX_VERTICES + 1) throw new Error(`chunk of ${copies} × ${nv} vertices exceeds 16-bit indices`);
    const positions = new Float32Array(nv * copies * 3);
    const normals = new Float32Array(nv * copies * 3);
    const colors = new Float32Array(nv * copies * 4);
    const copy = new Float32Array(nv * copies);
    const indices = new Uint32Array(g.indices.length * copies);
    const c = rgba(g.colors);
    for (let k = 0; k < copies; k++) {
        positions.set(g.positions, k * nv * 3);
        normals.set(g.normals, k * nv * 3);
        colors.set(c, k * nv * 4);
        copy.fill(k, k * nv, (k + 1) * nv);
        for (let i = 0; i < g.indices.length; i++) indices[k * g.indices.length + i] = g.indices[i] + k * nv;
    }
    return interleavedMesh([
        { name: gfx.AttributeName.ATTR_POSITION, size: 3, data: positions },
        { name: gfx.AttributeName.ATTR_NORMAL, size: 3, data: normals },
        { name: gfx.AttributeName.ATTR_COLOR, size: 4, data: colors },
        { name: 'a_copy', size: 1, data: copy },
    ], indices, [-HUGE, -HUGE, -HUGE], [HUGE, HUGE, HUGE]);
}

/** Billboard quads for the GPU path: (corner u, corner v, copy). */
export function quadChunkMesh(copies: number): Mesh {
    const positions = new Array<number>(copies * 12);
    const indices = new Array<number>(copies * 6);
    const uv = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    for (let k = 0; k < copies; k++) {
        for (let q = 0; q < 4; q++) {
            positions[(k * 4 + q) * 3] = uv[q][0];
            positions[(k * 4 + q) * 3 + 1] = uv[q][1];
            positions[(k * 4 + q) * 3 + 2] = k;
        }
        const v = k * 4;
        indices.splice(k * 6, 6, v, v + 1, v + 2, v, v + 2, v + 3);
    }
    return utils.MeshUtils.createMesh({
        positions, indices,
        minPos: new Vec3(-HUGE, -HUGE, -HUGE), maxPos: new Vec3(HUGE, HUGE, HUGE),
    });
}

/** A merged cell part (world-space vertices). */
export function mergedMesh(m: Merged, min: readonly number[], max: readonly number[]): Mesh {
    return interleavedMesh([
        { name: gfx.AttributeName.ATTR_POSITION, size: 3, data: m.positions },
        { name: gfx.AttributeName.ATTR_NORMAL, size: 3, data: m.normals },
        { name: gfx.AttributeName.ATTR_COLOR, size: 4, data: m.colors },
    ], m.indices, min, max);
}

export function mergedQuadMesh(m: MergedQuads, min: readonly number[], max: readonly number[]): Mesh {
    return interleavedMesh([
        { name: gfx.AttributeName.ATTR_POSITION, size: 3, data: m.positions },
        { name: 'a_corner', size: 4, data: m.corners },
        { name: 'a_param', size: 4, data: m.params },
    ], m.indices, min, max);
}

/** Rolling ground with vertex colours, `side` metres square, (n + 1)² vertices. */
export function groundMesh(side: number, n = 254): Mesh {
    const positions = new Float32Array((n + 1) * (n + 1) * 3);
    const colors = new Float32Array((n + 1) * (n + 1) * 3);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const x = -side / 2 + (side * i) / n, z = -side / 2 + (side * j) / n;
        const o = (j * (n + 1) + i) * 3;
        positions[o] = x; positions[o + 1] = terrainHeight(x, z); positions[o + 2] = z;
        const v = 0.85 + 0.25 * valueNoise(x / 23, 0, z / 23, 31) + 0.1 * valueNoise(x / 7, 0, z / 7, 32);
        const dry = Math.max(0, valueNoise(x / 90, 0, z / 90, 33));
        colors[o] = (0.06 + 0.05 * dry) * v; colors[o + 1] = (0.085 + 0.02 * dry) * v; colors[o + 2] = 0.035 * v;
    }
    const indices = new Uint32Array(n * n * 6);
    let k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        indices.set([a, c, b, b, c, d], k);
        k += 6;
    }
    const normals = computeNormals(positions, indices);
    return utils.MeshUtils.createMesh({
        positions: Array.from(positions), normals: Array.from(normals), colors: rgba(colors), indices: Array.from(indices),
        minPos: new Vec3(-side / 2, -20, -side / 2), maxPos: new Vec3(side / 2, 20, side / 2),
    });
}
