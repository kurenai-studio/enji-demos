import { quat, quatFromEuler, v3 } from './Math3';
import type { V3 } from './Math3';
import { Shape } from './RigidBody';
import type { World } from './World';

export const SCENES = ['stack', 'domino', 'pile'] as const;
export type SceneName = (typeof SCENES)[number];

export interface SceneInfo {
    title: string;
    /** Rough centre and radius of the interesting region, for the camera. */
    center: V3;
    radius: number;
    /** Names of the drift-metric groups (index = BodyDef.group). */
    groups: string[];
}

const WARM: readonly (readonly [number, number, number])[] = [
    [0.91, 0.55, 0.33], [0.95, 0.72, 0.38], [0.84, 0.42, 0.36], [0.97, 0.83, 0.55],
];
const COOL: readonly (readonly [number, number, number])[] = [
    [0.36, 0.6, 0.86], [0.45, 0.75, 0.85], [0.52, 0.55, 0.9], [0.4, 0.8, 0.7],
];

export function buildScene(world: World, name: SceneName): SceneInfo {
    world.add({ shape: Shape.Plane, position: v3(0, 0, 0), density: 0, friction: 0.6 });
    if (name === 'stack') return stack(world);
    if (name === 'domino') return domino(world);
    return pile(world);
}

/** A seven-row pyramid of 0.4 m boxes and a ten-box tower of slightly twisted 0.3 m cubes. */
function stack(world: World): SceneInfo {
    const size = 0.4, gap = 0.01, rows = 7, px = -0.8;
    for (let row = 0; row < rows; row++) {
        const count = rows - row;
        for (let i = 0; i < count; i++) {
            const x = px + (i - (count - 1) / 2) * (size + gap);
            world.add({
                shape: Shape.Box, half: v3(size / 2, size / 2, size / 2), position: v3(x, size / 2 + row * size, 0),
                density: 500, color: WARM[(row + i) % WARM.length], group: 1,
            });
        }
    }
    const cube = 0.3;
    for (let i = 0; i < 10; i++) {
        const yaw = ((i * 7919) % 17 - 8) * 1.0;
        world.add({
            shape: Shape.Box, half: v3(cube / 2, cube / 2, cube / 2), position: v3(1.4, cube / 2 + i * cube, 0),
            rotation: quatFromEuler(quat(), 0, (yaw * Math.PI) / 180, 0),
            density: 500, color: COOL[i % COOL.length], group: 2,
        });
    }
    return { title: 'Pyramid and tower', center: v3(0.3, 1.3, 0), radius: 3.0, groups: ['', 'pyramid', 'tower'] };
}

/** 40 dominoes on an inward spiral; the first one is already tipping over. */
function domino(world: World): SceneInfo {
    const half = v3(0.03, 0.25, 0.12);
    let theta = 0;
    for (let i = 0; i < 40; i++) {
        const r = 1.7 - 0.024 * i;
        const x = r * Math.cos(theta), z = r * Math.sin(theta);
        // Thin axis (local x) along the path's tangent.
        const tx = -Math.sin(theta), tz = Math.cos(theta);
        const yaw = Math.atan2(-tz, tx);
        const rotation = quatFromEuler(quat(), 0, yaw, 0);
        const body = world.add({
            shape: Shape.Box, half, position: v3(x, half.y, z), rotation, density: 700,
            color: i % 2 ? WARM[i % 4] : COOL[i % 4], group: 1, friction: 0.5,
        });
        if (i === 0) {
            // Tip it towards the next domino: spin about its width axis (local z), pivoting on the bottom edge.
            const wz = -3.0;
            const az = { x: Math.sin(yaw), z: Math.cos(yaw) };
            body.w.x = az.x * wz; body.w.z = az.z * wz;
            body.v.x = tx * 0.25 * 3.0; body.v.z = tz * 0.25 * 3.0;
        }
        theta += 0.22 / r;
    }
    return { title: 'Domino spiral', center: v3(0, 0.3, 0), radius: 2.2, groups: ['', 'dominoes'] };
}

/** 50 boxes and 10 balls dropped into a walled bin. */
function pile(world: World): SceneInfo {
    const inner = 1.3, wallH = 0.7, wallT = 0.1;
    const wall = [0.5, 0.52, 0.58] as const;
    world.add({ shape: Shape.Box, half: v3(inner + wallT, wallH / 2, wallT / 2), position: v3(0, wallH / 2, inner + wallT / 2), density: 0, color: wall });
    world.add({ shape: Shape.Box, half: v3(inner + wallT, wallH / 2, wallT / 2), position: v3(0, wallH / 2, -inner - wallT / 2), density: 0, color: wall });
    world.add({ shape: Shape.Box, half: v3(wallT / 2, wallH / 2, inner), position: v3(inner + wallT / 2, wallH / 2, 0), density: 0, color: wall });
    world.add({ shape: Shape.Box, half: v3(wallT / 2, wallH / 2, inner), position: v3(-inner - wallT / 2, wallH / 2, 0), density: 0, color: wall });
    const rand = mulberry32(7);
    let n = 0;
    for (let layer = 0; layer < 5; layer++) {
        for (let gx = 0; gx < 4; gx++) {
            for (let gz = 0; gz < 3; gz++) {
                const x = -0.9 + gx * 0.6 + (rand() - 0.5) * 0.1;
                const z = -0.7 + gz * 0.7 + (rand() - 0.5) * 0.1;
                const y = 0.5 + layer * 0.56;
                const rotation = quatFromEuler(quat(), rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
                if ((n++ % 6) === 5) {
                    world.add({ shape: Shape.Sphere, radius: 0.12 + rand() * 0.06, position: v3(x, y, z), density: 600, color: [0.9, 0.9, 0.86] });
                } else {
                    const half = v3(0.07 + rand() * 0.1, 0.07 + rand() * 0.06, 0.07 + rand() * 0.1);
                    world.add({ shape: Shape.Box, half, position: v3(x, y, z), rotation, density: 500, color: (n % 2 ? WARM : COOL)[n % 4] });
                }
            }
        }
    }
    return { title: 'Bin of boxes and balls', center: v3(0, 0.5, 0), radius: 2.2, groups: [] };
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
