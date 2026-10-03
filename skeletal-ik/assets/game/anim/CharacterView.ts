import { gfx, Material, Mesh, MeshRenderer, Node, primitives, Quat, utils, Vec3, Vec4 } from 'cc';
import type { SkinnedMesh } from './Body';
import type { Character } from './Character';
import { DQ_FLOATS, ROW_FLOATS } from './Skinning';
import { terrainHeight } from './Terrain';

export type SkinMode = 'lbs' | 'dqs' | 'split';
export type ViewMode = 'skin' | 'weights' | 'bones';

/** Generous local bounds: the clips raise arms, squat and lean, and culling must not clip them. */
const BOUNDS_MIN = new Vec3(-1.2, -0.6, -1.2);
const BOUNDS_MAX = new Vec3(1.2, 2.4, 1.2);

export function skinnedMeshAsset(m: SkinnedMesh): Mesh {
    return utils.MeshUtils.createMesh({
        positions: m.positions,
        normals: m.normals,
        colors: m.colors,
        indices: m.indices,
        minPos: BOUNDS_MIN,
        maxPos: BOUNDS_MAX,
        customAttributes: [
            { attr: new gfx.Attribute('a_jointIdx', gfx.Format.RGBA32F), values: m.joints },
            { attr: new gfx.Attribute('a_jointWt', gfx.Format.RGBA32F), values: m.weights },
        ],
    });
}

/** Flat disc, dark in the middle and clear at the rim, for a blob shadow. */
export function blobMeshAsset(radius: number): Mesh {
    const positions = [0, 0, 0];
    const normals = [0, 1, 0];
    const colors = [0.05, 0.06, 0.05, 0.42];
    const indices: number[] = [];
    const sides = 20;
    for (let k = 0; k < sides; k++) {
        const a = (2 * Math.PI * k) / sides;
        positions.push(radius * Math.cos(a), 0, radius * Math.sin(a));
        normals.push(0, 1, 0);
        colors.push(0.05, 0.06, 0.05, 0);
        indices.push(0, 1 + ((k + 1) % sides), 1 + k);
    }
    return utils.MeshUtils.createMesh({ positions, normals, colors, indices });
}

export function orbMeshAsset(radius: number): Mesh {
    const g = primitives.sphere(radius, { segments: 16 });
    const colors: number[] = [];
    for (let i = 0; i < g.positions.length / 3; i++) colors.push(1, 0.62, 0.2, 1);
    return utils.MeshUtils.createMesh({ ...g, colors });
}

export interface ViewAssets {
    body: Mesh;
    bones: Mesh;
    blob: Mesh;
    orb: Mesh;
    skinLbs: Material;
    skinDqs: Material;
    boneOverlay: Material;
    blobMaterial: Material;
    lit: Material;
}

function renderer(parent: Node, name: string, mesh: Mesh, material: Material): MeshRenderer {
    const node = new Node(name);
    parent.addChild(node);
    const r = node.addComponent(MeshRenderer);
    r.mesh = mesh;
    r.setSharedMaterial(material, 0);
    r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
    r.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
    return r;
}

/**
 * The scene objects of one character: a linear-blend and a dual-quaternion
 * body (both drawn, each on its half, in split mode), the bone overlay, a
 * blob shadow and the reach orb. Joint transforms go to the material
 * instances as vec4 arrays every frame.
 */
export class CharacterView {
    readonly root: Node;
    private readonly character: Character;
    private readonly lbs: MeshRenderer;
    private readonly dqs: MeshRenderer;
    private readonly bones: MeshRenderer;
    private readonly blob: Node;
    private readonly orb: Node;
    private readonly lbsMat: Material;
    private readonly dqsMat: Material;
    private readonly boneMat: Material;
    private readonly rows: Vec4[];
    private readonly dqVecs: Vec4[];
    private readonly quat = new Quat();
    private skin: SkinMode = 'lbs';
    private view: ViewMode = 'skin';

    constructor(parent: Node, character: Character, assets: ViewAssets, tint: Vec4) {
        this.character = character;
        this.root = new Node('Character');
        parent.addChild(this.root);
        this.lbs = renderer(this.root, 'BodyLBS', assets.body, assets.skinLbs);
        this.dqs = renderer(this.root, 'BodyDQS', assets.body, assets.skinDqs);
        this.bones = renderer(this.root, 'Bones', assets.bones, assets.boneOverlay);
        this.lbsMat = this.lbs.getMaterialInstance(0)!;
        this.dqsMat = this.dqs.getMaterialInstance(0)!;
        this.boneMat = this.bones.getMaterialInstance(0)!;
        this.lbsMat.setProperty('tint', tint);
        this.dqsMat.setProperty('tint', tint);
        this.boneMat.setProperty('skinParams', new Vec4(0, 3, 0, 0));
        this.blob = renderer(parent, 'Blob', assets.blob, assets.blobMaterial).node;
        this.orb = renderer(parent, 'Orb', assets.orb, assets.lit).node;
        const joints = character.set.skel.count;
        this.rows = Array.from({ length: (ROW_FLOATS / 4) * joints }, () => new Vec4());
        this.dqVecs = Array.from({ length: (DQ_FLOATS / 4) * joints }, () => new Vec4());
        this.apply();
    }

    setModes(skin: SkinMode, view: ViewMode): void {
        this.skin = skin;
        this.view = view;
        this.apply();
    }

    private apply(): void {
        const v = this.view === 'skin' ? 0 : this.view === 'weights' ? 1 : 2;
        const split = this.skin === 'split';
        this.lbs.node.active = this.skin !== 'dqs';
        this.dqs.node.active = this.skin !== 'lbs';
        this.lbsMat.setProperty('skinParams', new Vec4(split ? 1 : 0, v, 0, 0));
        this.dqsMat.setProperty('skinParams', new Vec4(split ? 2 : 0, v, 0, 0));
        this.bones.node.active = this.view === 'bones';
    }

    sync(): void {
        const c = this.character;
        const p = c.rootPos, q = c.rootRot;
        this.root.setPosition(p.x, p.y, p.z);
        this.root.setRotation(this.quat.set(q.x, q.y, q.z, q.w));
        const amp = c.terrainAmplitude;
        this.blob.setPosition(p.x, terrainHeight(p.x, p.z, amp) + 0.025, p.z);
        this.orb.active = c.reach;
        if (c.reach) this.orb.setPosition(c.orb.x, c.orb.y, c.orb.z);

        const lbsOn = this.skin !== 'dqs' || this.view === 'bones';
        if (lbsOn) {
            const r = c.rows;
            for (let i = 0; i < this.rows.length; i++) this.rows[i].set(r[4 * i], r[4 * i + 1], r[4 * i + 2], r[4 * i + 3]);
            if (this.skin !== 'dqs') this.lbsMat.setProperty('jointRows', this.rows);
            if (this.view === 'bones') this.boneMat.setProperty('jointRows', this.rows);
        }
        if (this.skin !== 'lbs') {
            const d = c.dqs;
            for (let i = 0; i < this.dqVecs.length; i++) this.dqVecs[i].set(d[4 * i], d[4 * i + 1], d[4 * i + 2], d[4 * i + 3]);
            this.dqsMat.setProperty('jointDq', this.dqVecs);
        }
    }

    destroy(): void {
        this.root.destroy();
        this.blob.destroy();
        this.orb.destroy();
    }
}
