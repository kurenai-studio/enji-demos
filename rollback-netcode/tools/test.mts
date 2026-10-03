// Headless checks of the deterministic game, the rollback and lockstep peers
// and the session on simulated networks.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
import { fdiv, fmul, fx, isqrt } from '../assets/game/net/Fixed.ts';
import { checksum, createState, DASH, DOWN, FRAME, LEFT, P, RIGHT, SCORE0, SCORE1, step, UP } from '../assets/game/net/Game.ts';
import { MAX_PREDICTION } from '../assets/game/net/Peer.ts';
import { Session, type SessionSettings } from '../assets/game/net/Session.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- fixed point
{
    let wrong = 0;
    let seed = 12345;
    for (let i = 0; i < 200000; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const v = Math.floor((seed / 4294967296) * 2 ** 42) + (i % 7);
        const s = isqrt(v);
        if (!(s * s <= v && (s + 1) * (s + 1) > v)) wrong++;
    }
    check('isqrt is the exact floor up to 2^42', wrong === 0, `${wrong} wrong of 200000`);
    const a = fx(3.7), b = fx(-1.25);
    check('fmul / fdiv round towards zero, symmetric in sign', fmul(a, b) === -fmul(-a, b) && fdiv(a, b) === -fdiv(-a, b) && fmul(fx(-0.00001), fx(0.92)) === 0,
        `3.7 × −1.25 = ${fmul(a, b) / 65536}, 3.7 / −1.25 = ${fdiv(a, b) / 65536}`);
}

// ---------------------------------------------------------------- determinism
function randomInputs(n: number, seed: number): number[][] {
    const out: number[][] = [[], []];
    let s = seed;
    const keys = [0, UP, DOWN, LEFT, RIGHT, UP | LEFT, UP | RIGHT, DOWN | LEFT, DOWN | RIGHT];
    const held = [0, 0];
    for (let f = 0; f < n; f++) {
        for (let i = 0; i < 2; i++) {
            s = (Math.imul(s, 1103515245) + 12345) >>> 0;
            if (s % 9 === 0) held[i] = keys[(s >>> 8) % keys.length] | ((s >>> 16) % 4 === 0 ? DASH : 0);
            out[i].push(held[i]);
        }
    }
    return out;
}
{
    const n = 3600;
    const inputs = randomInputs(n, 7);
    const run = () => {
        const s = createState(42);
        const sums: number[] = [];
        for (let f = 0; f < n; f++) { step(s, inputs[0][f], inputs[1][f]); sums.push(checksum(s)); }
        return { sums, s };
    };
    const r1 = run(), r2 = run();
    const same = r1.sums.every((c, i) => c === r2.sums[i]);
    check('same inputs, same checksum at every one of 3600 frames', same, `final ${r1.sums[n - 1].toString(16)}, score ${r1.s[SCORE0]}:${r1.s[SCORE1]}`);
    // Snapshot at 1000, run on to 1500, restore, re-run: identical.
    const s = createState(42);
    for (let f = 0; f < 1000; f++) step(s, inputs[0][f], inputs[1][f]);
    const snap = s.slice();
    for (let f = 1000; f < 1500; f++) step(s, inputs[0][f], inputs[1][f]);
    const after = checksum(s);
    s.set(snap);
    for (let f = 1000; f < 1500; f++) step(s, inputs[0][f], inputs[1][f]);
    check('restore a snapshot and re-simulate: bit-identical', checksum(s) === after && after === r1.sums[1499]);
    // One different input changes the very next state, so the checksum sees it.
    const t = createState(42);
    for (let f = 0; f <= 900; f++) step(t, f === 900 ? inputs[0][f] ^ RIGHT : inputs[0][f], inputs[1][f]);
    check('one changed input at frame 900 changes the checksum of frame 901', checksum(t) !== r1.sums[900]);
    // Raw cost of one step, which bounds what a rollback costs here.
    const bench = createState(42);
    const t0 = performance.now();
    for (let f = 0; f < 200000; f++) step(bench, inputs[0][f % n], inputs[1][f % n]);
    const us = ((performance.now() - t0) * 1000) / 200000;
    console.log(`info one step ${us.toFixed(3)} µs, a 9-frame rollback with snapshots ${(9 * us).toFixed(2)} µs + copies`);
    // Float drag drifts away from the fixed-point game.
    const u = createState(42);
    let diverged = -1;
    for (let f = 0; f < n && diverged < 0; f++) {
        step(u, inputs[0][f], inputs[1][f], true);
        if (checksum(u) !== r1.sums[f]) diverged = f + 1;
    }
    check('float drag diverges from fixed point', diverged > 0, `first different state at frame ${diverged}`);
}

// ---------------------------------------------------------------- sessions
const BASE: SessionSettings = { mode: 'rollback', inputDelay: 1, seed: 3, latencyMs: 100, jitterMs: 20, loss: 0.05, floatDrag: false };

interface Run {
    session: Session;
    verified: number[];
    mismatches: number;
    frames: number[];
    /** Mean distance (units) between each peer's view of the other player and the reference, and of the puck. */
    remoteError: number;
    ballError: number;
}

/** Runs `ticks` ticks; checks every frame that becomes final on either peer against the reference. */
function run(settings: Partial<SessionSettings>, ticks = 3600): Run {
    const session = new Session({ ...BASE, ...settings });
    const verified = [0, 0];
    const next = [0, 0];
    let mismatches = 0;
    let errSum = 0, ballSum = 0, errCount = 0;
    for (let t = 0; t < ticks; t++) {
        session.tick();
        for (let i = 0; i < 2; i++) {
            const peer = session.peers[i];
            while (next[i] <= peer.finalFrame) {
                const mine = peer.checksumAt(next[i]);
                const ref = session.referenceChecksum(next[i]);
                if (mine >= 0 && ref >= 0) {
                    verified[i]++;
                    if (mine !== ref) mismatches++;
                }
                next[i]++;
            }
            const ref = session.referenceAt(peer.frame);
            if (ref) {
                const o = P + 5 * (1 - i);
                errSum += Math.hypot(peer.state[o] - ref[o], peer.state[o + 1] - ref[o + 1]) / 65536;
                ballSum += Math.hypot(peer.state[15] - ref[15], peer.state[16] - ref[16]) / 65536;
                errCount++;
            }
        }
    }
    return { session, verified, mismatches, frames: session.peers.map((p) => p.frame), remoteError: errSum / errCount, ballError: ballSum / errCount };
}

const line = (r: Run) => {
    const p = r.session.peers.map((x) => x.stats);
    const ticks = r.session.ticks, sec = ticks / 60;
    const st = p[0];
    return `frames ${r.frames.join(' / ')} in ${ticks} ticks; rollbacks ${(st.rollbacks / sec).toFixed(1)}/s, mean depth ${(st.resimulated / Math.max(1, st.rollbacks)).toFixed(1)}, max ${Math.max(p[0].maxDepth, p[1].maxDepth)}; ` +
        `stalls ${p[0].stalls} / ${p[1].stalls}; predictions wrong ${(100 * (p[0].mispredicted + p[1].mispredicted) / Math.max(1, p[0].predicted + p[1].predicted)).toFixed(1)}%; ` +
        `rollback jumps of the other player mean ${(st.sumCorrection / Math.max(1, st.rollbacks)).toFixed(2)}, max ${Math.max(p[0].maxCorrection, p[1].maxCorrection).toFixed(2)} units; final frames checked ${r.verified.join(' / ')}, mismatches ${r.mismatches}; view error: other player ${r.remoteError.toFixed(3)}, puck ${r.ballError.toFixed(3)} units; ` +
        `${(r.session.tickMicros / ticks).toFixed(0)} µs per tick (both peers)`;
};

{
    const r = run({});
    const p = r.session.peers;
    const s = r.session.reference;
    check('rollback, 100 ms ±20 ms, 5% loss: every final frame of both peers equals the reference', r.mismatches === 0 && r.verified.every((v) => v > 3400), line(r));
    check('rollback keeps full speed: ≥ 98% of ticks advance a frame', r.frames.every((f) => f >= 0.98 * 3600), `score ${s[SCORE0]}:${s[SCORE1]}`);
    check(`rollback never re-simulates more than MAX_PREDICTION + 1 = ${MAX_PREDICTION + 1} frames`, p.every((x) => x.stats.maxDepth <= MAX_PREDICTION + 1));
    check('the checksum exchange agrees (no desync reported, recent frame checked)', p.every((x) => x.stats.desyncFrame < 0 && x.stats.checkedFrame > 3400),
        `checked up to ${p[0].stats.checkedFrame} / ${p[1].stats.checkedFrame}`);
    check('the game is played: goals are scored', s[SCORE0] + s[SCORE1] > 0, `score ${s[SCORE0]}:${s[SCORE1]} at frame ${s[FRAME]}`);

    const lock = run({ mode: 'lockstep' });
    check('lockstep, same network, input delay 1: correct but slowed to a crawl', lock.mismatches === 0 && lock.frames.every((f) => f < 0.25 * 3600), line(lock));
    const lock7 = run({ mode: 'lockstep', inputDelay: 7 });
    console.log(`info lockstep, input delay 7 (117 ms): ${line(lock7)}`);
    check('lockstep with the delay covering the latency (7 frames) runs near full speed, no view error', lock7.frames.every((f) => f > 0.9 * 3600) && lock7.remoteError === 0 && lock7.mismatches === 0,
        `${lock7.frames.join(' / ')} frames in 3600 ticks`);

    const zero = run({ latencyMs: 0, jitterMs: 0, loss: 0 });
    check('rollback on a perfect link with input delay 1: no rollbacks, no stalls', zero.session.peers.every((x) => x.stats.rollbacks === 0 && x.stats.stalls === 0), line(zero));
    const zero0 = run({ latencyMs: 0, jitterMs: 0, loss: 0, inputDelay: 0 });
    console.log(`info rollback, perfect link, input delay 0: ${line(zero0)}`);
    check('input delay 0 on a perfect link: one-frame rollbacks only', zero0.session.peers.every((x) => x.stats.maxDepth === 1) && zero0.mismatches === 0);

    for (const latencyMs of [30, 60, 150]) console.log(`info rollback ${latencyMs} ms ±20 ms, 5% loss: ${line(run({ latencyMs }))}`);
    const far = run({ latencyMs: 150 });
    check('rollback at 150 ms: still correct; stalls at the prediction window', far.mismatches === 0 && far.session.peers.every((x) => x.stats.stalls > 0), line(far));
    const lossy = run({ loss: 0.3 });
    check('30% packet loss: redundant inputs keep both peers correct and near full speed', lossy.mismatches === 0 && lossy.frames.every((f) => f > 0.9 * 3600), line(lossy));
    for (const inputDelay of [0, 2, 3]) console.log(`info rollback 100 ms, input delay ${inputDelay}: ${line(run({ inputDelay }))}`);

    const broken = run({ floatDrag: true });
    // First frame where peer 1's own final state differs from the reference.
    const s1 = new Session({ ...BASE, floatDrag: true });
    let firstBad = -1, detectedAt = -1, next = 0;
    for (let t = 0; t < 3600 && detectedAt < 0; t++) {
        s1.tick();
        const peer = s1.peers[1];
        while (firstBad < 0 && next <= peer.finalFrame) {
            const mine = peer.checksumAt(next), ref = s1.referenceChecksum(next);
            if (mine >= 0 && ref >= 0 && mine !== ref) firstBad = next;
            next++;
        }
        if (s1.peers.some((x) => x.stats.desyncFrame >= 0)) detectedAt = s1.peers[0].frame;
    }
    check('a peer with float drag: the checksum exchange reports the desync within 30 frames of the first different state',
        firstBad >= 0 && detectedAt >= 0 && detectedAt - firstBad <= 30 && broken.mismatches > 0,
        `first different state at frame ${firstBad}, reported at frame ${detectedAt} (desync frame ${Math.max(s1.peers[0].stats.desyncFrame, s1.peers[1].stats.desyncFrame)})`);
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
