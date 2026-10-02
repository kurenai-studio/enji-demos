import { Material, Mesh, MeshRenderer, Node, primitives, utils, Vec3, Vec4 } from 'cc';
import { loadEffect, updateDynamicMesh } from '../../enji/helpers';
import { FemBody, type BlockLayout } from './FemBody';

export type Preset = 'beams' | 'spin' | 'jelly';
const PRESETS: Preset[] = ['beams', 'spin', 'jelly'];

export const STIFFNESS = [
    { name: 'Soft', scale: 0.4 },
    { name: 'Medium', scale: 1 },
    { name: 'Stiff', scale: 2.5 },
];
export const CG_ITERATIONS = [5, 10, 20, 40];

const LIGHT = new Vec4(0.4, 0.8, 0.45, 0);
const BLUE = new Vec4(0.3, 0.55, 0.95, 1);
const ORANGE = new Vec4(0.95, 0.55, 0.25, 1);
const JELLY = [new Vec4(0.95, 0.45, 0.62, 1), new Vec4(0.45, 0.82, 0.5, 1), new Vec4(0.98, 0.8, 0.3, 1)];
const SPIN_PERIOD = 1.8;
/** Cantilever root: the beams are clamped to a wall at this x. */
const WALL_X = -0.6;
const BEAM_Y = 1.2;

interface Body {
    fem: FemBody;
    label: string;
    renderer: MeshRenderer;
    geometry: primitives.IDynamicGeometry;
    /** Surface vertex → FEM node. */
    nodeOf: Uint32Array;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint16Array;
    minPos: Vec3;
    maxPos: Vec3;
    /** Node at the free end of a beam, for the tip drop readout. */
    tip: number;
    tipRestY: number;
    youngModulus: number;
}

export interface SoftPick {
    body: number;
    node: number;
    t: number;
}

/**
 * Soft-body scenes on FemBody: two cantilever beams (linear vs co-rotated), two
 * cubes spinning in zero gravity (linear inflates, co-rotated does not), and
 * co-rotated jelly blocks dropped on the ground and a ball. Every body streams
 * its surface into a dynamic mesh each frame.
 */
export class SoftScene {
    preset: Preset = 'beams';
    paused = false;
    lite = false;
    stiffness = 1;
    cgLevel = 2;
    /** Jelly scene only: false runs plain linear FEM on every block. */
    corotated = true;
    simMs = 0;
    readonly bodies: Body[] = [];
    readonly sphere = { x: 0, y: 0.3, z: 0.05, r: 0.3 };

    private readonly renderers: MeshRenderer[] = [];
    private readonly sphereNode: Node;
    private readonly wallNode: Node;
    private readonly sphereUniform = new Vec4();
    private readonly blobUniform = new Vec4();
    private grabBody = -1;
    private time = 0;

    private constructor(
        private readonly parent: Node,
        private readonly bodyMaterial: Material,
        private readonly groundMaterial: Material,
        sphereMaterial: Material,
    ) {
        const ground = new Node('Ground');
        parent.addChild(ground);
        ground.addComponent(MeshRenderer).mesh = utils.MeshUtils.createMesh(primitives.plane({ width: 40, length: 40, widthSegments: 1, lengthSegments: 1 }));
        ground.getComponent(MeshRenderer)!.setSharedMaterial(groundMaterial, 0);

        this.sphereNode = new Node('Sphere');
        parent.addChild(this.sphereNode);
        const sphereRenderer = this.sphereNode.addComponent(MeshRenderer);
        sphereRenderer.mesh = utils.MeshUtils.createMesh(primitives.sphere(1, { segments: 32 }));
        sphereRenderer.setSharedMaterial(sphereMaterial, 0);

        this.wallNode = new Node('Wall');
        parent.addChild(this.wallNode);
        const wallRenderer = this.wallNode.addComponent(MeshRenderer);
        wallRenderer.mesh = utils.MeshUtils.createMesh(primitives.box({ width: 0.08, height: BEAM_Y + 0.6, length: 1.4 }));
        wallRenderer.setSharedMaterial(sphereMaterial, 0);
        wallRenderer.material!.setProperty('baseColor', new Vec4(0.55, 0.57, 0.62, 1));
        this.wallNode.setPosition(WALL_X - 0.04, (BEAM_Y + 0.6) / 2, 0);
    }

    static async create(parent: Node): Promise<SoftScene> {
        const effect = await loadEffect('effects/soft-lit');
        const body = new Material();
        body.initialize({ effectAsset: effect });
        body.setProperty('lightDir', LIGHT);
        const ground = new Material();
        ground.initialize({ effectAsset: effect, defines: { USE_GRID: true } });
        ground.setProperty('lightDir', LIGHT);
        ground.setProperty('baseColor', new Vec4(0.52, 0.54, 0.58, 1));
        const sphere = new Material();
        sphere.initialize({ effectAsset: effect });
        sphere.setProperty('lightDir', LIGHT);
        sphere.setProperty('baseColor', new Vec4(0.25, 0.3, 0.38, 1));
        const scene = new SoftScene(parent, body, ground, sphere);
        scene.rebuild();
        return scene;
    }

    get tetCount(): number {
        return this.bodies.reduce((sum, b) => sum + b.fem.tetCount, 0);
    }

    get nodeCount(): number {
        return this.bodies.reduce((sum, b) => sum + b.fem.nodeCount, 0);
    }

    get cgUsed(): number {
        return this.bodies.reduce((most, b) => Math.max(most, b.fem.lastIterations), 0);
    }

    get spinTime(): number {
        return this.time;
    }

    /** Tip drop below the rest height, metres (beams scene). */
    tipDrop(body: Body): number {
        return body.tip >= 0 ? body.tipRestY - body.fem.x[body.tip * 3 + 1] : 0;
    }

    cyclePreset(): void {
        this.preset = PRESETS[(PRESETS.indexOf(this.preset) + 1) % PRESETS.length];
        this.rebuild();
    }

    cycleStiffness(): void {
        this.stiffness = (this.stiffness + 1) % STIFFNESS.length;
        this.applySettings(true);
    }

    cycleCg(): void {
        this.cgLevel = (this.cgLevel + 1) % CG_ITERATIONS.length;
        this.applySettings(false);
    }

    toggleMethod(): void {
        this.corotated = !this.corotated;
        this.applySettings(false);
    }

    setLite(lite: boolean): void {
        this.lite = lite;
        this.rebuild();
    }

    rebuild(): void {
        this.releaseGrab();
        this.time = 0;
        this.bodies.length = 0;
        const lite = this.lite;
        const specs: { layout: BlockLayout; label: string; colour: Vec4; E: number; corotated?: boolean }[] = [];
        if (this.preset === 'beams') {
            const [nx, n, cell] = lite ? [10, 2, 0.12] : [15, 3, 0.08];
            const fixed = (i: number) => i === 0;
            for (const [z, corotated] of [[-0.35, false], [0.35, true]] as const) {
                specs.push({
                    layout: { nx, ny: n, nz: n, cell, origin: [WALL_X, BEAM_Y - (n * cell) / 2, z - (n * cell) / 2], fixed },
                    label: corotated ? 'Orange co-rotated' : 'Blue linear',
                    colour: corotated ? ORANGE : BLUE,
                    E: 4e5,
                    corotated,
                });
            }
        } else if (this.preset === 'spin') {
            const [n, cell] = lite ? [3, 0.13] : [5, 0.08];
            const half = (n * cell) / 2;
            for (const [x, corotated] of [[-0.5, false], [0.5, true]] as const) {
                specs.push({
                    layout: { nx: n, ny: n, nz: n, cell, origin: [x - half, 1.1 - half, -half] },
                    label: corotated ? 'Orange co-rotated' : 'Blue linear',
                    colour: corotated ? ORANGE : BLUE,
                    E: 1e5,
                    corotated,
                });
            }
        } else {
            const [n, cell] = lite ? [3, 0.11] : [4, 0.08];
            const half = (n * cell) / 2;
            const drops: [number, number, number, number][] = [[-0.62, 0.55, 0.1, 3e4], [0.02, 1.0, 0.0, 8e4], [0.62, 0.7, -0.1, 2.5e5]];
            drops.forEach(([x, y, z, E], i) => specs.push({
                layout: { nx: n, ny: n, nz: n, cell, origin: [x - half, y, z - half] },
                label: ['Pink', 'Green', 'Yellow'][i],
                colour: JELLY[i],
                E,
            }));
        }

        specs.forEach((spec, slot) => this.bodies.push(this.makeBody(spec.layout, spec.label, spec.colour, spec.E, slot, spec.corotated)));
        for (let slot = specs.length; slot < this.renderers.length; slot++) this.renderers[slot].node.active = false;

        if (this.preset === 'jelly') {
            // Tilt each block so it lands on an edge.
            this.bodies.forEach((b, i) => rotateBody(b.fem, [0.5, 0.35, -0.6][i], [0.3, -0.4, 0.2][i]));
        }
        if (this.preset === 'spin') this.launchSpin();
        this.sphereNode.active = this.preset === 'jelly';
        this.wallNode.active = this.preset === 'beams';
        this.applySettings(true);
        this.syncSphere();
        this.syncMeshes();
    }

    update(dt: number): void {
        if (this.paused || this.bodies.length === 0) return;
        const h = Math.min(dt, 1 / 30);
        this.time += h;
        if (this.preset === 'spin' && this.time > SPIN_PERIOD) {
            this.time = 0;
            for (const b of this.bodies) b.fem.reset();
            this.launchSpin();
        }
        const t0 = performance.now();
        for (const b of this.bodies) b.fem.step(h);
        const ms = performance.now() - t0;
        this.simMs = this.simMs === 0 ? ms : this.simMs * 0.9 + ms * 0.1;
        this.syncMeshes();
    }

    /** Nearest surface node within reach of the ray, by distance along it. */
    pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: SoftPick): boolean {
        const reach = 0.12;
        out.body = -1;
        out.t = Infinity;
        this.bodies.forEach((b, bi) => {
            const x = b.fem.x;
            for (let v = 0; v < b.nodeOf.length; v++) {
                const k = b.nodeOf[v] * 3;
                const px = x[k] - ox, py = x[k + 1] - oy, pz = x[k + 2] - oz;
                const t = px * dx + py * dy + pz * dz;
                if (t <= 0 || t > out.t) continue;
                const qx = px - t * dx, qy = py - t * dy, qz = pz - t * dz;
                if (qx * qx + qy * qy + qz * qz > reach * reach) continue;
                out.body = bi;
                out.node = b.nodeOf[v];
                out.t = t;
            }
        });
        return out.body >= 0;
    }

    grab(pick: SoftPick, hit: Vec3): void {
        const body = this.bodies[pick.body];
        if (!body) return;
        this.grabBody = pick.body;
        body.fem.grab(pick.node);
        const k = pick.node * 3;
        hit.set(body.fem.x[k], body.fem.x[k + 1], body.fem.x[k + 2]);
    }

    moveGrab(x: number, y: number, z: number): void {
        if (this.grabBody >= 0) this.bodies[this.grabBody].fem.moveGrab(x, y, z);
    }

    releaseGrab(): void {
        if (this.grabBody >= 0) this.bodies[this.grabBody]?.fem.releaseGrab();
        this.grabBody = -1;
    }

    get sphereActive(): boolean {
        return this.preset === 'jelly';
    }

    moveSphere(x: number, y: number, z: number): void {
        this.sphere.x = x;
        this.sphere.y = Math.max(y, this.sphere.r);
        this.sphere.z = z;
        this.syncSphere();
    }

    private launchSpin(): void {
        for (const b of this.bodies) {
            const c = centroid(b.fem);
            b.fem.setRigidVelocity(0, 0, 0, 0.36, 1.5, 0.18, c[0], c[1], c[2]);
        }
    }

    private applySettings(rebuildStiffness: boolean): void {
        const scale = STIFFNESS[this.stiffness].scale;
        for (const b of this.bodies) {
            const fem = b.fem;
            if (rebuildStiffness) {
                fem.youngModulus = b.youngModulus * scale;
                fem.rebuildStiffness();
            }
            fem.cgIterations = CG_ITERATIONS[this.cgLevel];
            if (this.preset === 'jelly') fem.corotated = this.corotated;
        }
    }

    private makeBody(layout: BlockLayout, label: string, colour: Vec4, E: number, slot: number, corotated?: boolean): Body {
        const fem = new FemBody(layout);
        fem.youngModulus = E;
        if (corotated !== undefined) fem.corotated = corotated;
        if (this.preset === 'spin') {
            fem.gravity = 0;
            fem.massDamping = 0;
        }
        const s = this.sphere;
        if (this.preset === 'jelly') Object.assign(fem.sphere, s);

        // Surface vertices: the distinct nodes used by boundary triangles.
        const remap = new Map<number, number>();
        const nodes: number[] = [];
        const indices = new Uint16Array(fem.surface.length);
        fem.surface.forEach((node, i) => {
            let v = remap.get(node);
            if (v === undefined) {
                v = nodes.length;
                remap.set(node, v);
                nodes.push(node);
            }
            indices[i] = v;
        });
        const nodeOf = Uint32Array.from(nodes);
        const positions = new Float32Array(nodes.length * 3);
        const normals = new Float32Array(nodes.length * 3);

        let renderer = this.renderers[slot];
        if (!renderer) {
            const node = new Node(`Soft${slot}`);
            this.parent.addChild(node);
            renderer = node.addComponent(MeshRenderer);
            renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            renderer.setSharedMaterial(this.bodyMaterial, 0);
            this.renderers[slot] = renderer;
        }
        renderer.node.active = true;
        renderer.material!.setProperty('baseColor', colour);
        const minPos = new Vec3();
        const maxPos = new Vec3();
        const geometry: primitives.IDynamicGeometry = { positions, normals, indices16: indices, minPos, maxPos };
        const body: Body = { fem, label, renderer, geometry, nodeOf, positions, normals, indices, minPos, maxPos, tip: -1, tipRestY: 0, youngModulus: E };
        this.writeSurface(body);
        const mesh: Mesh = utils.MeshUtils.createDynamicMesh(0, geometry, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: nodes.length,
            maxSubMeshIndices: indices.length,
        });
        const old = renderer.mesh;
        renderer.mesh = mesh;
        old?.destroy();

        if (layout.fixed) {
            // Free end, centre of the cross-section (or the nearest node to it).
            const sx = layout.nx + 1, sy = layout.ny + 1;
            const tip = layout.nx + sx * ((layout.ny >> 1) + sy * (layout.nz >> 1));
            body.tip = tip;
            body.tipRestY = fem.rest[tip * 3 + 1];
        }
        return body;
    }

    private syncMeshes(): void {
        const blobs = ['blob0', 'blob1', 'blob2', 'blob3'];
        this.bodies.forEach((b, i) => {
            this.writeSurface(b);
            updateDynamicMesh(b.renderer, b.geometry);
            if (i < blobs.length) {
                const r = Math.max(b.maxPos.x - b.minPos.x, b.maxPos.z - b.minPos.z) * 0.6;
                this.blobUniform.set((b.minPos.x + b.maxPos.x) / 2, r, (b.minPos.z + b.maxPos.z) / 2, Math.max(b.minPos.y, 0));
                this.groundMaterial.setProperty(blobs[i], this.blobUniform);
            }
        });
        for (let i = this.bodies.length; i < blobs.length; i++) this.groundMaterial.setProperty(blobs[i], this.blobUniform.set(0, 0, 0, 0));
    }

    /** Positions, area-weighted normals and bounds of the surface. */
    private writeSurface(b: Body): void {
        const x = b.fem.x;
        const p = b.positions;
        const nrm = b.normals;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let v = 0; v < b.nodeOf.length; v++) {
            const k = b.nodeOf[v] * 3;
            const px = x[k], py = x[k + 1], pz = x[k + 2];
            p[v * 3] = px; p[v * 3 + 1] = py; p[v * 3 + 2] = pz;
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
        }
        nrm.fill(0);
        const idx = b.indices;
        for (let t = 0; t < idx.length; t += 3) {
            const a = idx[t] * 3, c = idx[t + 1] * 3, d = idx[t + 2] * 3;
            const ux = p[c] - p[a], uy = p[c + 1] - p[a + 1], uz = p[c + 2] - p[a + 2];
            const vx = p[d] - p[a], vy = p[d + 1] - p[a + 1], vz = p[d + 2] - p[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            for (const o of [a, c, d]) { nrm[o] += nx; nrm[o + 1] += ny; nrm[o + 2] += nz; }
        }
        b.minPos.set(minX, minY, minZ);
        b.maxPos.set(maxX, maxY, maxZ);
    }

    private syncSphere(): void {
        const s = this.sphere;
        this.sphereNode.setPosition(s.x, s.y, s.z);
        this.sphereNode.setScale(s.r, s.r, s.r);
        const active = this.preset === 'jelly';
        for (const b of this.bodies) {
            Object.assign(b.fem.sphere, s);
            if (!active) b.fem.sphere.y = -10;
        }
        this.groundMaterial.setProperty('sphere', active ? this.sphereUniform.set(s.x, s.y, s.z, s.r) : this.sphereUniform.set(0, -10, 0, 0.01));
    }
}

function centroid(fem: FemBody): [number, number, number] {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < fem.nodeCount; i++) {
        x += fem.x[i * 3]; y += fem.x[i * 3 + 1]; z += fem.x[i * 3 + 2];
    }
    return [x / fem.nodeCount, y / fem.nodeCount, z / fem.nodeCount];
}

/** Rotates the current shape about its centroid (x axis, then z axis). The rest shape stays put. */
function rotateBody(fem: FemBody, ax: number, az: number): void {
    const [cx, cy, cz] = centroid(fem);
    const ca = Math.cos(ax), sa = Math.sin(ax), cb = Math.cos(az), sb = Math.sin(az);
    for (let i = 0; i < fem.nodeCount; i++) {
        const k = i * 3;
        const px = fem.x[k] - cx;
        let py = fem.x[k + 1] - cy;
        let pz = fem.x[k + 2] - cz;
        [py, pz] = [ca * py - sa * pz, sa * py + ca * pz];
        fem.x[k] = cx + cb * px - sb * py;
        fem.x[k + 1] = cy + sb * px + cb * py;
        fem.x[k + 2] = cz + pz;
    }
}
