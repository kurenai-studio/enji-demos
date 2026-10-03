import { director, gfx, Material, Mesh, MeshRenderer, Node, Texture2D } from 'cc';
import { createDataTexture } from '../../enji/helpers';
import { IMPOSTOR, LOD_LEVELS, LodSystem } from './Lod';
import { chunkMesh, quadChunkMesh } from './Meshes';
import { instanceTextureRows, listTextureRows, packInstances, packList, TEX_WIDTH } from './Pack';
import { v4, type FrameInput, type RenderPath, type Shared } from './Paths';
import { copiesPerChunk } from './Species';

/** Billboards per impostor chunk (4 vertices each). */
const QUAD_COPIES = 4096;

interface Bucket {
    mesh: Mesh;
    copies: number;
    /** Indices of one copy: the last chunk draws only the copies in use. */
    copyIndices: number;
    level: number;
    fading: boolean;
    renderers: MeshRenderer[];
    materials: Material[];
    /** Index count last set on each renderer's input assembler. */
    drawn: number[];
}

/**
 * Data-texture instancing: no node per tree. Script culls cells and trees,
 * picks levels with hysteresis and cross-fades, and writes a compact list of
 * visible (instance, fade) entries per bucket (species × level). Each draw is
 * a chunk mesh holding K copies of one level; copy k of chunk j reads entry
 * j·K + k of its bucket and the instance's transform from textures. The last
 * chunk of a bucket draws only the copies in use (input assembler index count).
 */
export class GpuPath implements RenderPath {
    cpuMs = 0;
    readonly lod: LodSystem;
    private readonly root: Node;
    private readonly instTex: Texture2D;
    private readonly listTex: Texture2D;
    private readonly listData: Float32Array;
    private readonly instRows: number;
    private readonly listRows: number;
    private readonly buckets: Bucket[] = [];
    private tint = false;
    private fog = 1;
    private draws = 0;
    private uploadedRows = 0;
    private partialUpload = true;

    constructor(parent: Node, private readonly shared: Shared) {
        const f = shared.forest;
        this.root = new Node('GpuPath');
        parent.addChild(this.root);
        this.lod = new LodSystem(f, shared.species.map((s) => s.radius), shared.species.map((s) => s.centerY), shared.species.length);
        this.instRows = instanceTextureRows(f.count);
        this.instTex = createDataTexture(TEX_WIDTH, this.instRows, { float: true });
        this.instTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
        this.instTex.uploadData(packInstances(f));
        // Worst case: every tree visible and mid-fade (two entries).
        this.listRows = listTextureRows(f.count * 2);
        this.listTex = createDataTexture(TEX_WIDTH, this.listRows, { float: true });
        this.listTex.setFilters(Texture2D.Filter.NEAREST, Texture2D.Filter.NEAREST);
        this.listData = new Float32Array(this.listRows * TEX_WIDTH * 4);
        this.listTex.uploadData(this.listData);
        shared.species.forEach((sp) => {
            for (let level = 0; level < LOD_LEVELS; level++) {
                const bucket = (mesh: Mesh, copies: number, copyIndices: number): Bucket =>
                    ({ mesh, copies, copyIndices, level, fading: false, renderers: [], materials: [], drawn: [] });
                if (level === IMPOSTOR) {
                    this.buckets.push(bucket(quadChunkMesh(QUAD_COPIES), QUAD_COPIES, 6));
                } else {
                    const g = sp.levels[level];
                    const copies = copiesPerChunk(g);
                    this.buckets.push(bucket(chunkMesh(g, copies), copies, g.indices.length));
                }
            }
        });
        // The fading buckets share the meshes; only their tree material discards.
        const steady = this.buckets.length;
        for (let b = 0; b < steady; b++) this.buckets.push({ ...this.buckets[b], fading: true, renderers: [], materials: [], drawn: [] });
        // One renderer per bucket up front: the first fade would otherwise compile its shader mid-flight.
        for (let b = 0; b < this.buckets.length; b++) this.addRenderer(b);
    }

    private addRenderer(b: number): void {
        const bucket = this.buckets[b];
        const j = bucket.renderers.length;
        const impostor = bucket.level === IMPOSTOR;
        const m = impostor ? this.shared.makeMaterial(this.shared.impostorEffect, { DATA_TEX: true })
            : this.shared.makeMaterial(this.shared.treeEffect, { DATA_TEX: true, FADE: bucket.fading });
        m.setProperty('instTex', this.instTex);
        m.setProperty('listTex', this.listTex);
        m.setProperty('slot', v4(b, j * bucket.copies, bucket.level, 0));
        m.setProperty('dims', v4(this.instRows, this.listRows, this.fog, 0));
        if (impostor) {
            const sp = this.shared.species;
            m.setProperty('atlas', this.shared.atlas);
            m.setProperty('sizes', v4(sp[0].impostor.size, sp[1].impostor.size, sp[2].impostor.size, 0));
            m.setProperty('centers', v4(sp[0].impostor.centerY, sp[1].impostor.centerY, sp[2].impostor.centerY, 0));
            m.setProperty('lookF', v4(this.tint ? 1 : 0, IMPOSTOR, 0, 0));
        } else {
            m.setProperty('look', v4(this.tint ? 1 : 0, bucket.level, 0, 0));
        }
        const node = new Node(`b${b}-${j}`);
        this.root.addChild(node);
        const r = node.addComponent(MeshRenderer);
        r.mesh = bucket.mesh;
        r.setSharedMaterial(m, 0);
        r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        r.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
        bucket.renderers.push(r);
        bucket.materials.push(m);
        bucket.drawn.push(-1);
    }

    setVisible(on: boolean): void {
        this.root.active = on;
    }

    update(frame: FrameInput): void {
        const t0 = performance.now();
        const [x, y, z] = frame.eye;
        this.lod.update(frame.planes, x, y, z, frame.projScale, frame.dt, frame.lod);
        const rows = packList(this.lod, this.listData);
        this.upload(rows);
        if (frame.tint !== this.tint || frame.fog !== this.fog) {
            this.tint = frame.tint;
            this.fog = frame.fog;
            for (const b of this.buckets) {
                for (const m of b.materials) {
                    m.setProperty(b.level === IMPOSTOR ? 'lookF' : 'look', v4(this.tint ? 1 : 0, b.level, 0, 0));
                    m.setProperty('dims', v4(this.instRows, this.listRows, this.fog, 0));
                }
            }
        }
        this.draws = 0;
        this.drawnTris = 0;
        this.buckets.forEach((bucket, b) => {
            const count = this.lod.counts[b];
            const need = Math.ceil(count / bucket.copies);
            while (bucket.renderers.length < need) this.addRenderer(b);
            bucket.renderers.forEach((r, j) => {
                if (r.node.active !== j < need) r.node.active = j < need;
                if (j >= need) return;
                const indices = Math.min(bucket.copies, count - j * bucket.copies) * bucket.copyIndices;
                if (bucket.drawn[j] !== indices) {
                    const ia = r.model?.subModels[0]?.inputAssembler;
                    if (ia) { ia.indexCount = indices; bucket.drawn[j] = indices; }
                }
                this.drawnTris += indices / 3;
            });
            this.draws += need;
        });
        this.cpuMs = performance.now() - t0;
    }

    private drawnTris = 0;

    /** Uploads only the rows in use (header plus entries); falls back to the whole texture. */
    private upload(rows: number): void {
        this.uploadedRows = rows;
        if (this.partialUpload) {
            try {
                const region = new gfx.BufferTextureCopy();
                region.texExtent.width = TEX_WIDTH;
                region.texExtent.height = rows;
                region.texExtent.depth = 1;
                director.root!.device.copyBuffersToTexture([this.listData.subarray(0, rows * TEX_WIDTH * 4)], this.listTex.getGFXTexture()!, [region]);
                return;
            } catch (e) {
                console.warn('partial upload failed, uploading whole list texture', e);
                this.partialUpload = false;
            }
        }
        this.uploadedRows = this.listRows;
        this.listTex.uploadData(this.listData);
    }

    describe(): string {
        const s = this.lod.stats;
        return `GPU list: ${s.visible} visible, levels ${Array.from(s.perLevel).join('/')}, ${s.fading} fading, ${this.draws} draws, ` +
            `${(this.drawnTris / 1e6).toFixed(2)} M tris, ${((this.uploadedRows * TEX_WIDTH * 16) / 1024).toFixed(0)} KB upload`;
    }

    destroy(): void {
        this.root.destroy();
        this.instTex.destroy();
        this.listTex.destroy();
    }
}
