import { gfx, Mat4, MeshRenderer, Node, Vec3 } from 'cc';

export interface SkinHit {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    dist: number;
}

interface Solid {
    node: Node;
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    pos: Float32Array;
    idx: Uint32Array;
    tris: number;
}

const scratch = new Mat4();
const corner = new Vec3();

/**
 * Triangle hits for harbor meshes small enough to test per shot.
 * The walk grid still covers the big merged chunks.
 */
export class Surface {
    private readonly solids: Solid[] = [];

    static collect(root: Node): Surface {
        const surface = new Surface();
        for (const mesh of root.getComponentsInChildren(MeshRenderer)) {
            const solid = bakeSolid(mesh);
            if (solid) surface.solids.push(solid);
        }
        console.log('[saltline-enji] hit surfaces', surface.solids.length);
        return surface;
    }

    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): SkinHit | null {
        const hits: { solid: Solid; t: number }[] = [];
        for (const solid of this.solids) {
            const t = rayBox(ox, oy, oz, dx, dy, dz, solid.minX, solid.minY, solid.minZ, solid.maxX, solid.maxY, solid.maxZ);
            if (t >= 0 && t < maxDist) hits.push({ solid, t });
        }
        hits.sort((a, b) => a.t - b.t);
        let best = maxDist;
        let found: SkinHit | null = null;
        const limit = Math.min(hits.length, 5);
        for (let i = 0; i < limit; i++) {
            if (hits[i].t > best) break;
            const hit = meshHit(hits[i].solid, ox, oy, oz, dx, dy, dz, best);
            if (hit && hit.dist < best) {
                best = hit.dist;
                found = hit;
            }
        }
        return found;
    }
}

function bakeSolid(mesh: MeshRenderer): Solid | null {
    const data = mesh.mesh;
    const node = mesh.node;
    if (!data) return null;
    const label = `${mesh.getSharedMaterial(0)?.name ?? ''} ${node.name}`;
    if (/water|sea|decal|glass|rain|label|rope/i.test(label)) return null;
    const struct = data.struct;
    const min = struct.minPosition;
    const max = struct.maxPosition;
    if (!min || !max || struct.primitives.length === 0) return null;
    node.updateWorldTransform();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const xs = [min.x, max.x];
    const ys = [min.y, max.y];
    const zs = [min.z, max.z];
    for (const x of xs) {
        for (const y of ys) {
            for (const z of zs) {
                Vec3.set(corner, x, y, z);
                Vec3.transformMat4(corner, corner, node.worldMatrix);
                minX = Math.min(minX, corner.x);
                minY = Math.min(minY, corner.y);
                minZ = Math.min(minZ, corner.z);
                maxX = Math.max(maxX, corner.x);
                maxY = Math.max(maxY, corner.y);
                maxZ = Math.max(maxZ, corner.z);
            }
        }
    }
    if (maxX - minX > 28 || maxY - minY > 28 || maxZ - minZ > 28) return null;
    const positions: number[] = [];
    const indices: number[] = [];
    let base = 0;
    let indexCount = 0;
    for (let p = 0; p < struct.primitives.length; p++) {
        const ind = data.readIndices(p);
        if (!ind) return null;
        indexCount += ind.length;
        if (indexCount > 4500 * 3) return null;
        const pos = data.readAttribute(p, gfx.AttributeName.ATTR_POSITION);
        if (!pos) return null;
        for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
        for (let i = 0; i < ind.length; i++) indices.push(ind[i] + base);
        base += pos.length / 3;
    }
    const tris = Math.floor(indices.length / 3);
    if (tris < 1) return null;
    return {
        node,
        minX, minY, minZ, maxX, maxY, maxZ,
        pos: Float32Array.from(positions),
        idx: Uint32Array.from(indices),
        tris,
    };
}

function meshHit(solid: Solid, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): SkinHit | null {
    if (!Mat4.invert(scratch, solid.node.worldMatrix)) return null;
    const o = mulPoint(scratch, ox, oy, oz);
    const d = mulVector(scratch, dx, dy, dz);
    let best = maxDist;
    let tri = -1;
    const pos = solid.pos;
    const idx = solid.idx;
    for (let t = 0; t < solid.tris; t++) {
        const a = idx[t * 3] * 3;
        const b = idx[t * 3 + 1] * 3;
        const c = idx[t * 3 + 2] * 3;
        const hit = rayTri(
            o.x, o.y, o.z, d.x, d.y, d.z,
            pos[a], pos[a + 1], pos[a + 2],
            pos[b], pos[b + 1], pos[b + 2],
            pos[c], pos[c + 1], pos[c + 2],
        );
        if (hit >= 0 && hit < best) {
            best = hit;
            tri = t;
        }
    }
    if (tri < 0) return null;
    const wm = solid.node.worldMatrix;
    const a = idx[tri * 3] * 3;
    const b = idx[tri * 3 + 1] * 3;
    const c = idx[tri * 3 + 2] * 3;
    const pa = mulPoint(wm, pos[a], pos[a + 1], pos[a + 2]);
    const pb = mulPoint(wm, pos[b], pos[b + 1], pos[b + 2]);
    const pc = mulPoint(wm, pos[c], pos[c + 1], pos[c + 2]);
    const e1x = pb.x - pa.x;
    const e1y = pb.y - pa.y;
    const e1z = pb.z - pa.z;
    const e2x = pc.x - pa.x;
    const e2y = pc.y - pa.y;
    const e2z = pc.z - pa.z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
    if (nx * dx + ny * dy + nz * dz > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
    }
    return {
        x: ox + dx * best,
        y: oy + dy * best,
        z: oz + dz * best,
        nx, ny, nz,
        dist: best,
    };
}

function mulPoint(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number } {
    const w = m.m03 * x + m.m07 * y + m.m11 * z + m.m15;
    const inv = w !== 0 ? 1 / w : 1;
    return {
        x: (m.m00 * x + m.m04 * y + m.m08 * z + m.m12) * inv,
        y: (m.m01 * x + m.m05 * y + m.m09 * z + m.m13) * inv,
        z: (m.m02 * x + m.m06 * y + m.m10 * z + m.m14) * inv,
    };
}

function mulVector(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number } {
    return {
        x: m.m00 * x + m.m04 * y + m.m08 * z,
        y: m.m01 * x + m.m05 * y + m.m09 * z,
        z: m.m02 * x + m.m06 * y + m.m10 * z,
    };
}

function rayBox(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
): number {
    let tMin = 0;
    let tMax = 1e9;
    const slab = (o: number, d: number, min: number, max: number): boolean => {
        if (Math.abs(d) < 1e-8) return o >= min && o <= max;
        let t1 = (min - o) / d;
        let t2 = (max - o) / d;
        if (t1 > t2) {
            const swap = t1;
            t1 = t2;
            t2 = swap;
        }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        return tMin <= tMax;
    };
    if (!slab(ox, dx, minX, maxX) || !slab(oy, dy, minY, maxY) || !slab(oz, dz, minZ, maxZ)) return -1;
    if (tMax < 0) return -1;
    return tMin >= 0 ? tMin : 0;
}

function rayTri(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
): number {
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-7 && det < 1e-7) return -1;
    const inv = 1 / det;
    const sx = ox - ax;
    const sy = oy - ay;
    const sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 1e-4 ? t : -1;
}
