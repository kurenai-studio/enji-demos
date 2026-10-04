/**
 * Builds a closed snow surface from particles every frame (from pbf-water):
 *   1. splat a smooth kernel (1 - d^2/r^2)^3 of every particle onto a 3D node grid
 *      (only nodes inside the tray, so the surface closes exactly on the walls)
 *   2. extract the iso-surface with Naive Surface Nets (a marching-cubes-family dual
 *      method: one vertex per crossing cell, one quad per crossing grid edge)
 *   3. per-vertex normals from the analytic gradient of the trilinear field
 *
 * Sleeping snow does not move, so its splats live in `base`, updated one
 * particle at a time when it falls asleep or wakes; each frame starts from
 * `base` and splats only the awake particles.
 *
 * Output goes into preallocated typed arrays sized for a dynamic Mesh.
 */
const CORNER_OFFSETS: number[] = [];
const EDGES: number[] = [];
for (let c = 0; c < 8; c++) CORNER_OFFSETS.push(c & 1, (c >> 1) & 1, (c >> 2) & 1);
for (let c = 0; c < 8; c++) {
    for (const bit of [1, 2, 4]) if (!(c & bit)) EDGES.push(c, c | bit);
}

export class SurfaceMesher {
    readonly cell: number;
    readonly radius: number;
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly ox: number;
    readonly oy: number;
    readonly oz: number;
    iso = 0.55;

    readonly maxVertices: number;
    readonly maxIndices: number;
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    vertexCount = 0;
    indexCount = 0;

    private readonly field: Float32Array;
    private readonly scratch: Float32Array;
    private readonly cellVertex: Int32Array;
    private readonly corner = new Float32Array(8);
    private readonly nodeStride: [number, number, number];
    private readonly cornerNodeOffset = new Int32Array(8);

    constructor(min: [number, number, number], max: [number, number, number], cell: number, radius: number, maxVertices = 30000) {
        this.cell = cell;
        this.radius = radius;
        const pad = cell * 2;
        this.ox = min[0] - pad;
        this.oy = min[1] - pad;
        this.oz = min[2] - pad;
        this.nx = Math.ceil((max[0] - min[0] + 2 * pad) / cell);
        this.ny = Math.ceil((max[1] - min[1] + 2 * pad) / cell);
        this.nz = Math.ceil((max[2] - min[2] + 2 * pad) / cell);
        const nodes = (this.nx + 1) * (this.ny + 1) * (this.nz + 1);
        this.field = new Float32Array(nodes);
        this.scratch = new Float32Array(nodes);
        this.cellVertex = new Int32Array(this.nx * this.ny * this.nz);
        this.nodeStride = [1, this.nx + 1, (this.nx + 1) * (this.ny + 1)];
        for (let c = 0; c < 8; c++) {
            this.cornerNodeOffset[c] =
                CORNER_OFFSETS[c * 3] * this.nodeStride[0] +
                CORNER_OFFSETS[c * 3 + 1] * this.nodeStride[1] +
                CORNER_OFFSETS[c * 3 + 2] * this.nodeStride[2];
        }
        this.maxVertices = maxVertices;
        this.maxIndices = maxVertices * 6;
        this.positions = new Float32Array(maxVertices * 3);
        this.normals = new Float32Array(maxVertices * 3);
        this.indices = new Uint32Array(this.maxIndices);
    }

    get resolution(): string {
        return `${this.nx}x${this.ny}x${this.nz}`;
    }

    private base: Float32Array | null = null;
    private clip = [0, 0, 0, 0, 0, 0];

    /** Nodes outside the box [x0,x1]×[y0,y1]×[z0,z1] (the tray interior) stay empty. */
    setClip(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
        const inv = 1 / this.cell;
        this.clip = [
            Math.max(0, Math.ceil((x0 - this.ox) * inv)), Math.min(this.nx, Math.floor((x1 - this.ox) * inv)),
            Math.max(0, Math.ceil((y0 - this.oy) * inv)), Math.min(this.ny, Math.floor((y1 - this.oy) * inv)),
            Math.max(0, Math.ceil((z0 - this.oz) * inv)), Math.min(this.nz, Math.floor((z1 - this.oz) * inv)),
        ];
    }

    resetBase(): void {
        if (!this.base) this.base = new Float32Array(this.field.length);
        this.base.fill(0);
    }

    /** Adds (sign 1) or removes (sign −1) one sleeping particle's splat. */
    addToBase(x: number, y: number, z: number, sign: number): void {
        if (!this.base) this.resetBase();
        this.splatPoint(this.base!, x, y, z, sign);
    }

    /** Field = base + the listed particles. */
    splatActive(px: Float32Array, py: Float32Array, pz: Float32Array, list: Int32Array, count: number): void {
        if (this.base) this.field.set(this.base);
        else this.field.fill(0);
        for (let a = 0; a < count; a++) {
            const p = list[a];
            this.splatPoint(this.field, px[p], py[p], pz[p], 1);
        }
    }

    /**
     * Particles below this height are left out of the field. Sleeping particles do not
     * move, so their add and remove in the base always agree.
     */
    minY = -Infinity;

    private splatPoint(target: Float32Array, x: number, y: number, z: number, sign: number): void {
        if (y < this.minY) return;
        const { cell, ox, oy, oz } = this;
        const r = this.radius;
        const r2 = r * r;
        const invR2 = 1 / r2;
        const sy = this.nx + 1;
        const sz = sy * (this.ny + 1);
        const invCell = 1 / cell;
        const c = this.clip;
        const i0 = Math.max(c[0], Math.ceil((x - r - ox) * invCell));
        const i1 = Math.min(c[1], Math.floor((x + r - ox) * invCell));
        const j0 = Math.max(c[2], Math.ceil((y - r - oy) * invCell));
        const j1 = Math.min(c[3], Math.floor((y + r - oy) * invCell));
        const k0 = Math.max(c[4], Math.ceil((z - r - oz) * invCell));
        const k1 = Math.min(c[5], Math.floor((z + r - oz) * invCell));
        for (let k = k0; k <= k1; k++) {
            const dz = oz + k * cell - z;
            const dz2 = dz * dz;
            for (let j = j0; j <= j1; j++) {
                const dy = oy + j * cell - y;
                const dyz2 = dy * dy + dz2;
                if (dyz2 >= r2) continue;
                let idx = i0 + j * sy + k * sz;
                for (let i = i0; i <= i1; i++, idx++) {
                    const dx = ox + i * cell - x;
                    const d2 = dx * dx + dyz2;
                    if (d2 < r2) {
                        const q = 1 - d2 * invR2;
                        target[idx] += sign * q * q * q;
                    }
                }
            }
        }
    }

    /** Splats particles, clipped to the box [x0,x1]x[y0,y1]x[z0,z1] (the tank interior). */
    splat(px: Float32Array, py: Float32Array, pz: Float32Array, count: number,
        x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
        const { field, cell, ox, oy, oz } = this;
        field.fill(0);
        const r = this.radius;
        const r2 = r * r;
        const invR2 = 1 / r2;
        const sy = this.nx + 1;
        const sz = sy * (this.ny + 1);
        const invCell = 1 / cell;
        const ci0 = Math.max(0, Math.ceil((x0 - ox) * invCell));
        const ci1 = Math.min(this.nx, Math.floor((x1 - ox) * invCell));
        const cj0 = Math.max(0, Math.ceil((y0 - oy) * invCell));
        const cj1 = Math.min(this.ny, Math.floor((y1 - oy) * invCell));
        const ck0 = Math.max(0, Math.ceil((z0 - oz) * invCell));
        const ck1 = Math.min(this.nz, Math.floor((z1 - oz) * invCell));
        for (let p = 0; p < count; p++) {
            const x = px[p];
            const y = py[p];
            const z = pz[p];
            let i0 = Math.ceil((x - r - ox) * invCell);
            let i1 = Math.floor((x + r - ox) * invCell);
            let j0 = Math.ceil((y - r - oy) * invCell);
            let j1 = Math.floor((y + r - oy) * invCell);
            let k0 = Math.ceil((z - r - oz) * invCell);
            let k1 = Math.floor((z + r - oz) * invCell);
            if (i0 < ci0) i0 = ci0;
            if (i1 > ci1) i1 = ci1;
            if (j0 < cj0) j0 = cj0;
            if (j1 > cj1) j1 = cj1;
            if (k0 < ck0) k0 = ck0;
            if (k1 > ck1) k1 = ck1;
            for (let k = k0; k <= k1; k++) {
                const dz = oz + k * cell - z;
                const dz2 = dz * dz;
                for (let j = j0; j <= j1; j++) {
                    const dy = oy + j * cell - y;
                    const dyz2 = dy * dy + dz2;
                    if (dyz2 >= r2) continue;
                    let idx = i0 + j * sy + k * sz;
                    for (let i = i0; i <= i1; i++, idx++) {
                        const dx = ox + i * cell - x;
                        const d2 = dx * dx + dyz2;
                        if (d2 < r2) {
                            const q = 1 - d2 * invR2;
                            field[idx] += q * q * q;
                        }
                    }
                }
            }
        }
    }

    /** Separable [1 2 1] / 4 blur along x, y and z: removes particle-lattice bumps. */
    blur(): void {
        const { field, scratch } = this;
        const sx = 1;
        const sy = this.nx + 1;
        const sz = sy * (this.ny + 1);
        const dims = [this.nx + 1, this.ny + 1, this.nz + 1];
        const strides = [sx, sy, sz];
        let src = field;
        let dst = scratch;
        for (let axis = 0; axis < 3; axis++) {
            const stride = strides[axis];
            const n = dims[axis];
            const total = field.length;
            for (let idx = 0; idx < total; idx++) {
                const coord = Math.floor(idx / stride) % n;
                const a = coord > 0 ? src[idx - stride] : 0;
                const b = coord < n - 1 ? src[idx + stride] : 0;
                dst[idx] = 0.25 * a + 0.5 * src[idx] + 0.25 * b;
            }
            const t = src;
            src = dst;
            dst = t;
        }
        if (src !== field) field.set(src);
    }

    /** Extracts the iso-surface of the current field into positions/normals/indices. */
    extract(): void {
        const { field, cellVertex, positions, normals, indices, corner, cornerNodeOffset, cell, ox, oy, oz, iso } = this;
        const nx = this.nx;
        const ny = this.ny;
        const nz = this.nz;
        const sy = nx + 1;
        const sz = sy * (ny + 1);
        const maxV = this.maxVertices;
        let vc = 0;

        for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
                let node = j * sy + k * sz;
                let cellIdx = j * nx + k * nx * ny;
                for (let i = 0; i < nx; i++, node++, cellIdx++) {
                    let mask = 0;
                    for (let c = 0; c < 8; c++) {
                        const f = field[node + cornerNodeOffset[c]];
                        corner[c] = f;
                        if (f > iso) mask |= 1 << c;
                    }
                    if (mask === 0 || mask === 255 || vc >= maxV) {
                        cellVertex[cellIdx] = -1;
                        continue;
                    }
                    let sx = 0;
                    let syy = 0;
                    let szz = 0;
                    let crossings = 0;
                    for (let e = 0; e < 24; e += 2) {
                        const a = EDGES[e];
                        const b = EDGES[e + 1];
                        const fa = corner[a];
                        const fb = corner[b];
                        if ((fa > iso) === (fb > iso)) continue;
                        const t = (iso - fa) / (fb - fa);
                        sx += CORNER_OFFSETS[a * 3] + t * (CORNER_OFFSETS[b * 3] - CORNER_OFFSETS[a * 3]);
                        syy += CORNER_OFFSETS[a * 3 + 1] + t * (CORNER_OFFSETS[b * 3 + 1] - CORNER_OFFSETS[a * 3 + 1]);
                        szz += CORNER_OFFSETS[a * 3 + 2] + t * (CORNER_OFFSETS[b * 3 + 2] - CORNER_OFFSETS[a * 3 + 2]);
                        crossings++;
                    }
                    const u = sx / crossings;
                    const v = syy / crossings;
                    const w = szz / crossings;
                    // Gradient of the trilinear interpolant at (u, v, w).
                    const u0 = 1 - u;
                    const v0 = 1 - v;
                    const w0 = 1 - w;
                    const gx =
                        (corner[1] - corner[0]) * v0 * w0 + (corner[3] - corner[2]) * v * w0 +
                        (corner[5] - corner[4]) * v0 * w + (corner[7] - corner[6]) * v * w;
                    const gy =
                        (corner[2] - corner[0]) * u0 * w0 + (corner[3] - corner[1]) * u * w0 +
                        (corner[6] - corner[4]) * u0 * w + (corner[7] - corner[5]) * u * w;
                    const gz =
                        (corner[4] - corner[0]) * u0 * v0 + (corner[5] - corner[1]) * u * v0 +
                        (corner[6] - corner[2]) * u0 * v + (corner[7] - corner[3]) * u * v;
                    const len = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
                    const o = vc * 3;
                    positions[o] = ox + (i + u) * cell;
                    positions[o + 1] = oy + (j + v) * cell;
                    positions[o + 2] = oz + (k + w) * cell;
                    // The field grows toward the inside of the water, so the outward normal is -grad.
                    normals[o] = -gx / len;
                    normals[o + 1] = -gy / len;
                    normals[o + 2] = -gz / len;
                    cellVertex[cellIdx] = vc++;
                }
            }
        }

        let ic = 0;
        const maxI = this.maxIndices - 6;
        const cy = nx;
        const cz = nx * ny;
        for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const cidx = i + j * cy + k * cz;
                    const v0 = cellVertex[cidx];
                    if (v0 < 0) continue;
                    const node = i + j * sy + k * sz;
                    const inside = field[node] > iso;
                    // Edge along +x from this cell's corner 0: shared by cells (j-1..j, k-1..k).
                    if (j > 0 && k > 0 && (field[node + 1] > iso) !== inside) {
                        this.quad(ic, v0, cellVertex[cidx - cy], cellVertex[cidx - cy - cz], cellVertex[cidx - cz], inside);
                        if (this.lastQuadOk) ic += 6;
                    }
                    if (i > 0 && k > 0 && (field[node + sy] > iso) !== inside) {
                        this.quad(ic, v0, cellVertex[cidx - cz], cellVertex[cidx - 1 - cz], cellVertex[cidx - 1], inside);
                        if (this.lastQuadOk) ic += 6;
                    }
                    if (i > 0 && j > 0 && (field[node + sz] > iso) !== inside) {
                        this.quad(ic, v0, cellVertex[cidx - 1], cellVertex[cidx - 1 - cy], cellVertex[cidx - cy], inside);
                        if (this.lastQuadOk) ic += 6;
                    }
                    if (ic > maxI) break;
                }
            }
        }
        this.vertexCount = vc;
        this.indexCount = ic;
    }

    private lastQuadOk = false;

    private quad(ic: number, a: number, b: number, c: number, d: number, flip: boolean): void {
        if (b < 0 || c < 0 || d < 0) {
            this.lastQuadOk = false;
            return;
        }
        const idx = this.indices;
        if (flip) {
            idx[ic] = a; idx[ic + 1] = b; idx[ic + 2] = c;
            idx[ic + 3] = a; idx[ic + 4] = c; idx[ic + 5] = d;
        } else {
            idx[ic] = a; idx[ic + 1] = d; idx[ic + 2] = c;
            idx[ic + 3] = a; idx[ic + 4] = c; idx[ic + 5] = b;
        }
        this.lastQuadOk = true;
    }
}
