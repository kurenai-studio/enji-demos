/**
 * One direction of a simulated UDP connection: each packet arrives after the
 * latency plus a uniform random jitter, or is lost. Jitter reorders packets,
 * as on a real network. Seeded, so a session replays the same way.
 */
export interface LinkSettings {
    /** One-way latency, ms. */
    latencyMs: number;
    /** Extra delay, uniform in [0, jitterMs]. */
    jitterMs: number;
    /** Probability that a packet is lost, 0..1. */
    loss: number;
}

export class Link<T> {
    readonly settings: LinkSettings;
    sent = 0;
    lost = 0;
    private readonly queue: { at: number; packet: T }[] = [];
    private seed: number;

    constructor(settings: LinkSettings, seed: number) {
        this.settings = settings;
        this.seed = seed >>> 0 || 1;
    }

    send(packet: T, now: number): void {
        this.sent++;
        if (this.random() < this.settings.loss) {
            this.lost++;
            return;
        }
        this.queue.push({ at: now + this.settings.latencyMs + this.random() * this.settings.jitterMs, packet });
    }

    /** Packets due by `now`, in arrival order. */
    receive(now: number): T[] {
        const due = this.queue.filter((q) => q.at <= now).sort((a, b) => a.at - b.at);
        if (due.length === 0) return [];
        const rest = this.queue.filter((q) => q.at > now);
        this.queue.length = 0;
        this.queue.push(...rest);
        return due.map((q) => q.packet);
    }

    /** mulberry32, in [0, 1). */
    private random(): number {
        let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}
