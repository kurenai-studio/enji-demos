import type { Hand, HandPose } from './Hand';
import type { SnowSim } from './SnowSim';

export interface FrameBudget {
    substeps: number;
    /** Snow closer than this to the hand wakes up; awake snow farther than `sleepRadius` may sleep. */
    wakeRadius: number;
    sleepRadius: number;
}

export const BUDGET: FrameBudget = { substeps: 6, wakeRadius: 0.12, sleepRadius: 0.2 };

/** Advances one frame: moves the hand, updates sleeping, then runs the substeps along the sweep. */
export function stepFrame(sim: SnowSim, hand: Hand, pose: HandPose, frameDt: number, budget: FrameBudget = BUDGET): void {
    hand.moveTo(pose, frameDt);
    hand.at(1);
    sim.updateSleep(budget.wakeRadius, budget.sleepRadius);
    const dt = frameDt / budget.substeps;
    for (let k = 0; k < budget.substeps; k++) {
        hand.at((k + 1) / budget.substeps);
        sim.step(dt);
    }
}

/** Lets a fresh bed settle under gravity with every particle awake, then puts it all to sleep. */
export function settle(sim: SnowSim, frames: number, frameDt: number, substeps: number): void {
    const saved = sim.colliders.splice(0);
    sim.wakeAll();
    const dt = frameDt / substeps;
    for (let f = 0; f < frames; f++) for (let k = 0; k < substeps; k++) sim.step(dt);
    sim.sleepAll();
    sim.colliders.push(...saved);
}
