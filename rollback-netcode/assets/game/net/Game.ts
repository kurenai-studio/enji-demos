/**
 * The game both peers simulate: two-player air hockey in fixed point. The
 * whole state is one Int32Array, so a snapshot is a copy and a checksum is a
 * hash of 19 integers. `step` is a pure function of (state, input 0,
 * input 1): run it on the same inputs anywhere and the bits agree.
 */
import { clamp, fdiv, flength, fmul, fx, isqrt, ONE } from './Fixed';

export const UP = 1;
export const DOWN = 2;
export const LEFT = 4;
export const RIGHT = 8;
export const DASH = 16;

// State layout.
export const FRAME = 0;
export const RNG = 1;
export const KICKOFF = 2;
export const SCORE0 = 3;
export const SCORE1 = 4;
/** Player i at P + 5i: x, y, vx, vy, dash cooldown. */
export const P = 5;
/** Puck: x, y, vx, vy. */
export const BALL = 15;
export const STATE_SIZE = 19;

/** Arena half extents and goal mouth half width (units). */
export const HX = fx(8);
export const HY = fx(4.5);
export const GOAL = fx(1.4);
export const PLAYER_R = fx(0.5);
export const BALL_R = fx(0.3);

/** Per-frame (60 Hz) motion constants. */
const ACC = fx(0.012);
const ACC_DIAG = fmul(ACC, fx(Math.SQRT1_2));
const PLAYER_DRAG = fx(0.92);
const DASH_SPEED = fx(0.22);
const DASH_DIAG = fmul(DASH_SPEED, fx(Math.SQRT1_2));
export const DASH_COOLDOWN = 40;
const BALL_DRAG = fx(0.995);
const WALL_RESTITUTION = fx(0.9);
const HIT_RESTITUTION = fx(0.85);
const BALL_MAX = fx(0.32);
const SERVE_SPEED = fx(0.06);
export const KICKOFF_FRAMES = 45;
/** Serve directions (vy as a fraction of the speed), picked by the RNG. */
const SERVE_Y = [-0.6, -0.35, -0.15, 0.15, 0.35, 0.6].map(fx);

export function createState(seed: number): Int32Array {
    const s = new Int32Array(STATE_SIZE);
    s[RNG] = seed | 0 || 1;
    kickoff(s, 0);
    return s;
}

function random(s: Int32Array): number {
    let x = s[RNG];
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    s[RNG] = x;
    return x >>> 0;
}

/** Players back at their spots, puck in the centre, served towards `towards` (0: left) after a pause. */
function kickoff(s: Int32Array, towards: number): void {
    for (let i = 0; i < 2; i++) {
        const o = P + 5 * i;
        s[o] = i === 0 ? -fx(5) : fx(5);
        s[o + 1] = 0;
        s[o + 2] = 0;
        s[o + 3] = 0;
        s[o + 4] = 0;
    }
    const vy = SERVE_Y[random(s) % SERVE_Y.length];
    const vx = isqrt(ONE * ONE - vy * vy);
    s[BALL] = 0;
    s[BALL + 1] = 0;
    s[BALL + 2] = fmul(towards === 0 ? -vx : vx, SERVE_SPEED);
    s[BALL + 3] = fmul(vy, SERVE_SPEED);
    s[KICKOFF] = KICKOFF_FRAMES;
}

/**
 * Advances one frame. `floatDrag` computes the puck's drag in floating point
 * instead: a stand-in for a peer whose maths differs in the last bit (another
 * compiler, CPU or engine), which the checksums then catch.
 */
export function step(s: Int32Array, in0: number, in1: number, floatDrag = false): void {
    s[FRAME]++;
    movePlayer(s, 0, in0);
    movePlayer(s, 1, in1);
    if (s[KICKOFF] > 0) {
        s[KICKOFF]--;
        return;
    }

    const b = BALL;
    if (floatDrag) {
        s[b + 2] = Math.round(s[b + 2] * 0.995);
        s[b + 3] = Math.round(s[b + 3] * 0.995);
    } else {
        s[b + 2] = fmul(s[b + 2], BALL_DRAG);
        s[b + 3] = fmul(s[b + 3], BALL_DRAG);
    }
    s[b] += s[b + 2];
    s[b + 1] += s[b + 3];

    // Side walls (top and bottom).
    const ymax = HY - BALL_R;
    if (s[b + 1] > ymax) { s[b + 1] = 2 * ymax - s[b + 1]; s[b + 3] = -fmul(s[b + 3], WALL_RESTITUTION); }
    if (s[b + 1] < -ymax) { s[b + 1] = -2 * ymax - s[b + 1]; s[b + 3] = -fmul(s[b + 3], WALL_RESTITUTION); }
    // End walls, except the goal mouths.
    const xmax = HX - BALL_R;
    const inMouth = s[b + 1] > -GOAL + BALL_R && s[b + 1] < GOAL - BALL_R;
    if (!inMouth) {
        if (s[b] > xmax) { s[b] = 2 * xmax - s[b]; s[b + 2] = -fmul(s[b + 2], WALL_RESTITUTION); }
        if (s[b] < -xmax) { s[b] = -2 * xmax - s[b]; s[b + 2] = -fmul(s[b + 2], WALL_RESTITUTION); }
    } else if (s[b] > HX + BALL_R) {
        s[SCORE0]++;
        kickoff(s, 1);
        return;
    } else if (s[b] < -HX - BALL_R) {
        s[SCORE1]++;
        kickoff(s, 0);
        return;
    }

    for (let i = 0; i < 2; i++) hit(s, P + 5 * i);

    const speed = flength(s[b + 2], s[b + 3]);
    if (speed > BALL_MAX) {
        const k = fdiv(BALL_MAX, speed);
        s[b + 2] = fmul(s[b + 2], k);
        s[b + 3] = fmul(s[b + 3], k);
    }
}

function movePlayer(s: Int32Array, i: number, input: number): void {
    const o = P + 5 * i;
    const dx = (input & RIGHT ? 1 : 0) - (input & LEFT ? 1 : 0);
    const dy = (input & UP ? 1 : 0) - (input & DOWN ? 1 : 0);
    const diag = dx !== 0 && dy !== 0;
    const acc = diag ? ACC_DIAG : ACC;
    s[o + 2] += dx * acc;
    s[o + 3] += dy * acc;
    if (s[o + 4] > 0) s[o + 4]--;
    else if (input & DASH && (dx !== 0 || dy !== 0)) {
        const d = diag ? DASH_DIAG : DASH_SPEED;
        s[o + 2] += dx * d;
        s[o + 3] += dy * d;
        s[o + 4] = DASH_COOLDOWN;
    }
    s[o + 2] = fmul(s[o + 2], PLAYER_DRAG);
    s[o + 3] = fmul(s[o + 3], PLAYER_DRAG);
    s[o] += s[o + 2];
    s[o + 1] += s[o + 3];
    // Each player keeps to its own half.
    const lo = i === 0 ? -HX + PLAYER_R : PLAYER_R;
    const hi = i === 0 ? -PLAYER_R : HX - PLAYER_R;
    const x = clamp(s[o], lo, hi);
    if (x !== s[o]) { s[o] = x; s[o + 2] = 0; }
    const y = clamp(s[o + 1], -HY + PLAYER_R, HY - PLAYER_R);
    if (y !== s[o + 1]) { s[o + 1] = y; s[o + 3] = 0; }
}

/** Puck against the player at offset o: pushed out of the disc, bounced off it as off a moving wall. */
function hit(s: Int32Array, o: number): void {
    const b = BALL;
    const dx = s[b] - s[o], dy = s[b + 1] - s[o + 1];
    const r = PLAYER_R + BALL_R;
    const d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return;
    const d = isqrt(d2);
    const nx = d === 0 ? ONE : fdiv(dx, d);
    const ny = d === 0 ? 0 : fdiv(dy, d);
    s[b] = s[o] + fmul(nx, r);
    s[b + 1] = s[o + 1] + fmul(ny, r);
    const vn = fmul(s[b + 2] - s[o + 2], nx) + fmul(s[b + 3] - s[o + 3], ny);
    if (vn >= 0) return;
    const j = fmul(vn, ONE + HIT_RESTITUTION);
    s[b + 2] -= fmul(j, nx);
    s[b + 3] -= fmul(j, ny);
}

/** FNV-1a over the state's bytes. */
export function checksum(s: Int32Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        const v = s[i];
        h = Math.imul(h ^ (v & 255), 16777619);
        h = Math.imul(h ^ ((v >>> 8) & 255), 16777619);
        h = Math.imul(h ^ ((v >>> 16) & 255), 16777619);
        h = Math.imul(h ^ (v >>> 24), 16777619);
    }
    return h >>> 0;
}
