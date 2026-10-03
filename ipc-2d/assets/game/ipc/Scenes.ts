import type { BodyDef } from './IpcWorld';
import { arcShape, diskShape, polygonShape, rectShape, type Shape } from './Mesh2D';

export interface SceneDef {
    name: string;
    bodies: BodyDef[];
    /** Visible area in metres: [minX, minY, maxX, maxY]. */
    view: [number, number, number, number];
}

export const SCENE_NAMES = ['Pile', 'Squeeze', 'Bullet', 'Crates'];

const JELLY = { young: 3e4, poisson: 0.4, density: 100 };
const RUBBER = { young: 1e5, poisson: 0.4, density: 150 };
const STIFF = { young: 1e6, poisson: 0.3, density: 400 };
/** What a rigid body becomes in the "stiff FEM" comparison: 100× the stiff material. */
export const RIGID_AS_FEM = { young: 1e8, poisson: 0.3 };

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

/** A rigid body (affine body dynamics); the material only matters for the stiff-FEM comparison. */
function rigid(shape: Shape, color: readonly number[], vx = 0, vy = 0): BodyDef {
    return { shape, ...STIFF, ...RIGID_AS_FEM, rigid: true, color, vx, vy };
}

/** The same scene with every rigid body simulated as a very stiff FEM body instead. */
export function rigidAsFem(bodies: readonly BodyDef[]): BodyDef[] {
    return bodies.map((b) => (b.rigid ? { ...b, rigid: false } : b));
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
            rigid(diskShape(0.3, 1.5, 0.11, 3), COLORS[5]),
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
            rigid(diskShape(-0.6, 0.45, 0.05, 2), COLORS[5], 30, 0),
        ],
    };
}

/** Rigid crates, a plank, a ring and a hook dropped onto a jelly mattress and the bare floor. */
function crates(): SceneDef {
    return {
        name: 'Crates',
        view: VIEW,
        bodies: [
            ...container(),
            soft(rectShape(-0.38, 0.085, 0.76, 0.16, 16, 3), JELLY, COLORS[2]),
            rigid(rectShape(0.4, 0.16, 0.3, 0.3, 6, 6), COLORS[1]),
            rigid(rectShape(-0.42, 0.42, 0.24, 0.24, 5, 5, 0.25), COLORS[0]),
            rigid(rectShape(0.42, 0.62, 0.2, 0.2, 4, 4, 0.6), COLORS[3]),
            rigid(rectShape(0.0, 1.0, 1.0, 0.06, 25, 2, -0.12), COLORS[5]),
            rigid(arcShape(-0.35, 1.45, 0.07, 0.13, 0, 2 * Math.PI, 2, 18), COLORS[4]),
            rigid(arcShape(0.3, 1.45, 0.08, 0.14, 0.3 * Math.PI, 1.7 * Math.PI, 2, 14), COLORS[6]),
            rigid(rectShape(0.0, 1.8, 0.16, 0.16, 4, 4, 0.7), COLORS[1]),
            rigid(rectShape(-0.45, 1.95, 0.2, 0.12, 5, 3, -0.4), COLORS[3]),
            soft(diskShape(0.42, 1.95, 0.1, 3), JELLY, COLORS[0], -0.5, 0),
        ],
    };
}

export function buildScene(index: number): SceneDef {
    return [pile, squeeze, bullet, crates][index]();
}
