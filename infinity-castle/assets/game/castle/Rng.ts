/** Small deterministic RNG (mulberry32) so a given depth always builds the same castle. */
export class Rng {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    static forChunk(seed: number, chunk: number): Rng {
        let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(chunk | 0, 0xc2b2ae35);
        h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
        h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
        return new Rng(h ^ (h >>> 16));
    }

    next(): number {
        let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    uniform(a: number, b: number): number {
        return a + (b - a) * this.next();
    }

    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.next() * items.length)];
    }
}
