/**
 * Extended Position Based Dynamics cloth (Macklin, Müller, Chentanez 2016) with
 * the "small steps" schedule (Macklin et al. 2019): many substeps, one
 * constraint iteration each. All state lives in preallocated typed arrays and
 * `step()` allocates nothing, so the solver runs on phones without GC stalls.
 *
 * Constraints are distance constraints in three groups with their own
 * compliance (inverse stiffness, m/N): stretch (grid edges), shear (cell
 * diagonals) and bending (every second particle along rows and columns).
 * Colliders: a kinematic sphere, the ground plane y = 0 and, optionally, the
 * cloth itself.
 *
 * `method = 'pbd'` switches to classic Position Based Dynamics (Müller et al.
 * 2007) for comparison: each sweep moves a constraint a fixed fraction k of the
 * way to its rest length, so the material stiffens as the substep count grows.
 */

export interface ClothLayout {
    /** Particles per side; the cloth has `segments * segments` particles. */
    segments: number;
    /** Side length in metres. */
    size: number;
    /** Total mass in kg. */
    mass: number;
    /** 'horizontal': flat at `height`, centred on the origin. 'vertical': hangs in the xy plane, top edge at `height`. */
    orientation: 'horizontal' | 'vertical';
    height: number;
    /** Grid (column, row) pairs whose particles are fixed in place. */
    pins: ReadonlyArray<readonly [number, number]>;
    /** Long range attachments to the pins; on by default. */
    tethers?: boolean;
    /** Shift along x, in metres. */
    offsetX?: number;
}

export type SolverMethod = 'xpbd' | 'pbd';

export const GROUP_STRETCH = 0;
export const GROUP_SHEAR = 1;
export const GROUP_BEND = 2;

export class XpbdCloth {
    readonly segments: number;
    readonly count: number;
    /** xyz per particle; handed to the renderer as-is. */
    readonly pos: Float32Array;
    /** Unit normals per particle, from `computeNormals()`. */
    readonly normals: Float32Array;
    readonly uvs: Float32Array;
    readonly indices: Uint16Array;
    readonly minPos = { x: 0, y: 0, z: 0 };
    readonly maxPos = { x: 0, y: 0, z: 0 };

    /** Compliance per constraint group (stretch, shear, bend), in m/N. */
    readonly compliance = new Float64Array([0, 1e-4, 5e-3]);
    method: SolverMethod = 'xpbd';
    /** PBD only: fraction of the constraint error removed per sweep, per group. See `matchPbdStiffness()`. */
    readonly pbdStiffness = new Float64Array([1, 1, 1]);
    substeps = 10;
    /** Rest distance between grid neighbours, in metres. */
    readonly spacing: number;
    selfCollision = false;
    /** Run the self collision pass on every n-th substep; 2 halves its cost while a substep moves particles far less than the thickness. */
    selfCollisionEvery = 1;
    /** Minimum distance between any two particles when self collision is on. */
    selfThickness: number;
    /** Fraction of the relative substep motion of two touching particles removed per contact. */
    selfFriction = 0.3;
    gravity = -9.81;
    /** Linear velocity damping per second. */
    damping = 0.3;
    /** Particle radius used against the colliders, in metres. */
    thickness = 0.012;
    /** Fraction of tangential motion removed on contact (0 = ice, 1 = glue). */
    friction = 0.4;
    /** Wind velocity (m/s) and drag rate (1/s, keep below the substep rate); drag acts along the particle normal. */
    readonly wind = { x: 0, y: 0, z: 0 };
    windDrag = 0;

    readonly sphere = { x: 0, y: 0.5, z: 0, r: 0.4 };

    private readonly prev: Float32Array;
    private readonly vel: Float32Array;
    private readonly invMass: Float32Array;
    private massTotal = 1;
    private readonly ca: Int32Array;
    private readonly cb: Int32Array;
    private readonly rest: Float32Array;
    private readonly groupEnd = new Int32Array(3);
    /** Long range attachments (Kim et al. 2012): pinned particle indices and each particle's rest distance to them. */
    private tetherPins: Int32Array = new Int32Array(0);
    private tetherRest: Float32Array = new Float32Array(0);
    /** Self collision grid: cell start offsets, particle indices sorted by cell, and each particle's cell. */
    private readonly cellStart: Int32Array;
    private readonly cellSorted: Int32Array;
    private readonly cellOf: Int32Array;

    private readonly sphereFrom = { x: 0, y: 0, z: 0 };
    private grabIndex = -1;
    private grabSavedInvMass = 0;
    private readonly grabFrom = { x: 0, y: 0, z: 0 };
    private readonly grabTo = { x: 0, y: 0, z: 0 };
    private stepParity = 0;

    constructor(layout: ClothLayout) {
        const n = layout.segments;
        this.segments = n;
        this.count = n * n;
        this.spacing = layout.size / (n - 1);
        // Below 1/√2 of the spacing a particle could slip through the middle of a cell.
        this.selfThickness = 0.9 * this.spacing;
        this.cellStart = new Int32Array(32 * this.count + 1);
        this.cellSorted = new Int32Array(this.count);
        this.cellOf = new Int32Array(this.count);
        this.pos = new Float32Array(this.count * 3);
        this.prev = new Float32Array(this.count * 3);
        this.vel = new Float32Array(this.count * 3);
        this.normals = new Float32Array(this.count * 3);
        this.uvs = new Float32Array(this.count * 2);
        this.invMass = new Float32Array(this.count);

        const cells = (n - 1) * (n - 1);
        this.indices = new Uint16Array(cells * 6);
        const constraintCount = 2 * n * (n - 1) + 2 * cells + 2 * n * (n - 2);
        this.ca = new Int32Array(constraintCount);
        this.cb = new Int32Array(constraintCount);
        this.rest = new Float32Array(constraintCount);

        this.buildParticles(layout);
        this.buildIndices();
        this.buildConstraints();
        this.sphereFrom.x = this.sphere.x;
        this.sphereFrom.y = this.sphere.y;
        this.sphereFrom.z = this.sphere.z;
        this.computeNormals();
    }

    get constraintCount(): number {
        return this.rest.length;
    }

    /**
     * Sets the PBD stiffness of every group to what one XPBD sweep applies at
     * `substeps` substeps per `frameDt`: k = w / (w + α/h²) for two particles of
     * the cloth's mass. Both methods then agree at that substep count only.
     */
    matchPbdStiffness(substeps: number, frameDt = 1 / 60): void {
        const h = frameDt / substeps;
        const w = (2 * this.count) / this.massTotal;
        for (let g = 0; g < 3; g++) this.pbdStiffness[g] = w / (w + this.compliance[g] / (h * h));
    }

    /** Advances the simulation by `dt` seconds split into `substeps` substeps. */
    step(dt: number): void {
        const substeps = this.substeps;
        const h = dt / substeps;
        const count = this.count;
        const pos = this.pos;
        const prev = this.prev;
        const vel = this.vel;
        const invMass = this.invMass;
        const normals = this.normals;
        const gh = this.gravity * h;
        const damp = Math.max(0, 1 - this.damping * h);
        const windDrag = this.windDrag * h;
        const wx = this.wind.x;
        const wy = this.wind.y;
        const wz = this.wind.z;
        const sphere = this.sphere;
        const sf = this.sphereFrom;
        const grab = this.grabIndex;

        for (let s = 0; s < substeps; s++) {
            const t = (s + 1) / substeps;

            for (let i = 0, k = 0; i < count; i++, k += 3) {
                prev[k] = pos[k];
                prev[k + 1] = pos[k + 1];
                prev[k + 2] = pos[k + 2];
                if (invMass[i] === 0) continue;
                let vx = vel[k] * damp;
                let vy = vel[k + 1] * damp + gh;
                let vz = vel[k + 2] * damp;
                if (windDrag !== 0) {
                    const nx = normals[k];
                    const ny = normals[k + 1];
                    const nz = normals[k + 2];
                    const rel = ((wx - vx) * nx + (wy - vy) * ny + (wz - vz) * nz) * windDrag;
                    vx += rel * nx;
                    vy += rel * ny;
                    vz += rel * nz;
                }
                pos[k] += vx * h;
                pos[k + 1] += vy * h;
                pos[k + 2] += vz * h;
            }

            if (grab >= 0) {
                const k = grab * 3;
                pos[k] = this.grabFrom.x + (this.grabTo.x - this.grabFrom.x) * t;
                pos[k + 1] = this.grabFrom.y + (this.grabTo.y - this.grabFrom.y) * t;
                pos[k + 2] = this.grabFrom.z + (this.grabTo.z - this.grabFrom.z) * t;
            }

            this.solveConstraints(h);
            if (this.selfCollision && (s + 1) % this.selfCollisionEvery === 0) this.solveSelfCollisions();
            if (this.tetherPins.length > 0) this.solveTethers();
            this.collide(
                sf.x + (sphere.x - sf.x) * t,
                sf.y + (sphere.y - sf.y) * t,
                sf.z + (sphere.z - sf.z) * t,
            );

            const invH = 1 / h;
            for (let k = 0; k < count * 3; k++) vel[k] = (pos[k] - prev[k]) * invH;
        }

        sf.x = sphere.x;
        sf.y = sphere.y;
        sf.z = sphere.z;
        if (grab >= 0) {
            this.grabFrom.x = this.grabTo.x;
            this.grabFrom.y = this.grabTo.y;
            this.grabFrom.z = this.grabTo.z;
        }
    }

    /** Area-weighted vertex normals and the bounding box, once per rendered frame. */
    computeNormals(): void {
        const pos = this.pos;
        const nrm = this.normals;
        const idx = this.indices;
        nrm.fill(0);
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3;
            const b = idx[t + 1] * 3;
            const c = idx[t + 2] * 3;
            const e1x = pos[b] - pos[a];
            const e1y = pos[b + 1] - pos[a + 1];
            const e1z = pos[b + 2] - pos[a + 2];
            const e2x = pos[c] - pos[a];
            const e2y = pos[c + 1] - pos[a + 1];
            const e2z = pos[c + 2] - pos[a + 2];
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz;
            nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz;
            nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
        }
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let k = 0; k < nrm.length; k += 3) {
            const x = nrm[k], y = nrm[k + 1], z = nrm[k + 2];
            const len = Math.sqrt(x * x + y * y + z * z);
            const inv = len > 0 ? 1 / len : 0;
            nrm[k] = x * inv; nrm[k + 1] = y * inv; nrm[k + 2] = z * inv;
            const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
        }
        this.minPos.x = minX; this.minPos.y = minY; this.minPos.z = minZ;
        this.maxPos.x = maxX; this.maxPos.y = maxY; this.maxPos.z = maxZ;
    }

    /** Moves the sphere collider; the motion is spread over the next step's substeps. */
    setSphere(x: number, y: number, z: number): void {
        this.sphere.x = x;
        this.sphere.y = Math.max(y, this.sphere.r);
        this.sphere.z = z;
    }

    /** Puts the sphere somewhere without sweeping it through the cloth on the next step. */
    placeSphere(x: number, y: number, z: number): void {
        this.setSphere(x, y, z);
        this.sphereFrom.x = this.sphere.x;
        this.sphereFrom.y = this.sphere.y;
        this.sphereFrom.z = this.sphere.z;
    }

    /** Holds particle `index` at a target that follows `moveGrab()`, until `releaseGrab()`. */
    grab(index: number): void {
        this.releaseGrab();
        this.grabIndex = index;
        this.grabSavedInvMass = this.invMass[index];
        this.invMass[index] = 0;
        const k = index * 3;
        this.grabFrom.x = this.grabTo.x = this.pos[k];
        this.grabFrom.y = this.grabTo.y = this.pos[k + 1];
        this.grabFrom.z = this.grabTo.z = this.pos[k + 2];
    }

    moveGrab(x: number, y: number, z: number): void {
        this.grabTo.x = x;
        this.grabTo.y = Math.max(y, this.thickness);
        this.grabTo.z = z;
    }

    /** Lets go; a pinned particle stays pinned where it was dropped. */
    releaseGrab(): void {
        if (this.grabIndex < 0) return;
        this.invMass[this.grabIndex] = this.grabSavedInvMass;
        this.grabIndex = -1;
    }

    get grabbing(): boolean {
        return this.grabIndex >= 0;
    }

    /** Frees every pinned particle so the cloth falls. */
    unpinAll(): void {
        this.tetherPins = new Int32Array(0);
        this.tetherRest = new Float32Array(0);
        const w = this.count / this.massTotal;
        for (let i = 0; i < this.count; i++) {
            if (i === this.grabIndex) this.grabSavedInvMass = w;
            else this.invMass[i] = w;
        }
    }

    /** Index of the particle nearest to where the ray first hits the cloth, and the hit distance. */
    pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: { index: number; t: number }): boolean {
        const pos = this.pos;
        const idx = this.indices;
        let bestT = Infinity;
        let bestTri = -1;
        let bestU = 0, bestV = 0;
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
            const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
            const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (det > -1e-12 && det < 1e-12) continue;
            const inv = 1 / det;
            const sx = ox - pos[a], sy = oy - pos[a + 1], sz = oz - pos[a + 2];
            const u = (sx * px + sy * py + sz * pz) * inv;
            if (u < 0 || u > 1) continue;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const v = (dx * qx + dy * qy + dz * qz) * inv;
            if (v < 0 || u + v > 1) continue;
            const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
            if (dist > 0 && dist < bestT) {
                bestT = dist; bestTri = t; bestU = u; bestV = v;
            }
        }
        if (bestTri < 0) return false;
        const w0 = 1 - bestU - bestV;
        const corner = w0 >= bestU && w0 >= bestV ? 0 : bestU >= bestV ? 1 : 2;
        out.index = idx[bestTri + corner];
        out.t = bestT;
        return true;
    }

    private buildParticles(layout: ClothLayout): void {
        const n = layout.segments;
        const spacing = this.spacing;
        const half = layout.size / 2;
        const offsetX = layout.offsetX ?? 0;
        const w = this.count / layout.mass;
        this.massTotal = layout.mass;
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                const i = row * n + col;
                const k = i * 3;
                const u = col * spacing - half + offsetX;
                const v = row * spacing;
                if (layout.orientation === 'horizontal') {
                    this.pos[k] = u;
                    this.pos[k + 1] = layout.height;
                    this.pos[k + 2] = v - half;
                } else {
                    this.pos[k] = u;
                    this.pos[k + 1] = layout.height - v;
                    // A tiny depth offset breaks the symmetry so the sheet can fold.
                    this.pos[k + 2] = 1e-4 * Math.sin(i * 12.9898);
                }
                this.uvs[i * 2] = col / (n - 1);
                this.uvs[i * 2 + 1] = row / (n - 1);
                this.invMass[i] = w;
            }
        }
        for (const [col, row] of layout.pins) this.invMass[row * n + col] = 0;
        this.prev.set(this.pos);

        if (layout.tethers === false) return;
        const pins = layout.pins.map(([col, row]) => row * n + col);
        this.tetherPins = Int32Array.from(pins);
        this.tetherRest = new Float32Array(pins.length * this.count);
        pins.forEach((pin, p) => {
            const a = pin * 3;
            for (let i = 0, k = 0; i < this.count; i++, k += 3) {
                const dx = this.pos[k] - this.pos[a];
                const dy = this.pos[k + 1] - this.pos[a + 1];
                const dz = this.pos[k + 2] - this.pos[a + 2];
                this.tetherRest[p * this.count + i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
        });
    }

    /**
     * A free particle may not get farther from a pin than it was in the rest
     * pose. One cheap unilateral projection per pin removes the stretching a
     * single Gauss-Seidel sweep cannot propagate down a long hanging sheet.
     */
    private solveTethers(): void {
        const pos = this.pos;
        const invMass = this.invMass;
        const pins = this.tetherPins;
        const rest = this.tetherRest;
        const count = this.count;
        for (let p = 0; p < pins.length; p++) {
            const a = pins[p] * 3;
            const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
            const base = p * count;
            for (let i = 0, k = 0; i < count; i++, k += 3) {
                if (invMass[i] === 0) continue;
                const dx = pos[k] - ax, dy = pos[k + 1] - ay, dz = pos[k + 2] - az;
                const d2 = dx * dx + dy * dy + dz * dz;
                const l = rest[base + i];
                if (d2 <= l * l) continue;
                const s = l / Math.sqrt(d2);
                pos[k] = ax + dx * s;
                pos[k + 1] = ay + dy * s;
                pos[k + 2] = az + dz * s;
            }
        }
    }

    /**
     * Keeps every pair of particles at least `selfThickness` apart (as in
     * Müller's "Ten Minute Physics" cloth self collision). Every substep the
     * particles are counting-sorted into a dense grid over the cloth's bounding
     * box with cells at least the thickness wide, so all contacts of a particle
     * lie in its 3×3×3 block of cells; a substep moves particles far less than a
     * cell. Cells along x are contiguous, and only the forward half of the block
     * is visited (5 runs of slots), so each pair is tested once. Grid
     * neighbours rest a full spacing apart, beyond the thickness, so only real
     * contacts and strong compression react.
     */
    private solveSelfCollisions(): void {
        const pos = this.pos;
        const count = this.count;
        const cellStart = this.cellStart;
        const sorted = this.cellSorted;
        const cellOf = this.cellOf;
        const maxCells = cellStart.length - 1;

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let k = 0; k < count * 3; k += 3) {
            const x = pos[k], y = pos[k + 1], z = pos[k + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        // Larger cells only add candidates; they keep a spread-out cloth within the grid memory.
        let cell = this.selfThickness;
        let nx = 0, ny = 0, nz = 0;
        for (;;) {
            nx = Math.floor((maxX - minX) / cell) + 1;
            ny = Math.floor((maxY - minY) / cell) + 1;
            nz = Math.floor((maxZ - minZ) / cell) + 1;
            if (nx * ny * nz <= maxCells) break;
            cell *= 1.25;
        }
        const inv = 1 / cell;
        const nxy = nx * ny;
        const cells = nxy * nz;

        cellStart.fill(0, 0, cells + 1);
        for (let i = 0, k = 0; i < count; i++, k += 3) {
            const c = Math.floor((pos[k] - minX) * inv) + nx * (Math.floor((pos[k + 1] - minY) * inv) + ny * Math.floor((pos[k + 2] - minZ) * inv));
            cellOf[i] = c;
            cellStart[c]++;
        }
        for (let c = 1; c < cells; c++) cellStart[c] += cellStart[c - 1];
        cellStart[cells] = count;
        // cellStart[c] holds the end of cell c; filling backwards leaves it at the start.
        for (let i = count - 1; i >= 0; i--) sorted[--cellStart[cellOf[i]]] = i;

        for (let s = 0; s < count; s++) {
            const i = sorted[s];
            const c = cellOf[i];
            const ix = c % nx;
            const iy = ((c / nx) | 0) % ny;
            const iz = (c / nxy) | 0;
            const x0 = ix > 0 ? ix - 1 : 0;
            const x1 = ix < nx - 1 ? ix + 1 : ix;
            // Own row: the rest of this cell, then the next cell along x.
            this.collideRun(i, s + 1, cellStart[c - ix + x1 + 1]);
            if (iy + 1 < ny) {
                const row = c - ix + nx;
                this.collideRun(i, cellStart[row + x0], cellStart[row + x1 + 1]);
            }
            if (iz + 1 < nz) {
                const y0 = iy > 0 ? iy - 1 : 0;
                const y1 = iy < ny - 1 ? iy + 1 : iy;
                for (let y = y0; y <= y1; y++) {
                    const row = nx * (y + ny * (iz + 1));
                    this.collideRun(i, cellStart[row + x0], cellStart[row + x1 + 1]);
                }
            }
        }
    }

    /** Separates particle `i` from the particles in sorted slots [from, to), with friction. */
    private collideRun(i: number, from: number, to: number): void {
        const pos = this.pos;
        const prev = this.prev;
        const invMass = this.invMass;
        const sorted = this.cellSorted;
        const thickness = this.selfThickness;
        const t2 = thickness * thickness;
        const friction = this.selfFriction * 0.5;
        const wi = invMass[i];
        const a = i * 3;
        for (let q = from; q < to; q++) {
            const j = sorted[q];
            const wj = invMass[j];
            const wSum = wi + wj;
            if (wSum === 0) continue;
            const b = j * 3;
            const ex = pos[b] - pos[a];
            const ey = pos[b + 1] - pos[a + 1];
            const ez = pos[b + 2] - pos[a + 2];
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 >= t2 || d2 < 1e-12) continue;
            const d = Math.sqrt(d2);
            const s = (thickness - d) / (d * wSum);
            const sa = s * wi;
            const sb = s * wj;
            pos[a] -= ex * sa; pos[a + 1] -= ey * sa; pos[a + 2] -= ez * sa;
            pos[b] += ex * sb; pos[b + 1] += ey * sb; pos[b + 2] += ez * sb;
            // Friction: pull both substep displacements toward their average.
            const rx = (pos[b] - prev[b] - pos[a] + prev[a]) * friction;
            const ry = (pos[b + 1] - prev[b + 1] - pos[a + 1] + prev[a + 1]) * friction;
            const rz = (pos[b + 2] - prev[b + 2] - pos[a + 2] + prev[a + 2]) * friction;
            if (wi > 0) { pos[a] += rx; pos[a + 1] += ry; pos[a + 2] += rz; }
            if (wj > 0) { pos[b] -= rx; pos[b + 1] -= ry; pos[b + 2] -= rz; }
        }
    }

    private buildIndices(): void {
        const n = this.segments;
        let t = 0;
        for (let row = 0; row < n - 1; row++) {
            for (let col = 0; col < n - 1; col++) {
                const a = row * n + col;
                const b = a + 1;
                const c = a + n;
                const d = c + 1;
                this.indices[t++] = a; this.indices[t++] = c; this.indices[t++] = b;
                this.indices[t++] = b; this.indices[t++] = c; this.indices[t++] = d;
            }
        }
    }

    private buildConstraints(): void {
        const n = this.segments;
        let c = 0;
        const add = (a: number, b: number) => {
            this.ca[c] = a;
            this.cb[c] = b;
            const dx = this.pos[a * 3] - this.pos[b * 3];
            const dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1];
            const dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2];
            this.rest[c] = Math.sqrt(dx * dx + dy * dy + dz * dz);
            c++;
        };
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                const i = row * n + col;
                if (col < n - 1) add(i, i + 1);
                if (row < n - 1) add(i, i + n);
            }
        }
        this.groupEnd[GROUP_STRETCH] = c;
        for (let row = 0; row < n - 1; row++) {
            for (let col = 0; col < n - 1; col++) {
                const i = row * n + col;
                add(i, i + n + 1);
                add(i + 1, i + n);
            }
        }
        this.groupEnd[GROUP_SHEAR] = c;
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                const i = row * n + col;
                if (col < n - 2) add(i, i + 2);
                if (row < n - 2) add(i, i + 2 * n);
            }
        }
        this.groupEnd[GROUP_BEND] = c;
    }

    /**
     * One Gauss-Seidel sweep over all distance constraints. With one iteration
     * per substep the Lagrange multiplier starts at zero, so the XPBD update
     * reduces to  dλ = -C / (w_a + w_b + α/h²)  and λ need not be stored.
     * Sweep direction alternates between substeps to avoid a one-sided bias;
     * groups run bend, shear, stretch so the stiffest ones are solved last.
     * PBD replaces the compliance term by a fixed fraction k of the full
     * correction: dλ = -k C / (w_a + w_b).
     */
    private solveConstraints(h: number): void {
        const pos = this.pos;
        const invMass = this.invMass;
        const ca = this.ca;
        const cb = this.cb;
        const rest = this.rest;
        const invH2 = 1 / (h * h);
        const pbd = this.method === 'pbd';
        const forward = (this.stepParity ^= 1) === 1;
        for (let g = 2; g >= 0; g--) {
            const start = g === 0 ? 0 : this.groupEnd[g - 1];
            const end = this.groupEnd[g];
            const alpha = pbd ? 0 : this.compliance[g] * invH2;
            const k = pbd ? this.pbdStiffness[g] : 1;
            const first = forward ? start : end - 1;
            const inc = forward ? 1 : -1;
            for (let j = first, left = end - start; left > 0; j += inc, left--) {
                const ia = ca[j];
                const ib = cb[j];
                const wa = invMass[ia];
                const wb = invMass[ib];
                const wSum = wa + wb + alpha;
                if (wSum === 0) continue;
                const a = ia * 3;
                const b = ib * 3;
                const dx = pos[a] - pos[b];
                const dy = pos[a + 1] - pos[b + 1];
                const dz = pos[a + 2] - pos[b + 2];
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (len < 1e-9) continue;
                const s = (-k * (len - rest[j])) / (wSum * len);
                const sa = s * wa;
                const sb = s * wb;
                pos[a] += dx * sa; pos[a + 1] += dy * sa; pos[a + 2] += dz * sa;
                pos[b] -= dx * sb; pos[b + 1] -= dy * sb; pos[b + 2] -= dz * sb;
            }
        }
    }

    /** Pushes particles out of the sphere and the ground, with position-level friction. */
    private collide(cx: number, cy: number, cz: number): void {
        const pos = this.pos;
        const prev = this.prev;
        const invMass = this.invMass;
        const thickness = this.thickness;
        const friction = this.friction;
        const r = this.sphere.r + thickness;
        const r2 = r * r;
        for (let i = 0, k = 0; i < this.count; i++, k += 3) {
            if (invMass[i] === 0) continue;
            let x = pos[k], y = pos[k + 1], z = pos[k + 2];
            const dx = x - cx, dy = y - cy, dz = z - cz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < r2 && d2 > 1e-12) {
                const d = Math.sqrt(d2);
                const nx = dx / d, ny = dy / d, nz = dz / d;
                x = cx + nx * r; y = cy + ny * r; z = cz + nz * r;
                const mx = x - prev[k], my = y - prev[k + 1], mz = z - prev[k + 2];
                const mn = mx * nx + my * ny + mz * nz;
                x -= (mx - mn * nx) * friction;
                y -= (my - mn * ny) * friction;
                z -= (mz - mn * nz) * friction;
            }
            if (y < thickness) {
                y = thickness;
                x -= (x - prev[k]) * friction;
                z -= (z - prev[k + 2]) * friction;
            }
            pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
        }
    }
}
