/**
 * 列占满（兼容层）：委托 placement/column-fill。
 * 新代码请用 placement/resolvePlacement + findColumnFillRow / isColumnFillEntry。
 */

import type { BoardLayoutProfile, CellRef } from './BoardLayout.ts';
import { columnFillAnchorRow, findColumnFillRow } from '../placement/index.ts';

export function isTopMappedRef(profile: BoardLayoutProfile, col: number, row: number): boolean {
    return (profile.topStrip?.mapToMain ?? []).some((c: CellRef) => c.col === col && c.row === row);
}

/**
 * @deprecated 请用 isColumnFillEntry(catalog.getEntry(id))
 * 不再按 profile.roles.bonus 猜；无 placement 即非列占满。
 */
export function isColumnSpanSymbol(
    _profile: BoardLayoutProfile | null | undefined,
    _symbolId: number | null | undefined,
): boolean {
    return false;
}

/** 主盘列内 column-fill 落点：始终 row0 */
export function columnSpanAnchorRow(
    _profile: BoardLayoutProfile,
    _col: number,
    columnCount: number,
): number | null {
    return columnFillAnchorRow(columnCount);
}

/**
 * 列内是否已有列占满符号。
 * 必须传入 isColumnFillId（通常基于 placementMainId）；无回调则视为无列占满。
 */
export function findColumnSpanRow(
    _profile: BoardLayoutProfile | null | undefined,
    col: number,
    columnCount: number,
    resolved: ReadonlyArray<ReadonlyArray<{ symbolId: number | null } | null | undefined>>,
    isColumnFillId?: (symbolId: number) => boolean,
): number | null {
    if (!isColumnFillId) return null;
    return findColumnFillRow(col, columnCount, resolved, isColumnFillId);
}
