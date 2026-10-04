// Checks: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { correctionL, correctedGrad, wendland, wendlandGrad } from '../assets/game/xpbi/Kernel.ts';
import { Sim } from '../assets/game/xpbi/Sim.ts';
import { returnMap, snowHardening, stvk, svd2 } from '../assets/game/xpbi/Svd2.ts';
import { defaultParams, JELLY, SAND, SNOW, World } from '../assets/game/xpbi/World.ts';
import { neighbors, xpbiStep } from '../assets/game/xpbi/Xpbi.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

{
    const h = 0.04;
    let mass = 0;
    const n = 80;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = ((i + 0.5) / n - 0.5) * 3 * h;
        const y = ((j + 0.5) / n - 0.5) * 3 * h;
        mass += wendland(Math.hypot(x, y), h) * (3 * h / n) ** 2;
    }
    check('Wendland C2 integrates to 1 over the support', Math.abs(mass - 1) < 0.02, `∫W = ${mass.toFixed(4)}`);
}

{
    const g = [0, 0];
    wendlandGrad(0, 0, 0.05, g);
    check('∇W(0) = 0', g[0] === 0 && g[1] === 0);
}

{
    const svd = new Float64Array(6);
    svd2(2, 0, 0, 0.5, svd);
    check('SVD of diag(2, 0.5)', Math.abs(svd[2] - 2) < 1e-9 && Math.abs(svd[3] - 0.5) < 1e-9);
    const P = new Float64Array(4);
    const psi0 = stvk(1, 0, 0, 1, 1, 1, P);
    check('Ψ(I) = 0', psi0 < 1e-12, `Ψ ${psi0}`);
}

{
    const f = new Float64Array([0.7, 0, 0, 1.4]);
    const next = returnMap(f, SNOW, 1, 30, 0, 0.025, 0.0075, 8, 1);
    check('snow Σ clamped', f[0] >= 0.975 - 1e-9 && f[3] <= 1.0075 + 1e-9, `F ${f[0].toFixed(4)} ${f[3].toFixed(4)} Jp ${next.toFixed(3)}`);
    check('hardening packed > 1, torn < 1', snowHardening(0.95, 10) > 1.6 && snowHardening(1.1, 10) < 0.4);
}

{
    const params = defaultParams();
    const w = new World(0.5, 0.5, 0.04, 400, params);
    w.fillBlock(0.06, 0.06, 0.44, 0.44, JELLY, 0);
    for (let i = 0; i < w.count; i++) { w.x0[i] = w.px[i]; w.y0[i] = w.py[i]; w.vol[i] = w.vol0[i]; }
    neighbors.build(w);
    const L = new Float64Array(4);
    const g = [0, 0];
    let worst = 0, nInt = 0;
    for (let p = 0; p < w.count; p++) {
        if (w.px[p] < 0.16 || w.px[p] > 0.34 || w.py[p] < 0.16 || w.py[p] > 0.34) continue;
        const start = neighbors.rowStart[p], end = neighbors.rowStart[p + 1];
        correctionL(w.px[p], w.py[p], neighbors.cols, end - start, start, w.px, w.py, w.vol, w.h, L, 0);
        let a = 0, b = 0, c = 0, d = 0;
        for (let e = start; e < end; e++) {
            const q = neighbors.cols[e];
            const dx = w.px[q] - w.px[p], dy = w.py[q] - w.py[p];
            correctedGrad(L[0], L[1], L[2], L[3], dx, dy, w.h, g);
            const dvx = 2 * dx, dvy = -dy;
            const v = w.vol[q];
            a += v * dvx * g[0];
            b += v * dvx * g[1];
            c += v * dvy * g[0];
            d += v * dvy * g[1];
        }
        worst = Math.max(worst, Math.abs(a - 2), Math.abs(b), Math.abs(c), Math.abs(d + 1));
        nInt++;
    }
    check('corrected ∇v reproduces a linear field', worst < 0.15 && nInt > 8, `worst ${worst.toFixed(3)} over ${nInt} particles`);
}

{
    const run = (phi: number) => {
        const sim = new Sim();
        sim.params.substeps = 6;
        sim.params.iterations = 5;
        sim.params.frictionDeg = phi;
        sim.scene = 0;
        sim.configure(['xpbi'], 0.9, 1.2, 0.028);
        for (let f = 0; f < 100; f++) sim.step();
        const w = sim.worlds[0];
        let sx = 0;
        for (let i = 0; i < w.count; i++) sx += w.px[i];
        const mx = sx / w.count;
        let v = 0;
        for (let i = 0; i < w.count; i++) v += (w.px[i] - mx) ** 2;
        return Math.sqrt(v / w.count);
    };
    const wide = run(20), steep = run(50);
    check('sand column: both sides have settled particles', wide > 0.05 && steep > 0.05, `σx 20° ${wide.toFixed(3)} 50° ${steep.toFixed(3)}`);
    check('higher friction keeps a narrower pile (Drucker–Prager)', steep < wide * 0.98, `σx 20° ${wide.toFixed(3)} vs 50° ${steep.toFixed(3)}`);
    void SAND;
}

{
    const sim = new Sim();
    sim.params.substeps = 6;
    sim.params.iterations = 4;
    sim.scene = 3;
    sim.configure(['xpbi'], 0.9, 1.2, 0.03);
    for (let f = 0; f < 100; f++) sim.step();
    const w = sim.worlds[0];
    const jelly = [], snow = [];
    for (let i = 0; i < w.count; i++) {
        if (w.material[i] === JELLY) jelly.push(w.py[i]);
        if (w.material[i] === SNOW) snow.push(w.py[i]);
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const jy = mean(jelly), sy = mean(snow);
    check('jelly sits higher than snow after the drop', jy > sy + 0.02, `jelly ȳ ${jy.toFixed(3)} snow ${sy.toFixed(3)}`);
}

{
    const sim = new Sim();
    sim.scene = 0;
    sim.configure(['xpbi'], 0.7, 1.0, 0.03);
    const w = sim.worlds[0];
    xpbiStep(w, 1 / 240, true);
    let finite = true;
    for (let i = 0; i < w.count; i++) if (!Number.isFinite(w.px[i] + w.vx[i] + w.f00[i])) finite = false;
    check('one XPBI step stays finite', finite && w.count > 0);
}

if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
}
console.log('\nall passed');
