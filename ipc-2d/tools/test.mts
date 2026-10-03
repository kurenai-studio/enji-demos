// Checks: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
// Derivatives against finite differences, the PSD projection, and the IPC
// guarantee (no boundary edges ever cross) on every scene.
import { neoHookeanHessian, peDistance2, peDistance2Derivatives, projectPsd } from '../assets/game/ipc/Geometry';
import { DEFAULT_PARAMS, IpcWorld } from '../assets/game/ipc/IpcWorld';
import { rectShape } from '../assets/game/ipc/Mesh2D';
import { buildScene, rigidAsFem, SCENE_NAMES } from '../assets/game/ipc/Scenes';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) failures++;
}

let seed = 7;
function rand(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}

// Point-edge squared distance: gradient and Hessian by central differences.
{
    const g = new Float64Array(6);
    const H = new Float64Array(36);
    const gp = new Float64Array(6);
    const gm = new Float64Array(6);
    const Hs = new Float64Array(36);
    let gradErr = 0;
    let hessErr = 0;
    const configs = [
        [0.3, 0.4, 0, 0, 1, 0.1], // line
        [-0.3, 0.2, 0, 0, 1, 0.1], // endpoint a
        [1.4, -0.3, 0, 0, 1, 0.1], // endpoint b
    ];
    for (let k = 0; k < 20; k++) configs.push([rand() * 2 - 0.5, rand() - 0.5, rand() * 0.2, rand() * 0.2, 1 + rand() * 0.2, rand() * 0.2]);
    for (const q of configs) {
        peDistance2Derivatives(q[0], q[1], q[2], q[3], q[4], q[5], g, H);
        const eps = 1e-6;
        for (let i = 0; i < 6; i++) {
            const qp = q.slice();
            const qm = q.slice();
            qp[i] += eps;
            qm[i] -= eps;
            const fd = (peDistance2(qp[0], qp[1], qp[2], qp[3], qp[4], qp[5]) - peDistance2(qm[0], qm[1], qm[2], qm[3], qm[4], qm[5])) / (2 * eps);
            gradErr = Math.max(gradErr, Math.abs(fd - g[i]));
            peDistance2Derivatives(qp[0], qp[1], qp[2], qp[3], qp[4], qp[5], gp, Hs);
            peDistance2Derivatives(qm[0], qm[1], qm[2], qm[3], qm[4], qm[5], gm, Hs);
            for (let j = 0; j < 6; j++) hessErr = Math.max(hessErr, Math.abs((gp[j] - gm[j]) / (2 * eps) - H[j * 6 + i]));
        }
    }
    check('point-edge distance gradient', gradErr < 1e-6, `max error ${gradErr.toExponential(1)}`);
    check('point-edge distance Hessian', hessErr < 1e-5, `max error ${hessErr.toExponential(1)}`);
}

// PSD projection: result has no negative eigenvalues (xᵀMx ≥ 0) and keeps PSD input.
{
    let worst = 0;
    let changed = 0;
    for (let trial = 0; trial < 200; trial++) {
        const n = trial % 2 ? 6 : 4;
        const m = new Float64Array(n * n);
        for (let i = 0; i < n; i++) for (let j = i; j < n; j++) m[i * n + j] = m[j * n + i] = rand() * 2 - 1;
        projectPsd(m, n);
        for (let s = 0; s < 50; s++) {
            const v = Array.from({ length: n }, () => rand() * 2 - 1);
            let q = 0;
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) q += v[i] * m[i * n + j] * v[j];
            worst = Math.min(worst, q);
        }
        // Gram matrix: already PSD, must come back unchanged.
        const a = Array.from({ length: n * n }, () => rand() * 2 - 1);
        const g = new Float64Array(n * n);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) g[i * n + j] += a[i * n + k] * a[j * n + k];
        const before = g.slice();
        projectPsd(g, n);
        for (let i = 0; i < n * n; i++) changed = Math.max(changed, Math.abs(g[i] - before[i]) / (1 + Math.abs(before[i])));
    }
    check('PSD projection removes negative directions', worst > -1e-9, `min xᵀMx ${worst.toExponential(1)}`);
    check('PSD projection keeps PSD input', changed < 1e-8, `max change ${changed.toExponential(1)}`);
}

// Analytic Neo-Hookean Hessian projection against building dP/dF and projecting it numerically.
{
    let worst = 0;
    const out = new Float64Array(16);
    const ref = new Float64Array(16);
    for (let trial = 0; trial < 500; trial++) {
        const f = [rand() * 2 - 0.5, rand() - 0.5, rand() - 0.5, rand() * 2 - 0.5];
        const J = f[0] * f[3] - f[1] * f[2];
        if (J < 0.05) continue;
        const mu = 1 + rand() * 10, lam = rand() * 40;
        const it = [f[3] / J, -f[2] / J, -f[1] / J, f[0] / J];
        const c2 = mu - lam * Math.log(J);
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) {
            ref[(i * 2 + j) * 4 + k * 2 + l] = (i === k && j === l ? mu : 0) + c2 * it[i * 2 + l] * it[k * 2 + j] + lam * it[k * 2 + l] * it[i * 2 + j];
        }
        projectPsd(ref, 4);
        neoHookeanHessian(f[0], f[1], f[2], f[3], mu, lam, out);
        let scale = 0;
        for (let i = 0; i < 16; i++) scale = Math.max(scale, Math.abs(ref[i]));
        for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(out[i] - ref[i]) / scale);
    }
    check('analytic Neo-Hookean Hessian matches numeric projection', worst < 1e-7, `max relative error ${worst.toExponential(1)}`);
}

// Full incremental potential: assembled gradient against finite differences,
// with bodies inside the barrier range, friction and a grab active.
for (const model of ['ipc', 'penalty'] as const) {
    const scene = buildScene(0);
    const world = new IpcWorld(scene.bodies, model) as any;
    for (let i = 0; i < 40; i++) world.step();
    world.grab(world.x[2 * world.points[world.points.length - 1]], world.x[2 * world.points[world.points.length - 1] + 1] + 0.01, 0.05);
    world.xn.set(world.x);
    for (let i = 0; i < world.vertexCount; i++) {
        world.xTilde[2 * i] = world.x[2 * i] + 0.002 * Math.sin(i);
        world.xTilde[2 * i + 1] = world.x[2 * i + 1] - 0.003;
    }
    world.lagFriction();
    // Shift a little so friction slip is non-zero.
    for (let i = 0; i < world.vertexCount; i++) if (!world.kinematic[i]) world.x[2 * i] += 2e-5 * Math.cos(3 * i);
    world.findPairs(world.x, null, 0);
    world.assemble();
    const contacts = world.contactCount;
    let err = 0;
    let scale = 0;
    const eps = 1e-8;
    for (let k = 0; k < 60; k++) {
        const i = world.points[(k * 37) % world.points.length];
        if (world.kinematic[i] || world.aff[i] >= 0) continue;
        for (let c = 0; c < 2; c++) {
            const idx = 2 * i + c;
            const x0 = world.x[idx];
            world.x[idx] = x0 + eps;
            const ep = world.energy(world.x, 0);
            world.x[idx] = x0 - eps;
            const em = world.energy(world.x, 0);
            world.x[idx] = x0;
            const fd = (ep - em) / (2 * eps);
            err = Math.max(err, Math.abs(fd - world.grad[idx]));
            scale = Math.max(scale, Math.abs(world.grad[idx]));
        }
    }
    check(`${model} energy gradient`, err < 1e-5 * Math.max(1, scale), `max error ${err.toExponential(1)} (largest ${scale.toExponential(1)}, ${contacts} contact + friction terms)`);
}

// Rigid bodies: gradient over their six unknowns (inertia, orthogonality, contact
// and friction through x = p + A x̄, and a grab on a rigid vertex) against finite differences.
{
    const crates = SCENE_NAMES.indexOf('Crates');
    const world = new IpcWorld(buildScene(crates).bodies, 'ipc') as any;
    for (let i = 0; i < 90; i++) world.step();
    const plank = world.bodies.find((b: any) => b.affine >= 0 && b.count > 60);
    const gv = plank.start + 7;
    world.grab(world.x[2 * gv], world.x[2 * gv + 1], 1e-3);
    world.moveGrab(world.x[2 * gv] + 0.01, world.x[2 * gv + 1] + 0.02);
    world.xn.set(world.x);
    world.qn.set(world.q);
    for (let k = 0; k < world.q.length; k++) world.qTilde[k] = world.q[k] + 1e-3 * Math.sin(k);
    world.lagFriction();
    for (let k = 0; k < world.q.length; k++) world.q[k] += 3e-6 * Math.cos(5 * k);
    world.syncAffine();
    world.findPairs(world.x, null, 0);
    world.assemble();
    world.gatherRhs();
    let err = 0;
    let scale = 0;
    const eps = 1e-7;
    for (let a = 0; a < world.rigidCount; a++) {
        for (let c = 0; c < 6; c++) {
            const idx = 6 * a + c;
            const q0 = world.q[idx];
            world.q[idx] = q0 + eps;
            world.syncAffine();
            const ep = world.energy(world.x, 0);
            world.q[idx] = q0 - eps;
            world.syncAffine();
            const em = world.energy(world.x, 0);
            world.q[idx] = q0;
            world.syncAffine();
            const analytic = -world.rhs[2 * world.abdDof[a] + c];
            err = Math.max(err, Math.abs((ep - em) / (2 * eps) - analytic));
            scale = Math.max(scale, Math.abs(analytic));
        }
    }
    check('rigid-body (ABD) energy gradient', err < 1e-5 * Math.max(1, scale), `max error ${err.toExponential(1)} (largest ${scale.toExponential(1)}, ${world.contactCount} contact + friction terms)`);
}

// A lone rigid body: free fall matches implicit Euler exactly, and a spinning one stays a rotation.
{
    const shape = rectShape(0, 1, 0.3, 0.1, 6, 2);
    const world = new IpcWorld([{ shape, young: 0, poisson: 0, density: 300, rigid: true, color: [1, 1, 1] }], 'ipc') as any;
    const h = world.params.dt;
    let vy = 0;
    let y = world.q[1];
    for (let i = 0; i < 60; i++) {
        world.step();
        vy += h * world.params.gravity;
        y += h * vy;
    }
    check('rigid body free fall = implicit Euler', Math.abs(world.q[1] - y) < 1e-6, `y ${world.q[1].toFixed(6)} vs ${y.toFixed(6)}`);

    const spin = new IpcWorld([{ shape, young: 0, poisson: 0, density: 300, rigid: true, color: [1, 1, 1] }], 'ipc', { ...DEFAULT_PARAMS, gravity: 0 }) as any;
    const omega = 6;
    spin.qv.set([0, 0, 0, omega, -omega, 0]);
    let worst = 0;
    for (let i = 0; i < 120; i++) {
        spin.step();
        worst = Math.max(worst, spin.orthogonalityError());
    }
    const spinLeft = Math.hypot(spin.qv[2], spin.qv[3]) / omega;
    check(
        'spinning rigid body stays a rotation',
        worst < 1e-3,
        `max ‖AᵀA − I‖ ${worst.toExponential(1)}, ${(spinLeft * 100).toFixed(0)}% of the spin left after 2 s (implicit Euler damping)`,
    );
}

// Rigid bodies as ABD against the same bodies as stiff FEM, both with IPC.
{
    const crates = SCENE_NAMES.indexOf('Crates');
    const defs = buildScene(crates).bodies;
    const rigidBodies = defs.map((d, i) => (d.rigid ? i : -1)).filter((i) => i >= 0);
    const strains: number[] = [];
    for (const [name, bodies] of [['ABD', defs], ['stiff FEM', rigidAsFem(defs)]] as const) {
        const world = new IpcWorld(bodies, 'ipc');
        let crossings = 0;
        let strain = 0;
        let ms = 0;
        let newton = 0;
        let cg = 0;
        const steps = 240;
        for (let i = 0; i < steps; i++) {
            world.step();
            crossings += world.countCrossings();
            ms += world.stats.ms;
            newton += world.stats.newton;
            cg += world.stats.cg;
            for (const k of rigidBodies) {
                const b = world.bodies[k];
                for (let t = b.triStart; t < b.triStart + b.triCount; t++) strain = Math.max(strain, world.strain(t));
            }
        }
        strains.push(strain);
        check(
            `Crates, rigid bodies as ${name}: no crossings`,
            crossings === 0,
            `${2 * world.dofCount} unknowns, ${(ms / steps).toFixed(1)} ms/step, ${(newton / steps).toFixed(1)} Newton, ${(cg / steps).toFixed(0)} CG/step, max rigid strain ${strain.toExponential(1)}`,
        );
    }
    check('ABD bodies stay stiffer than the stiff FEM ones', strains[0] < strains[1] / 3, `${strains[0].toExponential(1)} vs ${strains[1].toExponential(1)}`);
}

// The IPC guarantee on every scene: no crossing boundary edges, distances stay positive, no NaN.
for (let s = 0; s < SCENE_NAMES.length; s++) {
    const world = new IpcWorld(buildScene(s).bodies, 'ipc');
    let crossings = 0;
    let minDistance = Infinity;
    let finite = true;
    let newton = 0;
    let unconverged = 0;
    // The squeeze runs one whole plunger cycle.
    const steps = s === 1 ? 540 : 180;
    for (let i = 0; i < steps; i++) {
        world.step();
        crossings += world.countCrossings();
        minDistance = Math.min(minDistance, world.stats.minDistance);
        newton += world.stats.newton;
        if (!world.stats.converged) unconverged++;
        for (let k = 0; k < world.x.length; k++) if (!Number.isFinite(world.x[k])) finite = false;
    }
    check(
        `IPC ${SCENE_NAMES[s]}: no crossings in ${steps} steps`,
        crossings === 0 && finite && minDistance > 0,
        `min distance ${(minDistance * 1000).toFixed(3)} mm, ${(newton / steps).toFixed(1)} Newton/step, ${unconverged} steps hit the cap`,
    );
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
