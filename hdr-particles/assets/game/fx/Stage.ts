import { gfx, Mesh, utils, Vec3 } from 'cc';

const LIT = 0;
const EMISSIVE = 1;
const COALS = 2;
const SKY = 3;

/** Point lights of the stage: the two lamps (the scenes add their own after them). */
export const LAMPS: readonly { pos: readonly [number, number, number]; color: readonly [number, number, number] }[] = [
    { pos: [-4.5, 1.45, -3], color: [1, 0.72, 0.42] },
    { pos: [4.5, 1.45, -3], color: [0.45, 0.65, 1] },
];
/** Lamp light in watts-ish (irradiance = intensity / d²), and the radiance of the bulbs. */
export const LAMP_INTENSITY = 6;
const BULB_RADIANCE = 30;
export const FIRE_POS = [0, 1.0, 0] as const;
export const NOZZLE_POS = [0, 0.6, 0] as const;

/** Positions, normals and a per-vertex surface (rgb albedo or radiance, w kind) for hp-stage.effect. */
class Geometry {
    readonly positions: number[] = [];
    readonly normals: number[] = [];
    readonly surface: number[] = [];
    readonly indices: number[] = [];

    vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, s: readonly number[]): number {
        this.positions.push(x, y, z);
        this.normals.push(nx, ny, nz);
        this.surface.push(s[0], s[1], s[2], s[3]);
        return this.positions.length / 3 - 1;
    }

    /** Horizontal disc facing up at height y. */
    disc(cx: number, y: number, cz: number, r: number, segments: number, s: readonly number[]): void {
        const c = this.vertex(cx, y, cz, 0, 1, 0, s);
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            this.vertex(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, 1, 0, s);
        }
        for (let i = 0; i < segments; i++) this.indices.push(c, c + 2 + i, c + 1 + i);
    }

    /** Open cylinder side from y0 to y1. */
    tube(cx: number, cz: number, r: number, y0: number, y1: number, segments: number, s: readonly number[]): void {
        const start = this.positions.length / 3;
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            const nx = Math.cos(a), nz = Math.sin(a);
            this.vertex(cx + nx * r, y0, cz + nz * r, nx, 0, nz, s);
            this.vertex(cx + nx * r, y1, cz + nz * r, nx, 0, nz, s);
        }
        for (let i = 0; i < segments; i++) {
            const a = start + i * 2;
            this.indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
    }

    sphere(cx: number, cy: number, cz: number, r: number, rings: number, segments: number, s: readonly number[]): void {
        const start = this.positions.length / 3;
        for (let j = 0; j <= rings; j++) {
            const th = (j / rings) * Math.PI;
            for (let i = 0; i <= segments; i++) {
                const ph = (i / segments) * Math.PI * 2;
                const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
                this.vertex(cx + nx * r, cy + ny * r, cz + nz * r, nx, ny, nz, s);
            }
        }
        for (let j = 0; j < rings; j++) {
            for (let i = 0; i < segments; i++) {
                const a = start + j * (segments + 1) + i, b = a + segments + 1;
                this.indices.push(a, a + 1, b + 1, a, b + 1, b);
            }
        }
    }

    /** Axis-aligned box centred at (cx, cy, cz). */
    box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, s: readonly number[]): void {
        const faces: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        for (const [nx, ny, nz] of faces) {
            const u = ny !== 0 ? [1, 0, 0] : [0, 1, 0];
            const w = [ny * u[2] - nz * u[1], nz * u[0] - nx * u[2], nx * u[1] - ny * u[0]];
            const start = this.positions.length / 3;
            for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                this.vertex(
                    cx + (nx + u[0] * a + w[0] * b) * hx, cy + (ny + u[1] * a + w[1] * b) * hy, cz + (nz + u[2] * a + w[2] * b) * hz,
                    nx, ny, nz, s,
                );
            }
            this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        }
    }

    mesh(): Mesh {
        return utils.MeshUtils.createMesh({
            positions: this.positions,
            normals: this.normals,
            indices: this.indices,
            minPos: new Vec3(-100, -100, -100),
            maxPos: new Vec3(100, 100, 100),
            customAttributes: [{ attr: new gfx.Attribute('a_surface', gfx.Format.RGBA32F), values: this.surface }],
        });
    }
}

/** Sky dome: only in the stage camera (it hides no particle). */
export function buildSky(): Mesh {
    const g = new Geometry();
    g.sphere(0, 0, 0, 90, 12, 24, [0, 0, 0, SKY]);
    return g.mesh();
}

/** Ground and the two lamps: in every scene. */
export function buildGround(): Mesh {
    const g = new Geometry();
    g.disc(0, 0, 0, 40, 64, [0.32, 0.3, 0.28, LIT]);
    for (const lamp of LAMPS) {
        const [x, y, z] = lamp.pos;
        g.box(x, (y - 0.15) / 2, z, 0.04, (y - 0.15) / 2, 0.04, [0.12, 0.12, 0.12, LIT]);
        g.sphere(x, y, z, 0.13, 8, 16, [lamp.color[0] * BULB_RADIANCE, lamp.color[1] * BULB_RADIANCE, lamp.color[2] * BULB_RADIANCE, EMISSIVE]);
    }
    return g.mesh();
}

/** Fire bowl for the embers: dark iron sides, glowing coals on top. */
export function buildBowl(): Mesh {
    const g = new Geometry();
    g.tube(0, 0, 0.75, 0, 0.55, 32, [0.06, 0.055, 0.05, LIT]);
    g.disc(0, 0.5, 0, 0.7, 32, [1, 0.3, 0.05, COALS]);
    return g.mesh();
}

/** Nozzle of the spark fountain: a stub with a hot mouth. */
export function buildNozzle(): Mesh {
    const g = new Geometry();
    g.tube(0, 0, 0.22, 0, 0.3, 24, [0.15, 0.14, 0.13, LIT]);
    g.disc(0, 0.3, 0, 0.22, 24, [0.15, 0.14, 0.13, LIT]);
    g.disc(0, 0.302, 0, 0.06, 12, [6, 4, 1.5, EMISSIVE]);
    return g.mesh();
}
