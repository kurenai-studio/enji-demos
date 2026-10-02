/**
 * Geometry of the static room with its light baked into vertex attributes
 * (no engine imports): `colors` holds indirect radiance, `direct` the direct
 * radiance plus the light panel's emission, so the shader can toggle each and
 * let the moving sphere shadow only the direct part. Faces are resampled from
 * the bake grid, finer on the floor where the spheres' contact shading lands;
 * occlusion by the fixed spheres is applied here once.
 */
import type { Baked } from './Baked';
import { type Sphere, sphereLightBlock, sphereOcclusion } from './Occlusion';
import { LIGHT_RADIANCE, QUADS, quadPoint, type V3 } from './Room';

export interface RoomGeometry {
    positions: Float32Array;
    normals: Float32Array;
    /** RGBA, alpha 1. */
    colors: Float32Array;
    direct: Float32Array;
    indices: Uint32Array;
    vertexCount: number;
}

/** Render grid cells per bake cell. */
const REFINE: Record<string, number> = { floor: 3 };
const DEFAULT_REFINE = 2;

/** Whether sphere s reaches into the cone from p to the light disc (else it cannot block any of it). */
function inLightCone(p: V3, light: { center: V3; radius: number }, s: Sphere): boolean {
    const lx = light.center[0] - p[0], ly = light.center[1] - p[1], lz = light.center[2] - p[2];
    const dl = Math.hypot(lx, ly, lz);
    const sx = s.x - p[0], sy = s.y - p[1], sz = s.z - p[2];
    const t = (sx * lx + sy * ly + sz * lz) / dl;
    if (t < -s.r || t > dl + s.r) return false;
    const perp2 = sx * sx + sy * sy + sz * sz - t * t;
    const reach = s.r + (light.radius * Math.max(t, 0)) / dl;
    return perp2 < reach * reach;
}

export function buildRoomGeometry(baked: Baked, spheres: readonly Sphere[], light: { center: V3; radius: number }): RoomGeometry {
    const grids = QUADS.map((q) => {
        const k = REFINE[q.name] ?? DEFAULT_REFINE;
        return { nu: q.nu * k, nv: q.nv * k };
    });
    const vertexCount = grids.reduce((s, g) => s + (g.nu + 1) * (g.nv + 1), 0);
    const indexCount = grids.reduce((s, g) => s + g.nu * g.nv * 6, 0);
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 4);
    const direct = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    const e: V3 = [0, 0, 0];
    let v = 0;
    let t = 0;
    QUADS.forEach((q, f) => {
        const { nu, nv } = grids[f];
        const first = v;
        const isLight = q.emission[0] > 0;
        for (let j = 0; j <= nv; j++) {
            for (let i = 0; i <= nu; i++) {
                const a = i / nu, b = j / nv;
                const p = quadPoint(q, a, b);
                const d = baked.sample(f, a, b, e);
                let ao = 1, lit = 1;
                if (!isLight) {
                    for (const s of spheres) {
                        const sx = s.x - p[0], sy = s.y - p[1], sz = s.z - p[2];
                        if (sx * sx + sy * sy + sz * sz < 64 * s.r * s.r) ao *= 1 - sphereOcclusion(p, q.normal, s);
                        if (inLightCone(p, light, s)) lit *= 1 - sphereLightBlock(p, light.center, light.radius, s);
                    }
                }
                positions.set(p, v * 3);
                normals.set(q.normal, v * 3);
                for (let c = 0; c < 3; c++) {
                    colors[v * 4 + c] = (q.albedo[c] * e[c] * ao) / Math.PI;
                    direct[v * 3 + c] = (q.albedo[c] * d * LIGHT_RADIANCE[c] * lit) / Math.PI + q.emission[c];
                }
                colors[v * 4 + 3] = 1;
                v++;
            }
        }
        // Counter-clockwise seen from the normal side (normal = u × v).
        const row = nu + 1;
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                const k = first + j * row + i;
                indices[t++] = k;
                indices[t++] = k + 1;
                indices[t++] = k + row + 1;
                indices[t++] = k;
                indices[t++] = k + row + 1;
                indices[t++] = k + row;
            }
        }
    });
    return { positions, normals, colors, direct, indices, vertexCount };
}
