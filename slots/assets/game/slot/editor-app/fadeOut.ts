/**
 * fadeOut — 淡出消除（postClear）。
 * 主盘 + 顶条：符号 content 透明度→0，略缩小。
 */

import { Node, UIOpacity, Vec3, tween } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call, delay, par, seq, starterAnim } from '../common/anim/compose.ts';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import { ensureTopStripSymbols, readFrameExt } from '../editor-core/index.ts';
import type { BoardView } from './BoardView.ts';
import type { SymbolView } from './SymbolView.ts';
import type { BoardEvents, BoardEventType } from './boardEvents.ts';

export interface FadeOutContext {
    boardView: BoardView;
    prev: PresentationState;
    curr: PresentationState;
    params: Record<string, unknown>;
    events?: BoardEvents;
    frameIndex?: number;
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function eventStep(
    ctx: FadeOutContext,
    type: BoardEventType,
    cell?: { col: number; row: number; symbolId: number | null },
): IAnim {
    const ev = ctx.events;
    if (!ev) return call(() => undefined);
    return call(() =>
        ev.emit({
            type,
            frameIndex: ctx.frameIndex ?? 0,
            frameKind: readFrameExt(ctx.curr)?.frameKind ?? null,
            col: cell?.col,
            row: cell?.row,
            symbolId: cell?.symbolId ?? null,
        }),
    );
}

function fadeContent(view: SymbolView | null, node: Node | null, dur: number, scaleTo: number): IAnim {
    return starterAnim((finish) => {
        const content = view?.contentNode ?? null;
        const target = content?.isValid ? content : node;
        if (!target?.isValid) {
            finish();
            return () => undefined;
        }
        const op = target.getComponent(UIOpacity) ?? target.addComponent(UIOpacity);
        const base = target.scale.clone();
        const toScale = new Vec3(base.x * scaleTo, base.y * scaleTo, base.z);
        let completed = false;
        const t1 = tween(target).to(dur, { scale: toScale }, { easing: 'quadIn' }).start();
        const t2 = tween(op)
            .to(dur, { opacity: 0 }, { easing: 'quadIn' })
            .call(() => {
                completed = true;
                finish();
            })
            .start();
        return () => {
            t1.stop();
            t2.stop();
            if (!completed) finish();
        };
    });
}

function resetNodeVisual(view: SymbolView | null, node: Node | null): void {
    const content = view?.contentNode;
    if (content?.isValid) {
        content.setScale(1, 1, 1);
        const op = content.getComponent(UIOpacity);
        if (op) op.opacity = 255;
    }
    if (node?.isValid) {
        node.setScale(1, 1, 1);
        const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
        op.opacity = 255;
    }
}

interface GoneMain {
    col: number;
    row: number;
    symbolId: number;
}

interface GoneTop {
    index: number;
    symbolId: number;
}

function collectMainGone(prev: PresentationState, curr: PresentationState): GoneMain[] {
    const out: GoneMain[] = [];
    const { cols, visibleRows } = prev.board.topology;
    for (let c = 0; c < cols; c++) {
        const prevRows = visibleRows[c] ?? 0;
        const currRows = curr.board.topology.visibleRows[c] ?? 0;
        const maxR = Math.max(prevRows, currRows);
        for (let r = 0; r < maxR; r++) {
            const prevId = prev.board.resolved[c]?.[r]?.symbolId ?? null;
            const currId = r < currRows ? (curr.board.resolved[c]?.[r]?.symbolId ?? null) : null;
            if (prevId != null && currId === null) {
                out.push({ col: c, row: r, symbolId: prevId });
            }
        }
    }
    return out;
}

function collectTopGone(prev: PresentationState, curr: PresentationState, count: number): GoneTop[] {
    const a = ensureTopStripSymbols(readFrameExt(prev), count);
    const b = ensureTopStripSymbols(readFrameExt(curr), count);
    const out: GoneTop[] = [];
    for (let i = 0; i < count; i++) {
        const p = a[i] ?? null;
        const q = b[i] ?? null;
        if (p != null && q === null) out.push({ index: i, symbolId: p });
    }
    return out;
}

/** 供 animTemplates 注册 */
export function buildFadeOut(ctx: FadeOutContext): IAnim {
    const dur = Math.max(0.05, num(ctx.params, 'duration', 0.28));
    const stagger = Math.max(0, num(ctx.params, 'stagger', 0.02));
    const scaleTo = Math.min(1, Math.max(0.5, num(ctx.params, 'scaleTo', 0.88)));

    const { boardView, prev, curr } = ctx;
    const fadeSteps: IAnim[] = [];

    const mainGone = collectMainGone(prev, curr);
    mainGone.forEach((g, i) => {
        const node = boardView.getCellNode(g.col, g.row);
        const view = boardView.getSymbolView(g.col, g.row);
        if (!node) return;
        fadeSteps.push(
            seq(
                delay(i * stagger),
                eventStep(ctx, 'symbol-vanish', { col: g.col, row: g.row, symbolId: g.symbolId }),
                fadeContent(view, node, dur, scaleTo),
                call(() => {
                    boardView.applyCell(g.col, g.row, null);
                    resetNodeVisual(view, node);
                }),
            ),
        );
    });

    const topHost = boardView.getTopStripReelHost();
    let topNeedsLand = false;
    if (topHost?.root?.isValid && topHost.count > 0) {
        const topGone = collectTopGone(prev, curr, topHost.count);
        topGone.forEach((g, i) => {
            const node = topHost.getCellNode(g.index);
            const view = topHost.getSymbolView(g.index);
            if (!node?.isValid) return;
            topNeedsLand = true;
            fadeSteps.push(
                seq(
                    delay(i * stagger),
                    fadeContent(view, node, dur, scaleTo),
                    call(() => resetNodeVisual(view, node)),
                ),
            );
        });
    }

    const finalize = call(() => {
        for (let c = 0; c < curr.board.topology.cols; c++) {
            boardView.applyColumnSpanVisual(c, curr);
        }
        if (topNeedsLand) topHost?.landState(curr);
    });

    if (fadeSteps.length === 0) return finalize;
    return seq(par(...fadeSteps), finalize);
}
