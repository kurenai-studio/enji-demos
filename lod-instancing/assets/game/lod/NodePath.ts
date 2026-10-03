import { LOD, LODGroup, Material, Mesh, MeshRenderer, Node, Vec3 } from 'cc';
import { IMPOSTOR } from './Lod';
import { geoMesh } from './Meshes';
import { v4, type FrameInput, type RenderPath, type Shared } from './Paths';

/**
 * The scene-graph way: a node per tree. Without LOD every tree draws level 0
 * with its own draw call (or batched by engine instancing). With LOD each
 * tree is a LODGroup over three child renderers; the engine picks the level
 * by screen size and culls past the last one. No hysteresis, no fade.
 */
export class NodePath implements RenderPath {
    cpuMs = 0;
    private readonly root: Node;
    private readonly materials: Material[];
    private tint = false;
    private fog = 1;
    readonly buildMs: number;

    /** `limit` caps the trees (the forest's first ones, spread over the whole area). */
    constructor(parent: Node, private readonly shared: Shared, readonly useLod: boolean, readonly instancing: boolean, lodThresholds: readonly number[], farThreshold: number, readonly limit: number) {
        const t0 = performance.now();
        this.root = new Node(useLod ? 'NodesLodGroup' : 'NodesPlain');
        parent.addChild(this.root);
        this.materials = [0, 1, 2].map((level) => {
            const m = shared.makeMaterial(shared.treeEffect, { USE_INSTANCING: instancing });
            m.setProperty('look', v4(0, level, 0, 0));
            return m;
        });
        const meshes: Mesh[][] = shared.species.map((sp) => sp.levels.map((g) => geoMesh(g, sp.bounds)));
        const f = shared.forest;
        const euler = new Vec3();
        for (let i = 0; i < Math.min(f.count, limit); i++) {
            const sp = shared.species[f.species[i]];
            const node = new Node();
            this.root.addChild(node);
            node.setPosition(f.x[i], f.y[i], f.z[i]);
            node.setRotationFromEuler(euler.set(0, (f.yaw[i] * 180) / Math.PI, 0));
            node.setScale(f.scale[i], f.scale[i], f.scale[i]);
            if (!useLod) {
                this.addRenderer(node, meshes[f.species[i]][0], 0);
                continue;
            }
            const group = node.addComponent(LODGroup);
            while (group.lodCount > 0) group.eraseLOD(0);
            for (let level = 0; level < IMPOSTOR; level++) {
                const child = new Node();
                node.addChild(child);
                const lod = new LOD();
                lod.insertRenderer(0, this.addRenderer(child, meshes[f.species[i]][level], level));
                group.insertLOD(level, level < IMPOSTOR - 1 ? lodThresholds[level] : farThreshold, lod);
            }
            // Screen usage = objectSize · scale · cot(fov/2) / (2 d): with objectSize = 2r and the
            // sphere centre as the boundary centre it equals our screen size s.
            group.localBoundaryCenter = new Vec3(0, sp.centerY, 0);
            group.objectSize = 2 * sp.radius;
        }
        this.buildMs = performance.now() - t0;
    }

    private addRenderer(node: Node, mesh: Mesh, level: number): MeshRenderer {
        const r = node.addComponent(MeshRenderer);
        r.mesh = mesh;
        r.setSharedMaterial(this.materials[level], 0);
        r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        r.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
        return r;
    }

    setVisible(on: boolean): void {
        this.root.active = on;
    }

    update(frame: FrameInput): void {
        if (frame.tint !== this.tint || frame.fog !== this.fog) {
            this.tint = frame.tint;
            this.fog = frame.fog;
            this.materials.forEach((m, level) => {
                m.setProperty('look', v4(this.tint ? 1 : 0, level, 0, 0));
                m.setProperty('dims', v4(1, 1, this.fog, 0));
            });
        }
        this.cpuMs = 0;
    }

    describe(): string {
        const n = Math.min(this.shared.forest.count, this.limit);
        const capped = n < this.shared.forest.count ? ` (capped from ${this.shared.forest.count})` : '';
        return `${n} nodes${capped}, ${this.useLod ? 'LODGroup' : 'level 0 only'}, ` +
            `${this.instancing ? 'engine instancing' : 'no instancing'}, built in ${(this.buildMs / 1000).toFixed(1)} s`;
    }

    destroy(): void {
        this.root.destroy();
    }
}