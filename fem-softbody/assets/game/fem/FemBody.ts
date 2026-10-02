/**
 * Co-rotated linear FEM on tetrahedra with implicit Euler (Müller & Gross
 * 2004, "Interactive Virtual Materials"; Müller et al. 2002, "Stable Real-Time
 * Deformations").
 *
 * Every tetrahedron has a constant-strain linear stiffness matrix K_e (12×12),
 * built once from Young's modulus and Poisson's ratio. Linear FEM measures
 * strain from the displacement x − X directly, so a rotated but undeformed
 * element looks strained and the body inflates. Co-rotated FEM first takes the
 * element's rotation R out of its deformation gradient and measures strain in
 * the rotated frame: the force is f_e = −R K_e (Rᵀ x − X), and its stiffness
 * R K_e Rᵀ. `corotated = false` uses R = I.
 *
 * One step solves the linearised implicit Euler system
 *   (M (1 + hα) + (h² + hβ) K') v⁺ = M v + h (f_el + f_ext)
 * with conjugate gradients, warm started from the current velocity, then
 * moves x += h v⁺. K' is assembled each step into a block-sparse matrix whose
 * pattern (node adjacency) is built once. Rotations come from Müller et al.
 * 2016, "A Robust Method to Extract the Rotational Part of Deformations":
 * a few iterations per step, warm started from the last step's quaternion.
 *
 * Fixed nodes keep zero velocity; the grabbed node gets the velocity that
 * takes it to its target. Both are Dirichlet conditions in the CG solve. All
 * state is preallocated; `step()` allocates nothing.
 */

export interface BlockLayout {
    /** Cells along x, y, z; every cell is split into five tetrahedra. */
    nx: number;
    ny: number;
    nz: number;
    /** Cell edge in metres. */
    cell: number;
    /** Position of the block's minimum corner. */
    origin: readonly [number, number, number];
    /** Nodes for which this returns true are fixed in place (grid indices). */
    fixed?: (i: number, j: number, k: number) => boolean;
}

export class FemBody {
    readonly nodeCount: number;
    readonly tetCount: number;
    readonly x: Float64Array;
    readonly v: Float64Array;
    readonly rest: Float64Array;
    readonly tets: Int32Array;
    /** Boundary triangles (node indices), wound outwards. */
    readonly surface: Uint32Array;
    readonly restVolume: number;

    corotated = true;
    /** Pa; kg/m³. Changing either needs `rebuildStiffness()`. */
    youngModulus = 6e4;
    poisson = 0.45;
    density = 1000;
    gravity = -9.81;
    /** Rayleigh damping: mass (1/s) and stiffness (s) proportional. */
    massDamping = 0.2;
    stiffnessDamping = 0.002;
    cgIterations = 20;
    /** Stop CG once the residual drops below this fraction of the first one. */
    cgTolerance = 1e-4;
    substeps = 1;
    /** Collider sphere (centre, radius) and the ground y = 0. */
    readonly sphere = { x: 0, y: -10, z: 0, r: 0.4 };
    friction = 0.5;
    /** Iterations used by the last CG solve, and the residual ratio it reached. */
    lastIterations = 0;
    lastResidual = 0;

    private readonly mass: Float64Array;
    private readonly fixed: Uint8Array;
    private readonly ke: Float64Array;
    /** K_e X_e per tetrahedron, rotated each step into the force offset R K_e X_e. */
    private readonly keRest: Float64Array;
    private readonly dmInv: Float64Array;
    private readonly volume: Float64Array;
    private readonly quat: Float64Array;
    private readonly rot: Float64Array;
    /** Block-sparse rows: rowStart[n] … rowStart[n+1] index blocks; blockCol is the column node, values are 9 per block. */
    private readonly rowStart: Int32Array;
    private readonly blockCol: Int32Array;
    private readonly blocks: Float64Array;
    /** For tetrahedron t and local pair (a, b), the global block index. */
    private readonly tetBlock: Int32Array;
    private readonly rhs: Float64Array;
    private readonly r: Float64Array;
    private readonly p: Float64Array;
    private readonly ap: Float64Array;
    private readonly force: Float64Array;
    private readonly contact: Uint8Array;
    private readonly released: Uint8Array;
    private readonly contactNormal: Float64Array;
    private grabNode = -1;
    private readonly grabTarget = { x: 0, y: 0, z: 0 };

    constructor(layout: BlockLayout) {
        const { nx, ny, nz, cell, origin } = layout;
        const sx = nx + 1;
        const sy = ny + 1;
        this.nodeCount = sx * sy * (nz + 1);
        this.tetCount = nx * ny * nz * 5;
        const n = this.nodeCount;
        this.x = new Float64Array(n * 3);
        this.v = new Float64Array(n * 3);
        this.rest = new Float64Array(n * 3);
        this.mass = new Float64Array(n);
        this.fixed = new Uint8Array(n);
        const node = (i: number, j: number, k: number) => i + sx * (j + sy * k);
        for (let k = 0; k <= nz; k++) {
            for (let j = 0; j <= ny; j++) {
                for (let i = 0; i <= nx; i++) {
                    const a = node(i, j, k) * 3;
                    this.rest[a] = origin[0] + i * cell;
                    this.rest[a + 1] = origin[1] + j * cell;
                    this.rest[a + 2] = origin[2] + k * cell;
                    if (layout.fixed?.(i, j, k)) this.fixed[node(i, j, k)] = 1;
                }
            }
        }
        this.x.set(this.rest);

        // Five tetrahedra per cube, mirrored on alternate cells so shared faces match.
        this.tets = new Int32Array(this.tetCount * 4);
        let t = 0;
        for (let k = 0; k < nz; k++) {
            for (let j = 0; j < ny; j++) {
                for (let i = 0; i < nx; i++) {
                    const c = (di: number, dj: number, dk: number) => {
                        const odd = (i + j + k) & 1;
                        return node(i + (odd ? 1 - di : di), j + dj, k + dk);
                    };
                    const five = [
                        [c(0, 0, 0), c(1, 0, 0), c(0, 1, 0), c(0, 0, 1)],
                        [c(1, 1, 0), c(0, 1, 0), c(1, 0, 0), c(1, 1, 1)],
                        [c(1, 0, 1), c(1, 0, 0), c(0, 0, 1), c(1, 1, 1)],
                        [c(0, 1, 1), c(0, 0, 1), c(0, 1, 0), c(1, 1, 1)],
                        [c(1, 0, 0), c(0, 1, 0), c(0, 0, 1), c(1, 1, 1)],
                    ];
                    for (const tet of five) {
                        if (this.signedVolume(tet[0], tet[1], tet[2], tet[3]) < 0) [tet[2], tet[3]] = [tet[3], tet[2]];
                        this.tets.set(tet, t * 4);
                        t++;
                    }
                }
            }
        }

        const T = this.tetCount;
        this.ke = new Float64Array(T * 144);
        this.keRest = new Float64Array(T * 12);
        this.dmInv = new Float64Array(T * 9);
        this.volume = new Float64Array(T);
        this.quat = new Float64Array(T * 4);
        this.rot = new Float64Array(T * 9);
        for (let e = 0; e < T; e++) this.quat[e * 4 + 3] = 1;

        // Node adjacency through shared tetrahedra gives the sparsity pattern.
        const neighbours: Set<number>[] = Array.from({ length: n }, (_, i) => new Set([i]));
        for (let e = 0; e < T; e++) {
            for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) neighbours[this.tets[e * 4 + a]].add(this.tets[e * 4 + b]);
        }
        this.rowStart = new Int32Array(n + 1);
        for (let i = 0; i < n; i++) this.rowStart[i + 1] = this.rowStart[i] + neighbours[i].size;
        this.blockCol = new Int32Array(this.rowStart[n]);
        for (let i = 0; i < n; i++) {
            const cols = [...neighbours[i]].sort((a, b) => a - b);
            this.blockCol.set(cols, this.rowStart[i]);
        }
        this.blocks = new Float64Array(this.rowStart[n] * 9);
        this.tetBlock = new Int32Array(T * 16);
        for (let e = 0; e < T; e++) {
            for (let a = 0; a < 4; a++) {
                const row = this.tets[e * 4 + a];
                for (let b = 0; b < 4; b++) {
                    const col = this.tets[e * 4 + b];
                    let q = this.rowStart[row];
                    while (this.blockCol[q] !== col) q++;
                    this.tetBlock[e * 16 + a * 4 + b] = q;
                }
            }
        }

        this.rhs = new Float64Array(n * 3);
        this.r = new Float64Array(n * 3);
        this.p = new Float64Array(n * 3);
        this.ap = new Float64Array(n * 3);
        this.force = new Float64Array(n * 3);
        this.contact = new Uint8Array(n);
        this.released = new Uint8Array(n);
        this.contactNormal = new Float64Array(n * 3);
        this.surface = this.buildSurface();
        this.rebuildStiffness();
        let volume = 0;
        for (let e = 0; e < T; e++) volume += this.volume[e];
        this.restVolume = volume;
    }

    /** Recomputes element stiffness matrices and lumped masses from the material parameters. */
    rebuildStiffness(): void {
        const E = this.youngModulus;
        const nu = this.poisson;
        const mu = E / (2 * (1 + nu));
        const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
        this.mass.fill(0);
        const g = new Float64Array(12);
        for (let e = 0; e < this.tetCount; e++) {
            const [i0, i1, i2, i3] = [this.tets[e * 4], this.tets[e * 4 + 1], this.tets[e * 4 + 2], this.tets[e * 4 + 3]];
            const X = this.rest;
            const d = [
                X[i1 * 3] - X[i0 * 3], X[i2 * 3] - X[i0 * 3], X[i3 * 3] - X[i0 * 3],
                X[i1 * 3 + 1] - X[i0 * 3 + 1], X[i2 * 3 + 1] - X[i0 * 3 + 1], X[i3 * 3 + 1] - X[i0 * 3 + 1],
                X[i1 * 3 + 2] - X[i0 * 3 + 2], X[i2 * 3 + 2] - X[i0 * 3 + 2], X[i3 * 3 + 2] - X[i0 * 3 + 2],
            ];
            const inv = this.dmInv.subarray(e * 9, e * 9 + 9);
            const det = invert3(d, inv);
            const vol = det / 6;
            this.volume[e] = vol;
            // Gradients of the barycentric shape functions: rows of Dm⁻¹ for nodes 1–3, minus their sum for node 0.
            for (let a = 1; a < 4; a++) for (let c = 0; c < 3; c++) g[a * 3 + c] = inv[(a - 1) * 3 + c];
            for (let c = 0; c < 3; c++) g[c] = -(g[3 + c] + g[6 + c] + g[9 + c]);
            const K = this.ke.subarray(e * 144, e * 144 + 144);
            for (let a = 0; a < 4; a++) {
                for (let b = 0; b < 4; b++) {
                    const dot = g[a * 3] * g[b * 3] + g[a * 3 + 1] * g[b * 3 + 1] + g[a * 3 + 2] * g[b * 3 + 2];
                    for (let r = 0; r < 3; r++) {
                        for (let c = 0; c < 3; c++) {
                            const value = lambda * g[a * 3 + r] * g[b * 3 + c] + mu * g[b * 3 + r] * g[a * 3 + c] + (r === c ? mu * dot : 0);
                            K[(a * 3 + r) * 12 + b * 3 + c] = value * vol;
                        }
                    }
                }
            }
            const kr = this.keRest.subarray(e * 12, e * 12 + 12);
            for (let row = 0; row < 12; row++) {
                let s = 0;
                for (let col = 0; col < 12; col++) s += K[row * 12 + col] * X[this.tets[e * 4 + (col / 3 | 0)] * 3 + (col % 3)];
                kr[row] = s;
            }
            const m = (this.density * vol) / 4;
            for (let a = 0; a < 4; a++) this.mass[this.tets[e * 4 + a]] += m;
        }
    }

    get volumeRatio(): number {
        let volume = 0;
        for (let e = 0; e < this.tetCount; e++) {
            const t = this.tets;
            volume += this.signedVolume(t[e * 4], t[e * 4 + 1], t[e * 4 + 2], t[e * 4 + 3]);
        }
        return volume / this.restVolume;
    }

    /** Tetrahedra whose current volume is negative. */
    get invertedCount(): number {
        let count = 0;
        const t = this.tets;
        for (let e = 0; e < this.tetCount; e++) if (this.signedVolume(t[e * 4], t[e * 4 + 1], t[e * 4 + 2], t[e * 4 + 3]) < 0) count++;
        return count;
    }

    /** Sets every node's velocity to the rigid motion (linear v, angular ω about `centre`). */
    setRigidVelocity(vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, cx: number, cy: number, cz: number): void {
        for (let i = 0; i < this.nodeCount; i++) {
            const k = i * 3;
            const rx = this.x[k] - cx, ry = this.x[k + 1] - cy, rz = this.x[k + 2] - cz;
            this.v[k] = vx + wy * rz - wz * ry;
            this.v[k + 1] = vy + wz * rx - wx * rz;
            this.v[k + 2] = vz + wx * ry - wy * rx;
        }
    }

    /** Back to the rest shape, at rest. */
    reset(): void {
        this.x.set(this.rest);
        this.v.fill(0);
        this.released.fill(0);
        for (let e = 0; e < this.tetCount; e++) {
            this.quat[e * 4] = this.quat[e * 4 + 1] = this.quat[e * 4 + 2] = 0;
            this.quat[e * 4 + 3] = 1;
        }
        this.grabNode = -1;
    }

    grab(node: number): void {
        this.grabNode = node;
        this.grabTarget.x = this.x[node * 3];
        this.grabTarget.y = this.x[node * 3 + 1];
        this.grabTarget.z = this.x[node * 3 + 2];
    }

    moveGrab(x: number, y: number, z: number): void {
        this.grabTarget.x = x;
        this.grabTarget.y = Math.max(y, 0);
        this.grabTarget.z = z;
    }

    releaseGrab(): void {
        this.grabNode = -1;
    }

    unfix(): void {
        this.fixed.fill(0);
    }

    step(dt: number): void {
        const h = dt / this.substeps;
        for (let s = 0; s < this.substeps; s++) this.substep(h);
    }

    private substep(h: number): void {
        const n = this.nodeCount;
        const x = this.x;
        const v = this.v;
        this.assemble();

        // Right-hand side M v + h (f_el + f_ext); the system matrix is applied matrix-free from the blocks.
        const rhs = this.rhs;
        const f = this.force;
        for (let i = 0; i < n; i++) {
            const m = this.mass[i];
            rhs[i * 3] = m * v[i * 3] + h * f[i * 3];
            rhs[i * 3 + 1] = m * v[i * 3 + 1] + h * (f[i * 3 + 1] + m * this.gravity);
            rhs[i * 3 + 2] = m * v[i * 3 + 2] + h * f[i * 3 + 2];
        }
        // Dirichlet nodes: their velocity is known before the solve.
        const grab = this.grabNode;
        for (let i = 0; i < n; i++) if (this.fixed[i] && i !== grab) v[i * 3] = v[i * 3 + 1] = v[i * 3 + 2] = 0;
        if (grab >= 0) {
            const k = grab * 3;
            const maxSpeed = 8;
            let gx = (this.grabTarget.x - x[k]) / h, gy = (this.grabTarget.y - x[k + 1]) / h, gz = (this.grabTarget.z - x[k + 2]) / h;
            const speed = Math.hypot(gx, gy, gz);
            if (speed > maxSpeed) { gx *= maxSpeed / speed; gy *= maxSpeed / speed; gz *= maxSpeed / speed; }
            v[k] = gx; v[k + 1] = gy; v[k + 2] = gz;
        }
        this.findContacts();
        this.conjugateGradient(h);
        this.releaseContacts(h);

        for (let k = 0; k < n * 3; k++) x[k] += h * v[k];
        this.collide();
    }

    /**
     * Nodes resting on the ground or the sphere keep zero normal velocity inside
     * the solve (Baraff & Witkin 1998, filtered CG). Projecting them only after
     * the solve lets the implicit step sink the whole body every frame and crushes
     * the bottom layer of elements.
     */
    private findContacts(): void {
        const x = this.x;
        const v = this.v;
        const s = this.sphere;
        const eps = 1e-3;
        for (let i = 0; i < this.nodeCount; i++) {
            const k = i * 3;
            this.contact[i] = 0;
            if (this.isDirichlet(i)) continue;
            let nx = 0, ny = 0, nz = 0;
            if (x[k + 1] <= eps) {
                ny = 1;
            } else {
                const dx = x[k] - s.x, dy = x[k + 1] - s.y, dz = x[k + 2] - s.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > s.r + eps || d < 1e-9) {
                    this.released[i] = 0;
                    continue;
                }
                nx = dx / d; ny = dy / d; nz = dz / d;
            }
            if (this.released[i]) continue;
            const vn = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
            if (vn > 0) continue;
            this.contact[i] = 1;
            this.contactNormal[k] = nx; this.contactNormal[k + 1] = ny; this.contactNormal[k + 2] = nz;
            v[k] -= vn * nx; v[k + 1] -= vn * ny; v[k + 2] -= vn * nz;
        }
    }

    /** Contacts whose constraint force pulls the node in are let go next step; the rest get friction. */
    private releaseContacts(h: number): void {
        const v = this.v;
        const r = this.r;
        this.applyA(h, v, this.ap);
        const keep = 1 - this.friction;
        for (let i = 0; i < this.nodeCount; i++) {
            if (!this.contact[i]) continue;
            const k = i * 3;
            const nx = this.contactNormal[k], ny = this.contactNormal[k + 1], nz = this.contactNormal[k + 2];
            // Constraint force = A v − b along the normal.
            r[k] = this.ap[k] - this.rhs[k]; r[k + 1] = this.ap[k + 1] - this.rhs[k + 1]; r[k + 2] = this.ap[k + 2] - this.rhs[k + 2];
            const push = r[k] * nx + r[k + 1] * ny + r[k + 2] * nz;
            this.released[i] = push < 0 ? 1 : 0;
            const vn = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
            v[k] = vn * nx + (v[k] - vn * nx) * keep;
            v[k + 1] = vn * ny + (v[k + 1] - vn * ny) * keep;
            v[k + 2] = vn * nz + (v[k + 2] - vn * nz) * keep;
        }
    }

    /** Removes the constrained components: everything at Dirichlet nodes, the normal at contacts. */
    private filter(a: Float64Array): void {
        for (let i = 0; i < this.nodeCount; i++) {
            const k = i * 3;
            if (this.isDirichlet(i)) {
                a[k] = a[k + 1] = a[k + 2] = 0;
            } else if (this.contact[i]) {
                const nx = this.contactNormal[k], ny = this.contactNormal[k + 1], nz = this.contactNormal[k + 2];
                const d = a[k] * nx + a[k + 1] * ny + a[k + 2] * nz;
                a[k] -= d * nx; a[k + 1] -= d * ny; a[k + 2] -= d * nz;
            }
        }
    }

    /** Rotations, rotated stiffness blocks R K Rᵀ, and elastic forces −R K (Rᵀ x − X). */
    private assemble(): void {
        const x = this.x;
        const f = this.force;
        f.fill(0);
        this.blocks.fill(0);
        const R = scratchR;
        const tmp = scratchTmp;
        const y = scratchY;
        const tets = this.tets;
        const K = this.ke;
        const kr = this.keRest;
        const B = this.blocks;
        for (let e = 0; e < this.tetCount; e++) {
            const t = e * 4;
            if (this.corotated) {
                this.updateRotation(e);
                for (let k = 0; k < 9; k++) R[k] = this.rot[e * 9 + k];
            } else {
                R.fill(0);
                R[0] = R[4] = R[8] = 1;
            }
            const ko = e * 144;
            // y = Rᵀ x per node; force = −R (K y − K X).
            for (let a = 0; a < 4; a++) {
                const k = tets[t + a] * 3;
                const px = x[k], py = x[k + 1], pz = x[k + 2];
                y[a * 3] = R[0] * px + R[3] * py + R[6] * pz;
                y[a * 3 + 1] = R[1] * px + R[4] * py + R[7] * pz;
                y[a * 3 + 2] = R[2] * px + R[5] * py + R[8] * pz;
            }
            for (let a = 0; a < 4; a++) {
                let fx = 0, fy = 0, fz = 0;
                const row = ko + a * 36;
                for (let col = 0; col < 12; col++) {
                    const yc = y[col];
                    fx += K[row + col] * yc;
                    fy += K[row + 12 + col] * yc;
                    fz += K[row + 24 + col] * yc;
                }
                fx -= kr[e * 12 + a * 3]; fy -= kr[e * 12 + a * 3 + 1]; fz -= kr[e * 12 + a * 3 + 2];
                const k = tets[t + a] * 3;
                f[k] -= R[0] * fx + R[1] * fy + R[2] * fz;
                f[k + 1] -= R[3] * fx + R[4] * fy + R[5] * fz;
                f[k + 2] -= R[6] * fx + R[7] * fy + R[8] * fz;
            }
            // Blocks R K_ab Rᵀ (R row-major: R[r*3+c]); block (b, a) is the transpose of (a, b).
            for (let a = 0; a < 4; a++) {
                for (let b = a; b < 4; b++) {
                    // tmp = K_ab Rᵀ
                    for (let r = 0; r < 3; r++) {
                        const kb = ko + (a * 3 + r) * 12 + b * 3;
                        const k0 = K[kb], k1 = K[kb + 1], k2 = K[kb + 2];
                        for (let c = 0; c < 3; c++) tmp[r * 3 + c] = k0 * R[c * 3] + k1 * R[c * 3 + 1] + k2 * R[c * 3 + 2];
                    }
                    const q = this.tetBlock[e * 16 + a * 4 + b] * 9;
                    const qt = this.tetBlock[e * 16 + b * 4 + a] * 9;
                    for (let r = 0; r < 3; r++) {
                        const r0 = R[r * 3], r1 = R[r * 3 + 1], r2 = R[r * 3 + 2];
                        for (let c = 0; c < 3; c++) {
                            const value = r0 * tmp[c] + r1 * tmp[3 + c] + r2 * tmp[6 + c];
                            B[q + r * 3 + c] += value;
                            if (b !== a) B[qt + c * 3 + r] += value;
                        }
                    }
                }
            }
        }
    }

    /** Polar rotation of the element's deformation gradient, iterated from last step's quaternion. */
    private updateRotation(e: number): void {
        const x = this.x;
        const t = this.tets;
        const i0 = t[e * 4] * 3, i1 = t[e * 4 + 1] * 3, i2 = t[e * 4 + 2] * 3, i3 = t[e * 4 + 3] * 3;
        const ds = scratchDs;
        ds[0] = x[i1] - x[i0]; ds[1] = x[i2] - x[i0]; ds[2] = x[i3] - x[i0];
        ds[3] = x[i1 + 1] - x[i0 + 1]; ds[4] = x[i2 + 1] - x[i0 + 1]; ds[5] = x[i3 + 1] - x[i0 + 1];
        ds[6] = x[i1 + 2] - x[i0 + 2]; ds[7] = x[i2 + 2] - x[i0 + 2]; ds[8] = x[i3 + 2] - x[i0 + 2];
        const m = this.dmInv;
        const o = e * 9;
        // F = Ds Dm⁻¹, row-major.
        const F = scratchF;
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) F[r * 3 + c] = ds[r * 3] * m[o + c] + ds[r * 3 + 1] * m[o + 3 + c] + ds[r * 3 + 2] * m[o + 6 + c];
        }
        const q = this.quat;
        const qo = e * 4;
        let qx = q[qo], qy = q[qo + 1], qz = q[qo + 2], qw = q[qo + 3];
        const R = this.rot;
        for (let it = 0; it < 3; it++) {
            quatToMatrix(qx, qy, qz, qw, R, o);
            // ω = Σ r_i × a_i / |Σ r_i · a_i| over the columns of R and F.
            let wx = 0, wy = 0, wz = 0, dot = 0;
            for (let c = 0; c < 3; c++) {
                const rx = R[o + c], ry = R[o + 3 + c], rz = R[o + 6 + c];
                const ax = F[c], ay = F[3 + c], az = F[6 + c];
                wx += ry * az - rz * ay;
                wy += rz * ax - rx * az;
                wz += rx * ay - ry * ax;
                dot += rx * ax + ry * ay + rz * az;
            }
            const s = 1 / (Math.abs(dot) + 1e-9);
            wx *= s; wy *= s; wz *= s;
            const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
            if (w < 1e-6) break;
            const half = 0.5 * Math.min(w, 1);
            const sn = Math.sin(half) / w;
            const ax = wx * sn, ay = wy * sn, az = wz * sn, aw = Math.cos(half);
            // q = Δq · q
            const nx = aw * qx + ax * qw + ay * qz - az * qy;
            const ny = aw * qy - ax * qz + ay * qw + az * qx;
            const nz = aw * qz + ax * qy - ay * qx + az * qw;
            const nw = aw * qw - ax * qx - ay * qy - az * qz;
            const len = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
            qx = nx * len; qy = ny * len; qz = nz * len; qw = nw * len;
        }
        q[qo] = qx; q[qo + 1] = qy; q[qo + 2] = qz; q[qo + 3] = qw;
        quatToMatrix(qx, qy, qz, qw, R, o);
    }

    /** A p = M (1 + hα) p + (h² + hβ) K' p, with Dirichlet rows and columns removed. */
    private applyA(h: number, p: Float64Array, out: Float64Array): void {
        const n = this.nodeCount;
        const mScale = 1 + h * this.massDamping;
        const kScale = h * h + h * this.stiffnessDamping;
        const B = this.blocks;
        for (let i = 0; i < n; i++) {
            let sx = 0, sy = 0, sz = 0;
            for (let q = this.rowStart[i]; q < this.rowStart[i + 1]; q++) {
                const c = this.blockCol[q] * 3;
                const px = p[c], py = p[c + 1], pz = p[c + 2];
                const b = q * 9;
                sx += B[b] * px + B[b + 1] * py + B[b + 2] * pz;
                sy += B[b + 3] * px + B[b + 4] * py + B[b + 5] * pz;
                sz += B[b + 6] * px + B[b + 7] * py + B[b + 8] * pz;
            }
            const m = this.mass[i] * mScale;
            out[i * 3] = m * p[i * 3] + kScale * sx;
            out[i * 3 + 1] = m * p[i * 3 + 1] + kScale * sy;
            out[i * 3 + 2] = m * p[i * 3 + 2] + kScale * sz;
        }
    }

    private isDirichlet(i: number): boolean {
        return this.fixed[i] === 1 || i === this.grabNode;
    }

    private conjugateGradient(h: number): void {
        const n3 = this.nodeCount * 3;
        const v = this.v;
        const r = this.r;
        const p = this.p;
        const ap = this.ap;
        this.applyA(h, v, ap);
        for (let k = 0; k < n3; k++) r[k] = this.rhs[k] - ap[k];
        this.filter(r);
        p.set(r);
        let rr = dot(r, r);
        const rr0 = rr;
        let it = 0;
        for (; it < this.cgIterations && rr > this.cgTolerance * this.cgTolerance * rr0 && rr > 1e-30; it++) {
            this.applyA(h, p, ap);
            this.filter(ap);
            const alpha = rr / dot(p, ap);
            for (let k = 0; k < n3; k++) {
                v[k] += alpha * p[k];
                r[k] -= alpha * ap[k];
            }
            const rrNew = dot(r, r);
            const beta = rrNew / rr;
            rr = rrNew;
            for (let k = 0; k < n3; k++) p[k] = r[k] + beta * p[k];
        }
        this.lastIterations = it;
        this.lastResidual = rr0 > 0 ? Math.sqrt(rr / rr0) : 0;
    }

    /** Ground and sphere: push out, remove the approaching normal velocity, and damp the tangential part. */
    private collide(): void {
        const x = this.x;
        const v = this.v;
        const s = this.sphere;
        const keep = 1 - this.friction;
        for (let i = 0; i < this.nodeCount; i++) {
            if (this.isDirichlet(i)) continue;
            const k = i * 3;
            if (x[k + 1] < 0) {
                x[k + 1] = 0;
                if (v[k + 1] < 0) v[k + 1] = 0;
                v[k] *= keep;
                v[k + 2] *= keep;
            }
            const dx = x[k] - s.x, dy = x[k + 1] - s.y, dz = x[k + 2] - s.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < s.r * s.r && d2 > 1e-12) {
                const d = Math.sqrt(d2);
                const nx = dx / d, ny = dy / d, nz = dz / d;
                x[k] = s.x + nx * s.r; x[k + 1] = s.y + ny * s.r; x[k + 2] = s.z + nz * s.r;
                const vn = v[k] * nx + v[k + 1] * ny + v[k + 2] * nz;
                const tx = v[k] - vn * nx, ty = v[k + 1] - vn * ny, tz = v[k + 2] - vn * nz;
                const n = Math.max(vn, 0);
                v[k] = n * nx + tx * keep; v[k + 1] = n * ny + ty * keep; v[k + 2] = n * nz + tz * keep;
            }
        }
    }

    private signedVolume(a: number, b: number, c: number, d: number): number {
        const X = this.x.length ? this.x : this.rest;
        const ax = X[a * 3], ay = X[a * 3 + 1], az = X[a * 3 + 2];
        const ux = X[b * 3] - ax, uy = X[b * 3 + 1] - ay, uz = X[b * 3 + 2] - az;
        const vx = X[c * 3] - ax, vy = X[c * 3 + 1] - ay, vz = X[c * 3 + 2] - az;
        const wx = X[d * 3] - ax, wy = X[d * 3 + 1] - ay, wz = X[d * 3 + 2] - az;
        return (ux * (vy * wz - vz * wy) - uy * (vx * wz - vz * wx) + uz * (vx * wy - vy * wx)) / 6;
    }

    /** Faces used by one tetrahedron only, wound so the normal points away from the fourth node. */
    private buildSurface(): Uint32Array {
        const count = new Map<string, { face: number[]; n: number }>();
        const t = this.tets;
        for (let e = 0; e < this.tetCount; e++) {
            const n = [t[e * 4], t[e * 4 + 1], t[e * 4 + 2], t[e * 4 + 3]];
            // Positive tetrahedra (a, b, c, d): these windings face outwards.
            const faces = [[n[0], n[2], n[1]], [n[0], n[1], n[3]], [n[1], n[2], n[3]], [n[0], n[3], n[2]]];
            for (const face of faces) {
                const key = [...face].sort((a, b) => a - b).join(',');
                const entry = count.get(key);
                if (entry) entry.n++;
                else count.set(key, { face, n: 1 });
            }
        }
        const out: number[] = [];
        for (const { face, n } of count.values()) if (n === 1) out.push(...face);
        return Uint32Array.from(out);
    }
}

const scratchR = new Float64Array(9);
const scratchTmp = new Float64Array(9);
const scratchY = new Float64Array(12);
const scratchDs = new Float64Array(9);
const scratchF = new Float64Array(9);

function dot(a: Float64Array, b: Float64Array): number {
    let s = 0;
    for (let k = 0; k < a.length; k++) s += a[k] * b[k];
    return s;
}

/** Inverse of a row-major 3×3 matrix into `out`; returns the determinant. */
function invert3(m: ArrayLike<number>, out: Float64Array): number {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const inv = 1 / det;
    out[0] = A * inv; out[1] = -(b * i - c * h) * inv; out[2] = (b * f - c * e) * inv;
    out[3] = B * inv; out[4] = (a * i - c * g) * inv; out[5] = -(a * f - c * d) * inv;
    out[6] = C * inv; out[7] = -(a * h - b * g) * inv; out[8] = (a * e - b * d) * inv;
    return det;
}

/** Row-major rotation matrix of a unit quaternion, written at `out[o…o+8]`. */
function quatToMatrix(x: number, y: number, z: number, w: number, out: Float64Array, o: number): void {
    out[o] = 1 - 2 * (y * y + z * z); out[o + 1] = 2 * (x * y - z * w); out[o + 2] = 2 * (x * z + y * w);
    out[o + 3] = 2 * (x * y + z * w); out[o + 4] = 1 - 2 * (x * x + z * z); out[o + 5] = 2 * (y * z - x * w);
    out[o + 6] = 2 * (x * z - y * w); out[o + 7] = 2 * (y * z + x * w); out[o + 8] = 1 - 2 * (x * x + y * y);
}
