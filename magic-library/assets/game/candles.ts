import { Color, gfx, Material, MeshRenderer, Node, PointLight, primitives, sys, utils } from 'cc';
import { loadBuiltinEffect } from '../enji/helpers';
import { LevelId } from './levels';

/** Submesh slots that the hall export left as flat white instead of flame. */
type SlotMap = Record<string, number[]>;

const ARCHIVE_FLAME: SlotMap = {
    Decor_Air: [1],
    Decor_Front: [3],
    Decor_Back: [3],
    Decor_Stairs: [2],
};

const ARCHIVE_GLASS: SlotMap = {
    Decor_Air: [2],
    Decor_Front: [4],
    Decor_Stairs: [1],
};

const GOTHIC_FLAME: SlotMap = {
    Decor_Lights: [1],
    Decor_Front: [4, 5, 6],
    Decor_Upper: [3],
};

/** x, y, z, luminance, range — positions from the authored hall lights. */
type Lamp = [number, number, number, number, number];

const ARCHIVE_LAMPS: Lamp[] = [
    [-2.7, 3.17, 0, 420, 4.2],
    [0, 3.17, 0, 420, 4.2],
    [2.7, 3.17, 0, 420, 4.2],
    [-2.7, 2.7, -4.795, 160, 2.4],
    [0, 2.7, -4.795, 160, 2.4],
    [2.7, 2.7, -4.795, 160, 2.4],
    [-2.7, 2.7, 4.795, 160, 2.4],
    [0, 2.7, 4.795, 160, 2.4],
    [2.7, 2.7, 4.795, 160, 2.4],
    [-5.4, 2.594, -1.8, 140, 2.2],
    [-5.4, 2.594, 1.8, 140, 2.2],
    [-5.73, 1.21, 3.2, 90, 1.6],
    [5.05, 1.42, -2.9, 110, 1.8],
    [5.05, 1.42, 2.6, 110, 1.8],
];

const GOTHIC_LAMPS: Lamp[] = [
    [-4.05, 6.05, 0, 420, 5],
    [-1.35, 6.05, 0, 420, 5],
    [1.35, 6.05, 0, 420, 5],
    [-3.3, 2.6, -5.045, 140, 2.2],
    [3.3, 2.6, -5.045, 140, 2.2],
    [-6, 2.6, -5.045, 140, 2.2],
    [6, 2.6, -5.045, 140, 2.2],
    [-3.3, 5.95, -5.045, 140, 2.2],
    [3.3, 5.95, -5.045, 140, 2.2],
    [-3.3, 2.6, 5.045, 140, 2.2],
    [3.3, 2.6, 5.045, 140, 2.2],
    [-6, 2.6, 5.045, 140, 2.2],
    [6, 2.6, 5.045, 140, 2.2],
    [-3.3, 5.95, 5.045, 140, 2.2],
    [3.3, 5.95, 5.045, 140, 2.2],
    [-6.2, 0.5, -3, 260, 2.8],
    [-6.72, 1.85, -1.08, 90, 1.6],
    [-6.72, 1.85, 1.08, 90, 1.6],
    [6.55, 1.35, 3.45, 90, 1.6],
    [4.9, 1.85, 5, 90, 1.6],
    [-5.55, 4.55, -3.45, 90, 1.6],
    [-5.55, 4.55, 2.55, 90, 1.6],
    [-6.6, 5.1, 0, 120, 2],
];

const FLAME = new Color(255, 186, 64, 255);
const WARM = new Color(255, 156, 78, 255);
const STORE = 'enji.library.candles';

/** Off until the flame meshes are cheap enough to leave on. */
let enabled = false;
loadCandles();

export function candlesEnabled(): boolean {
    return enabled;
}

export function setCandlesEnabled(on: boolean): void {
    enabled = on;
    try {
        sys.localStorage.setItem(STORE, on ? '1' : '0');
    } catch {
        // Private mode can reject storage; the session still keeps the choice.
    }
}

function loadCandles(): void {
    try {
        enabled = sys.localStorage.getItem(STORE) === '1';
    } catch {
        enabled = false;
    }
}

export type CandleRig = {
    lights: PointLight[];
    bases: number[];
    flame: Material;
};

function unlit(color: Color): Material {
    const material = new Material();
    material.initialize({
        effectName: 'builtin-unlit',
        technique: 0,
        states: { rasterizerState: { cullMode: gfx.CullMode.NONE } },
    });
    material.setProperty('mainColor', color);
    return material;
}

function paint(root: Node, slots: SlotMap, material: Material): void {
    for (const name of Object.keys(slots)) {
        const renderer = root.getChildByName(name)?.getComponent(MeshRenderer);
        if (!renderer) continue;
        for (const index of slots[name]) {
            if (index < renderer.sharedMaterials.length) renderer.setSharedMaterial(material, index);
        }
    }
}


/** Wick tips sampled from the hall flame meshes, so the visible fire sits on the candles. */
const ARCHIVE_WICKS: number[] = [
    -5.90,3.64,1.20, -5.86,3.13,1.48, -5.64,3.33,1.15, -5.40,2.93,-1.80,
    -5.40,2.93,1.80, -5.14,3.05,-1.89, -4.99,2.75,3.50, -4.93,3.01,4.03,
    -4.91,3.55,2.70, -4.90,3.51,0.85, -4.90,3.49,1.06, -4.75,2.89,-0.72,
    -3.92,3.16,-1.13, -3.87,3.55,1.19, -3.64,3.33,2.90, -3.63,3.20,-3.67,
    -3.54,2.84,-2.41, -3.40,2.75,2.29, -3.40,3.14,0.78, -3.33,2.81,1.76,
    -3.32,3.22,-0.00, -3.24,3.22,0.31, -3.24,3.25,-0.31, -3.06,3.23,0.95,
    -3.01,3.22,0.54, -3.01,3.24,-0.54, -2.96,3.46,-0.15, -2.96,3.44,0.15,
    -2.70,3.25,0.62, -2.70,2.99,-4.80, -2.70,2.99,4.79, -2.70,3.25,-0.62,
    -2.70,3.44,0.30, -2.70,3.51,-0.30, -2.44,3.45,0.15, -2.44,3.44,-0.15,
    -2.39,3.20,-0.54, -2.39,3.21,0.54, -2.17,3.26,-0.31, -2.16,3.23,0.31,
    -2.08,3.20,-0.00, -1.84,3.34,-0.95, -1.73,2.71,-1.37, -1.72,3.36,-1.19,
    -1.64,3.05,-1.86, -1.41,3.23,-1.42, -1.13,3.55,2.52, -1.07,3.14,-0.11,
    -0.83,2.72,1.80, -0.73,3.33,-2.41, -0.62,3.20,-0.00, -0.56,3.60,-1.41,
    -0.54,3.19,0.31, -0.54,3.19,-0.31, -0.45,2.70,1.23, -0.39,3.43,-3.58,
    -0.32,3.11,4.08, -0.31,3.20,-0.54, -0.31,3.25,0.54, -0.29,3.06,-2.26,
    -0.26,3.45,0.15, -0.26,3.43,-0.15, -0.00,3.45,0.30, -0.00,3.45,-0.30,
    0.00,2.99,-4.80, 0.00,2.99,4.79, 0.00,3.21,0.62, 0.00,3.21,-0.62,
    0.26,3.51,0.15, 0.26,3.50,-0.15, 0.31,3.26,-0.54, 0.31,3.24,0.54,
    0.53,3.17,0.31, 0.53,3.24,-0.31, 0.62,3.26,-0.00, 0.74,3.07,2.89,
    0.97,3.33,0.33, 1.15,3.05,-3.03, 1.16,2.79,2.63, 1.22,3.65,3.96,
    1.22,3.26,-2.21, 1.41,3.26,3.88, 1.43,3.34,2.08, 1.46,3.45,1.01,
    1.51,3.16,-1.34, 1.65,2.94,2.79, 1.68,3.03,-3.63, 1.83,3.04,-2.50,
    1.86,3.63,-1.71, 2.08,3.25,-0.00, 2.16,3.24,-0.31, 2.16,3.25,0.31,
    2.36,3.33,-2.01, 2.39,3.22,0.54, 2.39,3.25,-0.54, 2.44,3.46,0.15,
    2.44,3.51,-0.15, 2.70,3.23,-0.62, 2.70,3.44,-0.30, 2.70,3.45,0.30,
    2.70,2.99,-4.80, 2.70,2.99,4.79, 2.70,3.19,0.62, 2.96,3.49,0.15,
    2.96,3.50,-0.15, 3.01,3.22,-0.54, 3.01,3.24,0.54, 3.23,3.26,0.31,
    3.24,3.23,-0.31, 3.32,3.22,-0.00, 3.57,3.44,2.70, 3.74,2.83,-3.35,
    3.87,3.19,-3.91, 3.89,3.33,1.82, 4.03,3.49,-1.83, 4.14,2.81,3.00,
    -5.73,1.21,3.20, 5.05,1.21,-2.76, 5.05,1.30,2.60, 5.05,1.21,-3.04,
    5.05,1.21,2.46, 5.05,1.21,2.74, 5.05,1.30,-2.90, 3.98,1.23,-0.64,
    3.98,1.23,0.64,
];

const GOTHIC_WICKS: number[] = [
    -3.14,0.16,6.70, -2.94,0.16,6.71, -2.79,0.17,6.71, -3.19,0.23,6.71,
    -3.14,0.37,6.70, -2.97,0.22,6.70, -2.92,0.41,6.70, -2.81,0.17,6.71,
    -2.74,0.30,6.70, -4.05,1.60,6.70, -1.95,1.57,6.70, -1.08,1.68,6.52,
    -1.08,1.68,6.92, -1.08,1.83,6.72, 1.08,1.68,6.52, 1.08,1.68,6.92,
    1.08,1.83,6.72, 3.45,1.22,-6.55, 5.00,1.68,-4.70, 5.00,1.68,-5.10,
    5.00,1.83,-4.90, -5.05,2.50,-6.00, -5.05,2.50,3.30, -5.05,2.50,6.00,
    -5.05,2.50,-3.30, -3.99,5.91,1.66, -3.97,2.33,-1.65, -3.90,5.90,0.07,
    -3.89,2.36,3.15, -3.77,6.18,4.41, -3.70,5.62,-4.39, -3.56,5.94,4.70,
    -3.55,5.55,-4.06, -3.28,6.72,3.15, -3.13,6.74,-2.18, -3.08,6.01,-3.11,
    -2.83,2.33,4.73, -2.80,5.94,-3.26, -2.67,6.89,-3.17, -2.55,2.32,-4.53,
    -2.45,6.17,5.80, -2.36,2.57,-4.39, -2.32,2.69,3.16, -2.25,6.39,-1.48,
    -1.75,6.66,0.76, -1.68,2.45,-4.59, -1.65,6.48,-4.39, -1.46,5.58,4.21,
    -1.11,6.67,-2.60, -1.07,2.15,-0.62, -1.04,6.40,4.61, -0.98,6.95,-4.87,
    -0.62,6.14,-1.35, -0.62,6.14,1.35, -0.62,6.14,4.05, -0.54,6.14,3.74,
    -0.54,6.14,-1.66, -0.54,6.14,-1.04, -0.54,6.14,1.04, -0.54,6.14,1.66,
    -0.54,6.14,4.36, -0.32,6.46,4.05, -0.32,6.46,-1.35, -0.32,6.46,1.35,
    -0.31,6.14,3.51, -0.31,6.14,-1.89, -0.31,6.14,1.89, -0.31,6.14,-0.81,
    -0.31,6.14,0.81, -0.31,6.14,4.59, -0.25,2.45,2.84, -0.16,6.46,3.77,
    -0.16,6.46,4.33, -0.16,6.46,-1.07, -0.16,6.46,1.07, -0.16,6.46,-1.63,
    -0.16,6.46,1.63, -0.00,6.14,3.43, -0.00,6.14,1.97, -0.00,6.14,-1.97,
    -0.00,6.14,-0.73, -0.00,6.14,4.67, -0.00,6.14,0.73, 0.16,6.46,3.77,
    0.16,6.46,4.33, 0.16,6.46,-1.07, 0.16,6.46,1.07, 0.16,6.46,-1.63,
    0.16,6.46,1.63, 0.31,6.14,3.51, 0.31,6.14,-1.89, 0.31,6.14,1.89,
    0.31,6.14,-0.81, 0.31,6.14,0.81, 0.31,6.14,4.59, 0.32,6.46,4.05,
    0.32,6.46,-1.35, 0.32,6.46,1.35, 0.54,6.14,3.74, 0.54,6.14,-1.66,
    0.54,6.14,-1.04, 0.54,6.14,1.04, 0.54,6.14,1.66, 0.54,6.14,4.36,
    0.62,6.14,-1.35, 0.62,6.14,1.35, 0.62,6.14,4.05, 0.89,6.04,-4.08,
    0.89,5.91,-0.41, 0.91,6.30,5.14, 0.94,2.23,4.09, 0.98,2.59,-2.31,
    0.99,6.48,-2.48, 1.04,5.65,-2.63, 1.18,6.04,-2.73, 1.31,6.05,-2.30,
    1.51,5.69,-4.96, 1.53,6.56,-1.86, 1.64,2.56,4.81, 1.90,6.05,-3.07,
    1.92,2.21,-4.19, 2.00,2.22,-3.38, 2.12,2.52,3.74, 2.24,6.49,-0.30,
    2.54,2.34,0.40, 2.54,6.74,1.51, 2.70,6.65,4.74, 2.96,7.02,-1.51,
    3.15,2.32,2.29, 3.43,6.00,-4.35, 3.54,2.56,-1.35, 3.89,6.06,0.23,
    3.99,6.96,-3.34, 5.04,2.50,-6.00, 5.04,2.50,3.30, 5.04,2.50,6.00,
    5.04,2.50,-3.30, -3.58,4.38,5.55, -3.45,4.48,5.55, -3.32,4.38,5.55,
    -0.00,5.08,6.60, -0.00,4.93,6.80, -0.00,4.93,6.40, 2.42,4.38,5.55,
    2.55,4.48,5.55, 2.68,4.38,5.55,
];

function addFlames(hall: Node, wicks: number[], material: Material): void {
    const mesh = utils.MeshUtils.createMesh(primitives.cone(0.042, 0.18, { radialSegments: 6 }));
    for (let i = 0; i < wicks.length; i += 3) {
        const node = new Node('Flame');
        hall.addChild(node);
        const s = 0.82 + ((i * 7) % 28) / 100;
        const h = 0.78 + ((i * 5) % 36) / 100;
        node.setPosition(wicks[i], wicks[i + 1] + 0.04 * h, wicks[i + 2]);
        node.setScale(s, h, s);
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = mesh;
        renderer.setSharedMaterial(material, 0);
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        renderer.receiveShadow = false;
    }
}

export async function lightCandles(hall: Node, level: LevelId): Promise<CandleRig> {
    await loadBuiltinEffect('builtin-unlit');
    const flame = unlit(FLAME);
    const wicks = level === 'archive' ? ARCHIVE_WICKS : GOTHIC_WICKS;
    if (level === 'archive') {
        paint(hall, ARCHIVE_FLAME, flame);
        paint(hall, ARCHIVE_GLASS, unlit(new Color(255, 148, 62, 255)));
    } else {
        paint(hall, GOTHIC_FLAME, flame);
    }
    addFlames(hall, wicks, flame);
    const lamps = level === 'archive' ? ARCHIVE_LAMPS : GOTHIC_LAMPS;
    const lights: PointLight[] = [];
    const bases: number[] = [];
    for (const [x, y, z, lum, range] of lamps) {
        const node = new Node('Wick');
        hall.addChild(node);
        node.setPosition(x, y, z);
        const light = node.addComponent(PointLight);
        light.color = WARM;
        light.range = range;
        light.luminance = lum;
        lights.push(light);
        bases.push(lum);
    }
    return { lights, bases, flame };
}

export function flickerCandles(rig: CandleRig, t: number): void {
    const flick = 0.72 + 0.28 * Math.sin(t * 7.4) * Math.sin(t * 2.6);
    FLAME.g = 150 + Math.round(80 * flick);
    FLAME.b = 32 + Math.round(48 * flick);
    rig.flame.setProperty('mainColor', FLAME);
    for (let i = 0; i < rig.lights.length; i++) {
        const wobble = 0.84 + 0.16 * Math.sin(t * 6.2 + i * 1.37);
        rig.lights[i].luminance = rig.bases[i] * wobble;
    }
}
