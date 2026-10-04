/**
 * compactFall — 压缩补位（compact）。
 *
 * 列内：
 * 1) 存活符号序列保序下沉（纯压缩）
 * 2) 若 curr 在顶部多出新符号（prev 序列是 curr 的后缀），新符从屏外落入
 * 不构成上述关系的列直接切到 curr。
 */

import { Node, UIOpacity, UITransform, Vec3, Tween, tween, view } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call, delay, par, seq, starterAnim } from '../common/anim/compose.ts';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import type { BoardView } from './BoardView.ts';
import type { BoardEvents, BoardEventType } from './boardEvents.ts';
import { readFrameExt } from '../editor-core/index.ts';

export interface CompactFallContext {
    boardView: BoardView;
    prev: PresentationState;
    curr: PresentationState;
    params: Record<string, unknown>;
    events?: BoardEvents;
    frameIndex?: number;
}

interface CellSym {
    row: number;
    id: number;
}

interface CompactMove {
    fromRow: number;
    toRow: number;
    symbolId: number;
}

interface ColPlan {
    col: number;
    moves: CompactMove[];
    /** 顶部新落入的符号（仅出现在 curr） */
    drops: Array<{ row: number; symbolId: number }>;
    invalid?: boolean;
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function ensureOpacity(node: Node): UIOpacity {
    return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
}

function tweenStep(node: Node, setup: (t: Tween<Node>) => Tween<Node>): IAnim {
    return starterAnim((finish) => {
        const t = setup(tween(node)).call(() => finish()).start();
        return () => t.stop();
    });
}

function eventStep(
    ctx: CompactFallContext,
    type: BoardEventType,
    cell?: { col: number; row: number; symbolId: number | null },
): IAnim {
    const ev = ctx.events;
    if (!ev) return call(() => undefined);
    return call(() =>
        ev.emit({
            type,
            frameIndex: ctx.frameIndex ?? -1,
            frameKind: readFrameExt(ctx.curr)?.frameKind ?? null,
            col: cell?.col,
            row: cell?.row,
            symbolId: cell?.symbolId,
        }),
    );
}

function columnSymbols(state: PresentationState, col: number, rows: number): CellSym[] {
    const out: CellSym[] = [];
    for (let r = 0; r < rows; r++) {
        const id = state.board.resolved[col]?.[r]?.symbolId ?? null;
        if (id !== null) out.push({ row: r, id });
    }
    return out;
}

function cellMultiplier(state: PresentationState, col: number, row: number): number | null {
    const cell = state.board.resolved[col]?.[row];
    if (!cell?.entityRef) return null;
    const ent = state.board.entities[cell.entityRef];
    const m = ent?.multiplier;
    return typeof m === 'number' && m > 0 ? m : null;
}

function offscreenTopY(boardView: BoardView): number {
    const ui = boardView.node.getComponent(UITransform);
    const screenTopLocal = ui
        ? ui.convertToNodeSpaceAR(new Vec3(0, view.getVisibleSize().height, 0)).y
        : 400;
    return screenTopLocal + boardView.cellH;
}

/** prev 序列与 curr 对齐：相等=纯压缩；prev 为 curr 后缀=压缩+顶补 */
function planColumn(prev: PresentationState, curr: PresentationState, col: number, rows: number): ColPlan {
    const pv = columnSymbols(prev, col, rows);
    const cv = columnSymbols(curr, col, rows);

    if (pv.length === cv.length && pv.every((s, i) => s.id === cv[i]!.id)) {
        const moves = pv
            .map((s, i) => ({ fromRow: s.row, toRow: cv[i]!.row, symbolId: s.id }))
            .filter((m) => m.fromRow !== m.toRow);
        return { col, moves, drops: [] };
    }

    // curr = [news...] + prevSeq（顶补新符，存活序列保序）
    if (cv.length >= pv.length) {
        const offset = cv.length - pv.length;
        const suffixOk = pv.every((s, i) => s.id === cv[offset + i]!.id);
        if (suffixOk) {
            const moves = pv
                .map((s, i) => ({
                    fromRow: s.row,
                    toRow: cv[offset + i]!.row,
                    symbolId: s.id,
                }))
                .filter((m) => m.fromRow !== m.toRow);
            const drops = cv.slice(0, offset).map((s) => ({ row: s.row, symbolId: s.id }));
            return { col, moves, drops };
        }
    }

    console.warn(`[compactFall] 列 ${col} 前后帧不构成压缩/顶补关系，直接切帧`);
    return { col, moves: [], drops: [], invalid: true };
}

function snapColumn(boardView: BoardView, curr: PresentationState, col: number, rows: number): void {
    for (let r = 0; r < rows; r++) {
        const id = curr.board.resolved[col]?.[r]?.symbolId ?? null;
        boardView.applyCell(col, r, id, cellMultiplier(curr, col, r));
        boardView.getCellNode(col, r)?.setPosition(boardView.cellPosition(col, r));
    }
    boardView.applyColumnSpanVisual(col, curr);
}

export function buildCompactFall(ctx: CompactFallContext): IAnim {
    const { boardView, prev, curr, params } = ctx;
    const maxDur = Math.max(0.05, num(params, 'fallDuration', 0.3));
    const colStagger = Math.max(0, num(params, 'colStagger', 0));
    const bouncePx = Math.max(0, num(params, 'bouncePx', 14));
    const bounceDur = Math.max(0, num(params, 'bounceDuration', 0.1));

    const { cols, visibleRows } = curr.board.topology;
    const plans: ColPlan[] = [];
    for (let c = 0; c < cols; c++) {
        plans.push(planColumn(prev, curr, c, visibleRows[c] ?? 0));
    }

    // 用像素落距统一速度
    let maxDistPx = 1;
    const startY = offscreenTopY(boardView);
    for (const plan of plans) {
        if (plan.invalid) continue;
        for (const m of plan.moves) {
            const from = boardView.cellPosition(plan.col, m.fromRow);
            const to = boardView.cellPosition(plan.col, m.toRow);
            maxDistPx = Math.max(maxDistPx, Math.abs(from.y - to.y));
        }
        for (const d of plan.drops) {
            const to = boardView.cellPosition(plan.col, d.row);
            maxDistPx = Math.max(maxDistPx, Math.abs(startY - to.y));
        }
    }

    const colAnims: IAnim[] = [];
    for (const plan of plans) {
        const c = plan.col;
        const rows = visibleRows[c] ?? 0;
        if (plan.invalid) {
            colAnims.push(call(() => snapColumn(boardView, curr, c, rows)));
            continue;
        }
        if (!plan.moves.length && !plan.drops.length) continue;

        const fallTweens: IAnim[] = [];

        for (const m of plan.moves) {
            const node = boardView.getCellNode(c, m.toRow);
            if (!node) continue;
            const to = boardView.cellPosition(c, m.toRow);
            const from = boardView.cellPosition(c, m.fromRow);
            const dist = Math.abs(from.y - to.y);
            const dur = maxDur * (dist / maxDistPx);
            fallTweens.push(
                seq(
                    tweenStep(node, (t) => {
                        let tw = t.to(dur, { position: new Vec3(to.x, to.y, 0) }, { easing: 'quadIn' });
                        if (bouncePx > 0 && bounceDur > 0) {
                            tw = tw
                                .to(
                                    bounceDur * 0.5,
                                    { position: new Vec3(to.x, to.y + bouncePx, 0) },
                                    { easing: 'quadOut' },
                                )
                                .to(bounceDur * 0.5, { position: new Vec3(to.x, to.y, 0) }, { easing: 'quadIn' });
                        }
                        return tw;
                    }),
                    eventStep(ctx, 'symbol-land', { col: c, row: m.toRow, symbolId: m.symbolId }),
                ),
            );
        }

        for (const d of plan.drops) {
            const node = boardView.getCellNode(c, d.row);
            if (!node) continue;
            const to = boardView.cellPosition(c, d.row);
            const dist = Math.abs(startY - to.y);
            const dur = maxDur * (dist / maxDistPx);
            fallTweens.push(
                seq(
                    tweenStep(node, (t) => {
                        let tw = t.to(dur, { position: new Vec3(to.x, to.y, 0) }, { easing: 'quadIn' });
                        if (bouncePx > 0 && bounceDur > 0) {
                            tw = tw
                                .to(
                                    bounceDur * 0.5,
                                    { position: new Vec3(to.x, to.y + bouncePx, 0) },
                                    { easing: 'quadOut' },
                                )
                                .to(bounceDur * 0.5, { position: new Vec3(to.x, to.y, 0) }, { easing: 'quadIn' });
                        }
                        return tw;
                    }),
                    eventStep(ctx, 'symbol-land', { col: c, row: d.row, symbolId: d.symbolId }),
                ),
            );
        }

        colAnims.push(
            seq(
                delay(c * colStagger),
                call(() => {
                    const toRows = new Set(plan.moves.map((m) => m.toRow));
                    const dropRows = new Set(plan.drops.map((d) => d.row));

                    // 只清「将空出」的源格；底部静止格绝不动
                    for (const m of plan.moves) {
                        if (!toRows.has(m.fromRow) && !dropRows.has(m.fromRow)) {
                            boardView.applyCell(c, m.fromRow, null);
                            const n = boardView.getCellNode(c, m.fromRow);
                            if (n) n.setPosition(boardView.cellPosition(c, m.fromRow));
                        }
                    }
                    for (let r = 0; r < rows; r++) {
                        const prevId = prev.board.resolved[c]?.[r]?.symbolId ?? null;
                        const currId = curr.board.resolved[c]?.[r]?.symbolId ?? null;
                        if (prevId != null && currId == null && !dropRows.has(r) && !toRows.has(r)) {
                            boardView.applyCell(c, r, null);
                            const n = boardView.getCellNode(c, r);
                            if (n) n.setPosition(boardView.cellPosition(c, r));
                        }
                    }

                    for (const m of plan.moves) {
                        boardView.applyCell(c, m.toRow, m.symbolId, cellMultiplier(curr, c, m.toRow));
                        const from = boardView.cellPosition(c, m.fromRow);
                        const n = boardView.getCellNode(c, m.toRow);
                        if (n) {
                            n.setPosition(from.x, from.y, 0);
                            ensureOpacity(n).opacity = 255;
                            n.active = true;
                        }
                    }
                    for (const d of plan.drops) {
                        boardView.applyCell(c, d.row, d.symbolId, cellMultiplier(curr, c, d.row));
                        const n = boardView.getCellNode(c, d.row);
                        if (n) {
                            const to = boardView.cellPosition(c, d.row);
                            n.setPosition(to.x, startY, 0);
                            ensureOpacity(n).opacity = 255;
                            n.active = true;
                        }
                    }
                }),
                fallTweens.length ? par(...fallTweens) : call(() => undefined),
                call(() => {
                    // 只归位参与动画的格；静止格保持原样
                    for (const m of plan.moves) {
                        const n = boardView.getCellNode(c, m.toRow);
                        if (n) {
                            n.setPosition(boardView.cellPosition(c, m.toRow));
                            ensureOpacity(n).opacity = 255;
                        }
                    }
                    for (const d of plan.drops) {
                        const n = boardView.getCellNode(c, d.row);
                        if (n) {
                            n.setPosition(boardView.cellPosition(c, d.row));
                            ensureOpacity(n).opacity = 255;
                        }
                    }
                    for (const m of plan.moves) {
                        const stillNeeded = plan.moves.some((x) => x.toRow === m.fromRow)
                            || plan.drops.some((x) => x.row === m.fromRow);
                        if (!stillNeeded && (curr.board.resolved[c]?.[m.fromRow]?.symbolId ?? null) == null) {
                            const n = boardView.getCellNode(c, m.fromRow);
                            if (n) n.setPosition(boardView.cellPosition(c, m.fromRow));
                        }
                    }
                    boardView.applyColumnSpanVisual(c, curr);
                }),
            ),
        );
    }

    if (!colAnims.length) {
        return call(() => {
            for (let c = 0; c < cols; c++) snapColumn(boardView, curr, c, visibleRows[c] ?? 0);
        });
    }
    return par(...colAnims);
}
