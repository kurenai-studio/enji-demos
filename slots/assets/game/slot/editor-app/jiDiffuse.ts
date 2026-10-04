/**
 * jiDiffuse — 横栏连续 JI（Bonus）扩散：下方列变成竖 JI（column-fill Bonus）。
 * 帧生成仍写 expandPost；演出改为直接切盘（spine transform 效果差，停用）。
 */

import type { IAnim } from '../common/anim/IAnim.ts';
import { call } from '../common/anim/compose.ts';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import { ensureTopStripSymbols, readFrameExt, writeFrameExt } from '../editor-core/index.ts';
import { serialize, deserialize } from '../vendor/slot-presentation-ir/index.ts';
import { resolveTopBonusColumnWild, type BoardLayoutProfile } from './board-layout/index.ts';
import type { BoardView } from './BoardView.ts';

export interface JiDiffuseContext {
    boardView: BoardView;
    prev: PresentationState;
    curr: PresentationState;
    params: Record<string, unknown>;
}

/** 顶条连续 Bonus≥2 → 应变竖 JI 的主盘列 */
export function resolveJiDiffuseCols(
    profile: BoardLayoutProfile | null | undefined,
    state: PresentationState,
): number[] {
    if (!profile?.topStrip) return [];
    const count = profile.topStrip.count;
    const raw = ensureTopStripSymbols(readFrameExt(state), count).map((v) => (v == null ? 0 : v));
    const hit = resolveTopBonusColumnWild(profile, { topSymbols: raw });
    return hit.triggered ? hit.wildCols.slice() : [];
}

/** 整列写成竖 JI（Bonus @ row0，其余清空） */
export function applyVerticalJiColumn(state: PresentationState, col: number, bonusId: number): void {
    const rows = state.board.topology.visibleRows[col] ?? 0;
    for (let r = 0; r < rows; r++) {
        const cell = state.board.resolved[col]?.[r];
        if (!cell) continue;
        cell.symbolId = r === 0 ? bonusId : null;
        cell.entityRef = null;
    }
}

/** 基于当前帧生成 JI 扩散后的 expandPost 帧；无连续横 JI 则 null */
export function makeJiDiffuseState(
    source: PresentationState,
    profile: BoardLayoutProfile,
): PresentationState | null {
    const cols = resolveJiDiffuseCols(profile, source);
    if (!cols.length) return null;
    const bonusId = profile.roles.bonus;
    const next = deserialize(serialize(source));
    let changed = false;
    for (const col of cols) {
        const rows = next.board.topology.visibleRows[col] ?? 0;
        const before = Array.from({ length: rows }, (_, r) => next.board.resolved[col]?.[r]?.symbolId ?? null);
        applyVerticalJiColumn(next, col, bonusId);
        const after = Array.from({ length: rows }, (_, r) => next.board.resolved[col]?.[r]?.symbolId ?? null);
        if (before.some((v, i) => v !== after[i])) changed = true;
    }
    if (!changed) return null;
    const ext = readFrameExt(next);
    writeFrameExt(next, {
        cascadeIndex: ext?.cascadeIndex ?? 0,
        frameIndex: (ext?.frameIndex ?? 0) + 1,
        frameKind: 'expandPost',
        templateId: 'jiDiffuse',
        topStrip: ext?.topStrip ? ext.topStrip.slice() : ext?.topStrip,
    });
    return next;
}

/** 直接切到 curr（竖 JI 落盘），不播 spine */
export function buildJiDiffuse(ctx: JiDiffuseContext): IAnim {
    const { boardView, curr } = ctx;
    return call(() => {
        boardView.render(curr);
        boardView.getTopStripReelHost()?.landState(curr);
    });
}
