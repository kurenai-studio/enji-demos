// Headless checks of the particle simulation (the CPU twin of the GPU one),
// its 16-bit state, the 8-bit HDR encodings, the tone maps and the bloom chain.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { readFileSync } from 'node:fs';
import {
    acesHill, ACES, bloomChain, bloomDecode, bloomDecodeLinear, bloomEncode, bloomEncodeLinear, CLAMP, decodeParticles,
    decodeStage, DUAL, encodeStage, HIGH_SCALE, LDR, newImage, REINHARD, SINGLE, threshold, toDisplay, toneMap,
    type BloomStore, type Image,
} from '../assets/game/fx/Hdr.ts';
import * as P from '../assets/game/fx/Particles.ts';
import {
    CpuParticles, curl, EMBERS, FIREWORKS, FloatParticles, FOUNTAIN, FOUNTAIN_LIFE, newSchedule, quantize, Q16, schedule,
    SHELLS, starIndex, trailIndex, TRAIL, TRAIL_DT,
} from '../assets/game/fx/Particles.ts';
import { buildShellTable, shellLights } from '../assets/game/fx/Shells.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const shells = buildShellTable();
const DT = 1 / 60;

// ---------------------------------------------------------------- GLSL ↔ TS
{
    const chunk = readFileSync(new URL('../assets/resources/effects/chunks/hp-particles.chunk', import.meta.url), 'utf8');
    const common = readFileSync(new URL('../assets/resources/effects/chunks/hp-common.chunk', import.meta.url), 'utf8');
    const defines = new Map<string, string>();
    for (const m of (chunk + common).matchAll(/^#define (\w+) (.+)$/gm)) defines.set(m[1], m[2].trim());
    const ts: Record<string, unknown> = { ...P, HIGH_SCALE };
    const wrong: string[] = [];
    for (const [name, value] of defines) {
        if (name === 'TAU') continue;
        const expected = name === 'POS_MIN' ? `vec3(${P.POS_MIN.map((x) => x.toFixed(1)).join(', ')})` : String(ts[name]);
        if (name === 'POS_MIN' ? value !== expected : Number(value) !== Number(expected)) wrong.push(`${name}: ${value} vs ${expected}`);
    }
    check('every #define in the particle and common chunks equals the TypeScript constant', wrong.length === 0 && defines.size >= 13,
        wrong.join(', ') || `${defines.size} constants`);
}

// ---------------------------------------------------------------- 16-bit state
{
    const posStep = P.POS_RANGE / Q16, velStep = P.VEL_RANGE / Q16;
    const rand = lcg(1);
    let worst = 0;
    for (let i = 0; i < 100000; i++) {
        const u = rand();
        const q = quantize(u, 0.5);
        const back = ((q >>> 8) * 256 + (q & 255)) / Q16;
        worst = Math.max(worst, Math.abs(back - u) * Q16);
    }
    check('hi/lo byte pair round trip: error ≤ half a 16-bit step', worst <= 0.5 + 1e-9,
        `worst ${worst.toFixed(3)} steps; a step is ${(posStep * 1000).toFixed(3)} mm in position, ${(velStep * 1000).toFixed(3)} mm/s in velocity`);

    // A value creeping by 0.1 step per update: nearest rounding never moves it, stochastic rounding follows on average.
    const run = (stochastic: boolean): number => {
        const r = lcg(7);
        let q = 30000;
        for (let i = 0; i < 1000; i++) q = quantize((q + 0.1) / Q16, stochastic ? r() : 0.5);
        return q - 30000;
    };
    const near = run(false), stoch = run(true);
    check('a 0.1-step increment: nearest rounding loses it all, stochastic rounding keeps it on average',
        near === 0 && Math.abs(stoch - 100) < 15, `after 1000 updates: nearest moved ${near} steps, stochastic ${stoch} (exact 100)`);
}

// Mean signed and max position error of the 8-bit state against the double-precision run.
function stateError(scene: number, width: number, seconds: number, stochastic: boolean): { bias: number; mean: number; max: number } {
    const cpu = new CpuParticles(width);
    cpu.stochastic = stochastic;
    const ref = new FloatParticles(width);
    const n = width * width;
    let t = 0;
    for (let s = 0; s < Math.round(seconds / DT); s++) {
        t += DT;
        cpu.step(scene, t, DT, n, shells);
        ref.step(scene, t, DT, n, shells);
    }
    const sch = newSchedule(), p = [0, 0, 0], v = [0, 0, 0];
    let bias = 0, sum = 0, max = 0, count = 0;
    for (let i = 0; i < n; i++) {
        schedule(scene, i, i % width, Math.floor(i / width), t, sch);
        if (!P.isAlive(sch) || sch.age < 0.5) continue;
        cpu.read(i, p, v);
        const dy = p[1] - ref.pos[i * 3 + 1];
        const d = Math.hypot(p[0] - ref.pos[i * 3], dy, p[2] - ref.pos[i * 3 + 2]);
        bias += dy; sum += d; max = Math.max(max, d); count++;
    }
    return { bias: bias / count, mean: sum / count, max };
}
{
    const fs = stateError(FOUNTAIN, 64, 2.5, true), fn = stateError(FOUNTAIN, 64, 2.5, false);
    const fmt = (e: { bias: number; mean: number; max: number }): string =>
        `mean ${(e.mean * 1000).toFixed(2)} mm, max ${(e.max * 1000).toFixed(1)} mm, height bias ${(e.bias * 1000).toFixed(2)} mm`;
    check('fountain, 2.5 s on the 16-bit state vs doubles: within a few mm, stochastic rounding halves the error',
        fs.mean < 0.005 && fs.max < 0.15 && Math.abs(fs.bias) < 0.002 && fs.mean < 0.6 * fn.mean, `stochastic ${fmt(fs)}; nearest ${fmt(fn)}`);
    const es = stateError(EMBERS, 64, 3, true), en = stateError(EMBERS, 64, 3, false);
    check('embers, 3 s through the curl flow on the 16-bit state: within a few mm of doubles either way',
        es.mean < 0.01 && es.max < 0.05 && en.mean < 0.01, `stochastic ${fmt(es)}; nearest ${fmt(en)}`);
}

// ---------------------------------------------------------------- schedule
{
    const width = 128, n = width * width;
    const sch = newSchedule();
    for (const [scene, name] of [[FOUNTAIN, 'fountain'], [EMBERS, 'embers']] as const) {
        const life = scene === FOUNTAIN ? FOUNTAIN_LIFE : P.EMBER_LIFE;
        // The same count of births with uniformly random phases, for comparison.
        const rand = lcg(9);
        const randomPhase = Float64Array.from({ length: n }, () => rand() * life);
        let lo = Infinity, hi = 0, rlo = Infinity, rhi = 0, aliveLate = Infinity;
        for (let s = 0; s < 600; s++) {
            const t = 10 + s * DT;
            let born = 0, alive = 0, rborn = 0;
            for (let i = 0; i < n; i++) {
                schedule(scene, i, i % width, Math.floor(i / width), t, sch);
                if (P.isAlive(sch)) alive++;
                if (sch.cycle >= 0 && sch.age < DT) born++;
                const age = (((t - randomPhase[i]) % life) + life) % life;
                if (age < DT) rborn++;
            }
            lo = Math.min(lo, born); hi = Math.max(hi, born);
            rlo = Math.min(rlo, rborn); rhi = Math.max(rhi, rborn);
            aliveLate = Math.min(aliveLate, alive);
        }
        const mean = (n * DT) / life;
        check(`${name}: every particle alive after one life, births spread evenly (R2 phases, no pulses)`,
            aliveLate === n && lo >= mean - 4 && hi <= mean + 4 && rhi - rlo > 4 * (hi - lo),
            `births per step ${lo}…${hi} (mean ${mean.toFixed(1)}; random phases ${rlo}…${rhi}), alive ${aliveLate}/${n}`);
    }

    const total = 65536;
    const seen = new Set<string>();
    for (let i = 0; i < total; i++) seen.add(`${i % SHELLS},${trailIndex(i)},${starIndex(i)}`);
    check('fireworks: index = shell + 16 × (trail + 16 × star) is a bijection', seen.size === total,
        `${seen.size} distinct (shell, trail, star) for ${total} particles, ${total / (SHELLS * TRAIL)} stars per shell`);

    // Trail particle j is born j·TRAIL_DT after the lead and retraces its path: at t + j·TRAIL_DT it is where the lead was at t.
    const h = TRAIL_DT / 3;
    const sim = new FloatParticles(256);
    const history = new Map<number, number[]>();
    const star = 37, shell = 5;
    const lead = shell + SHELLS * (0 + TRAIL * star);
    let worst = 0, compared = 0;
    for (let s = 1; s <= Math.round(4 / h); s++) {
        const t = s * h;
        sim.step(FIREWORKS, t, h, total, shells);
        schedule(FIREWORKS, lead, 0, 0, t, sch);
        if (P.isAlive(sch)) history.set(s, [sim.pos[lead * 3], sim.pos[lead * 3 + 1], sim.pos[lead * 3 + 2]]);
        for (let j = 1; j < TRAIL; j++) {
            const i = shell + SHELLS * (j + TRAIL * star);
            schedule(FIREWORKS, i, 0, 0, t, sch);
            const past = history.get(s - 3 * j);
            if (!P.isAlive(sch) || !past || sch.cycle !== Math.floor((t - 3 * j * h - (shell / SHELLS) * P.SHELL_PERIOD) / P.SHELL_PERIOD)) continue;
            worst = Math.max(worst, Math.hypot(sim.pos[i * 3] - past[0], sim.pos[i * 3 + 1] - past[1], sim.pos[i * 3 + 2] - past[2]));
            compared++;
        }
    }
    check('fireworks trail: particle j at t + j·25 ms is where the star\'s lead was at t', compared > 500 && worst < 1e-9,
        `${compared} comparisons, worst ${worst.toExponential(1)} m`);
}

// ---------------------------------------------------------------- physics
{
    // Straight up with linear drag k: apex at v0/k − (g/k²) ln(1 + k v0 / g).
    const g = 9.8, k = 0.25, v0 = 7.7;
    const apex = v0 / k - (g / (k * k)) * Math.log(1 + (k * v0) / g);
    const p = [0, 0, 0], v = [0, v0, 0];
    let top = 0;
    for (let i = 0; i < 120; i++) { P.integrate(FOUNTAIN, 0, i * DT, 0, DT, p, v); top = Math.max(top, p[1]); }
    // Semi-implicit Euler moves with the velocity after each kick: it peaks about v0·dt/2 low.
    const expected = apex - (v0 * DT) / 2;
    check('fountain step: apex matches the closed form with linear drag, less the v0·dt/2 of semi-implicit Euler',
        Math.abs(top - expected) < 0.01, `simulated ${top.toFixed(3)} m, exact ${apex.toFixed(3)} m, exact − v0·dt/2 = ${expected.toFixed(3)} m`);

    const sim = new FloatParticles(64);
    let below = 0, t = 0;
    for (let s = 0; s < 360; s++) {
        sim.step(FOUNTAIN, (t += DT), DT, 4096, shells);
        for (let i = 0; i < 4096; i++) if (sim.pos[i * 3 + 1] < 0) below++;
    }
    check('bounce: no fountain particle ever ends a step below the ground', below === 0, `${below} below in 360 steps × 4096`);

    // Divergence of the curl field by central differences, relative to its gradient scale.
    const rand = lcg(3);
    const a = [0, 0, 0], b = [0, 0, 0];
    const e = 1e-4;
    let worst = 0, scale = 0;
    for (let i = 0; i < 2000; i++) {
        const x = rand() * 8 - 4, y = rand() * 8, z = rand() * 8 - 4, time = rand() * 100;
        let div = 0;
        for (let d = 0; d < 3; d++) {
            const q = [x, y, z];
            q[d] += e; curl(q[0], q[1], q[2], time, a);
            q[d] -= 2 * e; curl(q[0], q[1], q[2], time, b);
            div += (a[d] - b[d]) / (2 * e);
            scale = Math.max(scale, Math.abs((a[d] - b[d]) / (2 * e)));
        }
        worst = Math.max(worst, Math.abs(div));
    }
    check('embers: the curl-noise flow is divergence-free (no sinks to pile embers into)', worst < 1e-6 * Math.max(scale, 1),
        `max |∇·u| ${worst.toExponential(1)} against |∂u/∂x| up to ${scale.toFixed(2)}`);
}

// ---------------------------------------------------------------- 8-bit HDR storage
const q8 = (x: number): number => Math.min(Math.max(Math.round(x * 255), 0), 255) / 255;
{
    // Stage round trip through 8 bits over 0.02 … 64 (darks of the ground to lamp cores).
    const relErr = (mode: number, lo: number, hi: number): number => {
        let worst = 0;
        for (let i = 0; i <= 400; i++) {
            const c = lo * Math.pow(hi / lo, i / 400);
            worst = Math.max(worst, Math.abs(decodeStage(q8(encodeStage(c, mode)), mode) - c) / c);
        }
        return worst;
    };
    const dualDark = relErr(DUAL, 0.02, 1), dualBright = relErr(DUAL, 1, 16), dualTop = relErr(DUAL, 16, 64);
    const singleDark = relErr(SINGLE, 0.02, 1), ldrBright = relErr(LDR, 1, 16);
    check('stage x/(1+x) with 1/2.2: within 3% from 0.02 to 1 and 8% up to 16; one /16 range loses the darks, LDR the brights',
        dualDark < 0.03 && dualBright < 0.08 && singleDark > 0.5 && ldrBright > 0.9,
        `two ranges ${(dualDark * 100).toFixed(1)}% / ${(dualBright * 100).toFixed(1)}%, one range darks ${(singleDark * 100).toFixed(0)}%, LDR brights ${(ldrBright * 100).toFixed(0)}%`);
    // Above 16 the steps grow (x → 1), but ACES has already rolled off to white there.
    let worstCode = 0;
    for (let i = 0; i <= 200; i++) {
        const c = 16 * Math.pow(4, i / 200);
        const shown = (x: number): number => Math.round(toDisplay(acesHill([x, x, x], [0, 0, 0])[0]) * 255);
        worstCode = Math.max(worstCode, Math.abs(shown(decodeStage(q8(encodeStage(c, DUAL)), DUAL)) - shown(c)));
    }
    check('stage from 16 to 64: errors up to 25%, but at most 1 display code after ACES', dualTop < 0.3 && worstCode <= 1,
        `worst ${(dualTop * 100).toFixed(0)}%, ${worstCode} code`);
}

/** n particles of light c each, blended additively into an 8-bit target (rounded after every blend), with or without dither. */
function accumulate(n: number, c: number, scale: number, dither: boolean, rand: () => number): number {
    let dst = 0;
    for (let i = 0; i < n; i++) {
        const src = c * scale + (dither ? (rand() - 0.5) / 255 : 0);
        dst = q8(dst + src);
    }
    return dst;
}
{
    const rand = lcg(11);
    const cases: [number, number][] = [[300, 0.0015], [40, 0.05], [12, 0.4], [30, 0.4], [60, 0.25]];
    const rows: string[] = [];
    let worstDual = 0, worstLdrAbove = 1, faintNoDither = 1;
    for (const [n, c] of cases) {
        const exact = n * c;
        const avg = (dither: boolean, mode: number): number => {
            let sum = 0;
            for (let k = 0; k < 64; k++) sum += decodeParticles(accumulate(n, c, 1, dither, rand), accumulate(n, c, 1 / HIGH_SCALE, dither, rand), mode);
            return sum / 64;
        };
        const dual = avg(true, DUAL), ldr = avg(true, LDR), plain = avg(false, DUAL);
        worstDual = Math.max(worstDual, Math.abs(dual - exact) / exact);
        if (exact > 1.5) worstLdrAbove = Math.min(worstLdrAbove, Math.abs(ldr - exact) / exact);
        if (c * 255 < 0.5) faintNoDither = plain;
        rows.push(`${n}×${c} = ${exact.toFixed(2)} → ${dual.toFixed(3)}`);
    }
    check('additive particles in two 8-bit ranges, dithered: totals from 0.45 to 15 within 6%',
        worstDual < 0.06 && worstLdrAbove > 0.3, `${rows.join(', ')}; LDR loses ≥ ${(worstLdrAbove * 100).toFixed(0)}% above 1.5`);
    check('without dither, particles under half a step vanish: 300 × 0.0015 adds up to nothing', faintNoDither === 0,
        `undithered total ${faintNoDither}, dithered ≈ 0.45`);
}

// ---------------------------------------------------------------- tone maps
{
    const stops = [1, 2, 4, 8, 16];
    const codes = (mode: number): number => new Set(stops.map((c) => Math.round(toDisplay(toneMap([c, c, c], mode, [0, 0, 0])[0]) * 255))).size;
    let monotonic = true, prev = -1;
    for (let i = 0; i <= 2000; i++) {
        const c = Math.pow(2, -10 + (i / 2000) * 16);
        const y = acesHill([c, c, c], [0, 0, 0])[0];
        if (y < prev - 1e-9) monotonic = false;
        prev = y;
    }
    const mid = acesHill([0.18, 0.18, 0.18], [0, 0, 0])[0];
    check('ACES fit: monotonic from 2⁻¹⁰ to 2⁶, keeps 1…16 apart; clamping maps them all to white',
        monotonic && codes(ACES) === 5 && codes(REINHARD) === 5 && codes(CLAMP) === 1,
        `display codes for 1, 2, 4, 8, 16: ACES ${codes(ACES)}, Reinhard ${codes(REINHARD)}, clamp ${codes(CLAMP)}; 18% grey → ${(mid * 100).toFixed(1)}% linear`);
    const sat = acesHill([8, 0.5, 0.1], [0, 0, 0]);
    check('ACES desaturates very bright colours towards white (the fireball cores)', sat[1] > 0.75 && sat[0] === 1,
        `(8, 0.5, 0.1) → (${sat.map((x) => x.toFixed(2)).join(', ')})`);
}

// ---------------------------------------------------------------- bloom
{
    const knee = 0.5, t = 1;
    let continuous = true;
    for (let i = 1; i < 4000; i++) {
        const a = i / 1000, b = a + 1e-4;
        if (Math.abs(threshold(b, 0, 0, t, knee) * b - threshold(a, 0, 0, t, knee) * a) > 1e-3) continuous = false;
    }
    check('soft-knee threshold: zero below 0.5, continuous, then c − 1 above 1.5',
        threshold(0.49, 0, 0, t, knee) === 0 && continuous && Math.abs(threshold(3, 0, 0, t, knee) * 3 - 2) < 1e-9,
        `kept at 0.75: ${(threshold(0.75, 0, 0, t, knee) * 0.75).toFixed(3)}, at 1: ${threshold(1, 0, 0, t, knee).toFixed(3)}`);

    // A small bright source on black: 3×3 texels at 40 in a 192² image.
    const W = 192;
    const src: Image = newImage(W, W);
    for (let y = 94; y < 97; y++) for (let x = 94; x < 97; x++) src.data.fill(40, (y * W + x) * 3, (y * W + x) * 3 + 3);
    const levels = 6;
    const rand = lcg(5);
    const ref = bloomChain(src, levels, 0, knee, { encode: null, decode: null, rand });
    const lin = bloomChain(src, levels, 0, knee, { encode: bloomEncodeLinear, decode: bloomDecodeLinear, rand });
    const sqr = bloomChain(src, levels, 0, knee, { encode: bloomEncode, decode: bloomDecode, rand });
    const hw = bloomChain(src, levels, 0, knee, { encode: bloomEncode, decode: bloomDecode, rand, filterEncoded: true });
    const energy = (img: Image): number => img.data.reduce((s, x) => s + x, 0) * 4;
    const srcEnergy = src.data.reduce((s, x) => s + x, 0);
    const ratio = energy(ref) / srcEnergy, ratio8 = energy(sqr) / srcEnergy, ratioHw = energy(hw) / srcEnergy;
    check('bloom chain: each of the 6 levels carries the source energy once (hence strength / levels)',
        Math.abs(ratio - levels) / levels < 0.03 && Math.abs(ratio8 - levels) / levels < 0.03,
        `bloom energy / source energy = ${ratio.toFixed(3)} in floats, ${ratio8.toFixed(3)} in 8 bits`);
    check('decoding before filtering matters: bilinear on the encoded levels loses most of a small source\'s light',
        ratioHw < 0.5 * levels, `filtered encoded: ${ratioHw.toFixed(2)} instead of ${levels}`);

    // How the faint outer halo looks on screen (strength 0.9/6, ACES, gamma), over black and over a dim sky.
    const strength = 0.9 / levels;
    const display = (c: number, bg: number): number => {
        const x = bg + c * strength;
        return Math.round(toDisplay(acesHill([x, x, x], [0, 0, 0])[0]) * 255);
    };
    const haloError = (img: Image, bg: number): number => {
        let err = 0;
        for (let y = 0; y < img.h; y++) {
            for (let x = 0; x < img.w; x++) {
                const i = (y * img.w + x) * 3;
                if (ref.data[i] * strength > 0.05) continue;
                err = Math.max(err, Math.abs(display(img.data[i], bg) - display(ref.data[i], bg)));
            }
        }
        return err;
    };
    const sBlack = haloError(sqr, 0), lBlack = haloError(lin, 0), sSky = haloError(sqr, 0.02), lSky = haloError(lin, 0.02);
    check('bloom levels stored as √(c/(1+c)): the faint halo matches the float chain on screen; c/(1+c) is off by more',
        sBlack <= 2 && sSky <= 2 && lBlack > sBlack && lSky >= sSky,
        `max display error where the halo adds < 0.05, over black: ${sBlack} vs ${lBlack} codes; over a 0.02 sky: ${sSky} vs ${lSky}`);
}

// ---------------------------------------------------------------- fireworks lights
{
    // The newest bursts are the brightest: the 4 lights must be the 4 youngest live shells.
    let ok = true, total = 0;
    for (let i = 0; i < 400; i++) {
        const t = 4 + i * 0.05;
        const lights = shellLights(shells, t, 4, 60);
        const live: [number, number, number][] = [];
        for (let s = 0; s < SHELLS; s++) {
            const phase = (s / SHELLS) * P.SHELL_PERIOD;
            const k = Math.floor((t - phase) / P.SHELL_PERIOD);
            const age = t - phase - k * P.SHELL_PERIOD;
            if (age <= P.SHELL_LIFE) live.push([age, s, k]);
        }
        live.sort((a, b) => a[0] - b[0]);
        if (lights.length !== Math.min(4, live.length)) ok = false;
        const centre = [0, 0, 0, 0];
        lights.forEach((l, j) => {
            P.shellTexel(shells, live[j][1], live[j][2], 0, centre);
            if (Math.hypot(l.x - centre[0], l.y - centre[1], l.z - centre[2]) > 1e-6 || l.r + l.g + l.b <= 0) ok = false;
        });
        total += lights.length;
    }
    check('ground lights: the 4 brightest live bursts each frame', ok && total === 1600, `${(total / 400).toFixed(2)} lights per frame`);
}

// ---------------------------------------------------------------- CPU cost (info)
for (const [scene, name] of [[FOUNTAIN, 'fountain'], [EMBERS, 'embers'], [FIREWORKS, 'fireworks']] as const) {
    const out: string[] = [];
    for (const w of [128, 256]) {
        const cpu = new CpuParticles(w);
        let t = 0;
        for (let s = 0; s < 120; s++) cpu.step(scene, (t += DT), DT, w * w, shells);
        const t0 = performance.now();
        for (let s = 0; s < 60; s++) cpu.step(scene, (t += DT), DT, w * w, shells);
        out.push(`${(w * w) / 1024}K ${((performance.now() - t0) / 60).toFixed(2)} ms`);
    }
    console.log(`info CPU step (Node), ${name}: ${out.join(', ')}`);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
