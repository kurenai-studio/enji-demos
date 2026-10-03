import { Camera, Color, director, Director, Material, MeshRenderer, Node, RenderTexture, Texture2D } from 'cc';
import { bakeYaw, buildMips, CELL_PX, dilate, FRAMES, type MipChain } from './Impostor';
import type { SpeciesAssets } from './Species';
import { geoMesh } from './Meshes';

/** A user layer seen only by the bake camera. */
const BAKE_LAYER = 1 << 18;
const ORIGIN_X = 50000;

export interface BakedAtlas {
    texture: Texture2D;
    chain: MipChain;
    /** Level-0 pixels as rendered (rows top to bottom), for inspection. */
    width: number;
    height: number;
}

/**
 * Renders every species from FRAMES azimuths in one orthographic shot: one
 * world unit per atlas cell, albedo copies in rows 0..S-1 and normal copies in
 * rows S..2S-1. Each copy is scaled to its cell and turned by bakeYaw(k).
 * Reads the target back, pads colours into the transparent texels, builds
 * coverage-preserving mipmaps and uploads them to a mipmapped texture.
 */
export function bakeImpostors(scene: Node, species: readonly SpeciesAssets[], albedo: Material, normal: Material, preserveCoverage = true): Promise<BakedAtlas> {
    const rows = species.length * 2;
    const width = FRAMES * CELL_PX, height = rows * CELL_PX;
    const target = new RenderTexture();
    target.reset({ width, height });

    const root = new Node('ImpostorBake');
    root.layer = BAKE_LAYER;
    scene.addChild(root);
    species.forEach((sp, s) => {
        const mesh = geoMesh(sp.levels[0], sp.bounds);
        const k = 1 / sp.impostor.size;
        for (let f = 0; f < FRAMES; f++) {
            for (const [row, mat] of [[s, albedo], [s + species.length, normal]] as const) {
                const node = new Node(`bake-${sp.name}-${f}-${row}`);
                node.layer = BAKE_LAYER;
                root.addChild(node);
                const cx = ORIGIN_X - FRAMES / 2 + f + 0.5;
                const cy = rows / 2 - row - 0.5;
                node.setPosition(cx, cy - sp.impostor.centerY * k, 0);
                node.setScale(k, k, k);
                node.setRotationFromEuler(0, (bakeYaw(f) * 180) / Math.PI, 0);
                const r = node.addComponent(MeshRenderer);
                r.mesh = mesh;
                r.setSharedMaterial(mat, 0);
                r.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            }
        }
    });
    const camNode = new Node('ImpostorBakeCamera');
    scene.addChild(camNode);
    camNode.setPosition(ORIGIN_X, 0, 10);
    const camera = camNode.addComponent(Camera);
    camera.projection = Camera.ProjectionType.ORTHO;
    camera.orthoHeight = rows / 2;
    camera.near = 1;
    camera.far = 20;
    camera.visibility = BAKE_LAYER;
    camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
    camera.clearColor = new Color(0, 0, 0, 0);
    camera.priority = -50;
    camera.targetTexture = target;

    return new Promise((resolve) => {
        let frames = 0;
        const after = (): void => {
            if (++frames < 2) return;
            director.off(Director.EVENT_AFTER_DRAW, after);
            const raw = target.readPixels(0, 0, width, height) as Uint8Array;
            camera.enabled = false;
            root.destroy();
            camNode.destroy();
            const pixels = orientTopDown(raw, width, height, species.length);
            dilate(pixels, width, height, CELL_PX);
            const chain = buildMips(pixels, width, height, CELL_PX, 4, preserveCoverage, species.length);
            const texture = new Texture2D();
            texture.reset({ width, height, format: Texture2D.PixelFormat.RGBA8888, mipmapLevel: chain.data.length });
            chain.data.forEach((d, level) => texture.uploadData(d, level));
            texture.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
            texture.setMipFilter(Texture2D.Filter.LINEAR);
            texture.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);
            target.destroy();
            resolve({ texture, chain, width, height });
        };
        director.on(Director.EVENT_AFTER_DRAW, after);
    });
}

/**
 * Readback row order depends on the backend. The top cell row holds albedo
 * (dark green, little blue) and the bottom one normals (blue >= 0.5), so the
 * blue channel tells which way up the buffer is.
 */
function orientTopDown(raw: Uint8Array, w: number, h: number, speciesCount: number): Uint8Array {
    const meanBlue = (y0: number): number => {
        let sum = 0, n = 0;
        for (let y = y0; y < y0 + CELL_PX; y++) for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (raw[o + 3] > 128) { sum += raw[o + 2]; n++; }
        }
        return n ? sum / n : 0;
    };
    const firstIsNormals = meanBlue(0) > meanBlue((speciesCount * 2 - 1) * CELL_PX);
    const out = new Uint8Array(raw.length);
    if (!firstIsNormals) { out.set(raw); return out; }
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
}
