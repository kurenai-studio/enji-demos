/** Triangle meshes for the soft bodies and obstacles. Triangles are counter-clockwise. */
export interface Shape {
    /** x, y pairs. */
    positions: number[];
    triangles: number[];
}

export function rectShape(cx: number, cy: number, w: number, h: number, nx: number, ny: number, angle = 0): Shape {
    const positions: number[] = [];
    const triangles: number[] = [];
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    for (let j = 0; j <= ny; j++) {
        for (let i = 0; i <= nx; i++) {
            const lx = (i / nx - 0.5) * w;
            const ly = (j / ny - 0.5) * h;
            positions.push(cx + c * lx - s * ly, cy + s * lx + c * ly);
        }
    }
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const a = j * (nx + 1) + i;
            const b = a + 1;
            const d = a + nx + 1;
            const e = d + 1;
            // Alternate diagonals so the mesh has no preferred shear direction.
            if ((i + j) % 2 === 0) triangles.push(a, b, e, a, e, d);
            else triangles.push(a, b, d, b, e, d);
        }
    }
    return orient({ positions, triangles });
}

/** Disk from concentric rings: ring k has `6k` vertices. */
export function diskShape(cx: number, cy: number, r: number, rings: number): Shape {
    const positions: number[] = [cx, cy];
    const triangles: number[] = [];
    let prevStart = 0;
    let prevCount = 1;
    for (let k = 1; k <= rings; k++) {
        const count = 6 * k;
        const start = positions.length / 2;
        const radius = (r * k) / rings;
        // A half-step twist per ring keeps the triangles closer to equilateral.
        const twist = (k % 2) * (Math.PI / count);
        for (let i = 0; i < count; i++) {
            const a = (2 * Math.PI * i) / count + twist;
            positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
        }
        zipRings(positions, triangles, prevStart, prevCount, start, count);
        prevStart = start;
        prevCount = count;
    }
    return orient({ positions, triangles });
}

/**
 * Ring sector between radii r0 < r1 and angles a0 < a1 (a full ring when the
 * span is 2π), `rings` cells across and `segments` along.
 */
export function arcShape(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, rings: number, segments: number): Shape {
    const closed = Math.abs(a1 - a0 - 2 * Math.PI) < 1e-9;
    const columns = closed ? segments : segments + 1;
    const positions: number[] = [];
    const triangles: number[] = [];
    for (let j = 0; j <= rings; j++) {
        const r = r0 + ((r1 - r0) * j) / rings;
        for (let i = 0; i < columns; i++) {
            const a = a0 + ((a1 - a0) * i) / segments;
            positions.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
        }
    }
    for (let j = 0; j < rings; j++) {
        for (let i = 0; i < segments; i++) {
            const i1 = closed ? (i + 1) % columns : i + 1;
            const a = j * columns + i;
            const b = j * columns + i1;
            const d = (j + 1) * columns + i;
            const e = (j + 1) * columns + i1;
            if ((i + j) % 2 === 0) triangles.push(a, b, e, a, e, d);
            else triangles.push(a, b, d, b, e, d);
        }
    }
    return orient({ positions, triangles });
}

/** Convex polygon fanned from its first vertex (for static obstacles). */
export function polygonShape(points: number[]): Shape {
    const triangles: number[] = [];
    const n = points.length / 2;
    for (let i = 1; i < n - 1; i++) triangles.push(0, i, i + 1);
    return orient({ positions: points.slice(), triangles });
}

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
    const positions = shape.positions.slice();
    for (let i = 0; i < positions.length; i += 2) {
        positions[i] += dx;
        positions[i + 1] += dy;
    }
    return { positions, triangles: shape.triangles.slice() };
}

/** Flips clockwise triangles. */
export function orient(shape: Shape): Shape {
    const p = shape.positions;
    const t = shape.triangles;
    for (let i = 0; i < t.length; i += 3) {
        const a = t[i];
        const b = t[i + 1];
        const c = t[i + 2];
        const area = (p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a]);
        if (area < 0) {
            t[i + 1] = c;
            t[i + 2] = b;
        }
    }
    return shape;
}

/** Edges used by exactly one triangle, oriented as in that triangle. */
export function boundaryEdges(triangles: number[]): number[] {
    const count = new Map<number, number>();
    const key = (a: number, b: number) => (a < b ? a * 1048576 + b : b * 1048576 + a);
    for (let i = 0; i < triangles.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const id = key(triangles[i + k], triangles[i + ((k + 1) % 3)]);
            count.set(id, (count.get(id) ?? 0) + 1);
        }
    }
    const edges: number[] = [];
    for (let i = 0; i < triangles.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const a = triangles[i + k];
            const b = triangles[i + ((k + 1) % 3)];
            if (count.get(key(a, b)) === 1) edges.push(a, b);
        }
    }
    return edges;
}

/** Triangulates the band between two concentric rings by walking both in angle order. */
function zipRings(positions: number[], triangles: number[], s0: number, n0: number, s1: number, n1: number): void {
    if (n0 === 1) {
        for (let i = 0; i < n1; i++) triangles.push(s0, s1 + i, s1 + ((i + 1) % n1));
        return;
    }
    const cx = positions[0];
    const cy = positions[1];
    const angle = (v: number) => {
        const a = Math.atan2(positions[2 * v + 1] - cy, positions[2 * v] - cx);
        return a < 0 ? a + 2 * Math.PI : a;
    };
    // Unwrapped angles of both rings, each starting at its own first vertex.
    const unwrap = (start: number, n: number) => {
        const out: number[] = [];
        let prev = -Infinity;
        for (let i = 0; i <= n; i++) {
            let a = angle(start + (i % n));
            while (a <= prev) a += 2 * Math.PI;
            out.push(a);
            prev = a;
        }
        return out;
    };
    const A = unwrap(s0, n0);
    const B = unwrap(s1, n1);
    // Align ring 1 so it starts within one step of ring 0.
    while (B[0] > A[0] + 1e-9) for (let i = 0; i < B.length; i++) B[i] -= 2 * Math.PI;
    let i = 0;
    let j = 0;
    while (i < n0 || j < n1) {
        const a0 = s0 + (i % n0);
        const b0 = s1 + (j % n1);
        const advanceA = j >= n1 || (i < n0 && A[i + 1] <= B[j + 1]);
        if (advanceA) {
            triangles.push(a0, b0, s0 + ((i + 1) % n0));
            i++;
        } else {
            triangles.push(a0, b0, s1 + ((j + 1) % n1));
            j++;
        }
    }
}
