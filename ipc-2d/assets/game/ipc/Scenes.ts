import type { BodyDef } from './IpcWorld';
import { arcShape, diskShape, polygonShape, rectShape, type Shape } from './Mesh2D';

export interface SceneDef {
    name: string;
    bodies: BodyDef[];
    /** Visible area in metres: [minX, minY, maxX, maxY]. */
    view: [number, number, number, number];
}

export const SCENE_NAMES = ['Pile', 'Squeeze', 'Bullet'];

const JELLY = { young: 3e4, poisson: 0.4, density: 100 };
const RUBBER = { young: 1e5, poisson: 0.4, density: 150 };
const STIFF = { young: 1e6, poisson: 0.3, density: 400 };

const WALL_COLOR = [0.24, 0.26, 0.32];
const PISTON_COLOR = [0.42, 0.45, 0.52];
const COLORS = [
    [0.93, 0.36, 0.45],
    [0.98, 0.66, 0.3],
    [0.45, 0.78, 0.5],
    [0.36, 0.6, 0.95],
    [0.72, 0.5, 0.92],
    [0.95, 0.85, 0.35],
    [0.35, 0.82, 0.85],
];

const HALF_WIDTH = 0.8;
const HEIGHT = 2.2;
const WALL = 0.1;

function soft(shape: Shape, material: typeof JELLY, color: readonly number[], vx = 0, vy = 0): BodyDef {
    return { shape, ...material, color, vx, vy };
}

function fixed(shape: Shape, color = WALL_COLOR, motion?: (t: number) => [number, number]): BodyDef {
    return { shape, young: 0, poisson: 0, density: 0, kinematic: true, motion, color };
}

/** Floor, two walls and a lid around x ∈ [−0.8, 0.8], y ∈ [0, 2.2]. */
function container(): BodyDef[] {
    const w = HALF_WIDTH;
    return [
        fixed(rectShape(0, -WALL / 2, 2 * w + 2 * WALL, WALL, 1, 1)),
        fixed(rectShape(-w - WALL / 2, HEIGHT / 2, WALL, HEIGHT, 1, 1)),
        fixed(rectShape(w + WALL / 2, HEIGHT / 2, WALL, HEIGHT, 1, 1)),
        fixed(rectShape(0, HEIGHT + WALL / 2, 2 * w + 2 * WALL, WALL, 1, 1)),
    ];
}

const VIEW: [number, number, number, number] = [-HALF_WIDTH - WALL, -WALL, HALF_WIDTH + WALL, HEIGHT + WALL];

function pile(): SceneDef {
    return {
        name: 'Pile',
        view: VIEW,
        bodies: [
            ...container(),
            fixed(polygonShape([-0.18, 0, 0.18, 0, 0, 0.22])),
            soft(diskShape(-0.42, 0.4, 0.15, 4), JELLY, COLORS[0]),
            soft(rectShape(0.4, 0.3, 0.4, 0.18, 8, 4, 0.15), RUBBER, COLORS[1]),
            soft(arcShape(-0.05, 0.85, 0.08, 0.17, 0.35 * Math.PI, 1.65 * Math.PI, 2, 14), JELLY, COLORS[2]),
            soft(arcShape(0.45, 0.9, 0.07, 0.15, 0, 2 * Math.PI, 2, 18), RUBBER, COLORS[3]),
            soft(rectShape(-0.35, 1.35, 0.55, 0.12, 11, 2, -0.3), JELLY, COLORS[4]),
            soft(diskShape(0.3, 1.5, 0.11, 3), STIFF, COLORS[5]),
            soft(diskShape(-0.1, 1.85, 0.13, 4), JELLY, COLORS[6], 0.8, 0),
        ],
    };
}

function squeeze(): SceneDef {
    const plate = (t: number): [number, number] => {
        // Down at 0.5 m/s to 10 cm above the floor, hold, back up; every 9 s.
        const c = t % 9;
        const travel = 1.7;
        const y = c < 3.4 ? -0.5 * c : c < 4.5 ? -travel : -Math.max(0, travel - 0.5 * (c - 4.5));
        return [0, y];
    };
    return {
        name: 'Squeeze',
        view: VIEW,
        bodies: [
            ...container(),
            { ...fixed(rectShape(0, 1.84, 1.4, 0.08, 14, 1), PISTON_COLOR, plate), young: 2e6, poisson: 0.3 },
            soft(diskShape(-0.42, 0.16, 0.15, 4), JELLY, COLORS[0]),
            soft(arcShape(0.02, 0.16, 0.07, 0.15, 0, 2 * Math.PI, 2, 18), RUBBER, COLORS[3]),
            soft(rectShape(0.45, 0.11, 0.3, 0.2, 6, 4), JELLY, COLORS[2]),
        ],
    };
}

function bullet(): SceneDef {
    const slabs: BodyDef[] = [];
    for (let k = 0; k < 3; k++) slabs.push(soft(rectShape(0.05 + 0.2 * k, 0.301, 0.03, 0.6, 1, 16), RUBBER, COLORS[1 + k]));
    return {
        name: 'Bullet',
        view: VIEW,
        bodies: [
            ...container(),
            ...slabs,
            soft(diskShape(-0.6, 0.45, 0.05, 2), STIFF, COLORS[5], 30, 0),
        ],
    };
}

export function buildScene(index: number): SceneDef {
    return [pile, squeeze, bullet][index]();
}
