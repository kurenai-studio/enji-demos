import { Mesh, primitives, utils, Vec3 } from 'cc';

/** Height of the pool rim (and the deck) above the water rest level. */
export const RIM = 2 / 12;

/**
 * Flat grid over the pool opening (x, z in [-1, 1], y = 0), front faces up.
 * The water effects displace it in the vertex shader, so its bounds reserve
 * room above and below the rest level.
 */
export function createWaterGrid(segments: number): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const row = segments + 1;
    for (let j = 0; j <= segments; j++) {
        for (let i = 0; i <= segments; i++) {
            positions.push((i / segments) * 2 - 1, 0, (j / segments) * 2 - 1);
        }
    }
    for (let j = 0; j < segments; j++) {
        for (let i = 0; i < segments; i++) {
            const a = j * row + i;
            indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
        }
    }
    return utils.MeshUtils.createMesh({
        positions,
        indices,
        minPos: new Vec3(-1, -1, -1),
        maxPos: new Vec3(1, 1, 1),
    });
}

/** Open-top box from the floor (y = -1) up to the rim; every face points into the pool. */
export function createPoolBox(): Mesh {
    const b = new QuadBuilder();
    const y0 = -1;
    const y1 = RIM;
    b.quad([-1, y0, -1], [1, y0, -1], [1, y0, 1], [-1, y0, 1], [0, 1, 0]);
    b.quad([-1, y0, -1], [-1, y1, -1], [-1, y1, 1], [-1, y0, 1], [1, 0, 0]);
    b.quad([1, y0, -1], [1, y1, -1], [1, y1, 1], [1, y0, 1], [-1, 0, 0]);
    b.quad([-1, y0, -1], [1, y0, -1], [1, y1, -1], [-1, y1, -1], [0, 0, 1]);
    b.quad([-1, y0, 1], [1, y0, 1], [1, y1, 1], [-1, y1, 1], [0, 0, -1]);
    return b.build();
}

/** Deck at rim height from the pool edge out to `size`, with a square hole for the pool. */
export function createDeck(size: number): Mesh {
    const b = new QuadBuilder();
    const y = RIM;
    const up: Triple = [0, 1, 0];
    b.quad([-size, y, 1], [size, y, 1], [size, y, size], [-size, y, size], up);
    b.quad([-size, y, -size], [size, y, -size], [size, y, -1], [-size, y, -1], up);
    b.quad([1, y, -1], [size, y, -1], [size, y, 1], [1, y, 1], up);
    b.quad([-size, y, -1], [-1, y, -1], [-1, y, 1], [-size, y, 1], up);
    return b.build();
}

type Triple = [number, number, number];

/** Collects quads given as a corner loop and orients each so its front face looks along `normal`. */
class QuadBuilder {
    private positions: number[] = [];
    private indices: number[] = [];
    private min = new Vec3(Infinity, Infinity, Infinity);
    private max = new Vec3(-Infinity, -Infinity, -Infinity);

    quad(a: Triple, b: Triple, c: Triple, d: Triple, normal: Triple): void {
        const base = this.positions.length / 3;
        for (const p of [a, b, c, d]) {
            this.positions.push(...p);
            Vec3.min(this.min, this.min, new Vec3(...p));
            Vec3.max(this.max, this.max, new Vec3(...p));
        }
        const e1 = new Vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const e2 = new Vec3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
        const facing = Vec3.dot(Vec3.cross(new Vec3(), e1, e2), new Vec3(...normal));
        const order = facing > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
        for (const k of order) this.indices.push(base + k);
    }

    build(): Mesh {
        const geometry: primitives.IGeometry = {
            positions: this.positions,
            indices: this.indices,
            minPos: this.min,
            maxPos: this.max,
        };
        return utils.MeshUtils.createMesh(geometry);
    }
}
