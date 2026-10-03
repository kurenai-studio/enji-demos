/**
 * The three static scenes, generated in code: each an object on a ground
 * disc, with linear albedo per vertex. Transfer is stored per vertex, so the
 * meshes are tessellated finely enough to carry soft shadows (about 8 cm on
 * the ground near the object).
 */

export interface SceneGeo {
    name: string;
    positions: Float32Array;
    normals: Float32Array;
    /** Linear RGB albedo per vertex. */
    albedo: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
    /** Camera target height and a radius that frames the object. */
    focusY: number;
    radius: number;
}

type V3 = [number, number, number];

export class Builder {
    private readonly p: number[] = [];
    private readonly n: number[] = [];
    private readonly a: number[] = [];
    private readonly i: number[] = [];

    get count(): number { return this.p.length / 3; }

    vertex(p: V3, n: V3, albedo: V3): number {
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        this.p.push(p[0], p[1], p[2]);
        this.n.push(n[0] / l, n[1] / l, n[2] / l);
        this.a.push(albedo[0], albedo[1], albedo[2]);
        return this.count - 1;
    }

    tri(a: number, b: number, c: number): void { this.i.push(a, b, c); }

    quad(a: number, b: number, c: number, d: number): void { this.tri(a, b, c); this.tri(a, c, d); }

    /**
     * Surface f(u, v) → (point, normal) over u, v in [0, 1], nu × nv quads.
     * Wrapped directions reuse their first row. Counter-clockwise seen from the normal
     * when ∂f/∂u × ∂f/∂v points along it.
     */
    surface(nu: number, nv: number, wrapU: boolean, wrapV: boolean, albedo: V3, f: (u: number, v: number) => [V3, V3]): void {
        const cu = wrapU ? nu : nu + 1, cv = wrapV ? nv : nv + 1;
        const base = this.count;
        for (let j = 0; j < cv; j++) for (let i = 0; i < cu; i++) {
            const [p, n] = f(i / nu, j / nv);
            this.vertex(p, n, albedo);
        }
        const id = (i: number, j: number): number => base + (j % cv) * cu + (i % cu);
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) this.quad(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
    }

    /** Axis-aligned box with every face split into cells of about `step`. */
    box(center: V3, size: V3, step: number, albedo: V3): void {
        for (let axis = 0; axis < 3; axis++) for (const s of [-1, 1]) {
            const u = (axis + 1) % 3, v = (axis + 2) % 3;
            const nu = Math.max(1, Math.ceil(size[u] / step)), nv = Math.max(1, Math.ceil(size[v] / step));
            const n: V3 = [0, 0, 0];
            n[axis] = s;
            // u × v = +axis: flip u on the negative face to stay counter-clockwise.
            this.surface(nu, nv, false, false, albedo, (a, b) => {
                const p: V3 = [...center];
                p[axis] += (s * size[axis]) / 2;
                p[u] += (s > 0 ? a - 0.5 : 0.5 - a) * size[u];
                p[v] += (b - 0.5) * size[v];
                return [p, n];
            });
        }
    }

    /** Capped vertical cylinder from y0 to y1. */
    cylinder(cx: number, cz: number, r: number, y0: number, y1: number, segments: number, rings: number, albedo: V3): void {
        this.surface(segments, rings, true, false, albedo, (u, v) => {
            const a = -u * Math.PI * 2;
            const c = Math.cos(a), s = Math.sin(a);
            return [[cx + r * c, y0 + (y1 - y0) * v, cz + r * s], [c, 0, s]];
        });
        for (const [y, ny] of [[y1, 1], [y0, -1]] as const) {
            const centre = this.vertex([cx, y, cz], [0, ny, 0], albedo);
            const first = this.count;
            for (let i = 0; i < segments; i++) {
                const a = (i / segments) * Math.PI * 2;
                this.vertex([cx + r * Math.cos(a), y, cz + r * Math.sin(a)], [0, ny, 0], albedo);
            }
            for (let i = 0; i < segments; i++) {
                const a = first + i, b = first + ((i + 1) % segments);
                if (ny > 0) this.tri(centre, b, a); else this.tri(centre, a, b);
            }
        }
    }

    /** Torus of radii R, r about the unit axis, centred at c. */
    torus(c: V3, axis: V3, R: number, r: number, nu: number, nv: number, albedo: V3): void {
        const [t, b] = perpendiculars(axis);
        this.surface(nu, nv, true, true, albedo, (u, v) => {
            const a = u * Math.PI * 2, w = v * Math.PI * 2;
            const radial = add(scale(t, Math.cos(a)), scale(b, Math.sin(a)));
            const n = add(scale(radial, Math.cos(w)), scale(axis, Math.sin(w)));
            return [add(c, add(scale(radial, R), scale(n, r))), n];
        });
    }

    sphere(c: V3, r: number, nu: number, nv: number, albedo: V3): void {
        // Poles are degenerate rows of the surface; harmless for the rays.
        this.surface(nu, nv, true, false, albedo, (u, v) => {
            const phi = -u * Math.PI * 2, theta = (1 - v) * Math.PI;
            const n: V3 = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
            return [add(c, scale(n, r)), n];
        });
    }

    /** Ground disc of radius R at y = 0, rings packed towards the centre. */
    ground(R: number, rings: number, segments: number, albedo: V3): void {
        const centre = this.vertex([0, 0, 0], [0, 1, 0], albedo);
        const first = this.count;
        for (let i = 1; i <= rings; i++) {
            const r = R * Math.pow(i / rings, 1.6);
            for (let s = 0; s < segments; s++) {
                const a = ((s + (i % 2) * 0.5) / segments) * Math.PI * 2;
                this.vertex([r * Math.cos(a), 0, r * Math.sin(a)], [0, 1, 0], albedo);
            }
        }
        const id = (ring: number, s: number): number => first + (ring - 1) * segments + (((s % segments) + segments) % segments);
        for (let s = 0; s < segments; s++) this.tri(centre, id(1, s + 1), id(1, s));
        for (let i = 1; i < rings; i++) for (let s = 0; s < segments; s++) {
            // Odd rings are rotated half a segment: alternate the diagonal to follow it.
            if (i % 2) this.quad(id(i, s), id(i, s + 1), id(i + 1, s + 1), id(i + 1, s));
            else this.quad(id(i, s), id(i, s + 1), id(i + 1, s), id(i + 1, s - 1));
        }
    }

    finish(name: string, focusY: number, radius: number): SceneGeo {
        if (this.count > 65535) throw new Error(`${name}: ${this.count} vertices exceed 16-bit indices`);
        return {
            name, focusY, radius,
            positions: Float32Array.from(this.p), normals: Float32Array.from(this.n), albedo: Float32Array.from(this.a),
            indices: Uint32Array.from(this.i), vertexCount: this.count,
        };
    }
}

function add(a: V3, b: V3): V3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a: V3, s: number): V3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: V3): V3 { return scale(a, 1 / Math.hypot(a[0], a[1], a[2])); }
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** Two unit vectors completing a right-handed frame (t, b, axis). */
function perpendiculars(axis: V3): [V3, V3] {
    const helper: V3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const t = norm(cross(helper, axis));
    return [t, cross(axis, t)];
}

function rotateX(p: V3, a: number): V3 {
    const c = Math.cos(a), s = Math.sin(a);
    return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]];
}

export const GROUND: V3 = [0.22, 0.32, 0.15];
const GROUND_RADIUS = 4.5;

/** (2, 3) torus knot, tilted, resting on the ground. */
export function knotScene(): SceneGeo {
    const g = new Builder();
    const P = 2, Q = 3, SEG = 420, SIDES = 28, TUBE = 0.2, SCALE = 0.42, TILT = 0.6;
    const curve = (t: number): V3 => {
        const a = t * Math.PI * 2, w = 2 + Math.cos(Q * a);
        return rotateX([w * Math.cos(P * a) * SCALE, w * Math.sin(P * a) * SCALE, -Math.sin(Q * a) * SCALE], TILT);
    };
    // Parallel-transported frame with the closing twist spread along the loop.
    const pts: V3[] = [], tans: V3[] = [];
    for (let i = 0; i < SEG; i++) pts.push(curve(i / SEG));
    for (let i = 0; i < SEG; i++) tans.push(norm(add(pts[(i + 1) % SEG], scale(pts[(i - 1 + SEG) % SEG], -1))));
    const normals: V3[] = [perpendiculars(tans[0])[0]];
    for (let i = 1; i <= SEG; i++) {
        const t = tans[i % SEG], prev = normals[i - 1];
        normals.push(norm(add(prev, scale(t, -dot(prev, t)))));
    }
    const end = normals[SEG], startB = cross(tans[0], normals[0]);
    const twist = Math.atan2(dot(end, startB), dot(end, normals[0]));
    let minY = Infinity;
    for (const p of pts) minY = Math.min(minY, p[1] - TUBE);
    const lift = -minY;
    g.surface(SEG, SIDES, true, true, [0.75, 0.2, 0.08], (u, v) => {
        const i = Math.round(u * SEG) % SEG;
        const t = tans[i];
        const n0 = normals[i], b0 = cross(t, n0);
        // Clockwise about the tangent keeps the triangles facing out.
        const ang = -v * Math.PI * 2 - twist * u;
        const nn = add(scale(n0, Math.cos(ang)), scale(b0, Math.sin(ang)));
        const p = add(pts[i], scale(nn, TUBE));
        return [[p[0], p[1] + lift, p[2]], nn];
    });
    g.ground(GROUND_RADIUS, 56, 180, GROUND);
    return g.finish('Knot', 0.9, 2.2);
}

/** Two rows of columns under a roof slab on a stepped base. */
export function colonnadeScene(): SceneGeo {
    const g = new Builder();
    const MARBLE: V3 = [0.7, 0.68, 0.64];
    const STEP = 0.1;
    g.box([0, 0.08, 0], [3.4, 0.16, 1.8], STEP, MARBLE);
    g.box([0, 1.66, 0], [3.5, 0.2, 1.9], STEP, MARBLE);
    for (let i = 0; i < 5; i++) for (const z of [-0.65, 0.65]) {
        g.cylinder(-1.4 + i * 0.7, z, 0.12, 0.16, 1.56, 20, 14, MARBLE);
    }
    g.ground(GROUND_RADIUS, 56, 180, GROUND);
    return g.finish('Colonnade', 0.8, 2.4);
}

/** Armillary sphere: thin rings around a ball, on a stand. */
export function armillaryScene(): SceneGeo {
    const g = new Builder();
    const BRASS: V3 = [0.7, 0.48, 0.18];
    const C: V3 = [0, 1.25, 0];
    const tilt = 0.41;
    const axes: V3[] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], norm([Math.sin(tilt), Math.cos(tilt), 0]), norm([0, Math.cos(1.1), Math.sin(1.1)])];
    axes.forEach((a, i) => g.torus(C, a, 0.95 - i * 0.004, 0.035, 140, 10, BRASS));
    g.sphere(C, 0.38, 64, 32, [0.7, 0.72, 0.75]);
    g.cylinder(0, 0, 0.05, 0.12, C[1] - 0.95, 14, 10, BRASS);
    g.cylinder(0, 0, 0.45, 0, 0.12, 48, 2, BRASS);
    g.ground(GROUND_RADIUS, 56, 180, GROUND);
    return g.finish('Armillary', 1.1, 2.2);
}

export const SCENES = [knotScene, colonnadeScene, armillaryScene];
