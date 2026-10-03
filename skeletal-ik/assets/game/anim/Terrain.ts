import type { Vec } from './Math3';

/** Smooth rolling ground: a few sines, up to about ±0.2 m, plus a flat patch at the centre. */
export function terrainHeight(x: number, z: number, amplitude = 1): number {
    const r = Math.hypot(x, z);
    const flat = Math.min(1, Math.max(0, (r - 1.2) / 1.0));
    const h = 0.11 * Math.sin(0.9 * x + 0.4) * Math.cos(0.75 * z - 0.3)
        + 0.06 * Math.sin(1.9 * x - 1.3 * z + 1.1)
        + 0.04 * Math.cos(2.7 * z + 0.8 * x);
    return amplitude * flat * flat * (3 - 2 * flat) * h;
}

/** Unit normal by central differences. */
export function terrainNormal(x: number, z: number, out: Vec, amplitude = 1): Vec {
    const e = 0.01;
    const dx = (terrainHeight(x + e, z, amplitude) - terrainHeight(x - e, z, amplitude)) / (2 * e);
    const dz = (terrainHeight(x, z + e, amplitude) - terrainHeight(x, z - e, amplitude)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    out.x = -dx / l;
    out.y = 1 / l;
    out.z = -dz / l;
    return out;
}

/** Grid mesh over [−half, half]² with a 1 m checker tint, lighter on the crests. */
export function buildTerrain(half: number, cells: number, amplitude = 1): { positions: number[]; normals: number[]; colors: number[]; indices: number[] } {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const n = { x: 0, y: 1, z: 0 };
    for (let j = 0; j <= cells; j++) {
        for (let i = 0; i <= cells; i++) {
            const x = -half + (2 * half * i) / cells;
            const z = -half + (2 * half * j) / cells;
            const y = terrainHeight(x, z, amplitude);
            positions.push(x, y, z);
            terrainNormal(x, z, n, amplitude);
            normals.push(n.x, n.y, n.z);
            const checker = (Math.floor(x + 100) + Math.floor(z + 100)) % 2 === 0 ? 1 : 0.92;
            const shade = 0.75 + 2.2 * y;
            colors.push(0.42 * checker * shade, 0.5 * checker * shade, 0.36 * checker * shade, 1);
        }
    }
    for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
            const a = j * (cells + 1) + i;
            const b = a + 1;
            const c = a + cells + 1;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    return { positions, normals, colors, indices };
}
