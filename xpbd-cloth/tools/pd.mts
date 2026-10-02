// Projective Dynamics vs XPBD:
//   node --no-warnings --import ./tools/ts-resolve.mjs tools/pd.mts [hang|swing] [rubber|cotton] [segments]
//
// hang:  a sheet hung by its whole top edge, as in the PBD comparison. After
//        8 s: how far the bottom edge sags below its rest height and the worst
//        stretch of a grid edge.
// swing: a flat sheet held along one edge falls and swings like a flap. The
//        angle of the free edge below the horizontal at 0.25, 0.5 and 1 s
//        (90° = hanging straight down), how far it swings past the vertical
//        within 3 s (energy the integrator keeps), and the worst edge stretch
//        at any frame.
// Both print the solver cost of the fastest 60 Hz frame (other load on the
// machine only ever adds time). PD runs one implicit Euler step per frame
// unless noted. ONLY=<label part> filters runs; RHO, GAMMA and DELAY override
// the Chebyshev parameters.
import { GROUP_BEND, GROUP_SHEAR, GROUP_STRETCH, XpbdCloth } from '../assets/game/xpbd/XpbdCloth.ts';
import type { PdSolver } from '../assets/game/xpbd/ProjectiveDynamics.ts';

const PRESETS = {
    rubber: { stretch: 0.15, shear: 0.15, bend: 0.5 },
    cotton: { stretch: 0, shear: 1e-4, bend: 5e-3 },
};
const scenario = process.argv[2] === 'swing' ? 'swing' : 'hang';
const preset = (process.argv[3] ?? 'rubber') as keyof typeof PRESETS;
const n = Number(process.argv[4] ?? 32);
const SIZE = 1.1;
const HEIGHT = 2.0;
const FRAMES = scenario === 'hang' ? 480 : 180;

interface Run {
    label: string;
    method: 'xpbd' | 'pd';
    substeps: number;
    solver?: PdSolver;
    iterations?: number;
}

function edgeStretch(cloth: XpbdCloth): number {
    const rest = SIZE / (n - 1);
    const p = cloth.pos;
    let stretch = 0;
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            const a = (row * n + col) * 3;
            if (col < n - 1) stretch = Math.max(stretch, Math.hypot(p[a] - p[a + 3], p[a + 1] - p[a + 4], p[a + 2] - p[a + 5]) / rest - 1);
            if (row < n - 1) {
                const b = a + n * 3;
                stretch = Math.max(stretch, Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]) / rest - 1);
            }
        }
    }
    return stretch;
}

function run(r: Run) {
    const top = Array.from({ length: n }, (_, c) => [c, 0] as const);
    const cloth = new XpbdCloth(scenario === 'hang'
        ? { segments: n, size: SIZE, mass: 0.4, orientation: 'vertical', height: HEIGHT, pins: top, tethers: false }
        : { segments: n, size: SIZE, mass: 0.4, orientation: 'horizontal', height: HEIGHT, pins: top, tethers: false });
    const s = PRESETS[preset];
    cloth.compliance[GROUP_STRETCH] = s.stretch;
    cloth.compliance[GROUP_SHEAR] = s.shear;
    cloth.compliance[GROUP_BEND] = s.bend;
    cloth.method = r.method;
    cloth.substeps = r.substeps;
    if (r.solver) cloth.pd.solver = r.solver;
    if (r.iterations) cloth.pd.iterations = r.iterations;
    if (process.env.RHO) cloth.pd.rho = Number(process.env.RHO);
    if (process.env.GAMMA) cloth.pd.gamma = Number(process.env.GAMMA);
    if (process.env.DELAY) cloth.pd.chebyshevDelay = Number(process.env.DELAY);
    if (process.env.GROWTH) cloth.pd.restartGrowth = Number(process.env.GROWTH);
    if (process.env.HARD) cloth.pd.hardWeight = Number(process.env.HARD);
    cloth.setSphere(0, 0.45, 50);
    const edge = ((n - 1) * n + (n >> 1)) * 3;
    const pinZ = cloth.pos[(n >> 1) * 3 + 2];
    const times: number[] = [];
    let worstStretch = 0;
    let past = 0;
    const angles: number[] = [];
    const pinY = cloth.pos[(n >> 1) * 3 + 1];
    for (let f = 0; f < FRAMES; f++) {
        const t0 = performance.now();
        cloth.step(1 / 60);
        times.push(performance.now() - t0);
        if (scenario === 'swing') {
            worstStretch = Math.max(worstStretch, edgeStretch(cloth));
            // The flap starts on the +z side of its pinned edge and swings through the vertical to −z.
            past = Math.max(past, pinZ - cloth.pos[edge + 2]);
            // Angle of the free edge's centre below the horizontal, at 0.25 s, 0.5 s and 1 s.
            if (f + 1 === 15 || f + 1 === 30 || f + 1 === 60) {
                const dz = cloth.pos[edge + 2] - pinZ;
                const dy = pinY - cloth.pos[edge + 1];
                angles.push((Math.atan2(dy, dz) * 180) / Math.PI);
            }
        }
    }
    const settled = times.slice(60).sort((x, y) => x - y);
    return {
        sag: HEIGHT - SIZE - cloth.pos[edge + 1],
        stretch: scenario === 'hang' ? edgeStretch(cloth) : worstStretch,
        past,
        angles,
        ms: settled[0],
        factorMs: cloth.pd.factorMs,
        rho: cloth.pd.rhoUsed,
        finite: cloth.pos.every(Number.isFinite),
    };
}

const runs: Run[] = [
    { label: 'XPBD 10 substeps', method: 'xpbd', substeps: 10 },
    { label: 'XPBD 40 substeps', method: 'xpbd', substeps: 40 },
    ...[1, 2, 5, 10, 20].map((it): Run => ({ label: `PD direct ${it} it`, method: 'pd', substeps: 1, solver: 'direct', iterations: it })),
    { label: 'PD direct 2 × 5 it', method: 'pd', substeps: 2, solver: 'direct', iterations: 5 },
    { label: 'PD direct 5 × 2 it', method: 'pd', substeps: 5, solver: 'direct', iterations: 2 },
    ...[5, 10, 20, 40, 100].map((it): Run => ({ label: `PD Chebyshev ${it} it`, method: 'pd', substeps: 1, solver: 'chebyshev', iterations: it })),
    { label: 'PD Chebyshev 2 × 10 it', method: 'pd', substeps: 2, solver: 'chebyshev', iterations: 10 },
];

const only = process.env.ONLY;
console.log(scenario === 'hang'
    ? `${preset} sheet ${n}×${n} hung by its top edge, after ${FRAMES / 60} s`
    : `${preset} flap ${n}×${n} swinging from one edge, over ${FRAMES / 60} s`);
for (const r of runs) {
    if (only && !only.split(',').some((o) => r.label.includes(o))) continue;
    const res = run(r);
    const shape = scenario === 'hang'
        ? `sag ${(res.sag * 100).toFixed(1).padStart(6)} cm  stretch ${(res.stretch * 100).toFixed(1).padStart(6)}%`
        : `angle ${res.angles.map((a) => `${a.toFixed(0)}°`.padStart(5)).join(' ')}  past vertical ${(res.past * 100).toFixed(1).padStart(6)} cm  worst stretch ${(res.stretch * 100).toFixed(1).padStart(6)}%`;
    const extra = r.solver === 'direct' ? `  factor ${res.factorMs.toFixed(1)} ms` : r.solver === 'chebyshev' ? `  ρ ${res.rho.toFixed(6)}` : '';
    console.log(`${r.label.padEnd(24)} ${shape}  ${res.ms.toFixed(2).padStart(6)} ms/frame${extra}${res.finite ? '' : '  NaN!'}`);
}
