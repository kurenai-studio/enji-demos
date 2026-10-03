/**
 * One player's machine. Both run the same deterministic game and exchange
 * only inputs. Two ways to cope with the inputs' travel time:
 *
 * - **Lockstep** (delay-based): frame f is simulated once both inputs for f
 *   are in. Local inputs are scheduled `inputDelay` frames ahead; when the
 *   remote input is later than that, the game stalls.
 * - **Rollback** (GGPO style): frame f is simulated straight away, with the
 *   remote input predicted as the last one received. Every frame's start
 *   state is kept. When a remote input arrives that differs from what was
 *   predicted, the game restores the state before that frame and
 *   re-simulates up to the present with the corrected input, all within one
 *   tick. It stalls only when the prediction would run more than
 *   MAX_PREDICTION frames ahead of the last confirmed remote input.
 *
 * Packets carry every local input the peer has not acknowledged, so a lost
 * packet is covered by the next one, plus the checksum of the newest state
 * this side knows is final. The other side compares it with its own: a
 * mismatch means the simulations have diverged (a desync).
 */
import { ONE } from './Fixed';
import { checksum, createState, FRAME, P, STATE_SIZE, step } from './Game';

export type SyncMode = 'rollback' | 'lockstep';

export interface Packet {
    /** Frame of inputs[0]. */
    start: number;
    inputs: number[];
    /** Highest frame up to which the sender has every input of ours. */
    ack: number;
    /** A frame whose state the sender knows is final, and its checksum. */
    checkFrame: number;
    check: number;
}

/** History kept, frames; must exceed the prediction window and the inputs in flight. */
const RING = 256;
/** Rollback predicts at most this many frames past the last confirmed remote input. */
export const MAX_PREDICTION = 8;
/** At most this many inputs per packet. */
const MAX_PACKET_INPUTS = 120;

/** Inputs by frame in a ring; -1 when unknown. */
class InputRing {
    private readonly values = new Int16Array(RING);
    private readonly frames = new Int32Array(RING).fill(-1);

    get(f: number): number {
        const k = f & (RING - 1);
        return this.frames[k] === f ? this.values[k] : -1;
    }

    set(f: number, v: number): void {
        const k = f & (RING - 1);
        this.frames[k] = f;
        this.values[k] = v;
    }
}

export interface PeerStats {
    /** Ticks in which the peer re-simulated, and frames re-simulated in all. */
    rollbacks: number;
    resimulated: number;
    maxDepth: number;
    /** Ticks without advancing a frame. */
    stalls: number;
    /** Frames first simulated with a predicted remote input, and how many of those predictions were wrong. */
    predicted: number;
    mispredicted: number;
    /** How far rollbacks moved the other player on screen (units): largest, and summed. */
    maxCorrection: number;
    sumCorrection: number;
    /** Newest frame whose checksum matched the other side's; first frame found to differ (-1: none). */
    checkedFrame: number;
    desyncFrame: number;
}

export interface PeerOptions {
    mode: SyncMode;
    inputDelay: number;
    seed: number;
    /** Puck drag in floating point (see Game.step): this peer will desync. */
    floatDrag?: boolean;
}

export class Peer {
    readonly id: number;
    readonly options: PeerOptions;
    readonly state: Int32Array;
    /** Next frame to simulate (the state is at its start). */
    frame = 0;
    /** Every remote input up to this frame is known. */
    remoteConfirmed = -1;
    /** Depth of the rollback in the last tick (0: none), how far it moved the other player, and whether the tick stalled. */
    lastDepth = 0;
    lastCorrection = 0;
    lastStalled = false;
    readonly stats: PeerStats = { rollbacks: 0, resimulated: 0, maxDepth: 0, stalls: 0, predicted: 0, mispredicted: 0, maxCorrection: 0, sumCorrection: 0, checkedFrame: -1, desyncFrame: -1 };

    private readonly local = new InputRing();
    private readonly remote = new InputRing();
    /** Remote input each simulated frame used (known or predicted). */
    private readonly used = new InputRing();
    private readonly snapshots: Int32Array[] = [];
    private readonly snapshotFrames = new Int32Array(RING).fill(-1);
    private readonly checks = new Uint32Array(RING);
    private readonly checkFrames = new Int32Array(RING).fill(-1);
    private readonly pendingChecks: { frame: number; check: number }[] = [];
    private newestPendingCheck = -1;
    private localTop: number;
    private peerAck = -1;
    private rollbackFrom = Infinity;

    constructor(id: number, options: PeerOptions) {
        this.id = id;
        this.options = options;
        this.state = createState(options.seed);
        for (let i = 0; i < RING; i++) this.snapshots.push(new Int32Array(STATE_SIZE));
        // The first inputDelay frames have no input yet: nothing pressed.
        for (let f = 0; f < options.inputDelay; f++) this.local.set(f, 0);
        this.localTop = options.inputDelay - 1;
        this.recordCheck(0);
    }

    /** Frames simulated on a predicted remote input. */
    get predictedFrames(): number {
        return Math.max(0, this.frame - 1 - this.remoteConfirmed);
    }

    /** Newest frame whose state is final here: no unconfirmed input before it. */
    get finalFrame(): number {
        return Math.min(this.remoteConfirmed + 1, this.frame);
    }

    /** Checksum of frame f's start state if it is final and still in the history, else -1. */
    checksumAt(f: number): number {
        if (f > this.finalFrame) return -1;
        const k = f & (RING - 1);
        return this.checkFrames[k] === f ? this.checks[k] : -1;
    }

    receive(p: Packet): void {
        const rollback = this.options.mode === 'rollback';
        for (let k = 0; k < p.inputs.length; k++) {
            const f = p.start + k;
            if (f <= this.remoteConfirmed || this.remote.get(f) >= 0) continue;
            const v = p.inputs[k];
            this.remote.set(f, v);
            if (rollback && f < this.frame && this.used.get(f) !== v) {
                this.stats.mispredicted++;
                if (f < this.rollbackFrom) this.rollbackFrom = f;
            }
        }
        while (this.remote.get(this.remoteConfirmed + 1) >= 0) this.remoteConfirmed++;
        if (p.ack > this.peerAck) this.peerAck = p.ack;
        if (p.checkFrame > this.newestPendingCheck) {
            this.newestPendingCheck = p.checkFrame;
            this.pendingChecks.push({ frame: p.checkFrame, check: p.check });
        }
    }

    /**
     * One tick of wall-clock time: re-simulate if a misprediction came in,
     * schedule this tick's local input, then advance a frame unless stalled.
     * Returns the frame the input was scheduled for, or -1 when it was not
     * needed (a stall already has that frame's input).
     */
    tick(localInput: number): number {
        this.lastDepth = 0;
        this.lastCorrection = 0;
        if (this.rollbackFrom < this.frame) {
            const from = this.rollbackFrom;
            const to = this.frame;
            const o = P + 5 * (1 - this.id);
            const ox = this.state[o], oy = this.state[o + 1];
            this.state.set(this.snapshots[from & (RING - 1)]);
            this.frame = from;
            while (this.frame < to) this.simulate(true);
            const depth = to - from;
            this.lastDepth = depth;
            this.stats.rollbacks++;
            this.stats.resimulated += depth;
            if (depth > this.stats.maxDepth) this.stats.maxDepth = depth;
            const moved = Math.hypot(this.state[o] - ox, this.state[o + 1] - oy) / ONE;
            this.lastCorrection = moved;
            this.stats.sumCorrection += moved;
            if (moved > this.stats.maxCorrection) this.stats.maxCorrection = moved;
        }
        this.rollbackFrom = Infinity;

        let scheduled = -1;
        const lf = this.frame + this.options.inputDelay;
        if (this.local.get(lf) < 0) {
            this.local.set(lf, localInput);
            this.localTop = lf;
            scheduled = lf;
        }

        const ready = this.options.mode === 'lockstep'
            ? this.remote.get(this.frame) >= 0
            : this.frame - this.remoteConfirmed <= MAX_PREDICTION;
        this.lastStalled = !ready;
        if (ready) this.simulate(false);
        else this.stats.stalls++;
        this.compareChecks();
        return scheduled;
    }

    packet(): Packet {
        let start = Math.max(this.peerAck + 1, 0);
        const end = Math.min(this.localTop, start + MAX_PACKET_INPUTS - 1);
        const inputs: number[] = [];
        for (let f = start; f <= end; f++) inputs.push(this.local.get(f));
        if (inputs.length === 0) start = this.localTop + 1;
        const checkFrame = this.finalFrame;
        return { start, inputs, ack: this.remoteConfirmed, checkFrame, check: this.checksumAt(checkFrame) };
    }

    private simulate(resim: boolean): void {
        const f = this.frame;
        const k = f & (RING - 1);
        this.snapshots[k].set(this.state);
        this.snapshotFrames[k] = f;
        let r = this.remote.get(f);
        if (r < 0) {
            // Predict: the remote player keeps doing what it last did.
            const last = this.remote.get(this.remoteConfirmed);
            r = last < 0 ? 0 : last;
            if (!resim) this.stats.predicted++;
        }
        this.used.set(f, r);
        const l = this.local.get(f);
        const floatDrag = this.options.floatDrag ?? false;
        if (this.id === 0) step(this.state, l, r, floatDrag);
        else step(this.state, r, l, floatDrag);
        this.frame = this.state[FRAME];
        this.recordCheck(this.frame);
    }

    private recordCheck(f: number): void {
        const k = f & (RING - 1);
        this.checks[k] = checksum(this.state);
        this.checkFrames[k] = f;
    }

    private compareChecks(): void {
        const finalFrame = this.finalFrame;
        for (let i = this.pendingChecks.length - 1; i >= 0; i--) {
            const c = this.pendingChecks[i];
            if (c.frame > finalFrame) continue;
            this.pendingChecks.splice(i, 1);
            const mine = this.checksumAt(c.frame);
            if (mine < 0 || c.check < 0) continue;
            if (mine !== c.check) {
                if (this.stats.desyncFrame < 0 || c.frame < this.stats.desyncFrame) this.stats.desyncFrame = c.frame;
            } else if (c.frame > this.stats.checkedFrame) this.stats.checkedFrame = c.frame;
        }
    }
}
