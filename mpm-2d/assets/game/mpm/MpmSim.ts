import { mlsStep } from './MlsMpm';
import { defaultParams, type MpmParams, MpmWorld, PARTICLES_PER_AXIS, type SolverKind } from './MpmWorld';
import { pbStep } from './PbMpm';
import { buildScene } from './Scenes';

/** Simulated time per rendered frame: a slow device plays in slow motion instead of falling behind. */
export const FRAME_TIME = 1 / 60;
const BLOW_UP_HOLD_FRAMES = 20;

export interface SolverSetting {
    kind: SolverKind;
    /** Substeps per simulated second. */
    rate: number;
    /** PB-MPM iterations per substep. */
    iterations: number;
}

/** Grid-to-particle and particle-to-grid passes per frame: the cost unit both solvers share. */
export function passesPerFrame(s: SolverSetting): number {
    const substeps = Math.max(1, Math.round(s.rate * FRAME_TIME));
    return s.kind === 'pb' ? substeps * s.iterations : substeps;
}

/**
 * One or two worlds stepped with fixed substeps. In compare mode two worlds
 * run the same scene with different solvers.
 */
export class MpmSim {
    worlds: MpmWorld[] = [];
    settings: SolverSetting[] = [];
    scene = 0;
    /** Smoothed solver time per frame, per world. */
    readonly stepMs = [0, 0];
    readonly params: MpmParams;

    constructor(params: MpmParams = defaultParams()) {
        this.params = params;
    }

    /** One world of width × height cells per setting, seeded with the current scene. */
    configure(settings: SolverSetting[], width: number, height: number): void {
        this.settings = settings.map((s) => ({ ...s }));
        const capacity = width * height * PARTICLES_PER_AXIS * PARTICLES_PER_AXIS;
        this.worlds = settings.map((s) => new MpmWorld(width, height, capacity, s.kind, this.params));
        this.stepMs[0] = 0;
        this.stepMs[1] = 0;
        this.reset();
    }

    /** Changes substep rate / iterations without reseeding; a solver change needs configure(). */
    retune(settings: SolverSetting[]): void {
        settings.forEach((s, i) => {
            if (!this.settings[i]) return;
            const before = this.dt(i);
            Object.assign(this.settings[i], s);
            const world = this.worlds[i];
            if (world.solver !== 'pb') return;
            // PB-MPM stores motion per substep; keep the velocity when the substep changes.
            const k = this.dt(i) / before;
            for (const a of [world.vx, world.vy, world.c00, world.c01, world.c10, world.c11]) {
                for (let p = 0; p < world.count; p++) a[p] *= k;
            }
        });
    }

    /** Reseeds every world. Scenes give velocities in cells/s; PB-MPM stores motion per substep. */
    reset(): void {
        this.worlds.forEach((world, i) => {
            buildScene(world, this.scene);
            if (world.solver !== 'pb') return;
            const dt = this.dt(i);
            for (let p = 0; p < world.count; p++) {
                world.vx[p] *= dt;
                world.vy[p] *= dt;
            }
        });
    }

    get particleCount(): number {
        return this.worlds.reduce((n, w) => n + w.count, 0);
    }

    step(): void {
        this.worlds.forEach((world, i) => {
            // A blown-up world collapses into a corner within a second; hold it while the spray is still readable.
            if (world.blewUp && ++world.framesSinceBlowUp > BLOW_UP_HOLD_FRAMES) return;
            const s = this.settings[i];
            const substeps = Math.max(1, Math.round(s.rate * FRAME_TIME));
            const dt = FRAME_TIME / substeps;
            this.params.iterations = s.iterations;
            const t0 = performance.now();
            for (let k = 0; k < substeps; k++) {
                if (s.kind === 'pb') pbStep(world, dt);
                else mlsStep(world, dt);
            }
            this.stepMs[i] += (performance.now() - t0 - this.stepMs[i]) * 0.1;
        });
    }

    /** Substep length currently used by world i. */
    dt(i: number): number {
        return FRAME_TIME / Math.max(1, Math.round(this.settings[i].rate * FRAME_TIME));
    }
}
