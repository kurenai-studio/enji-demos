/**
 * Debug view of the raw particles: one octahedron per particle, all packed into a
 * single dynamic mesh (6 vertices / 8 triangles each), coloured by speed.
 * Topology never changes, so indices are written once.
 */
const DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
// Octahedron faces as (x, y, z) direction slots, counter-clockwise seen from outside.
const FACES = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];

export class ParticleMesh {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly colors: Float32Array;
    readonly indices: Uint32Array;
    vertexCount = 0;
    indexCount = 0;

    constructor(readonly capacity: number, readonly radius: number) {
        this.positions = new Float32Array(capacity * 18);
        this.normals = new Float32Array(capacity * 18);
        this.colors = new Float32Array(capacity * 24);
        this.indices = new Uint32Array(capacity * 24);
        for (let p = 0; p < capacity; p++) {
            this.normals.set(DIRS, p * 18);
            for (let f = 0; f < 24; f++) this.indices[p * 24 + f] = p * 6 + FACES[f];
        }
    }

    update(x: Float32Array, y: Float32Array, z: Float32Array,
        vx: Float32Array, vy: Float32Array, vz: Float32Array, count: number): void {
        const { positions, colors, radius } = this;
        for (let p = 0; p < count; p++) {
            const o = p * 18;
            const cx = x[p];
            const cy = y[p];
            const cz = z[p];
            for (let d = 0; d < 18; d += 3) {
                positions[o + d] = cx + DIRS[d] * radius;
                positions[o + d + 1] = cy + DIRS[d + 1] * radius;
                positions[o + d + 2] = cz + DIRS[d + 2] * radius;
            }
            const speed = Math.sqrt(vx[p] * vx[p] + vy[p] * vy[p] + vz[p] * vz[p]);
            const t = speed / (speed + 1.5);
            const r = 0.1 + 0.9 * t;
            const g = 0.35 + 0.65 * t;
            const b = 1;
            const c = p * 24;
            for (let v = 0; v < 24; v += 4) {
                colors[c + v] = r;
                colors[c + v + 1] = g;
                colors[c + v + 2] = b;
                colors[c + v + 3] = 1;
            }
        }
        this.vertexCount = count * 6;
        this.indexCount = count * 24;
    }
}
