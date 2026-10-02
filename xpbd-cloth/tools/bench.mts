// Headless solver benchmark: node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts
// Runs every quality level on both presets and reports the cost per 60 Hz
// frame and the worst stretch of the grid edges after 10 s of simulation.
import { XpbdCloth } from '../assets/game/xpbd/XpbdCloth.ts';

const LEVELS = [[20, 8], [32, 10], [48, 12], [64, 15]];
const SIZE = 1.6;

for (const [n, substeps] of LEVELS) {
    for (const orientation of ['horizontal', 'vertical'] as const) {
        const cloth = new XpbdCloth({
            segments: n,
            size: SIZE,
            mass: 0.4,
            orientation,
            height: orientation === 'horizontal' ? 1.5 : 2.0,
            pins: orientation === 'vertical' ? [[0, 0], [n - 1, 0]] : [],
        });
        cloth.substeps = substeps;
        cloth.sphere.r = 0.45;
        cloth.setSphere(0, 0.6, orientation === 'vertical' ? 5 : 0);

        const frames = 600;
        const times: number[] = [];
        for (let f = 0; f < frames; f++) {
            const t0 = performance.now();
            cloth.step(1 / 60);
            cloth.computeNormals();
            times.push(performance.now() - t0);
        }
        const settled = times.slice(100).sort((a, b) => a - b);
        const avg = settled.reduce((a, b) => a + b, 0) / settled.length;

        const rest = SIZE / (n - 1);
        let maxStretch = 0;
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n - 1; col++) {
                const a = (row * n + col) * 3;
                const b = a + 3;
                const d = Math.hypot(cloth.pos[a] - cloth.pos[b], cloth.pos[a + 1] - cloth.pos[b + 1], cloth.pos[a + 2] - cloth.pos[b + 2]);
                maxStretch = Math.max(maxStretch, d / rest - 1);
            }
        }
        const finite = cloth.pos.every(Number.isFinite);
        console.log(
            `${`${n}x${n}`.padEnd(6)} substeps ${String(substeps).padEnd(3)} ${orientation.padEnd(10)} ` +
            `${String(cloth.constraintCount).padStart(6)} constraints  avg ${avg.toFixed(2)} ms  ` +
            `p95 ${settled[Math.floor(settled.length * 0.95)].toFixed(2)} ms  max stretch ${(maxStretch * 100).toFixed(1)}%` +
            (finite ? '' : '  NaN!'),
        );
    }
}
