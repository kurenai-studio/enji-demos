/**
 * Two peers on one machine, joined by two simulated links, advanced in
 * lockstep with wall-clock ticks of 1/60 s. Each tick: deliver the packets
 * that are due, let each peer take its local input (a bot, or the human for
 * peer 0) and tick, then send each peer's packet.
 *
 * The session also keeps a reference: the same game fed every input as soon
 * as its player chose it, as if there were no network. It is what both peers
 * must agree with once their inputs are confirmed (the tests check this), and
 * the view draws it as ghosts to show what prediction got wrong.
 */
import { Bot } from './Bot';
import { checksum, createState, FRAME, STATE_SIZE, step } from './Game';
import { Link, type LinkSettings } from './Link';
import { type Packet, Peer, type SyncMode } from './Peer';

export const TICK_MS = 1000 / 60;
/** Reference states and checksums kept, frames. */
const HISTORY = 1024;

export interface SessionSettings extends LinkSettings {
    mode: SyncMode;
    inputDelay: number;
    seed: number;
    /** Peer 1 computes the puck's drag in floating point and drifts out of sync. */
    floatDrag: boolean;
}

export class Session {
    readonly settings: SessionSettings;
    readonly peers: Peer[];
    readonly links: Link<Packet>[];
    /** Reference state, at frame `reference[FRAME]`. */
    readonly reference: Int32Array;
    ticks = 0;
    now = 0;
    /** Microseconds spent in peer ticks (simulation, rollback and bookkeeping) over all ticks. */
    tickMicros = 0;
    private readonly bots: Bot[];
    private readonly inputs: Map<number, number>[] = [new Map(), new Map()];
    private readonly history: Int32Array[] = [];
    private readonly historyChecks = new Uint32Array(HISTORY);
    private readonly historyFrames = new Int32Array(HISTORY).fill(-1);

    constructor(settings: SessionSettings) {
        this.settings = settings;
        this.peers = [0, 1].map((id) => new Peer(id, {
            mode: settings.mode, inputDelay: settings.inputDelay, seed: settings.seed, floatDrag: id === 1 && settings.floatDrag,
        }));
        this.links = [0, 1].map((i) => new Link<Packet>(settings, settings.seed * 7 + i * 101 + 3));
        this.bots = [0, 1].map((i) => new Bot(i, settings.seed * 13 + i * 31 + 5));
        this.reference = createState(settings.seed);
        for (let i = 0; i < HISTORY; i++) this.history.push(new Int32Array(STATE_SIZE));
        for (let i = 0; i < 2; i++) for (let f = 0; f < settings.inputDelay; f++) this.inputs[i].set(f, 0);
        this.record();
    }

    /** One tick; `human` overrides peer 0's bot when given. */
    tick(human: number | null = null): void {
        this.now += TICK_MS;
        this.ticks++;
        for (let i = 0; i < 2; i++) {
            for (const p of this.links[1 - i].receive(this.now)) this.peers[i].receive(p);
        }
        const t0 = performance.now();
        for (let i = 0; i < 2; i++) {
            const peer = this.peers[i];
            const bot = this.bots[i].next(peer.state);
            const input = i === 0 && human !== null ? human : bot;
            const f = peer.tick(input);
            if (f >= 0) this.inputs[i].set(f, input);
        }
        this.tickMicros += (performance.now() - t0) * 1000;
        for (let i = 0; i < 2; i++) this.links[i].send(this.peers[i].packet(), this.now);
        this.advanceReference();
    }

    /** The reference state at frame f, if it is still in the history. */
    referenceAt(f: number): Int32Array | null {
        const k = f % HISTORY;
        return this.historyFrames[k] === f ? this.history[k] : null;
    }

    referenceChecksum(f: number): number {
        const k = f % HISTORY;
        return this.historyFrames[k] === f ? this.historyChecks[k] : -1;
    }

    private advanceReference(): void {
        const s = this.reference;
        for (;;) {
            const f = s[FRAME];
            const a = this.inputs[0].get(f), b = this.inputs[1].get(f);
            if (a === undefined || b === undefined) return;
            this.inputs[0].delete(f);
            this.inputs[1].delete(f);
            step(s, a, b);
            this.record();
        }
    }

    private record(): void {
        const f = this.reference[FRAME];
        const k = f % HISTORY;
        this.history[k].set(this.reference);
        this.historyChecks[k] = checksum(this.reference);
        this.historyFrames[k] = f;
    }
}
