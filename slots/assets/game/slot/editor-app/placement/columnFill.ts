/**
 * column-fill — 主盘整列占满（一列一个，锚 row0，视觉铺满列高）。
 */

import type { PlacementHandler, SymbolPlacementBinding } from './types.ts';
import { RECIPE_COLUMN_FILL } from './types.ts';
import type { SymbolEntry } from '../SymbolDefs.ts';

export const columnFillHandler: PlacementHandler = {
    meta: {
        id: RECIPE_COLUMN_FILL,
        label: '主盘整列占满',
        surfaces: ['main'],
    },
    resolve(_entry: SymbolEntry, binding: SymbolPlacementBinding) {
        if (binding.mainId !== RECIPE_COLUMN_FILL) return null;
        return { recipeId: RECIPE_COLUMN_FILL, surface: 'main' as const };
    },
};

/** 主盘列内 column-fill 的唯一落点：始终 row0 */
export function columnFillAnchorRow(columnCount: number): number | null {
    if (columnCount <= 0) return null;
    return 0;
}

/**
 * 列内是否已有「挂了 column-fill 的符号」。
 * lookup：用 symbolId → 是否 column-fill（由调用方注入，避免循环依赖 catalog）。
 */
export function findColumnFillRow(
    col: number,
    columnCount: number,
    resolved: ReadonlyArray<ReadonlyArray<{ symbolId: number | null } | null | undefined>>,
    isColumnFillId: (symbolId: number) => boolean,
): number | null {
    for (let r = 0; r < columnCount; r++) {
        const id = resolved[col]?.[r]?.symbolId ?? null;
        if (id != null && isColumnFillId(id)) return r;
    }
    return null;
}
