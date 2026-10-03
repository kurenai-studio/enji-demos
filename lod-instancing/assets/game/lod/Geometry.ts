/**
 * Indexed triangle meshes as plain arrays (no engine types), so that the
 * generators, the simplifier and the tests run in Node.
 */
export interface Geo {
    /** xyz per vertex. */
    positions: Float32Array;
    /** xyz per vertex, unit length. */
    normals: Float32Array;
    /** rgb per vertex, linear. */
    colors: Float32Array;
    indices: Uint32Array;
}

export function vertexCount(g: Geo): number {
    return g.positions.length / 3;
}

export function triangleCount(g: Geo): number {
    return g.indices.length / 3;
}

/** Area-weighted smooth normals (the cross product's length is twice the area). */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const n = new Float32Array(positions.length);
    for (let f = 0; f < indices.length; f += 3) {
        const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const o of [a, b, c]) { n[o] += nx; n[o + 1] += ny; n[o + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

/** Concatenates meshes. */
export function mergeGeos(parts: readonly Geo[]): Geo {
    let nv = 0, ni = 0;
    for (const p of parts) { nv += vertexCount(p); ni += p.indices.length; }
    const out: Geo = {
        positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3),
        colors: new Float32Array(nv * 3), indices: new Uint32Array(ni),
    };
    let vo = 0, io = 0;
    for (const p of parts) {
        out.positions.set(p.positions, vo * 3);
        out.normals.set(p.normals, vo * 3);
        out.colors.set(p.colors, vo * 3);
        for (let i = 0; i < p.indices.length; i++) out.indices[io + i] = p.indices[i] + vo;
        vo += vertexCount(p);
        io += p.indices.length;
    }
    return out;
}

export interface Bounds {
    min: [number, number, number];
    max: [number, number, number];
    /** Bounding sphere around the box centre. */
    center: [number, number, number];
    radius: number;
}

export function bounds(positions: Float32Array): Bounds {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], positions[i + k]);
            max[k] = Math.max(max[k], positions[i + k]);
        }
    }
    const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let r2 = 0;
    for (let i = 0; i < positions.length; i += 3) {
        r2 = Math.max(r2, (positions[i] - center[0]) ** 2 + (positions[i + 1] - center[1]) ** 2 + (positions[i + 2] - center[2]) ** 2);
    }
    return { min, max, center, radius: Math.sqrt(r2) };
}

/** Edges used by exactly one triangle (holes, open rims). */
export function boundaryEdgeCount(indices: Uint32Array): number {
    const count = new Map<number, number>();
    const key = (a: number, b: number): number => (a < b ? a * 4194304 + b : b * 4194304 + a);
    for (let f = 0; f < indices.length; f += 3) {
        for (let k = 0; k < 3; k++) {
            const e = key(indices[f + k], indices[f + ((k + 1) % 3)]);
            count.set(e, (count.get(e) ?? 0) + 1);
        }
    }
    let n = 0;
    for (const c of count.values()) if (c === 1) n++;
    return n;
}
