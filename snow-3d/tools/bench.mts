// node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts
// Fills the tray, settles it, then times the scripted sweep frame by frame.
import { BUDGET, settle, stepFrame } from '../assets/game/snow/Frame.ts';
import { Hand } from '../assets/game/snow/Hand.ts';
import { BEDS, bedCapacity, fillBed } from '../assets/game/snow/Scenes.ts';
import { SnowSim } from '../assets/game/snow/SnowSim.ts';
import { SCENE, simSize } from '../assets/game/snow/Setup.ts';

for (const perCell of [SCENE.perCell, 1.25]) {
    const { nx, ny, nz } = simSize();
    const bed = BEDS[SCENE.bed];
    const sim = new SnowSim(nx, ny, nz, SCENE.dx, bedCapacity({ dx: SCENE.dx, nx, nz }, bed, perCell, 3));
    Object.assign(sim.params, SCENE.params);
    fillBed(sim, bed, perCell);
    let t = performance.now();
    settle(sim, SCENE.settleFrames, 1 / 60, BUDGET.substeps);
    const settleMs = performance.now() - t;
    const hand = new Hand();
    hand.scale = SCENE.handScale;
    sim.colliders.push(...hand.capsules);
    const cx = (sim.lo + sim.hiX) / 2, cz = (sim.lo + sim.hiZ) / 2;
    const frames = 180;
    let worst = 0, total = 0, activeMax = 0;
    for (let fr = 0; fr < frames; fr++) {
        const down = Math.min(fr / 30, 1);
        const sweep = Math.min(Math.max((fr - 30) / 70, 0), 1);
        const lift = Math.min(Math.max((fr - 110) / 30, 0), 1);
        const y = sim.lo + SCENE.liftY - (SCENE.liftY - SCENE.digY) * down + 0.3 * lift;
        t = performance.now();
        stepFrame(sim, hand, { x: cx - 0.4 + sweep * 0.8, y, z: cz, yaw: 0, lean: 0.5 }, 1 / 60);
        const ms = performance.now() - t;
        worst = Math.max(worst, ms);
        total += ms;
        activeMax = Math.max(activeMax, sim.activeCount);
    }
    console.log(`${perCell}³/cell: grid ${nx}×${ny}×${nz}, ${sim.count} particles, ${BUDGET.substeps} substeps; settle ${(settleMs / SCENE.settleFrames).toFixed(0)} ms/frame`);
    console.log(`  sweep: mean ${(total / frames).toFixed(1)} ms/frame, worst ${worst.toFixed(1)}, max awake ${activeMax}, blewUp ${sim.blewUp}`);
}
