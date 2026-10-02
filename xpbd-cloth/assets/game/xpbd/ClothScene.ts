import { Material, Mesh, MeshRenderer, Node, primitives, sys, utils, Vec3, Vec4 } from 'cc';
import { loadEffect, updateDynamicMesh } from '../../enji/helpers';
import { GROUP_BEND, GROUP_SHEAR, XpbdCloth } from './XpbdCloth';

export interface QualityLevel {
    name: string;
    segments: number;
    substeps: number;
}

export const QUALITY: readonly QualityLevel[] = [
    { name: 'Low', segments: 20, substeps: 8 },
    { name: 'Medium', segments: 32, substeps: 10 },
    { name: 'High', segments: 48, substeps: 12 },
    { name: 'Ultra', segments: 64, substeps: 15 },
];

export interface Stiffness {
    name: string;
    shear: number;
    bend: number;
}

/** Compliance presets in m/N; larger is softer. */
export const STIFFNESS: readonly Stiffness[] = [
    { name: 'silk', shear: 1e-3, bend: 5e-2 },
    { name: 'cotton', shear: 1e-4, bend: 5e-3 },
    { name: 'leather', shear: 1e-5, bend: 1e-4 },
];

export type Preset = 'drape' | 'curtain';

const CLOTH_SIZE = 1.6;
const CLOTH_MASS = 0.4;
const SPHERE_RADIUS = 0.45;
const LIGHT = new Vec4(0.45, 0.8, 0.4, 0);
/** Auto quality drops a level when the solver averages more than this per frame. */
const AUTO_BUDGET_MS = 5;
/** ...and frames take longer than this (below ~55 FPS). */
const AUTO_SLOW_FRAME_MS = 18;
const AUTO_WINDOW_FRAMES = 90;

/**
 * Cloth, collider sphere and ground; owns the solver, the dynamic mesh it
 * streams into, the scene presets and the quality level. Call `update(dt)`
 * once per frame.
 */
export class ClothScene {
    cloth!: XpbdCloth;
    preset: Preset = 'drape';
    quality: number;
    /** When set, the quality drops by itself while the solver is over budget. */
    autoQuality = true;
    stiffness = 1;
    paused = false;
    wind = false;
    /** Solver + normals + mesh upload time, smoothed, in ms. */
    simMs = 0;

    private frameMs = 16.7;
    private readonly clothRenderer: MeshRenderer;
    private readonly sphereNode: Node;
    private readonly minPos = new Vec3();
    private readonly maxPos = new Vec3();
    private geometry!: primitives.IDynamicGeometry;
    private overBudgetFrames = 0;
    private time = 0;
    private readonly sphereUniform = new Vec4();

    private constructor(
        parent: Node,
        private readonly clothMaterial: Material,
        private readonly groundMaterial: Material,
        sphereMaterial: Material,
    ) {
        this.quality = sys.isMobile ? 1 : 2;

        const ground = new Node('Ground');
        parent.addChild(ground);
        ground.addComponent(MeshRenderer).mesh = utils.MeshUtils.createMesh(primitives.plane({ width: 40, length: 40, widthSegments: 1, lengthSegments: 1 }));
        ground.getComponent(MeshRenderer)!.setSharedMaterial(groundMaterial, 0);

        this.sphereNode = new Node('Sphere');
        parent.addChild(this.sphereNode);
        const sphereRenderer = this.sphereNode.addComponent(MeshRenderer);
        sphereRenderer.mesh = utils.MeshUtils.createMesh(primitives.sphere(1, { segments: 32 }));
        sphereRenderer.setSharedMaterial(sphereMaterial, 0);

        const clothNode = new Node('Cloth');
        parent.addChild(clothNode);
        this.clothRenderer = clothNode.addComponent(MeshRenderer);
        this.clothRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;

        this.rebuild();
    }

    static async create(parent: Node): Promise<ClothScene> {
        const [clothEffect, litEffect] = await Promise.all([loadEffect('effects/xpbd-cloth'), loadEffect('effects/xpbd-lit')]);
        const cloth = new Material();
        cloth.initialize({ effectAsset: clothEffect });
        cloth.setProperty('lightDir', LIGHT);
        const ground = new Material();
        ground.initialize({ effectAsset: litEffect, defines: { USE_GRID: true } });
        ground.setProperty('lightDir', LIGHT);
        ground.setProperty('baseColor', new Vec4(0.52, 0.54, 0.58, 1));
        const sphere = new Material();
        sphere.initialize({ effectAsset: litEffect });
        sphere.setProperty('lightDir', LIGHT);
        sphere.setProperty('baseColor', new Vec4(0.2, 0.5, 1.0, 1));
        return new ClothScene(parent, cloth, ground, sphere);
    }

    get level(): QualityLevel {
        return QUALITY[this.quality];
    }

    /** Recreates the cloth for the current preset and quality level. */
    rebuild(): void {
        const { segments, substeps } = this.level;
        const n = segments;
        const curtain = this.preset === 'curtain';
        const cloth = new XpbdCloth({
            segments: n,
            size: CLOTH_SIZE,
            mass: CLOTH_MASS,
            orientation: curtain ? 'vertical' : 'horizontal',
            height: curtain ? 2.0 : 1.5,
            pins: curtain ? [[0, 0], [n - 1, 0]] : [],
        });
        cloth.substeps = substeps;
        cloth.sphere.r = SPHERE_RADIUS;
        if (curtain) cloth.setSphere(-0.3, SPHERE_RADIUS, 1.1);
        else cloth.setSphere(0, 0.6, 0);
        this.cloth = cloth;
        this.wind = curtain;
        this.applyStiffness();

        this.geometry = {
            positions: cloth.pos,
            normals: cloth.normals,
            uvs: cloth.uvs,
            indices16: cloth.indices,
            minPos: this.minPos.set(cloth.minPos.x, cloth.minPos.y, cloth.minPos.z),
            maxPos: this.maxPos.set(cloth.maxPos.x, cloth.maxPos.y, cloth.maxPos.z),
        };
        const mesh: Mesh = utils.MeshUtils.createDynamicMesh(0, this.geometry, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: cloth.count,
            maxSubMeshIndices: cloth.indices.length,
        });
        const old = this.clothRenderer.mesh;
        this.clothRenderer.mesh = mesh;
        this.clothRenderer.setSharedMaterial(this.clothMaterial, 0);
        old?.destroy();
        // Later uploads skip the UVs: updateSubMesh maps buffers to attributes in order (positions, normals, uvs).
        delete this.geometry.uvs;
        this.overBudgetFrames = 0;
        this.syncSphere();
    }

    update(dt: number): void {
        const cloth = this.cloth;
        this.time += dt;
        const start = performance.now();
        if (!this.paused) {
            if (this.wind) {
                const gust = 0.5 + 0.5 * Math.sin(this.time * 0.9) * Math.sin(this.time * 2.3 + 1);
                cloth.wind.x = 0.5 * Math.sin(this.time * 0.37);
                cloth.wind.z = 0.6 + 2.4 * gust;
                cloth.windDrag = 2;
            } else {
                cloth.windDrag = 0;
            }
            cloth.step(Math.min(Math.max(dt, 1 / 120), 1 / 30));
            cloth.computeNormals();
            this.minPos.set(cloth.minPos.x, cloth.minPos.y, cloth.minPos.z);
            this.maxPos.set(cloth.maxPos.x, cloth.maxPos.y, cloth.maxPos.z);
            updateDynamicMesh(this.clothRenderer, this.geometry);
        }
        const ms = performance.now() - start;
        this.simMs += (ms - this.simMs) * 0.1;
        this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
        this.syncSphere();
        if (!this.paused) this.adaptQuality();
    }

    setPreset(preset: Preset): void {
        this.preset = preset;
        this.rebuild();
    }

    /** Manual choice; turns automatic quality off. */
    cycleQuality(): void {
        this.autoQuality = false;
        this.quality = (this.quality + 1) % QUALITY.length;
        this.rebuild();
    }

    cycleStiffness(): void {
        this.stiffness = (this.stiffness + 1) % STIFFNESS.length;
        this.applyStiffness();
    }

    moveSphere(x: number, y: number, z: number): void {
        this.cloth.setSphere(x, y, z);
        this.syncSphere();
    }

    private applyStiffness(): void {
        const s = STIFFNESS[this.stiffness];
        this.cloth.compliance[GROUP_SHEAR] = s.shear;
        this.cloth.compliance[GROUP_BEND] = s.bend;
    }

    private adaptQuality(): void {
        if (!this.autoQuality || this.quality === 0) return;
        // Only while frames are actually late; leaky, so a cost hovering around the budget still triggers.
        const over = this.simMs > AUTO_BUDGET_MS && this.frameMs > AUTO_SLOW_FRAME_MS;
        this.overBudgetFrames = Math.max(0, this.overBudgetFrames + (over ? 1 : -1));
        if (this.overBudgetFrames < AUTO_WINDOW_FRAMES) return;
        this.quality--;
        this.simMs = 0;
        this.rebuild();
    }

    private syncSphere(): void {
        const s = this.cloth.sphere;
        this.sphereNode.setPosition(s.x, s.y, s.z);
        this.sphereNode.setScale(s.r, s.r, s.r);
        this.groundMaterial.setProperty('sphere', this.sphereUniform.set(s.x, s.y, s.z, s.r));
    }
}
