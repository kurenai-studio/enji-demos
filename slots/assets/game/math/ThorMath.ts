// Pay-anywhere tumble math for the Power of Thor 2 symbol pack. Pure TS (no
// `cc`), so tools/sim.mjs runs the same code under Node to measure RTP.

export const COLS = 6;
export const ROWS = 5;

export const SYM = {
    BONUS: 1,
    SUPER: 2,
    ORB_GREEN: 3,
    ORB_CYAN: 4,
    ORB_PURPLE: 5,
    ORB_RED: 6,
    ORB_WHITE: 7,
    HELMET: 8,
    HAMMER: 9,
    STONE: 10,
    COINS: 11,
    A: 12,
    K: 13,
    Q: 14,
    J: 15,
    TEN: 16,
} as const;

export const isScatter = (id: number) => id === SYM.BONUS || id === SYM.SUPER;
export const isOrb = (id: number) => id >= SYM.ORB_GREEN && id <= SYM.ORB_WHITE;

/** Pay in total-bet multiples for 8-9 / 10-11 / 12+ of a kind anywhere. */
export const PAYTABLE: Record<number, [number, number, number]> = {
    [SYM.HELMET]: [9, 22, 45],
    [SYM.HAMMER]: [2.2, 9, 22],
    [SYM.STONE]: [1.8, 4.5, 13],
    [SYM.COINS]: [1.3, 1.8, 11],
    [SYM.A]: [0.9, 1.3, 9],
    [SYM.K]: [0.7, 1.1, 7],
    [SYM.Q]: [0.45, 0.9, 4.5],
    [SYM.J]: [0.35, 0.8, 3.5],
    [SYM.TEN]: [0.22, 0.65, 1.8],
};
export const MIN_COUNT = 8;

/** Scatter pay in total-bet multiples for 4 / 5 / 6+ scatters. */
export const SCATTER_PAY: [number, number, number] = [3, 5, 100];
export const FREE_SPINS_AWARD = 15;
export const FREE_SPINS_RETRIGGER = 5;
export const SUPER_START_MULTIPLIER = 5;

/** Orb colour by value band; values drawn uniformly from the band. */
export const ORB_VALUES: Record<number, number[]> = {
    [SYM.ORB_GREEN]: [2, 3, 4, 5],
    [SYM.ORB_CYAN]: [6, 8, 10],
    [SYM.ORB_PURPLE]: [12, 15, 20],
    [SYM.ORB_RED]: [25, 50],
    [SYM.ORB_WHITE]: [100, 250, 500],
};

export type Mode = 'base' | 'free';

interface Weights {
    symbols: [number, number][];
    orbChance: number;
    orbs: [number, number][];
    scatterChance: number;
    superShare: number;
}

export const WEIGHTS: Record<Mode, Weights> = {
    base: {
        symbols: [
            [SYM.HELMET, 3],
            [SYM.HAMMER, 5],
            [SYM.STONE, 6],
            [SYM.COINS, 7],
            [SYM.A, 9],
            [SYM.K, 10],
            [SYM.Q, 11],
            [SYM.J, 12],
            [SYM.TEN, 13],
        ],
        orbChance: 0.005,
        orbs: [
            [SYM.ORB_GREEN, 60],
            [SYM.ORB_CYAN, 25],
            [SYM.ORB_PURPLE, 10],
            [SYM.ORB_RED, 4],
            [SYM.ORB_WHITE, 1],
        ],
        scatterChance: 0.017,
        superShare: 0.04,
    },
    free: {
        symbols: [
            [SYM.HELMET, 3],
            [SYM.HAMMER, 5],
            [SYM.STONE, 6],
            [SYM.COINS, 7],
            [SYM.A, 9],
            [SYM.K, 10],
            [SYM.Q, 11],
            [SYM.J, 12],
            [SYM.TEN, 13],
        ],
        orbChance: 0.0285,
        orbs: [
            [SYM.ORB_GREEN, 55],
            [SYM.ORB_CYAN, 27],
            [SYM.ORB_PURPLE, 12],
            [SYM.ORB_RED, 5],
            [SYM.ORB_WHITE, 1],
        ],
        scatterChance: 0.009,
        superShare: 0,
    },
};

export type Rng = () => number;

/** Deterministic PRNG (mulberry32) so a seed replays the same session. */
export function makeRng(seed: number): Rng {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pickWeighted(rng: Rng, table: [number, number][]): number {
    let total = 0;
    for (const [, w] of table) total += w;
    let x = rng() * total;
    for (const [id, w] of table) {
        x -= w;
        if (x < 0) return id;
    }
    return table[table.length - 1][0];
}

export interface Cell {
    symbolId: number;
    /** Orb value; only on orb cells. */
    orb?: number;
    /** Stable id of an orb across tumbles. */
    orbId?: string;
}

export type Grid = Cell[][]; // [col][row], row 0 at the top

export interface WinLine {
    symbolId: number;
    count: number;
    cells: { col: number; row: number }[];
    pay: number;
}

export interface Tumble {
    /** Board before this tumble's wins are removed. */
    grid: Grid;
    wins: WinLine[];
    /** Board after removal + gravity + refill (the next tumble's `grid`). */
    next: Grid;
    /** Per column, how many new symbols dropped in at the top. */
    refillCounts: number[];
}

export interface SpinResult {
    mode: Mode;
    bet: number;
    initial: Grid;
    tumbles: Tumble[];
    final: Grid;
    /** Sum of tumble wins before multipliers (credits). */
    tumbleWin: number;
    scatterCount: number;
    superCount: number;
    scatterCells: { col: number; row: number }[];
    scatterWin: number;
    /** Orbs on the final board, collected when the spin won anything. */
    orbs: { col: number; row: number; value: number; symbolId: number }[];
    orbSum: number;
    /** Multiplier applied to tumbleWin (orb sum, or the free-spin running total). */
    appliedMultiplier: number;
    totalWin: number;
    freeSpinsAwarded: number;
    triggersSuper: boolean;
}

class CellSource {
    private orbSeq = 0;
    private rng: Rng;
    private weights: Weights;
    private tag: string;

    constructor(rng: Rng, weights: Weights, tag: string) {
        this.rng = rng;
        this.weights = weights;
        this.tag = tag;
    }

    next(): Cell {
        const { rng, weights } = this;
        const r = rng();
        if (r < weights.scatterChance) {
            return { symbolId: rng() < weights.superShare ? SYM.SUPER : SYM.BONUS };
        }
        if (r < weights.scatterChance + weights.orbChance) {
            const symbolId = pickWeighted(rng, weights.orbs);
            const band = ORB_VALUES[symbolId];
            return { symbolId, orb: band[Math.floor(rng() * band.length)], orbId: `${this.tag}o${this.orbSeq++}` };
        }
        return { symbolId: pickWeighted(rng, weights.symbols) };
    }
}

const cloneGrid = (g: Grid): Grid => g.map((col) => col.map((c) => ({ ...c })));

function findWins(grid: Grid, bet: number): WinLine[] {
    const byId = new Map<number, { col: number; row: number }[]>();
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const id = grid[c][r].symbolId;
            if (!PAYTABLE[id]) continue;
            let list = byId.get(id);
            if (!list) byId.set(id, (list = []));
            list.push({ col: c, row: r });
        }
    }
    const wins: WinLine[] = [];
    for (const [symbolId, cells] of byId) {
        if (cells.length < MIN_COUNT) continue;
        const tier = cells.length >= 12 ? 2 : cells.length >= 10 ? 1 : 0;
        wins.push({ symbolId, count: cells.length, cells, pay: round2(PAYTABLE[symbolId][tier] * bet) });
    }
    wins.sort((a, b) => b.pay - a.pay);
    return wins;
}

function tumble(grid: Grid, wins: WinLine[], src: CellSource): { next: Grid; refillCounts: number[] } {
    const gone = new Set<string>();
    for (const w of wins) for (const p of w.cells) gone.add(`${p.col},${p.row}`);
    const next: Grid = [];
    const refillCounts: number[] = [];
    for (let c = 0; c < COLS; c++) {
        const kept = grid[c].filter((_, r) => !gone.has(`${c},${r}`)).map((x) => ({ ...x }));
        const fresh: Cell[] = [];
        while (fresh.length + kept.length < ROWS) fresh.push(src.next());
        refillCounts.push(fresh.length);
        next.push([...fresh, ...kept]);
    }
    return { next, refillCounts };
}

export const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * One paid (or free) spin. `runningMultiplier` is the free-spin accumulated
 * multiplier before this spin (ignored in base mode).
 */
export function spin(rng: Rng, bet: number, mode: Mode, runningMultiplier = 0, tag = ''): SpinResult {
    const src = new CellSource(rng, WEIGHTS[mode], tag);
    const initial: Grid = [];
    for (let c = 0; c < COLS; c++) {
        const col: Cell[] = [];
        for (let r = 0; r < ROWS; r++) col.push(src.next());
        initial.push(col);
    }

    const tumbles: Tumble[] = [];
    let grid = initial;
    let tumbleWin = 0;
    for (let i = 0; i < 40; i++) {
        const wins = findWins(grid, bet);
        if (!wins.length) break;
        const { next, refillCounts } = tumble(grid, wins, src);
        tumbles.push({ grid, wins, next, refillCounts });
        for (const w of wins) tumbleWin += w.pay;
        grid = next;
    }
    const final = grid;

    const scatterCells: { col: number; row: number }[] = [];
    let superCount = 0;
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const id = final[c][r].symbolId;
            if (isScatter(id)) {
                scatterCells.push({ col: c, row: r });
                if (id === SYM.SUPER) superCount++;
            }
        }
    }
    const scatterCount = scatterCells.length;
    const scatterWin =
        scatterCount >= 4 ? round2(SCATTER_PAY[Math.min(scatterCount, 6) - 4] * bet) : 0;

    const orbs: SpinResult['orbs'] = [];
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            const cell = final[c][r];
            if (cell.orb) orbs.push({ col: c, row: r, value: cell.orb, symbolId: cell.symbolId });
        }
    }
    const orbSum = orbs.reduce((s, o) => s + o.value, 0);

    let appliedMultiplier = 1;
    if (tumbleWin > 0) {
        if (mode === 'free') {
            const total = runningMultiplier + orbSum;
            appliedMultiplier = Math.max(1, total);
        } else if (orbSum > 0) {
            appliedMultiplier = orbSum;
        }
    }
    const totalWin = round2(tumbleWin * appliedMultiplier + scatterWin);

    let freeSpinsAwarded = 0;
    let triggersSuper = false;
    if (mode === 'base' && scatterCount >= 4) {
        freeSpinsAwarded = FREE_SPINS_AWARD;
        triggersSuper = superCount > 0;
    } else if (mode === 'free' && scatterCount >= 3) {
        freeSpinsAwarded = FREE_SPINS_RETRIGGER;
    }

    return {
        mode,
        bet,
        initial,
        tumbles,
        final,
        tumbleWin: round2(tumbleWin),
        scatterCount,
        superCount,
        scatterCells,
        scatterWin,
        orbs,
        orbSum,
        appliedMultiplier,
        totalWin,
        freeSpinsAwarded,
        triggersSuper,
    };
}

export { cloneGrid };
