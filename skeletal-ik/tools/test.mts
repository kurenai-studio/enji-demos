// Headless checks of the animation runtime (assets/game/anim): quaternions,
// two-bone IK, the baked clips, phase-synced blending, foot IK on terrain,
// and linear blend vs dual quaternion skinning on a closed limb.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { addChain, buildBody, buildBones, emptyMesh, type SkinnedMesh } from '../assets/game/anim/Body.ts';
import { Character, createAnimSet } from '../assets/game/anim/Character.ts';
import { bakeClip, type BakeReport, type ClipName } from '../assets/game/anim/Gait.ts';
import { qAngle, qAxisAngle, qConj, qEuler, qFromTo, qMul, qNormalize, qRotate, qSlerp, quat, vDist, vDot, vec, vNorm, vSub, type Quat, type Vec } from '../assets/game/anim/Math3.ts';
import { forwardKinematics, humanoid, Skeleton } from '../assets/game/anim/Skeleton.ts';
import { DQ_FLOATS, ROW_FLOATS, skinDualQuat, skinLinear, skinTransforms } from '../assets/game/anim/Skinning.ts';
import { solveTwoBone } from '../assets/game/anim/TwoBoneIk.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

let seed = 7;
function rand(): number {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
}
function randomQuat(): Quat {
    return qNormalize(quat(), quat(rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5));
}
const mm = (m: number) => `${(m * 1000).toFixed(2)} mm`;

// Quaternions.
{
    let worst = 0;
    for (let i = 0; i < 200; i++) {
        const a = randomQuat(), b = randomQuat();
        const v = vec(rand() - 0.5, rand() - 0.5, rand() - 0.5);
        const ab = qRotate(vec(), qMul(quat(), a, b), v);
        const seq = qRotate(vec(), a, qRotate(vec(), b, v));
        worst = Math.max(worst, vDist(ab, seq));
        const from = vNorm(vec(), vec(rand() - 0.5, rand() - 0.5, rand() - 0.5));
        const to = vNorm(vec(), vec(rand() - 0.5, rand() - 0.5, rand() - 0.5));
        worst = Math.max(worst, vDist(qRotate(vec(), qFromTo(quat(), from, to), from), to));
        const s0 = qSlerp(quat(), a, b, 0), s1 = qSlerp(quat(), a, b, 1);
        worst = Math.max(worst, qAngle(qMul(quat(), qConj(quat(), s0), a)), qAngle(qMul(quat(), qConj(quat(), s1), b)));
    }
    check('quaternion product, from-to and slerp end points', worst < 1e-6, `worst ${worst.toExponential(1)}`);
}

// Two-bone IK on the humanoid leg.
const skel = humanoid();
{
    const legL = { upper: skel.index('thigh.L'), middle: skel.index('shin.L'), end: skel.index('foot.L'), bend: vec(0, 0, 1) };
    const pose = skel.newPose();
    const g = skel.newGlobal();
    const fk = skel.newGlobal();
    let worstMiss = 0, worstLen = 0, worstFk = 0, worstEnd = 0, wrongSide = 0, unreachable = 0, worstStraight = 0;
    const l1 = 0.42, l2 = 0.4;
    for (let i = 0; i < 500; i++) {
        for (const q of pose.rot) qNormalize(q, quat(0, 0, 0, 1));
        // A mildly bent animated knee to start from.
        qAxisAngle(pose.rot[legL.middle], 1, 0, 0, 0.2 + rand());
        qAxisAngle(pose.rot[legL.upper], 1, 0, 0, -0.5 * rand());
        forwardKinematics(skel, pose, g);
        const hip = g.pos[legL.upper];
        const footRot = quat(g.rot[legL.end].x, g.rot[legL.end].y, g.rot[legL.end].z, g.rot[legL.end].w);
        const dir = vNorm(vec(), vec(rand() - 0.5, -1.5 * rand() - 0.2, rand() - 0.5));
        const reach = i % 5 === 4 ? 0.9 + 0.2 * rand() : 0.1 + 0.7 * rand();
        const target = vec(hip.x + dir.x * reach, hip.y + dir.y * reach, hip.z + dir.z * reach);
        const r = solveTwoBone(skel, pose, g, legL, target);
        forwardKinematics(skel, pose, fk);
        for (const j of [legL.upper, legL.middle, legL.end]) worstFk = Math.max(worstFk, vDist(fk.pos[j], g.pos[j]));
        worstLen = Math.max(worstLen, Math.abs(vDist(fk.pos[legL.upper], fk.pos[legL.middle]) - l1), Math.abs(vDist(fk.pos[legL.middle], fk.pos[legL.end]) - l2));
        worstEnd = Math.max(worstEnd, qAngle(qMul(quat(), qConj(quat(), footRot), fk.rot[legL.end])));
        if (reach < l1 + l2 - 1e-3) {
            worstMiss = Math.max(worstMiss, r.miss);
            // The knee bends forward of the hip–ankle line.
            const a = fk.pos[legL.upper], c = fk.pos[legL.end], b = fk.pos[legL.middle];
            const axis = vNorm(vec(), vSub(vec(), c, a));
            const ab = vSub(vec(), b, a);
            const off = vSub(vec(), ab, vec(axis.x * vDot(ab, axis), axis.y * vDot(ab, axis), axis.z * vDot(ab, axis)));
            if (off.z < -1e-6 && Math.abs(axis.z) < 0.9) wrongSide++;
        } else {
            unreachable++;
            worstStraight = Math.max(worstStraight, Math.abs(r.miss - (reach - (l1 + l2))));
        }
    }
    check('IK reaches every reachable target', worstMiss < 1e-6, `worst miss ${worstMiss.toExponential(1)} m`);
    check('IK keeps bone lengths', worstLen < 1e-6, `worst ${worstLen.toExponential(1)} m`);
    check('IK globals match a fresh FK pass', worstFk < 1e-6, `worst ${worstFk.toExponential(1)} m`);
    check('IK keeps the end joint\'s global rotation', worstEnd < 1e-5, `worst ${worstEnd.toExponential(1)} rad`);
    check('IK knee stays on the animated (forward) side', wrongSide === 0, `${wrongSide} of 500 flipped`);
    check('unreachable targets: limb straightens towards them', worstStraight < 1e-3, `${unreachable} cases, miss − overshoot ≤ ${mm(worstStraight)}`);

    // A pole vector picks the bend plane; an explicit end rotation is applied.
    for (const q of pose.rot) qNormalize(q, quat(0, 0, 0, 1));
    forwardKinematics(skel, pose, g);
    const hip = g.pos[legL.upper];
    const pole = vec(hip.x + 1, hip.y - 0.4, hip.z);
    const endRot = qEuler(quat(), 0.3, 0.5, 0);
    solveTwoBone(skel, pose, g, legL, vec(hip.x, hip.y - 0.6, hip.z + 0.1), pole, endRot);
    forwardKinematics(skel, pose, fk);
    check('pole vector sets the bend side', fk.pos[legL.middle].x > hip.x + 0.1, `knee x − hip x = ${(fk.pos[legL.middle].x - hip.x).toFixed(3)} m`);
    check('explicit end rotation is applied', qAngle(qMul(quat(), qConj(quat(), endRot), fk.rot[legL.end])) < 1e-5);
}

// Baked clips: the authoring IK reaches every planted-foot target.
for (const name of ['Idle', 'Walk', 'Run', 'Exercise'] as ClipName[]) {
    const report: BakeReport = { maxMiss: 0 };
    const clip = bakeClip(skel, name, report);
    check(`${name}: legs reach the authored feet in every frame`, report.maxMiss < 1e-4, `${clip.frames} frames, worst ${mm(report.maxMiss)}, speed ${clip.speed.toFixed(2)} m/s`);
}

const set = createAnimSet();
const { Walk, Run } = set.clips;

/** Runs a character on a (nearly straight) path and returns its foot stats per planted sample. */
function stroll(opts: { speed: number; sync?: boolean; footIk?: boolean; amplitude?: number; radius?: number; warm?: number; seconds?: number }): { error: number; maxError: number; skate: number; samples: number; pelvis: number; drag: number; releases: number } {
    const radius = opts.radius ?? 1e4;
    const c = new Character(set, vec(radius === 1e4 ? -1e4 : 0, 0, 0), radius, 0, 1);
    c.speedOverride = opts.speed;
    c.syncPhases = opts.sync ?? true;
    c.footIk = opts.footIk ?? false;
    c.terrainAmplitude = opts.amplitude ?? 0;
    const dt = 1 / 60;
    for (let t = 0; t < (opts.warm ?? 6); t += dt) c.update(dt);
    c.resetStats();
    let pelvis = 0, n = 0;
    for (let t = 0; t < (opts.seconds ?? 10); t += dt) {
        c.update(dt);
        pelvis = Math.max(pelvis, Math.abs(c.pelvisOffset));
        n++;
    }
    const s = c.stats;
    return { error: s.error / s.samples, maxError: s.maxError, skate: s.skate / s.samples, samples: s.samples, pelvis, drag: s.maxDrag, releases: s.releases };
}

// Locomotion on flat ground: the root advances at the clip speed, so the
// planted ball stays put. Raw 30 Hz keyframes drift a little between frames
// (the run foot moves 10 cm per keyframe); foot locking pins it.
for (const [name, speed] of [['Walk', Walk.speed], ['Run', Run.speed]] as const) {
    const raw = stroll({ speed });
    check(`${name} (raw clip): planted foot nearly still on flat ground`, raw.skate < 0.015 * speed && raw.maxError < 0.008,
        `mean slide ${(raw.skate * 1000).toFixed(1)} mm/s (${((raw.skate / speed) * 100).toFixed(1)}% of ${speed.toFixed(2)} m/s), worst height ${mm(raw.maxError)}`);
    const locked = stroll({ speed, footIk: true });
    check(`${name} (foot IK + lock): planted foot pinned, close to the animation`, locked.skate < 0.005 && locked.maxError < 0.003 && locked.drag < 0.02 && locked.releases === 0,
        `mean slide ${(locked.skate * 1000).toFixed(2)} mm/s, worst height ${mm(locked.maxError)}, pin at most ${mm(locked.drag)} from the clip, ${locked.releases} released`);
}

// Blending walk and run halfway: a shared phase keeps the steps aligned, separate clocks do not.
{
    const mid = (Walk.speed + Run.speed) / 2;
    const synced = stroll({ speed: mid, sync: true });
    const free = stroll({ speed: mid, sync: false });
    check('walk/run blend: phase sync halves skating and keeps feet planted longer', synced.skate < 0.6 * free.skate && synced.samples > 1.3 * free.samples,
        `synced ${(synced.skate * 1000).toFixed(0)} mm/s, ${synced.samples} planted samples; separate clocks ${(free.skate * 1000).toFixed(0)} mm/s, ${free.samples}`);
    const locked = stroll({ speed: mid, footIk: true });
    check('walk/run blend with foot lock: no visible skating', locked.skate < 0.005 && locked.drag < 0.06 && locked.releases === 0,
        `${(locked.skate * 1000).toFixed(2)} mm/s, pin at most ${mm(locked.drag)} from the blend, ${locked.releases} released`);
}

// Foot IK on rolling ground.
{
    const off = stroll({ speed: Walk.speed, amplitude: 1, radius: 4, footIk: false });
    const on = stroll({ speed: Walk.speed, amplitude: 1, radius: 4, footIk: true });
    check('foot IK puts planted feet on uneven ground', on.error < 0.005 && on.error < 0.25 * off.error,
        `mean ball error ${mm(on.error)} with IK vs ${mm(off.error)} without; worst ${mm(on.maxError)} vs ${mm(off.maxError)}`);
    check('foot IK: pelvis offset stays bounded', on.pelvis < 0.25, `largest pelvis drop ${mm(on.pelvis)}`);
    check('foot IK on a 4 m circle: planted foot pinned while the body turns', on.skate < 0.005 && on.releases === 0, `${(on.skate * 1000).toFixed(2)} mm/s, pin at most ${mm(on.drag)} from the clip`);
    const run = stroll({ speed: Run.speed, amplitude: 1, radius: 4, footIk: true });
    check('foot IK while running on uneven ground', run.error < 0.01 && run.skate < 0.005 && run.releases === 0,
        `mean ball error ${mm(run.error)}, slide ${(run.skate * 1000).toFixed(2)} mm/s, pin at most ${mm(run.drag)} from the clip, pelvis drop up to ${mm(run.pelvis)}`);
}

// Switching foot IK off and back on mid-walk: the pins start fresh, so the feet only pop by the terrain error.
{
    const c = new Character(set, vec(), 4, 0, 1);
    c.speedOverride = Walk.speed;
    c.terrainAmplitude = 1;
    const dt = 1 / 60;
    const ankles = [set.skel.index('foot.L'), set.skel.index('foot.R')];
    const last = [vec(), vec()];
    let worstJump = 0, lowestPelvis = 0, toggles = 0;
    for (let f = 0; f < 60 * 30; f++) {
        if (f % 150 === 0 && f > 0) { c.footIk = !c.footIk; toggles++; }
        c.update(dt);
        for (let leg = 0; leg < 2; leg++) {
            const p = c.local.pos[ankles[leg]];
            if (f > 0) worstJump = Math.max(worstJump, vDist(p, last[leg]));
            last[leg].x = p.x; last[leg].y = p.y; last[leg].z = p.z;
        }
        lowestPelvis = Math.min(lowestPelvis, c.pelvisOffset);
    }
    check('toggling foot IK mid-walk: no leg snaps', worstJump < 0.12 && lowestPelvis > -0.15 && c.stats.releases === 0,
        `${toggles} toggles, largest ankle step in one frame ${mm(worstJump)}, lowest pelvis ${mm(lowestPelvis)}`);
}

// Skinning: a closed tube over a two-joint limb, bent and twisted at the middle joint.
function tubeVolume(m: SkinnedMesh, positions: ArrayLike<number>): number {
    let v = 0;
    const idx = m.indices;
    for (let i = 0; i < idx.length; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
        const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
        const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
        const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
        v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    return v / 6;
}

function skinAll(m: SkinnedMesh, rows: Float32Array, dqs: Float32Array, dual: boolean): Float64Array {
    const out = new Float64Array(m.positions.length);
    const p = vec(), r = vec();
    for (let i = 0; i < m.positions.length / 3; i++) {
        p.x = m.positions[3 * i]; p.y = m.positions[3 * i + 1]; p.z = m.positions[3 * i + 2];
        const js = m.joints.slice(4 * i, 4 * i + 4), ws = m.weights.slice(4 * i, 4 * i + 4);
        if (dual) skinDualQuat(dqs, p, js, ws, r);
        else skinLinear(rows, p, js, ws, r);
        out[3 * i] = r.x; out[3 * i + 1] = r.y; out[3 * i + 2] = r.z;
    }
    return out;
}

{
    const limb = new Skeleton([
        { name: 'upper', parent: -1, offset: vec(0, 1, 0) },
        { name: 'middle', parent: 0, offset: vec(0, -0.3, 0) },
        { name: 'end', parent: 1, offset: vec(0, -0.3, 0) },
    ]);
    const tube = emptyMesh();
    addChain(tube, {
        points: [vec(0, 1, 0), vec(0, 0.7, 0), vec(0, 0.4, 0)], joints: [0, 1], blend: 0.06,
        profile: [{ at: 0, r1: 0.05, r2: 0.05 }, { at: 1, r1: 0.05, r2: 0.05 }], color: () => [1, 1, 1, 0], capStart: true, capEnd: true,
    });
    const rest = tubeVolume(tube, tube.positions);
    // A 14-sided prism: area (n/2)·r²·sin(2π/n), plus the two caps' bulge.
    const prism = 7 * 0.05 * 0.05 * Math.sin((2 * Math.PI) / 14) * 0.6;
    check('test limb: closed tube volume ≈ prism', Math.abs(rest / prism - 1) < 0.03, `${(rest * 1e6).toFixed(0)} cm³ vs ${(prism * 1e6).toFixed(0)} cm³`);
    const pose = limb.newPose();
    const g = limb.newGlobal();
    const rows = new Float32Array(ROW_FLOATS * 3);
    const dqs = new Float32Array(DQ_FLOATS * 3);
    const cases: [string, Quat][] = [['bent 120°', qAxisAngle(quat(), 1, 0, 0, (-120 * Math.PI) / 180)], ['twisted 150°', qAxisAngle(quat(), 0, 1, 0, (150 * Math.PI) / 180)]];
    for (const [label, q] of cases) {
        pose.rot[1] = q;
        forwardKinematics(limb, pose, g);
        skinTransforms(limb, g, rows, dqs);
        const lbs = tubeVolume(tube, skinAll(tube, rows, dqs, false)) / rest;
        const dqsVol = tubeVolume(tube, skinAll(tube, rows, dqs, true)) / rest;
        check(`limb ${label}: dual quaternions keep volume, linear blend loses it`, Math.abs(dqsVol - 1) < 0.03 && 1 - lbs > 2 * Math.abs(1 - dqsVol),
            `volume LBS ${(lbs * 100).toFixed(1)}%, DQS ${(dqsVol * 100).toFixed(1)}%`);
    }
    // One influence per vertex: both methods are the same rigid transform.
    let worst = 0;
    for (let k = 0; k < 20; k++) {
        for (const q of pose.rot) {
            const r = randomQuat();
            q.x = r.x; q.y = r.y; q.z = r.z; q.w = r.w;
        }
        pose.root.x = rand(); pose.root.z = rand();
        forwardKinematics(limb, pose, g);
        skinTransforms(limb, g, rows, dqs);
        for (let j = 0; j < 3; j++) {
            const p = vec(rand(), rand(), rand());
            const a = skinLinear(rows, p, [j, 0, 0, 0], [1, 0, 0, 0], vec());
            const b = skinDualQuat(dqs, p, [j, 0, 0, 0], [1, 0, 0, 0], vec());
            // And both equal the joint's rigid transform: q·(p − bind) + pos.
            const c = qRotate(vec(), g.rot[j], vSub(vec(), p, limb.bind[j]));
            c.x += g.pos[j].x; c.y += g.pos[j].y; c.z += g.pos[j].z;
            worst = Math.max(worst, vDist(a, b), vDist(a, c));
        }
    }
    check('single influence: LBS = DQS = the joint transform', worst < 1e-5, `worst ${worst.toExponential(1)} m`);
}

// The body and bone meshes.
{
    const body = buildBody(skel);
    const bones = buildBones(skel);
    let badWeights = 0, badJoints = 0;
    for (const m of [body, bones]) {
        for (let i = 0; i < m.weights.length; i += 4) {
            const s = m.weights[i] + m.weights[i + 1] + m.weights[i + 2] + m.weights[i + 3];
            if (Math.abs(s - 1) > 1e-6) badWeights++;
            for (let k = 0; k < 4; k++) if (m.joints[i + k] < 0 || m.joints[i + k] >= skel.count) badJoints++;
        }
    }
    const verts = body.positions.length / 3, tris = body.indices.length / 3;
    check('body mesh: weights sum to 1, joints in range', badWeights === 0 && badJoints === 0, `${verts} vertices, ${tris} triangles; bones ${bones.indices.length / 3} triangles`);
    check('body mesh fits a phone budget', verts < 12000 && tris < 20000);

    // On the real body through the exercise: blended vertices around a joint
    // should keep their distance to it. Linear blending pulls them in (the
    // collapsing elbow, the "candy wrapper" wrist).
    const blended: { v: number; joint: number; rest: number }[] = [];
    for (let i = 0; i < body.positions.length / 3; i++) {
        const j0 = body.joints[4 * i], j1 = body.joints[4 * i + 1], w1 = body.weights[4 * i + 1];
        if (w1 < 0.2 || w1 > 0.8) continue;
        const joint = skel.joints[j1].parent === j0 ? j1 : j0;
        const p = vec(body.positions[3 * i], body.positions[3 * i + 1], body.positions[3 * i + 2]);
        blended.push({ v: i, joint, rest: vDist(p, skel.bind[joint]) });
    }
    const c = new Character(set, vec(), 3, 0, 1);
    c.mode = 'exercise';
    const dt = 1 / 60;
    let worstLbs = 1, worstDqs = 1, worstLbsJoint = 0;
    for (let f = 0; f < 8 * 60; f++) {
        c.update(dt);
        if (f < 120 || f % 6) continue;
        const lbs = skinAll(body, c.rows, c.dqs, false), dq = skinAll(body, c.rows, c.dqs, true);
        for (const b of blended) {
            const jp = c.local.pos[b.joint];
            const d = (a: Float64Array) => Math.hypot(a[3 * b.v] - jp.x, a[3 * b.v + 1] - jp.y, a[3 * b.v + 2] - jp.z) / b.rest;
            const rl = d(lbs);
            if (rl < worstLbs) { worstLbs = rl; worstLbsJoint = b.joint; }
            worstDqs = Math.min(worstDqs, d(dq));
        }
    }
    check('body in the exercise: DQS keeps blended vertices off the joint, LBS pulls them in', worstDqs > 0.85 && worstLbs < worstDqs - 0.1,
        `${blended.length} blended vertices; closest to its joint: LBS ${(worstLbs * 100).toFixed(0)}% of rest distance (${skel.joints[worstLbsJoint].name}), DQS ${(worstDqs * 100).toFixed(0)}%`);
}

// Cost of one character update (blend, root motion, foot + reach IK, skin transforms).
{
    const crowd: Character[] = [];
    for (let i = 0; i < 25; i++) {
        const ch = new Character(set, vec(), 3 + (i % 5), (i / 25) * 2 * Math.PI, i % 2 ? 1 : -1, i * 0.7);
        ch.reach = true;
        crowd.push(ch);
    }
    const dt = 1 / 60;
    for (let f = 0; f < 120; f++) for (const ch of crowd) ch.update(dt);
    const t0 = performance.now();
    const frames = 600;
    for (let f = 0; f < frames; f++) for (const ch of crowd) ch.update(dt);
    const per = (performance.now() - t0) / (frames * crowd.length);
    check('character update is cheap', per < 0.2, `${(per * 1000).toFixed(1)} µs per character (Node), 25 characters ${(per * 25).toFixed(2)} ms/frame`);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
if (failures) process.exit(1);
