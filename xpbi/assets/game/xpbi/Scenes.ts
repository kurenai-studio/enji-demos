import { CLAY, JELLY, SAND, SNOW, type World } from './World';

export const SCENE_NAMES = ['Sand column', 'Snowball', 'Clay drop', 'Jelly vs snow'];

export function seed(world: World, scene: number): void {
    world.clear();
    const W = world.width, H = world.height, s = world.spacing;
    if (scene === 0) {
        world.fillBlock(W * 0.22, s, W * 0.78, H * 0.72, SAND, 0.08);
    } else if (scene === 1) {
        const cx = W * 0.5, cy = H * 0.62, R = Math.min(W, H) * 0.16;
        fillDisk(world, cx, cy, R, SNOW);
        world.fillBlock(s, s, W - s, s * 4, SAND, 0.05);
    } else if (scene === 2) {
        fillDisk(world, W * 0.5, H * 0.55, Math.min(W, H) * 0.2, CLAY);
    } else {
        fillDisk(world, W * 0.32, H * 0.7, Math.min(W, H) * 0.14, JELLY);
        fillDisk(world, W * 0.68, H * 0.7, Math.min(W, H) * 0.14, SNOW);
        world.fillBlock(s, s, W - s, s * 3.5, SAND, 0.05);
    }
}

function fillDisk(world: World, cx: number, cy: number, R: number, material: number): void {
    const s = world.spacing;
    const r2 = R * R;
    let row = 0;
    for (let y = cy - R; y <= cy + R; y += s, row++) {
        const ox = (row & 1) ? s * 0.5 : 0;
        for (let x = cx - R + ox; x <= cx + R; x += s) {
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) world.add(x, y, material);
        }
    }
}
