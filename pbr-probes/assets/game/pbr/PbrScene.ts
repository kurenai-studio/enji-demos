import { gfx, JsonAsset, Material, Mesh, MeshRenderer, Node, primitives, resources, Texture2D, TextureCube, utils, Vec4 } from 'cc';
import { loadEffect } from '../../enji/helpers';
import { Baked, type BakeData } from './Baked';
import { captureCube, type CubeLevel, encodeRgbm, mipChain, prefilterFace } from './EnvFilter';
import type { Sphere } from './Occlusion';
import { BLOCKS, LIGHT, LIGHT_RADIANCE, lightVisibility, ROOM, type V3 } from './Room';
import { buildRoomGeometry } from './RoomMesh';
import { SH_COEFFS, shEval } from './SH';

export interface HeroMaterial {
    name: string;
    base: V3;
    metallic: number;
    roughness: number;
}

export const HERO_MATERIALS: readonly HeroMaterial[] = [
    { name: 'Gold', base: [1.0, 0.766, 0.336], metallic: 1, roughness: 0.3 },
    { name: 'Chrome', base: [0.55, 0.556, 0.554], metallic: 1, roughness: 0.05 },
    { name: 'Copper', base: [0.955, 0.638, 0.538], metallic: 1, roughness: 0.55 },
    { name: 'Red plastic', base: [0.7, 0.06, 0.04], metallic: 0, roughness: 0.35 },
    { name: 'Clay', base: [0.62, 0.6, 0.58], metallic: 0, roughness: 0.95 },
];

/** Number of SH coefficients used for each band setting: L0, L1, L2. */
export const SH_BAND_COUNTS = [1, 4, 9] as const;

const ROW_ROUGHNESS = [0.05, 0.25, 0.5, 0.75, 1];
const ROW_RADIUS = 0.22;
const HERO_RADIUS = 0.35;
const HERO_START: V3 = [-1.4, HERO_RADIUS, 0.05];
const PROBE_POSITION: V3 = [0, 1.5, 0];
/** Panel area as a disc, for the analytic light and the sphere shadows. */
const LIGHT_DISC_RADIUS = (2 * LIGHT.half) / Math.sqrt(Math.PI);
const LIGHT_CENTER: V3 = [0, LIGHT.y, 0];
const EXPOSURE = 1.1;
/** Prefiltered levels after the mirror capture: roughness, size, samples per texel. */
const ENV_LEVELS: readonly [number, number, number][] = [[0.25, 32, 24], [0.5, 16, 32], [0.75, 8, 48], [1, 8, 48]];
const ENV_CAPTURE_SIZE = 128;

interface SphereObject extends Sphere {
    node: Node;
    material: Material;
    base: V3;
    metallic: number;
    roughness: number;
    /** Fraction of the light panel visible from the centre (blocks only). */
    visibility: number;
    sh: Float32Array;
}

export class PbrScene {
    direct = true;
    indirect = true;
    specular = true;
    boxProjection = true;
    showProbes = false;
    /** Index into SH_BAND_COUNTS. */
    bands = 2;
    probeMode: 'grid' | 'one' = 'grid';
    heroMaterial = 0;

    readonly roomVertices: number;
    /** Building the room mesh from the bake, with the fixed spheres' occlusion (ms). */
    readonly roomBuildMs: number;
    /** Reflection probe build: capture time, then each level's prefilter time (ms). */
    readonly envTimings: number[] = [];

    private readonly spheres: SphereObject[] = [];
    private readonly probeRenderer: MeshRenderer;
    private readonly envCubes: TextureCube[] = [];
    private envChain: CubeLevel[] | null = null;
    private envFaces: Float32Array[] = [];
    private envFaceMs = 0;
    private dirty = true;
    private probesDirty = true;
    private readonly v4 = new Vec4();

    private constructor(
        private readonly parent: Node,
        readonly baked: Baked,
        private readonly roomMaterial: Material,
        private readonly probeMaterial: Material,
        sphereEffect: Material['effectAsset'],
    ) {
        const sphereMesh = utils.MeshUtils.createMesh(primitives.sphere(1, { segments: 48 }));
        const add = (name: string, center: V3, r: number, base: V3, metallic: number, roughness: number) => {
            const node = new Node(name);
            parent.addChild(node);
            node.setPosition(center[0], center[1], center[2]);
            node.setScale(r, r, r);
            const renderer = node.addComponent(MeshRenderer);
            renderer.mesh = sphereMesh;
            renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            const material = new Material();
            material.initialize({ effectAsset: sphereEffect });
            renderer.setSharedMaterial(material, 0);
            this.spheres.push({
                node, material, base, metallic, roughness,
                x: center[0], y: center[1], z: center[2], r,
                visibility: lightVisibility(center),
                sh: new Float32Array(SH_COEFFS * 3),
            });
        };
        const hero = HERO_MATERIALS[this.heroMaterial];
        add('Hero', HERO_START, HERO_RADIUS, hero.base, hero.metallic, hero.roughness);
        ROW_ROUGHNESS.forEach((roughness, i) => {
            const x = -1.4 + i * 0.7;
            add(`Metal${i}`, [x, ROW_RADIUS, 0.75], ROW_RADIUS, [0.95, 0.93, 0.88], 1, roughness);
            add(`Plastic${i}`, [x, ROW_RADIUS, 1.45], ROW_RADIUS, [0.1, 0.3, 0.8], 0, roughness);
        });

        const tRoom = performance.now();
        const room = buildRoomGeometry(baked, this.spheres.slice(1), { center: LIGHT_CENTER, radius: LIGHT_DISC_RADIUS });
        this.roomVertices = room.vertexCount;
        const roomNode = new Node('Room');
        parent.addChild(roomNode);
        const roomRenderer = roomNode.addComponent(MeshRenderer);
        // createMesh only indexes into these, so typed arrays skip a copy into plain arrays.
        const asNumbers = (a: ArrayLike<number>) => a as unknown as number[];
        roomRenderer.mesh = utils.MeshUtils.createMesh({
            positions: asNumbers(room.positions),
            normals: asNumbers(room.normals),
            colors: asNumbers(room.colors),
            indices: asNumbers(room.indices),
            customAttributes: [{ attr: new gfx.Attribute('a_direct', gfx.Format.RGB32F), values: asNumbers(room.direct) }],
        });
        roomRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        roomRenderer.setSharedMaterial(roomMaterial, 0);
        this.roomBuildMs = performance.now() - tRoom;

        const probeNode = new Node('Probes');
        parent.addChild(probeNode);
        this.probeRenderer = probeNode.addComponent(MeshRenderer);
        this.probeRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        this.probeRenderer.setSharedMaterial(probeMaterial, 0);
        probeNode.active = false;

        // Mirror level first so reflections show at once; the blurred levels follow one per frame.
        const t0 = performance.now();
        const capture = captureCube(baked, PROBE_POSITION, ENV_CAPTURE_SIZE);
        this.envChain = mipChain(capture);
        this.envCubes.push(makeRgbmCube(capture));
        this.envTimings.push(performance.now() - t0);
        this.bindEnv();
    }

    static async create(parent: Node): Promise<PbrScene> {
        const [json, roomEffect, probeEffect, sphereEffect] = await Promise.all([
            new Promise<BakeData>((resolve, reject) => {
                resources.load('bake/cornell', JsonAsset, (err, asset) => (err ? reject(err) : resolve(asset.json as unknown as BakeData)));
            }),
            loadEffect('effects/pbr-room'),
            loadEffect('effects/pbr-probe'),
            loadEffect('effects/pbr-sphere'),
        ]);
        const baked = new Baked(json.faces, json.probes);
        const room = new Material();
        room.initialize({ effectAsset: roomEffect });
        const probe = new Material();
        probe.initialize({ effectAsset: probeEffect });
        probe.setProperty('display', new Vec4(EXPOSURE, 0, 0, 0));
        return new PbrScene(parent, baked, room, probe, sphereEffect);
    }

    get hero(): Readonly<Sphere> {
        return this.spheres[0];
    }

    get heroVisibility(): number {
        return this.spheres[0].visibility;
    }

    get envReady(): boolean {
        return this.envCubes.length === ENV_LEVELS.length + 1;
    }

    get envLevelCount(): number {
        return this.envCubes.length;
    }

    /** Marks uniforms for refresh after a setting changed. */
    invalidate(probes = false): void {
        this.dirty = true;
        if (probes) this.probesDirty = true;
    }

    cycleHeroMaterial(): void {
        this.heroMaterial = (this.heroMaterial + 1) % HERO_MATERIALS.length;
        const m = HERO_MATERIALS[this.heroMaterial];
        const hero = this.spheres[0];
        hero.base = m.base;
        hero.metallic = m.metallic;
        hero.roughness = m.roughness;
        this.dirty = true;
    }

    resetHero(): void {
        this.moveHero(HERO_START[0], HERO_START[1], HERO_START[2]);
    }

    /** Moves the hero sphere, kept inside the room and out of the blocks and the other spheres. */
    moveHero(x: number, y: number, z: number): void {
        const hero = this.spheres[0];
        const r = hero.r;
        const p: V3 = [x, y, z];
        for (let iteration = 0; iteration < 3; iteration++) {
            p[0] = Math.min(Math.max(p[0], ROOM.minX + r), ROOM.maxX - r);
            p[1] = Math.min(Math.max(p[1], ROOM.minY + r), LIGHT.y - r - 0.01);
            p[2] = Math.min(Math.max(p[2], ROOM.minZ + r), ROOM.maxZ - r);
            for (const b of BLOCKS) pushOutOfBlock(p, r, b);
            for (const s of this.spheres) {
                if (s === hero) continue;
                const dx = p[0] - s.x, dy = p[1] - s.y, dz = p[2] - s.z;
                const d = Math.hypot(dx, dy, dz);
                const min = r + s.r;
                if (d >= min) continue;
                const k = d > 1e-6 ? min / d : 0;
                if (k === 0) p[1] = s.y + min;
                else { p[0] = s.x + dx * k; p[1] = s.y + dy * k; p[2] = s.z + dz * k; }
            }
        }
        if (p[0] === hero.x && p[1] === hero.y && p[2] === hero.z) return;
        hero.x = p[0]; hero.y = p[1]; hero.z = p[2];
        hero.node.setPosition(p[0], p[1], p[2]);
        hero.visibility = lightVisibility(p);
        this.dirty = true;
    }

    /** Distance along the ray to the hero sphere, or null. */
    pickHero(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number | null {
        const s = this.spheres[0];
        const px = ox - s.x, py = oy - s.y, pz = oz - s.z;
        const b = px * dx + py * dy + pz * dz;
        const c = px * px + py * py + pz * pz - s.r * s.r;
        const disc = b * b - c;
        if (disc < 0) return null;
        const t = -b - Math.sqrt(disc);
        return t >= 0 ? t : null;
    }

    update(): void {
        this.stepEnvFilter();
        // A mesh assigned while the node is inactive renders nothing once it is activated, so activate first.
        this.probeRenderer.node.active = this.showProbes;
        if (this.probesDirty && this.showProbes) {
            this.probesDirty = false;
            this.rebuildProbeMesh();
        }
        if (!this.dirty) return;
        this.dirty = false;
        const hero = this.spheres[0];
        const v = this.v4;
        this.roomMaterial.setProperty('hero', v.set(hero.x, hero.y, hero.z, hero.r));
        this.roomMaterial.setProperty('light', v.set(LIGHT_CENTER[0], LIGHT_CENTER[1], LIGHT_CENTER[2], LIGHT_DISC_RADIUS));
        this.roomMaterial.setProperty('toggles', v.set(this.direct ? 1 : 0, this.indirect ? 1 : 0, EXPOSURE, 0));
        const area = (2 * LIGHT.half) ** 2;
        const count = SH_BAND_COUNTS[this.bands];
        for (const s of this.spheres) {
            const m = s.material;
            this.probeSh(s.x, s.y, s.z, s.sh);
            m.setProperty('baseColor', v.set(s.base[0], s.base[1], s.base[2], 1));
            m.setProperty('material', v.set(s.metallic, s.roughness, s.visibility, EXPOSURE));
            m.setProperty('lightPos', v.set(LIGHT_CENTER[0], LIGHT_CENTER[1], LIGHT_CENTER[2], LIGHT_DISC_RADIUS));
            m.setProperty('lightColor', v.set(LIGHT_RADIANCE[0] * area, LIGHT_RADIANCE[1] * area, LIGHT_RADIANCE[2] * area, 0));
            m.setProperty('toggles', v.set(this.direct ? 1 : 0, this.indirect ? 1 : 0, this.specular ? 1 : 0, this.boxProjection ? 1 : 0));
            m.setProperty('probePos', v.set(PROBE_POSITION[0], PROBE_POSITION[1], PROBE_POSITION[2], 0));
            m.setProperty('boxMin', v.set(ROOM.minX, ROOM.minY, ROOM.minZ, 0));
            m.setProperty('boxMax', v.set(ROOM.maxX, ROOM.maxY, ROOM.maxZ, 0));
            const o = this.nearestOther(s);
            m.setProperty('occluder', v.set(o.x, o.y, o.z, o.r));
            for (let k = 0; k < SH_COEFFS; k++) {
                const on = k < count ? 1 : 0;
                m.setProperty(`sh${k}`, v.set(s.sh[k * 3] * on, s.sh[k * 3 + 1] * on, s.sh[k * 3 + 2] * on, 0));
            }
        }
    }

    /** SH used at a point: blended from the 8 surrounding probes, or the one probe in the middle of the room. */
    private probeSh(x: number, y: number, z: number, out: Float32Array): Float32Array {
        if (this.probeMode === 'one') return this.baked.probeAt(PROBE_POSITION[0], PROBE_POSITION[1], PROBE_POSITION[2], out);
        return this.baked.probeAt(x, y, z, out);
    }

    private nearestOther(s: SphereObject): Sphere {
        let best: Sphere = { x: 0, y: -100, z: 0, r: 0.01 };
        let bestGap = Infinity;
        for (const o of this.spheres) {
            if (o === s) continue;
            const gap = Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z) - o.r;
            if (gap < bestGap) { bestGap = gap; best = o; }
        }
        return best;
    }

    /** One cube face per frame, so prefiltering never stalls a frame for long. */
    private stepEnvFilter(): void {
        if (!this.envChain || this.envReady) return;
        const level = this.envCubes.length - 1;
        const [roughness, size, samples] = ENV_LEVELS[level];
        const t0 = performance.now();
        this.envFaces.push(prefilterFace(this.envChain, roughness, size, samples, this.envFaces.length));
        this.envFaceMs += performance.now() - t0;
        if (this.envFaces.length < 6) return;
        this.envCubes.push(makeRgbmCube({ size, faces: this.envFaces }));
        this.envTimings.push(this.envFaceMs);
        this.envFaces = [];
        this.envFaceMs = 0;
        if (this.envReady) this.envChain = null;
        this.bindEnv();
    }

    /** Levels not built yet use the blurriest one available. */
    private bindEnv(): void {
        for (const s of this.spheres) {
            for (let i = 0; i <= ENV_LEVELS.length; i++) {
                s.material.setProperty(`env${i}`, this.envCubes[Math.min(i, this.envCubes.length - 1)]);
            }
        }
    }

    private rebuildProbeMesh(): void {
        const unit = primitives.sphere(0.07, { segments: 12 });
        const count = SH_BAND_COUNTS[this.bands];
        const [nx, ny, nz] = this.baked.dims;
        const centres: V3[] = [];
        if (this.probeMode === 'one') centres.push(PROBE_POSITION);
        else for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) centres.push(this.baked.probePosition(i, j, k));
        const vertsPer = unit.positions.length / 3;
        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        const sh = new Float32Array(SH_COEFFS * 3);
        const c: V3 = [0, 0, 0];
        centres.forEach((p, n) => {
            this.baked.probeAt(p[0], p[1], p[2], sh);
            for (let k = count; k < SH_COEFFS; k++) sh[k * 3] = sh[k * 3 + 1] = sh[k * 3 + 2] = 0;
            for (let v = 0; v < vertsPer; v++) {
                const nxv = unit.normals![v * 3], nyv = unit.normals![v * 3 + 1], nzv = unit.normals![v * 3 + 2];
                positions.push(p[0] + unit.positions[v * 3], p[1] + unit.positions[v * 3 + 1], p[2] + unit.positions[v * 3 + 2]);
                shEval(sh, nxv, nyv, nzv, c);
                colors.push(c[0], c[1], c[2], 1);
            }
            for (const i of unit.indices!) indices.push(i + n * vertsPer);
        });
        const old = this.probeRenderer.mesh;
        this.probeRenderer.mesh = utils.MeshUtils.createMesh({ positions, colors, indices }) as Mesh;
        old?.destroy();
    }
}

function makeRgbmCube(level: CubeLevel): TextureCube {
    const cube = new TextureCube();
    cube.reset({ width: level.size, height: level.size, format: Texture2D.PixelFormat.RGBA8888, mipmapLevel: 1 });
    cube.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
    cube.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
    level.faces.forEach((face, i) => cube.uploadData(encodeRgbm(face), 0, i));
    return cube;
}

/** Pushes a sphere (centre p, radius r) out of a rotated block, onto its top when that is the shortest way. */
function pushOutOfBlock(p: V3, r: number, b: (typeof BLOCKS)[number]): void {
    const c = Math.cos(b.angle), s = Math.sin(b.angle);
    const dx = p[0] - b.x, dz = p[2] - b.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const qx = Math.min(Math.max(lx, -b.half), b.half);
    const qy = Math.min(Math.max(p[1], 0), b.height);
    const qz = Math.min(Math.max(lz, -b.half), b.half);
    let ox = lx - qx, oy = p[1] - qy, oz = lz - qz;
    const d = Math.hypot(ox, oy, oz);
    if (d >= r) return;
    let nx: number, ny: number, nz: number;
    if (d > 1e-6) {
        ox /= d; oy /= d; oz /= d;
        nx = qx + ox * r; ny = qy + oy * r; nz = qz + oz * r;
    } else {
        // Centre inside: leave through the nearest face.
        const exits = [b.half - lx, lx + b.half, b.half - lz, lz + b.half, b.height - p[1]];
        const face = exits.indexOf(Math.min(...exits));
        nx = lx; ny = p[1]; nz = lz;
        if (face === 0) nx = b.half + r;
        else if (face === 1) nx = -b.half - r;
        else if (face === 2) nz = b.half + r;
        else if (face === 3) nz = -b.half - r;
        else ny = b.height + r;
    }
    p[0] = b.x + nx * c + nz * s;
    p[1] = ny;
    p[2] = b.z - nx * s + nz * c;
}
