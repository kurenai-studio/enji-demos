import { Mat4, primitives, Quat, Vec3 } from 'cc';

/** Albedo rgb and reflectance at normal incidence (F0, Schlick), stored in the vertex colour's alpha. */
type Rgb = readonly [number, number, number, number];

const FLOOR: Rgb = [0.8, 0.78, 0.74, 0.12];
const PANEL: Rgb = [0.07, 0.08, 0.09, 0.6];
const WALL: Rgb = [0.86, 0.82, 0.75, 0];
const STONE: Rgb = [0.74, 0.74, 0.76, 0];
const CRATE: Rgb = [0.78, 0.6, 0.42, 0];
const CLAY: Rgb = [0.82, 0.5, 0.38, 0];
const TEAL: Rgb = [0.4, 0.66, 0.68, 0.15];
const BALL: Rgb = [0.9, 0.86, 0.5, 0.3];

/** Appends transformed primitives into one vertex-coloured geometry. */
class GeometryBuilder {
    readonly positions: number[] = [];
    readonly normals: number[] = [];
    readonly colors: number[] = [];
    readonly indices: number[] = [];
    private readonly matrix = new Mat4();
    private readonly v = new Vec3();

    add(g: primitives.IGeometry, color: Rgb, position: Readonly<Vec3>, yawDegrees = 0): void {
        const q = Quat.fromEuler(new Quat(), 0, yawDegrees, 0);
        Mat4.fromRT(this.matrix, q, position);
        const base = this.positions.length / 3;
        const p = g.positions;
        const n = g.normals!;
        for (let i = 0; i < p.length; i += 3) {
            Vec3.transformMat4(this.v, this.v.set(p[i], p[i + 1], p[i + 2]), this.matrix);
            this.positions.push(this.v.x, this.v.y, this.v.z);
            Vec3.transformQuat(this.v, this.v.set(n[i], n[i + 1], n[i + 2]), q);
            this.normals.push(this.v.x, this.v.y, this.v.z);
            this.colors.push(color[0], color[1], color[2], color[3]);
        }
        for (const i of g.indices!) this.indices.push(base + i);
    }

    box(color: Rgb, cx: number, y0: number, cz: number, w: number, h: number, l: number, yaw = 0): void {
        this.add(primitives.box({ width: w, height: h, length: l }), color, new Vec3(cx, y0 + h / 2, cz), yaw);
    }

    geometry(): primitives.IGeometry {
        let min = new Vec3(Infinity, Infinity, Infinity);
        let max = new Vec3(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < this.positions.length; i += 3) {
            const v = this.v.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]);
            min = Vec3.min(min, min, v);
            max = Vec3.max(max, max, v);
        }
        return { positions: this.positions, normals: this.normals, colors: this.colors, indices: this.indices, minPos: min, maxPos: max };
    }
}

/**
 * A walled corner full of creases and contacts, the cases SSAO is for: a
 * floor meeting two walls, a staircase, columns on plinths, stacked crates,
 * a cluster of touching spheres and a torus lying on the floor; and for the
 * reflections, a glossy floor with a polished dark slab. One static mesh.
 */
export function buildCourt(): primitives.IGeometry {
    const b = new GeometryBuilder();
    b.box(FLOOR, 0, -0.2, 0, 14, 0.2, 14);
    // A polished dark slab under the ball's path, 2 mm proud of the floor.
    b.box(PANEL, 0.2, -0.1, -0.3, 3.4, 0.102, 3.4);
    b.box(WALL, 0, 0, -4.15, 10.3, 3.2, 0.3);
    b.box(WALL, -5, 0, 0.85, 0.3, 3.2, 10);
    // Skirting along both walls: two small extra creases.
    b.box(WALL, 0, 0, -3.95, 10, 0.12, 0.1);
    b.box(WALL, -4.8, 0, 0.85, 0.1, 0.12, 10);

    // Staircase against the back wall.
    for (let i = 0; i < 6; i++) {
        const depth = 2.4 - i * 0.4;
        b.box(STONE, 2.6, 0, -4 + depth / 2, 1.6, 0.25 * (i + 1), depth);
    }
    // Columns along the side wall: plinth, shaft, capital.
    for (const z of [-2.4, -0.4, 1.6]) {
        b.box(STONE, -4.2, 0, z, 0.7, 0.3, 0.7);
        b.add(primitives.cylinder(0.22, 0.22, 2.4, { radialSegments: 24, heightSegments: 1 }), STONE, new Vec3(-4.2, 1.5, z));
        b.box(STONE, -4.2, 2.7, z, 0.7, 0.2, 0.7);
    }
    // Bench against the back wall.
    b.box(TEAL, -2.4, 0, -3.65, 2.0, 0.45, 0.6);

    // Crates: a big one with a smaller one on top, a third beside them.
    b.box(CRATE, -0.6, 0, -2.6, 1.0, 1.0, 1.0, 12);
    b.box(CRATE, -0.5, 1.0, -2.65, 0.55, 0.55, 0.55, 38);
    b.box(CRATE, 0.45, 0, -2.4, 0.6, 0.6, 0.6, -20);

    // Seven touching spheres: a hexagon round a centre one.
    const r = 0.35;
    const sphere = primitives.sphere(r, { segments: 20 });
    b.add(sphere, CLAY, new Vec3(1.8, r, 1.2));
    for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        b.add(sphere, CLAY, new Vec3(1.8 + 2 * r * Math.cos(a), r, 1.2 + 2 * r * Math.sin(a)));
    }

    // Torus lying flat (its axis is y by default).
    b.add(primitives.torus(0.6, 0.16, { radialSegments: 16, tubularSegments: 40 }), TEAL, new Vec3(-1.7, 0.16, 1.4));
    return b.geometry();
}

/** The moving ball, vertex-coloured like the court. */
export function buildBall(radius: number): primitives.IGeometry {
    const b = new GeometryBuilder();
    b.add(primitives.sphere(radius, { segments: 24 }), BALL, Vec3.ZERO);
    return b.geometry();
}
