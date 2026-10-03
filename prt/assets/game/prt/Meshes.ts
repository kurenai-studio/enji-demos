import { gfx, Mesh, Vec3 } from 'cc';
import { Builder, type SceneGeo } from './Scenes';

interface Stream {
    name: string;
    /** Floats per vertex (1–4). */
    size: number;
    data: Float32Array;
}

const FLOAT_FORMATS = [gfx.Format.R32F, gfx.Format.RG32F, gfx.Format.RGB32F, gfx.Format.RGBA32F];

/** Interleaved float vertices and 16-bit indices written straight into the mesh buffer. */
function interleavedMesh(streams: Stream[], indices: ArrayLike<number>, min: readonly number[], max: readonly number[]): Mesh {
    const nv = streams[0].data.length / streams[0].size;
    if (nv > 65536) throw new Error(`${nv} vertices exceed 16-bit indices`);
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

function bounds(p: Float32Array): [number[], number[]] {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) {
        const a = i % 3;
        if (p[i] < min[a]) min[a] = p[i];
        if (p[i] > max[a]) max[a] = p[i];
    }
    return [min, max];
}

/** Positions plus each vertex's index, which locates its transfer texels. */
export function sceneMesh(geo: SceneGeo): Mesh {
    const vid = new Float32Array(geo.vertexCount);
    for (let v = 0; v < geo.vertexCount; v++) vid[v] = v;
    const [min, max] = bounds(geo.positions);
    return interleavedMesh([
        { name: 'a_position', size: 3, data: geo.positions },
        { name: 'a_vid', size: 1, data: vid },
    ], geo.indices, min, max);
}

/** Sphere of radius r around the origin; the sky shader centres it on the camera. */
export function skyMesh(r: number): Mesh {
    const b = new Builder();
    b.sphere([0, 0, 0], r, 48, 24, [1, 1, 1]);
    const g = b.finish('Sky', 0, r);
    return interleavedMesh([{ name: 'a_position', size: 3, data: g.positions }], g.indices, [-r, -r, -r], [r, r, r]);
}
