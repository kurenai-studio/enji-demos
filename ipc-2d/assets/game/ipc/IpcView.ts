import { EffectAsset, Material, Mesh, MeshRenderer, Node, primitives, utils } from 'cc';
import { loadEffect, updateDynamicMesh } from '../../enji/helpers';
import type { IpcWorld } from './IpcWorld';

/** Gap between the worlds in compare mode, in metres. */
const WORLD_GAP = 0.25;

const BACKGROUND = [0.1, 0.11, 0.14];
const OUTLINE = [0.05, 0.05, 0.07];
const CROSSING = [1, 0.18, 0.15];
/** Outline width in screen pixels. */
const OUTLINE_PIXELS = 1.6;

interface WorldSlot {
    world: IpcWorld;
    offset: number;
    /** Soft and driven bodies: their triangles and boundary edges are drawn every frame. */
    bodies: number[];
}

/**
 * Draws the worlds side by side in metres: static obstacles once, and one
 * dynamic mesh holding every moving triangle (flat shaded, darker when
 * compressed) plus an outline quad per boundary edge, red where it crosses
 * another edge.
 */
export class IpcView {
    private readonly root: Node;
    private readonly material: Material;
    private staticNode: Node | null = null;
    private dynamicNode: Node | null = null;
    private renderer: MeshRenderer | null = null;
    private geometry: primitives.IDynamicGeometry | null = null;
    private slots: WorldSlot[] = [];
    private bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    private constructor(parent: Node, effect: EffectAsset) {
        this.root = new Node('IpcView');
        parent.addChild(this.root);
        this.material = new Material();
        this.material.initialize({ effectAsset: effect });
    }

    static async create(parent: Node): Promise<IpcView> {
        return new IpcView(parent, await loadEffect('effects/ipc-flat'));
    }

    /** Drawn area in metres. */
    get extent(): { minX: number; minY: number; width: number; height: number } {
        const b = this.bounds;
        return { minX: b.minX, minY: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
    }

    /** x offset of world i. */
    offset(i: number): number {
        return this.slots[i]?.offset ?? 0;
    }

    rebuild(worlds: readonly IpcWorld[], view: readonly number[]): void {
        this.staticNode?.destroy();
        this.dynamicNode?.destroy();
        const width = view[2] - view[0];
        this.slots = [];
        let triangles = 0;
        let edges = 0;
        worlds.forEach((world, i) => {
            const bodies: number[] = [];
            world.bodies.forEach((b, k) => {
                if (b.kinematic && !b.driven) return;
                bodies.push(k);
            });
            this.slots.push({ world, offset: i * (width + WORLD_GAP), bodies });
            for (const k of bodies) {
                triangles += world.bodies[k].triCount;
                edges += world.bodies[k].edgeCount;
            }
        });
        const last = this.slots[this.slots.length - 1];
        this.bounds = { minX: view[0], minY: view[1], maxX: last.offset + view[2], maxY: view[3] };

        this.staticNode = new Node('Static');
        this.root.addChild(this.staticNode);
        const staticRenderer = this.staticNode.addComponent(MeshRenderer);
        staticRenderer.mesh = this.staticMesh(view);
        staticRenderer.setSharedMaterial(this.material, 0);

        const vertexCount = 3 * triangles + 4 * edges;
        const indexCount = 3 * triangles + 6 * edges;
        const indices = new Uint32Array(indexCount);
        for (let t = 0; t < 3 * triangles; t++) indices[t] = t;
        for (let e = 0; e < edges; e++) {
            const v = 3 * triangles + 4 * e;
            indices.set([v, v + 1, v + 2, v, v + 2, v + 3], 3 * triangles + 6 * e);
        }
        this.geometry = {
            positions: new Float32Array(3 * vertexCount),
            colors: new Float32Array(4 * vertexCount),
            indices32: indices,
            minPos: { x: this.bounds.minX - 1, y: this.bounds.minY - 1, z: -1 },
            maxPos: { x: this.bounds.maxX + 1, y: this.bounds.maxY + 1, z: 1 },
        };
        this.dynamicNode = new Node('Bodies');
        this.root.addChild(this.dynamicNode);
        this.renderer = this.dynamicNode.addComponent(MeshRenderer);
        const mesh: Mesh = utils.MeshUtils.createDynamicMesh(0, this.geometry, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: vertexCount,
            maxSubMeshIndices: indexCount,
        });
        this.renderer.mesh = mesh;
        this.renderer.setSharedMaterial(this.material, 0);
    }

    /** `metresPerPixel` sets the outline width. */
    update(metresPerPixel: number): void {
        const g = this.geometry;
        if (!g || !this.renderer) return;
        const pos = g.positions as Float32Array;
        const col = g.colors as Float32Array;
        const half = (OUTLINE_PIXELS * metresPerPixel) / 2;
        let triangleVertices = 0;
        for (const s of this.slots) for (const k of s.bodies) triangleVertices += 3 * s.world.bodies[k].triCount;
        let v = 0;
        let e = triangleVertices;
        for (const slot of this.slots) {
            const w = slot.world;
            const x = w.x;
            const ox = slot.offset;
            for (const k of slot.bodies) {
                const b = w.bodies[k];
                // Bodies stack in z so overlapping penalty bodies do not z-fight.
                const z = 0.001 * k;
                for (let t = b.triStart; t < b.triStart + b.triCount; t++) {
                    const shade = b.driven ? 1 : w.areaRatio(t);
                    const k2 = Math.min(1.25, Math.max(0.55, 1 + (shade - 1) * 2.5));
                    for (let c = 0; c < 3; c++) {
                        const vi = w.tri[3 * t + c];
                        pos[3 * v] = x[2 * vi] + ox;
                        pos[3 * v + 1] = x[2 * vi + 1];
                        pos[3 * v + 2] = z;
                        col[4 * v] = Math.min(1, b.color[0] * k2);
                        col[4 * v + 1] = Math.min(1, b.color[1] * k2);
                        col[4 * v + 2] = Math.min(1, b.color[2] * k2);
                        col[4 * v + 3] = 1;
                        v++;
                    }
                }
                for (let ei = b.edgeStart; ei < b.edgeStart + b.edgeCount; ei++) {
                    const a = w.edges[2 * ei];
                    const c = w.edges[2 * ei + 1];
                    const ax = x[2 * a] + ox, ay = x[2 * a + 1];
                    const cx = x[2 * c] + ox, cy = x[2 * c + 1];
                    let nx = ay - cy;
                    let ny = cx - ax;
                    const len = Math.hypot(nx, ny) || 1;
                    nx = (nx / len) * half;
                    ny = (ny / len) * half;
                    const color = w.crossing[ei] ? CROSSING : OUTLINE;
                    const zz = w.crossing[ei] ? 0.2 : 0.1;
                    const corners = [ax - nx, ay - ny, cx - nx, cy - ny, cx + nx, cy + ny, ax + nx, ay + ny];
                    for (let q = 0; q < 4; q++) {
                        pos[3 * e] = corners[2 * q];
                        pos[3 * e + 1] = corners[2 * q + 1];
                        pos[3 * e + 2] = zz;
                        col[4 * e] = color[0];
                        col[4 * e + 1] = color[1];
                        col[4 * e + 2] = color[2];
                        col[4 * e + 3] = 1;
                        e++;
                    }
                }
            }
        }
        updateDynamicMesh(this.renderer, g);
    }

    private staticMesh(view: readonly number[]): Mesh {
        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        for (const slot of this.slots) {
            const w = slot.world;
            const ox = slot.offset;
            const base = positions.length / 3;
            positions.push(view[0] + ox, view[1], -0.5, view[2] + ox, view[1], -0.5, view[2] + ox, view[3], -0.5, view[0] + ox, view[3], -0.5);
            for (let k = 0; k < 4; k++) colors.push(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], 1);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
            for (const b of w.bodies) {
                if (!b.kinematic || b.driven) continue;
                const first = positions.length / 3;
                for (let i = b.start; i < b.start + b.count; i++) {
                    positions.push(w.x[2 * i] + ox, w.x[2 * i + 1], -0.4);
                    colors.push(b.color[0], b.color[1], b.color[2], 1);
                }
                for (let t = b.triStart; t < b.triStart + b.triCount; t++) {
                    for (let c = 0; c < 3; c++) indices.push(first + w.tri[3 * t + c] - b.start);
                }
            }
        }
        return utils.MeshUtils.createMesh({ positions, colors, indices });
    }
}
