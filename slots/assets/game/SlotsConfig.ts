import { Color } from 'cc';

export interface SlotSymbol {
    id: string;
    /** Short face text drawn on the reel cell. */
    face: string;
    color: Color;
    /** Multiplier of bet for three-of-a-kind. */
    payout: number;
}

/** Six distinct symbols; higher payout = rarer feel via equal RNG (demo-fair). */
export const SYMBOLS: readonly SlotSymbol[] = [
    { id: 'cherry', face: 'CH', color: new Color(220, 60, 80, 255), payout: 5 },
    { id: 'lemon', face: 'LM', color: new Color(230, 200, 50, 255), payout: 8 },
    { id: 'orange', face: 'OR', color: new Color(240, 140, 40, 255), payout: 10 },
    { id: 'bell', face: 'BL', color: new Color(255, 210, 80, 255), payout: 15 },
    { id: 'bar', face: 'BAR', color: new Color(100, 160, 255, 255), payout: 25 },
    { id: 'seven', face: '7', color: new Color(255, 60, 60, 255), payout: 50 },
];

export const REEL_COUNT = 3;
export const VISIBLE_ROWS = 3;
export const CELL_W = 110;
export const CELL_H = 100;
export const REEL_GAP = 16;

export const START_CREDITS = 1000;
export const BET_STEPS = [10, 20, 50, 100] as const;
export const DEFAULT_BET_INDEX = 0;

export function randomSymbolIndex(): number {
    return Math.floor(Math.random() * SYMBOLS.length);
}

/** Center-row three-of-a-kind only. */
export function payoutForWindow(centerIds: number[], bet: number): number {
    if (centerIds.length < 3) return 0;
    const a = centerIds[0];
    if (centerIds.every((id) => id === a)) {
        return SYMBOLS[a].payout * bet;
    }
    return 0;
}

export function paytableLines(): string[] {
    return SYMBOLS.map((s) => `${s.face} x3  →  ${s.payout}x`);
}
