/**
 * Placement Recipe — 可复用落盘逻辑包。
 * 符号通过 placementMainId / placementTopStripId 引用；盘面只查 PLACEMENT_INDEX。
 */

import type { SymbolEntry } from '../SymbolDefs.ts';

/** 落点表面 */
export type PlacementSurface = 'main' | 'topStrip';

/** 符号上挂的落盘绑定（可序列化进 prefab / draft） */
export interface SymbolPlacementBinding {
    /** 主盘 recipeId；空 = 普通单格 */
    mainId: string;
    /** 顶条 recipeId；空 = 普通单格 */
    topStripId: string;
    /** top-row-span 格数 */
    topStripCells: number;
    /** 顶条显示用 visualVariant.key */
    topStripVariantKey: string;
}

export const EMPTY_PLACEMENT_BINDING: SymbolPlacementBinding = {
    mainId: '',
    topStripId: '',
    topStripCells: 2,
    topStripVariantKey: '',
};

/** recipe 元数据（索引目录用） */
export interface PlacementRecipeMeta {
    id: string;
    label: string;
    surfaces: readonly PlacementSurface[];
}

/** 主盘 column-fill 解析结果 */
export interface ColumnFillResolved {
    recipeId: 'column-fill';
    surface: 'main';
}

/** 顶条 row-span 解析结果 */
export interface TopRowSpanResolved {
    recipeId: 'top-row-span';
    surface: 'topStrip';
    cells: number;
    variantKey: string;
}

export type ResolvedPlacement = ColumnFillResolved | TopRowSpanResolved;

export type PlacementHandler = {
    meta: PlacementRecipeMeta;
    /** 从符号绑定解析出本 surface 的参数；非法则 null */
    resolve(entry: SymbolEntry, binding: SymbolPlacementBinding): ResolvedPlacement | null;
};

export function readPlacementBinding(entry: SymbolEntry | null | undefined): SymbolPlacementBinding {
    if (!entry) return { ...EMPTY_PLACEMENT_BINDING };
    return {
        mainId: (entry.placementMainId || '').trim(),
        topStripId: (entry.placementTopStripId || '').trim(),
        topStripCells: Math.max(1, (entry.placementTopStripCells | 0) || 2),
        topStripVariantKey: (entry.placementTopStripVariantKey || '').trim(),
    };
}

/** 内置 recipe id 常量 */
export const RECIPE_COLUMN_FILL = 'column-fill';
export const RECIPE_TOP_ROW_SPAN = 'top-row-span';

/** 索引里已注册的 recipe 列表（符号编辑循环用） */
export const PLACEMENT_RECIPE_IDS = [RECIPE_COLUMN_FILL, RECIPE_TOP_ROW_SPAN] as const;
