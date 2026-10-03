import { Material, Mesh, MeshRenderer, Node, primitives, utils } from 'cc';
import { updateDynamicMesh } from '../../enji/helpers';
import { Shape } from './RigidBody';
import type { RigidBody } from './RigidBody';
import { BALL_POOL, DRIFT_LIMIT } from './World';
import type { World } from './World';

const BOX_VERTS = 24;
const BOX_INDICES = 36;
const SPHERE_SEGMENTS = 12;
const SPHERE_RINGS = 8;
const SPHERE_VERTS = (SPHERE_SEGMENTS + 1) * (SPHERE_RINGS + 1);
const SPHERE_INDICES = SPHERE_SEGMENTS * SPHERE_RINGS * 6;
/** Tracked bodies blend to this colour as they drift past DRIFT_LIMIT. */
const DRIFT_COLOR = [0.95, 0.18, 0.2] as const;
const DRIFT_RAMP = 0.1;

/** Unit sphere template; one quadrant is darker so rolling shows. */
const sphereUnit = new Float32Array(SPHERE_VERTS * 3);
const sphereShade = new Float32Array(SPHERE_VERTS);
const sphereIndex = new Uint16Array(SPHERE_INDICES);
{
    let v = 0;
    for (let r = 0; r <= SPHERE_RINGS; r++) {
        const phi = (r / SPHERE_RINGS) * Math.PI;
        for (let s = 0; s <= SPHERE_SEGMENTS; s++) {
            const theta = (s / SPHERE_SEGMENTS) * Math.PI * 2;
            const x = Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
            sphereUnit.set([x, y, z], v * 3);
            sphereShade[v] = s < SPHERE_SEGMENTS / 4 || (s >= SPHERE_SEGMENTS / 2 && s < (3 * SPHERE_SEGMENTS) / 4) ? 0.55 : 1;
            v++;
        }
    }
    let i = 0;
    for (let r = 0; r < SPHERE_RINGS; r++) {
        for (let s = 0; s < SPHERE_SEGMENTS; s++) {
            const a = r * (SPHERE_SEGMENTS + 1) + s, b = a + SPHERE_SEGMENTS + 1;
            sphereIndex.set([a, a + 1, b, a + 1, b + 1, b], i);
            i += 6;
        }
    }
}

/** Box faces: normal axis, sign, and the four corner sign triples (counter-clockwise from outside). */
const FACES: { axis: number; sign: number; corners: [number, number, number][] }[] = [
    { axis: 0, sign: 1, corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
    { axis: 0, sign: -1, corners: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
    { axis: 1, sign: 1, corners: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
    { axis: 1, sign: -1, corners: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
    { axis: 2, sign: 1, corners: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
    { axis: 2, sign: -1, corners: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];

interface Slot {
    world: World;
    /** World x offset of this copy. */
    offset: number;
    /** Bodies present at rebuild (planes skipped). */
    bodies: RigidBody[];
    /** Index in world.bodies where pooled balls start. */
    ballStart: number;
}

/**
 * All bodies of every world in one dynamic mesh (one draw call plus the shadow
 * pass), rebuilt on CPU each frame from positions and rotation matrices.
 */
export class RigidView {
    private readonly root: Node;
    private readonly material: Material;
    private node: Node | null = null;
    private renderer: MeshRenderer | null = null;
    private geometry: primitives.IDynamicGeometry | null = null;
    private slots: Slot[] = [];

    constructor(parent: Node, material: Material) {
        this.root = new Node('RigidBodies');
        parent.addChild(this.root);
        this.material = material;
    }

    rebuild(worlds: World[], offsets: number[]): void {
        this.node?.destroy();
        this.slots = worlds.map((world, i) => ({
            world,
            offset: offsets[i],
            bodies: world.bodies.filter((b) => b.shape !== Shape.Plane),
            ballStart: world.bodies.length,
        }));
        let vertices = 0, indices = 0, minX = Infinity, maxX = -Infinity;
        for (const slot of this.slots) {
            for (const b of slot.bodies) {
                vertices += b.shape === Shape.Box ? BOX_VERTS : SPHERE_VERTS;
                indices += b.shape === Shape.Box ? BOX_INDICES : SPHERE_INDICES;
            }
            vertices += BALL_POOL * SPHERE_VERTS;
            indices += BALL_POOL * SPHERE_INDICES;
            minX = Math.min(minX, slot.offset - 8);
            maxX = Math.max(maxX, slot.offset + 8);
        }
        const index = new Uint16Array(indices);
        let v = 0, k = 0;
        const addBox = (): void => {
            for (let f = 0; f < 6; f++) {
                const base = v + f * 4;
                index.set([base, base + 1, base + 2, base, base + 2, base + 3], k);
                k += 6;
            }
            v += BOX_VERTS;
        };
        const addSphere = (): void => {
            for (let i = 0; i < SPHERE_INDICES; i++) index[k + i] = sphereIndex[i] + v;
            k += SPHERE_INDICES;
            v += SPHERE_VERTS;
        };
        for (const slot of this.slots) {
            for (const b of slot.bodies) {
                if (b.shape === Shape.Box) addBox();
                else addSphere();
            }
            for (let i = 0; i < BALL_POOL; i++) addSphere();
        }
        this.geometry = {
            positions: new Float32Array(vertices * 3),
            normals: new Float32Array(vertices * 3),
            colors: new Float32Array(vertices * 4),
            indices16: index,
            minPos: { x: minX, y: -1, z: -8 },
            maxPos: { x: maxX, y: 8, z: 8 },
        };
        this.node = new Node('Bodies');
        this.root.addChild(this.node);
        this.renderer = this.node.addComponent(MeshRenderer);
        const mesh: Mesh = utils.MeshUtils.createDynamicMesh(0, this.geometry, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: vertices,
            maxSubMeshIndices: indices,
        });
        this.renderer.mesh = mesh;
        this.renderer.setSharedMaterial(this.material, 0);
        this.renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
        this.renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.ON;
        this.update();
    }

    update(): void {
        const g = this.geometry;
        if (!g || !this.renderer) return;
        const pos = g.positions as Float32Array, nor = g.normals as Float32Array, col = g.colors as Float32Array;
        let v = 0;
        for (const slot of this.slots) {
            for (const b of slot.bodies) v = b.shape === Shape.Box ? writeBox(b, slot.offset, v, pos, nor, col) : writeSphere(b, slot.offset, v, pos, nor, col);
            for (let i = 0; i < BALL_POOL; i++) {
                const ball = slot.world.bodies[slot.ballStart + i];
                if (ball) v = writeSphere(ball, slot.offset, v, pos, nor, col);
                else {
                    // Unused pool slot: collapse it below the ground.
                    for (let j = 0; j < SPHERE_VERTS; j++) {
                        pos[(v + j) * 3] = slot.offset; pos[(v + j) * 3 + 1] = -5; pos[(v + j) * 3 + 2] = 0;
                    }
                    v += SPHERE_VERTS;
                }
            }
        }
        updateDynamicMesh(this.renderer, g);
    }
}

function bodyColor(b: RigidBody, out: number[]): number[] {
    let t = 0;
    if (b.group) {
        const dx = b.p.x - b.restPosition.x, dy = b.p.y - b.restPosition.y, dz = b.p.z - b.restPosition.z;
        t = Math.max(0, Math.min(1, (Math.sqrt(dx * dx + dy * dy + dz * dz) - DRIFT_LIMIT) / DRIFT_RAMP));
    }
    for (let i = 0; i < 3; i++) out[i] = b.color[i] + (DRIFT_COLOR[i] - b.color[i]) * t;
    return out;
}

const rgb = [0, 0, 0];

function writeBox(b: RigidBody, ox: number, v: number, pos: Float32Array, nor: Float32Array, col: Float32Array): number {
    const r = b.R, h = b.half;
    const c = bodyColor(b, rgb);
    for (const face of FACES) {
        const nx = r[face.axis] * face.sign, ny = r[3 + face.axis] * face.sign, nz = r[6 + face.axis] * face.sign;
        for (const [sx, sy, sz] of face.corners) {
            const lx = sx * h.x, ly = sy * h.y, lz = sz * h.z;
            pos[v * 3] = b.p.x + ox + r[0] * lx + r[1] * ly + r[2] * lz;
            pos[v * 3 + 1] = b.p.y + r[3] * lx + r[4] * ly + r[5] * lz;
            pos[v * 3 + 2] = b.p.z + r[6] * lx + r[7] * ly + r[8] * lz;
            nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
            col[v * 4] = c[0]; col[v * 4 + 1] = c[1]; col[v * 4 + 2] = c[2]; col[v * 4 + 3] = 1;
            v++;
        }
    }
    return v;
}

function writeSphere(b: RigidBody, ox: number, v: number, pos: Float32Array, nor: Float32Array, col: Float32Array): number {
    const r = b.R, rad = b.radius;
    const c = bodyColor(b, rgb);
    for (let i = 0; i < SPHERE_VERTS; i++) {
        const ux = sphereUnit[i * 3], uy = sphereUnit[i * 3 + 1], uz = sphereUnit[i * 3 + 2];
        const nx = r[0] * ux + r[1] * uy + r[2] * uz;
        const ny = r[3] * ux + r[4] * uy + r[5] * uz;
        const nz = r[6] * ux + r[7] * uy + r[8] * uz;
        pos[v * 3] = b.p.x + ox + nx * rad; pos[v * 3 + 1] = b.p.y + ny * rad; pos[v * 3 + 2] = b.p.z + nz * rad;
        nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
        const s = sphereShade[i];
        col[v * 4] = c[0] * s; col[v * 4 + 1] = c[1] * s; col[v * 4 + 2] = c[2] * s; col[v * 4 + 3] = 1;
        v++;
    }
    return v;
}
