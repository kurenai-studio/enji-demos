import { Mat4, primitives, Quat, Vec3 } from 'cc';
import { FIELD_HALF, rng } from './Lights';

/** Albedo rgb and specular strength. */
type Surface = readonly [number, number, number, number];

const TILE_A: Surface = [0.62, 0.6, 0.58, 0.5];
const TILE_B: Surface = [0.48, 0.47, 0.46, 0.5];
const WALL: Surface = [0.7, 0.66, 0.6, 0.15];
const STONE: Surface = [0.72, 0.72, 0.74, 0.35];
const CRATE: Surface = [0.66, 0.5, 0.34, 0.1];
const METAL: Surface = [0.55, 0.58, 0.62, 1.0];
const CLAY: Surface = [0.75, 0.45, 0.35, 0.3];

/** Appends transformed primitives into one vertex-coloured geometry (alpha: specular strength). */
class GeometryBuilder {
    readonly positions: number[] = [];
    readonly normals: number[] = [];
    readonly colors: number[] = [];
    readonly indices: number[] = [];
    private readonly matrix = new Mat4();
    private readonly v = new Vec3();

    add(g: primitives.IGeometry, surface: Surface, position: Readonly<Vec3>, yawDegrees = 0): void {
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
            this.colors.push(surface[0], surface[1], surface[2], surface[3]);
        }
        for (const i of g.indices!) this.indices.push(base + i);
    }

    box(surface: Surface, cx: number, y0: number, cz: number, w: number, h: number, l: number, yaw = 0): void {
        this.add(primitives.box({ width: w, height: h, length: l }), surface, new Vec3(cx, y0 + h / 2, cz), yaw);
    }

    geometry(): primitives.IGeometry {
        const min = new Vec3(Infinity, Infinity, Infinity);
        const max = new Vec3(-Infinity, -Infinity, -Infinity);
        for (let i = 0; i < this.positions.length; i += 3) {
            const v = this.v.set(this.positions[i], this.positions[i + 1], this.positions[i + 2]);
            Vec3.min(min, min, v);
            Vec3.max(max, max, v);
        }
        return { positions: this.positions, normals: this.normals, colors: this.colors, indices: this.indices, minPos: min, maxPos: max };
    }
}

/**
 * A dark pillared hall for the lights to wander through: a tiled floor,
 * walls round it, a grid of columns, and crates, spheres and steel posts
 * scattered between them. One static mesh.
 */
export function buildHall(): primitives.IGeometry {
    const b = new GeometryBuilder();
    const half = FIELD_HALF + 1;
    const tile = 2;
    for (let i = -half; i < half; i += tile) {
        for (let j = -half; j < half; j += tile) {
            const odd = ((i + j) / tile) & 1;
            b.box(odd ? TILE_A : TILE_B, i + tile / 2, -0.1, j + tile / 2, tile - 0.04, 0.1, tile - 0.04);
        }
    }
    b.box(WALL, 0, -0.1, 0, 2 * half, 0.06, 2 * half);
    for (const s of [-1, 1]) {
        b.box(WALL, 0, 0, s * (half + 0.2), 2 * half + 0.8, 4, 0.4);
        b.box(WALL, s * (half + 0.2), 0, 0, 0.4, 4, 2 * half);
    }

    const column = primitives.cylinder(0.32, 0.32, 3.4, { radialSegments: 20, heightSegments: 1 });
    for (let x = -15; x <= 15; x += 5) {
        for (let z = -15; z <= 15; z += 5) {
            b.box(STONE, x, 0, z, 0.9, 0.3, 0.9);
            b.add(column, STONE, new Vec3(x, 2.0, z));
            b.box(STONE, x, 3.7, z, 0.9, 0.25, 0.9);
        }
    }

    const r = rng(3);
    const sphere = primitives.sphere(0.45, { segments: 18 });
    const post = primitives.cylinder(0.12, 0.12, 1.4, { radialSegments: 12, heightSegments: 1 });
    for (let k = 0; k < 60; k++) {
        const x = (r() * 2 - 1) * (half - 1.5);
        const z = (r() * 2 - 1) * (half - 1.5);
        // Keep clear of the columns.
        if (Math.abs(x - Math.round(x / 5) * 5) < 1 && Math.abs(z - Math.round(z / 5) * 5) < 1) continue;
        const kind = k % 4;
        if (kind === 0) {
            const s = 0.6 + r() * 0.6;
            b.box(CRATE, x, 0, z, s, s, s, r() * 90);
            if (r() < 0.5) b.box(CRATE, x, s, z, s * 0.6, s * 0.6, s * 0.6, r() * 90);
        } else if (kind === 1) {
            b.add(sphere, CLAY, new Vec3(x, 0.45, z));
        } else if (kind === 2) {
            b.add(post, METAL, new Vec3(x, 0.7, z));
        } else {
            b.box(STONE, x, 0, z, 2.4, 0.5 + r() * 0.6, 0.35, r() * 180);
        }
    }
    return b.geometry();
}
