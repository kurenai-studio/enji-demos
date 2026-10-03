import { EffectAsset, Material, MeshRenderer, Node, resources, type Texture2D, utils } from 'cc';
import { createDataTexture } from '../../enji/helpers';
import type { FluidGrid } from './FluidGrid';

/** Vertical gap between stacked grids, in cells. */
export const GRID_GAP = 4;
/** Frame drawn around each grid, in cells. */
const BORDER = 0.8;

export const ViewMode = { Dye: 0, Curl: 1 } as const;
export type ViewModeKind = (typeof ViewMode)[keyof typeof ViewMode];

const BACKGROUND = [0.04, 0.045, 0.06];
const SOLID = [0.36, 0.38, 0.44];
const FRAME = [0.2, 0.22, 0.28];
const CURL_POS = [1.0, 0.42, 0.18];
const CURL_NEG = [0.2, 0.55, 1.0];

function loadEffect(path: string): Promise<EffectAsset> {
    return new Promise((resolve, reject) => {
        resources.load(path, EffectAsset, (err, effect) => (err ? reject(err) : resolve(effect)));
    });
}

interface Panel {
    node: Node;
    texture: Texture2D;
    pixels: Uint8Array;
    material: Material;
}

/**
 * Draws each grid as a textured quad in cell units (one texel per cell),
 * stacked top to bottom: grid 0 on top. Dye mode tone-maps the dye over a
 * dark background; curl mode shows vorticity (orange counter-clockwise, blue
 * clockwise) over a faint copy of the dye.
 */
export class FluidView {
    private readonly root: Node;
    private readonly dyeEffect: EffectAsset;
    private readonly flatMaterial: Material;
    private panels: Panel[] = [];
    private frameNode: Node | null = null;
    private offsets: number[] = [];
    private size = { width: 0, height: 0 };
    mode: ViewModeKind = ViewMode.Dye;

    private constructor(parent: Node, dye: EffectAsset, flat: EffectAsset) {
        this.root = new Node('FluidView');
        parent.addChild(this.root);
        this.dyeEffect = dye;
        this.flatMaterial = new Material();
        this.flatMaterial.initialize({ effectAsset: flat });
    }

    static async create(parent: Node): Promise<FluidView> {
        const [dye, flat] = await Promise.all([loadEffect('effects/fluid-dye'), loadEffect('effects/fluid-flat')]);
        return new FluidView(parent, dye, flat);
    }

    /** Total drawn width and height in cells. */
    get extent(): { width: number; height: number } {
        return this.size;
    }

    /** y of grid i's bottom edge in view space. */
    offset(i: number): number {
        return this.offsets[i] ?? 0;
    }

    rebuild(grids: readonly FluidGrid[]): void {
        for (const p of this.panels) {
            p.node.destroy();
            p.texture.destroy();
        }
        this.panels = [];
        this.frameNode?.destroy();
        const nx = grids[0]?.nx ?? 0;
        const ny = grids[0]?.ny ?? 0;
        const count = grids.length;
        this.offsets = grids.map((_, i) => (count - 1 - i) * (ny + GRID_GAP));
        this.size = { width: nx, height: count * ny + (count - 1) * GRID_GAP };

        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        for (const y0 of this.offsets) {
            const base = positions.length / 3;
            positions.push(-BORDER, y0 - BORDER, -1, nx + BORDER, y0 - BORDER, -1, nx + BORDER, y0 + ny + BORDER, -1, -BORDER, y0 + ny + BORDER, -1);
            for (let k = 0; k < 4; k++) colors.push(FRAME[0], FRAME[1], FRAME[2], 1);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        this.frameNode = new Node('Frames');
        this.root.addChild(this.frameNode);
        const frames = this.frameNode.addComponent(MeshRenderer);
        frames.mesh = utils.MeshUtils.createMesh({ positions, colors, indices });
        frames.setSharedMaterial(this.flatMaterial, 0);

        grids.forEach((g, i) => {
            const y0 = this.offsets[i];
            const node = new Node(`Grid${i}`);
            this.root.addChild(node);
            const renderer = node.addComponent(MeshRenderer);
            renderer.mesh = utils.MeshUtils.createMesh({
                positions: [0, y0, 0, nx, y0, 0, nx, y0 + ny, 0, 0, y0 + ny, 0],
                uvs: [0, 0, 1, 0, 1, 1, 0, 1],
                indices: [0, 1, 2, 0, 2, 3],
            });
            const texture = createDataTexture(g.nx, g.ny);
            const material = new Material();
            material.initialize({ effectAsset: this.dyeEffect });
            material.setProperty('fieldTex', texture);
            renderer.setSharedMaterial(material, 0);
            this.panels.push({ node, texture, material, pixels: new Uint8Array(g.nx * g.ny * 4) });
        });
    }

    update(grids: readonly FluidGrid[]): void {
        grids.forEach((g, i) => {
            const panel = this.panels[i];
            if (!panel) return;
            if (this.mode === ViewMode.Curl) fillCurl(g, panel.pixels);
            else fillDye(g, panel.pixels);
            panel.texture.uploadData(panel.pixels);
        });
    }
}

function toByte(x: number): number {
    return x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0;
}

/** Soft exposure curve: thin dye tints the background, thick dye saturates towards its colour. */
function fillDye(g: FluidGrid, out: Uint8Array): void {
    const n = g.nx * g.ny;
    for (let c = 0, o = 0; c < n; c++, o += 4) {
        if (g.solid[c]) {
            out[o] = toByte(SOLID[0]);
            out[o + 1] = toByte(SOLID[1]);
            out[o + 2] = toByte(SOLID[2]);
        } else {
            out[o] = toByte(1 - (1 - BACKGROUND[0]) * Math.exp(-1.6 * g.r[c]));
            out[o + 1] = toByte(1 - (1 - BACKGROUND[1]) * Math.exp(-1.6 * g.g[c]));
            out[o + 2] = toByte(1 - (1 - BACKGROUND[2]) * Math.exp(-1.6 * g.b[c]));
        }
        out[o + 3] = 255;
    }
}

function fillCurl(g: FluidGrid, out: Uint8Array): void {
    const n = g.nx * g.ny;
    const scale = 50 / g.ny;
    for (let c = 0, o = 0; c < n; c++, o += 4) {
        if (g.solid[c]) {
            out[o] = toByte(SOLID[0]);
            out[o + 1] = toByte(SOLID[1]);
            out[o + 2] = toByte(SOLID[2]);
            out[o + 3] = 255;
            continue;
        }
        const w = g.curl[c] * scale;
        const t = Math.tanh(Math.abs(w));
        const col = w > 0 ? CURL_POS : CURL_NEG;
        const dye = 0.12 * Math.min(1, (g.r[c] + g.g[c] + g.b[c]) / 3);
        out[o] = toByte(BACKGROUND[0] + dye + (col[0] - BACKGROUND[0]) * t);
        out[o + 1] = toByte(BACKGROUND[1] + dye + (col[1] - BACKGROUND[1]) * t);
        out[o + 2] = toByte(BACKGROUND[2] + dye + (col[2] - BACKGROUND[2]) * t);
        out[o + 3] = 255;
    }
}
