import { Color, EffectAsset, Material, MeshRenderer, Node, utils, primitives, Vec3, Vec4 } from 'cc';
import { updateDynamicMesh } from '../enji/helpers';

const COUNT = 2000;

interface Drop {
    x: number;
    y: number;
    z: number;
    speed: number;
    len: number;
}

/**
 * Rain is a field of camera-facing streaks. They are not a post process:
 * containers occlude them, and they wrap inside the yard volume.
 */
export class Rain {
    private readonly drops: Drop[] = [];
    private readonly positions = new Float32Array(COUNT * 12);
    private readonly normals = new Float32Array(COUNT * 12);
    private readonly uvs = new Float32Array(COUNT * 8);
    private readonly indices = new Uint16Array(COUNT * 6);
    private readonly renderer: MeshRenderer;
    private readonly right = new Vec3();

    constructor(parent: Node, effect: EffectAsset) {
        for (let i = 0; i < COUNT; i++) {
            this.drops.push({
                x: -16 + Math.random() * 32,
                y: 2 + Math.random() * 10,
                z: -28 + Math.random() * 36,
                speed: 16 + Math.random() * 10,
                len: 0.9 + Math.random() * 0.8,
            });
            const v = i * 4;
            this.uvs[v * 2] = 0;
            this.uvs[v * 2 + 1] = 0;
            this.uvs[v * 2 + 2] = 1;
            this.uvs[v * 2 + 3] = 0;
            this.uvs[v * 2 + 4] = 1;
            this.uvs[v * 2 + 5] = 1;
            this.uvs[v * 2 + 6] = 0;
            this.uvs[v * 2 + 7] = 1;
            const t = i * 6;
            const b = i * 4;
            this.indices[t] = b;
            this.indices[t + 1] = b + 1;
            this.indices[t + 2] = b + 2;
            this.indices[t + 3] = b;
            this.indices[t + 4] = b + 2;
            this.indices[t + 5] = b + 3;
        }

        const mat = new Material();
        mat.initialize({ effectAsset: effect });
        mat.setProperty('tint', new Color(230, 220, 200, 42));

        const node = new Node('Rain');
        parent.addChild(node);
        this.renderer = node.addComponent(MeshRenderer);
        this.renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        this.renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
        const first = this.geometry();
        this.renderer.mesh = utils.MeshUtils.createDynamicMesh(0, first, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: COUNT * 4,
            maxSubMeshIndices: COUNT * 6,
        });
        this.renderer.setSharedMaterial(mat, 0);
        updateDynamicMesh(this.renderer, first);
    }

    step(dt: number, camera: Node): void {
        const cam = new Vec3();
        camera.getWorldPosition(cam);
        for (const drop of this.drops) {
            drop.y -= drop.speed * dt;
            drop.z -= dt * 1.4;
            const dx = drop.x - cam.x;
            const dz = drop.z - cam.z;
            const far = dx * dx + dz * dz > 26 * 26;
            if (drop.y < cam.y - 2 || far) {
                const ang = Math.random() * Math.PI * 2;
                const dist = 4 + Math.random() * 18;
                drop.x = cam.x + Math.cos(ang) * dist;
                drop.z = cam.z + Math.sin(ang) * dist;
                drop.y = cam.y + 2 + Math.random() * 14;
            }
        }
        Vec3.transformQuat(this.right, Vec3.RIGHT, camera.worldRotation);
        this.right.y = 0;
        if (this.right.lengthSqr() < 1e-6) this.right.set(1, 0, 0);
        this.right.normalize();
        updateDynamicMesh(this.renderer, this.geometry());
    }

    private geometry(): primitives.IDynamicGeometry {
        const rx = this.right.x * 0.012;
        const rz = this.right.z * 0.012;
        const positions = this.positions;
        const normals = this.normals;
        let minX = 1e9;
        let minY = 1e9;
        let minZ = 1e9;
        let maxX = -1e9;
        let maxY = -1e9;
        let maxZ = -1e9;
        for (let i = 0; i < this.drops.length; i++) {
            const drop = this.drops[i];
            const half = drop.len * 0.5;
            const corners = [
                [drop.x - rx, drop.y + half, drop.z - rz],
                [drop.x + rx, drop.y + half, drop.z + rz],
                [drop.x + rx, drop.y - half, drop.z + rz - 0.28],
                [drop.x - rx, drop.y - half, drop.z - rz - 0.28],
            ];
            for (let k = 0; k < 4; k++) {
                const o = (i * 4 + k) * 3;
                positions[o] = corners[k][0];
                positions[o + 1] = corners[k][1];
                positions[o + 2] = corners[k][2];
                normals[o] = 0;
                normals[o + 1] = 0;
                normals[o + 2] = 1;
                if (corners[k][0] < minX) minX = corners[k][0];
                if (corners[k][1] < minY) minY = corners[k][1];
                if (corners[k][2] < minZ) minZ = corners[k][2];
                if (corners[k][0] > maxX) maxX = corners[k][0];
                if (corners[k][1] > maxY) maxY = corners[k][1];
                if (corners[k][2] > maxZ) maxZ = corners[k][2];
            }
        }
        return {
            positions,
            normals,
            uvs: this.uvs,
            indices16: this.indices,
            minPos: { x: minX, y: minY, z: minZ },
            maxPos: { x: maxX, y: maxY, z: maxZ },
        };
    }
}
