// Turns a ThorMath SpinResult into SPIR frames for BoardDirector:
//   prev board -> dropOut -> dropIn -> (highlight -> vanish -> compact)* ->
//   scatter highlight? -> orb collect?
// Pure TS (no `cc`).

import type { Cell as IrCell, PresentationState, SymbolEntity, WinGroup } from '../slot/vendor/slot-presentation-ir/index.ts';
import type { IrFrameKind } from '../slot/editor-core/frameExt.ts';
import { COLS, ROWS, type Grid, type SpinResult } from './ThorMath.ts';

export interface FrameMark {
    /** Index of the frame in `states`. */
    index: number;
    kind: 'tumble-win' | 'scatter' | 'collect';
    /** Credits won by the frame (tumble wins), for the HUD. */
    amount?: number;
    tumble?: number;
}

export interface SpinFrames {
    states: PresentationState[];
    marks: FrameMark[];
}

function frame(
    grid: (number | null)[][],
    entities: Record<string, SymbolEntity>,
    refs: (string | null)[][],
    kind: IrFrameKind,
    opts: { cascade?: number; index: number; wins?: WinGroup[]; total?: number; mode: 'ng' | 'fg'; templateId?: string; params?: Record<string, unknown> },
): PresentationState {
    const resolved: IrCell[][] = grid.map((col, c) => col.map((id, r) => ({ symbolId: id, entityRef: id === null ? null : refs[c][r] })));
    return {
        version: '0.2.0',
        sessionId: 'thor',
        board: {
            topology: { cols: COLS, visibleRows: Array(COLS).fill(ROWS), extraTop: Array(COLS).fill(0), extraBottom: Array(COLS).fill(0) },
            display: resolved.map((col) => col.map((x) => ({ ...x }))),
            resolved,
            entities,
            anchors: { locks: new Set(), sticks: new Set() },
            overlays: [],
            wins: opts.wins ?? [],
        },
        phase: 'consequence',
        sessionContext: { mode: opts.mode },
        totalWinDisplay: opts.total ?? 0,
        extensions: {
            frame: {
                cascadeIndex: opts.cascade ?? 0,
                frameIndex: opts.index,
                frameKind: kind,
                ...(opts.templateId ? { templateId: opts.templateId } : {}),
                ...(opts.params ? { templateParams: opts.params } : {}),
            },
        },
    } as PresentationState;
}

function snapshot(g: Grid, withMultipliers = true): { ids: number[][]; refs: (string | null)[][]; entities: Record<string, SymbolEntity> } {
    const entities: Record<string, SymbolEntity> = {};
    const refs = g.map((col, c) =>
        col.map((cell, r) => {
            if (!cell.orbId) return null;
            entities[cell.orbId] = {
                id: cell.orbId,
                symbolId: cell.symbolId,
                anchor: { col: c, row: r },
                footprint: [[0, 0]],
                kind: 'multi',
                ...(withMultipliers ? { multiplier: cell.orb } : { meta: { lastMultiplier: cell.orb } }),
            };
            return cell.orbId;
        }),
    );
    return { ids: g.map((col) => col.map((c) => c.symbolId)), refs, entities };
}

export function buildSpinFrames(prev: Grid, r: SpinResult, opts: { skipDropOut?: boolean } = {}): SpinFrames {
    const mode = r.mode === 'free' ? 'fg' : 'ng';
    const states: PresentationState[] = [];
    const marks: FrameMark[] = [];
    const push = (s: PresentationState) => {
        states.push(s);
        return states.length - 1;
    };

    const p = snapshot(prev);
    push(frame(p.ids, p.entities, p.refs, 'spinEnd', { index: 0, mode }));
    if (!opts.skipDropOut) {
        const empty = p.ids.map((col) => col.map(() => null));
        push(frame(empty, {}, p.refs, 'postClear', { index: 1, mode, templateId: 'dropOut', params: { fallDuration: 0.32, rowStagger: 0.03, colStagger: 0.04 } }));
    }
    const s0 = snapshot(r.initial);
    push(frame(s0.ids, s0.entities, s0.refs, 'reveal', { index: states.length, mode, params: { fallDuration: 0.38, rowStagger: 0.05, colStagger: 0.06, bouncePx: 14, bounceDuration: 0.12 } }));

    let total = 0;
    r.tumbles.forEach((t, i) => {
        const cascade = i + 1;
        const g = snapshot(t.grid);
        const wins: WinGroup[] = t.wins.map((w, k) => ({ id: `t${i}w${k}`, kind: 'cluster', cells: w.cells, symbolId: w.symbolId, amount: w.pay }));
        const amount = t.wins.reduce((s, w) => s + w.pay, 0);
        total += amount;
        const hi = push(frame(g.ids, g.entities, g.refs, 'highlight', { cascade, index: states.length, mode, wins, total }));
        marks.push({ index: hi, kind: 'tumble-win', amount, tumble: i });

        const gone = new Set(t.wins.flatMap((w) => w.cells.map((c) => `${c.col},${c.row}`)));
        const cleared = g.ids.map((col, c) => col.map((id, row) => (gone.has(`${c},${row}`) ? null : id)));
        push(frame(cleared, g.entities, g.refs, 'postClear', { cascade, index: states.length, mode, total }));

        const n = snapshot(t.next);
        push(frame(n.ids, n.entities, n.refs, 'compact', { cascade, index: states.length, mode, total, params: { fallDuration: 0.3, bouncePx: 12, bounceDuration: 0.1 } }));
    });

    const fin = snapshot(r.final);
    if (r.freeSpinsAwarded > 0) {
        const wins: WinGroup[] = [{ id: 'scatter', kind: 'scatter', cells: r.scatterCells }];
        const i = push(frame(fin.ids, fin.entities, fin.refs, 'bonus-highlight', { index: states.length, mode, wins, total }));
        marks.push({ index: i, kind: 'scatter' });
    }
    if (r.tumbleWin > 0 && r.orbs.length) {
        const collected = snapshot(r.final, false);
        const i = push(frame(collected.ids, collected.entities, collected.refs, 'multiCollect', { index: states.length, mode, total, params: { stagger: 0.12 } }));
        marks.push({ index: i, kind: 'collect' });
    }
    return { states, marks };
}

/** A single idle frame showing `grid` (first screen). */
export function staticFrame(grid: Grid): PresentationState {
    const s = snapshot(grid);
    return frame(s.ids, s.entities, s.refs, 'spinEnd', { index: 0, mode: 'ng' });
}
