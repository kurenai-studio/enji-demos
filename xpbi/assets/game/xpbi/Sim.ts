import { World, type SolverKind, type XpbiParams, defaultParams } from './World';
import { seed } from './Scenes';
import { vanillaStep } from './Vanilla';
import { xpbiStep } from './Xpbi';

export const FRAME_TIME = 1 / 60;

export class Sim {
    worlds: World[] = [];
    scene = 0;
    params: XpbiParams = defaultParams();
    stepMs: number[] = [];
    spacing = 0.02;
    domainW = 1.2;
    domainH = 1.6;

    configure(kinds: SolverKind[], width: number, height: number, spacing: number): void {
        this.domainW = width;
        this.domainH = height;
        this.spacing = spacing;
        const cap = Math.ceil((width / spacing) * (height / spacing) * 1.05);
        this.worlds = kinds.map((kind) => {
            const w = new World(width, height, spacing, cap, { ...this.params });
            w.kind = kind;
            return w;
        });
        this.reset();
    }

    reset(): void {
        for (const w of this.worlds) {
            w.params = { ...this.params };
            seed(w, this.scene);
        }
        this.stepMs = this.worlds.map(() => 0);
    }

    step(): void {
        const dt = FRAME_TIME / this.params.substeps;
        for (let i = 0; i < this.worlds.length; i++) {
            const w = this.worlds[i];
            const t0 = performance.now();
            for (let s = 0; s < this.params.substeps; s++) {
                if (w.kind === 'vanilla') vanillaStep(w, dt);
                else xpbiStep(w, dt, w.kind === 'xpbi');
            }
            this.stepMs[i] = performance.now() - t0;
        }
    }
}
