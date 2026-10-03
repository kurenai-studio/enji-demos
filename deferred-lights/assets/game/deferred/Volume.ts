export interface Polyhedron {
    /** Unit-length vertex directions, xyz. */
    positions: number[];
    /** Counter-clockwise seen from outside. */
    indices: number[];
}

/** Icosahedron subdivided `levels` times, vertices pushed onto the unit sphere. */
export function icosphere(levels: number): Polyhedron {
    const t = (1 + Math.sqrt(5)) / 2;
    const positions: number[] = [];
    const push = (x: number, y: number, z: number): number => {
        const l = Math.hypot(x, y, z);
        positions.push(x / l, y / l, z / l);
        return positions.length / 3 - 1;
    };
    for (const [x, y, z] of [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
        [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ]) push(x, y, z);
    let indices = [
        0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
        3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
    for (let level = 0; level < levels; level++) {
        const mid = new Map<string, number>();
        const midpoint = (a: number, b: number): number => {
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            let m = mid.get(key);
            if (m === undefined) {
                m = push(
                    positions[a * 3] + positions[b * 3], positions[a * 3 + 1] + positions[b * 3 + 1], positions[a * 3 + 2] + positions[b * 3 + 2],
                );
                mid.set(key, m);
            }
            return m;
        };
        const next: number[] = [];
        for (let i = 0; i < indices.length; i += 3) {
            const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
            const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
            next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
        }
        indices = next;
    }
    return { positions, indices };
}

/**
 * Smallest distance from the centre to a face plane. A polyhedron with its
 * vertices on the unit sphere cuts the sphere off between them; scaled by
 * 1 / inradius, every face lies outside the sphere, so the volume covers
 * every pixel the light can reach.
 */
export function inradius(p: Polyhedron): number {
    let min = Infinity;
    const v = p.positions;
    for (let i = 0; i < p.indices.length; i += 3) {
        const [a, b, c] = [p.indices[i] * 3, p.indices[i + 1] * 3, p.indices[i + 2] * 3];
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
        const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const d = (nx * v[a] + ny * v[a + 1] + nz * v[a + 2]) / Math.hypot(nx, ny, nz);
        min = Math.min(min, d);
    }
    return min;
}

export interface VolumeBatch {
    /** Unit directions already scaled by 1 / inradius. */
    positions: number[];
    /** Light index per vertex. */
    lightIndex: number[];
    indices: number[];
}

/** One mesh with a copy of the bounding polyhedron per light; the vertex shader moves and sizes each copy. */
export function volumeBatch(shape: Polyhedron, lights: number): VolumeBatch {
    const s = 1 / inradius(shape);
    const n = shape.positions.length / 3;
    const positions: number[] = [];
    const lightIndex: number[] = [];
    const indices: number[] = [];
    for (let l = 0; l < lights; l++) {
        for (let i = 0; i < n * 3; i++) positions.push(shape.positions[i] * s);
        for (let i = 0; i < n; i++) lightIndex.push(l);
        for (const i of shape.indices) indices.push(l * n + i);
    }
    return { positions, lightIndex, indices };
}
