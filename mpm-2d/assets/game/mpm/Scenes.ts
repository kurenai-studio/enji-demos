import { ELASTIC, LIQUID, type MpmWorld, SAND, SNOW, VISCO } from './MpmWorld';

export const SCENE_NAMES = ['Dam break', 'Sand column', 'Mixed', 'Snowball'];

/** Seeds a preset scene, sized relative to the world so it fits any grid. */
export function buildScene(world: MpmWorld, scene: number): void {
    const W = world.width;
    const H = world.height;
    world.clear();
    switch (scene) {
        case 0:
            world.addBlock(LIQUID, 0, 0, 0.42 * W, 0.6 * H);
            world.addBlock(ELASTIC, 0.62 * W, 0, 0.84 * W, 0.22 * W);
            world.addBlock(ELASTIC, 0.6 * W, 0.45 * H, 0.8 * W, 0.45 * H + 0.2 * W);
            break;
        case 1:
            world.addBlock(SAND, 0.34 * W, 0, 0.62 * W, 0.62 * H);
            world.addDisc(ELASTIC, 0.8 * W, 0.8 * H, 0.1 * W);
            break;
        case 3: {
            // A snowball thrown down onto a snow bank and a smaller one at the
            // right wall. Sized by the narrower of width and half height, so
            // the balls keep their size in the wide single view.
            const s = Math.min(W, 0.5 * H);
            world.addBlock(SNOW, 0, 0, W, 0.14 * H);
            world.addDisc(SNOW, 0.3 * W, 0.6 * H, 0.22 * s, 0.8 * s, -1.2 * s);
            world.addDisc(SNOW, 0.6 * W, 0.86 * H, 0.13 * s, 2.2 * s, 0);
            break;
        }
        default:
            world.addBlock(LIQUID, 0, 0, W, 0.16 * H);
            world.addBlock(SAND, 0.08 * W, 0.42 * H, 0.42 * W, 0.62 * H);
            world.addBlock(VISCO, 0.58 * W, 0.36 * H, 0.9 * W, 0.56 * H);
            world.addDisc(ELASTIC, 0.5 * W, 0.8 * H, 0.12 * W);
            break;
    }
}
