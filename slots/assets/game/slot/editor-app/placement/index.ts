/**
 * PLACEMENT_INDEX — 落盘 recipe 编译索引。
 * 新符号复用：挂同一 recipeId，无需改 BoardEditor 分支。
 */

import type { SymbolEntry } from '../SymbolDefs.ts';
import { columnFillHandler } from './columnFill.ts';
import { topRowSpanHandler } from './topRowSpan.ts';
import type {
    PlacementHandler,
    PlacementRecipeMeta,
    PlacementSurface,
    ResolvedPlacement,
    SymbolPlacementBinding,
} from './types.ts';
import {
    PLACEMENT_RECIPE_IDS,
    RECIPE_COLUMN_FILL,
    RECIPE_TOP_ROW_SPAN,
    readPlacementBinding,
} from './types.ts';

const HANDLERS: Record<string, PlacementHandler> = {
    [RECIPE_COLUMN_FILL]: columnFillHandler,
    [RECIPE_TOP_ROW_SPAN]: topRowSpanHandler,
};

/** 编译索引：recipeId → handler */
export const PLACEMENT_INDEX: Readonly<Record<string, PlacementHandler>> = HANDLERS;

export function listPlacementRecipes(): PlacementRecipeMeta[] {
    return PLACEMENT_RECIPE_IDS.map((id) => HANDLERS[id]!.meta);
}

export function getPlacementHandler(recipeId: string): PlacementHandler | null {
    return HANDLERS[recipeId] ?? null;
}

/**
 * 盘面唯一入口：按表面解析符号落盘规则。
 * 无绑定 / 未知 id → null（走普通单格）。
 */
export function resolvePlacement(
    entry: SymbolEntry | null | undefined,
    surface: PlacementSurface,
    binding?: SymbolPlacementBinding,
): ResolvedPlacement | null {
    if (!entry) return null;
    const b = binding ?? readPlacementBinding(entry);
    const recipeId = surface === 'main' ? b.mainId : b.topStripId;
    if (!recipeId) return null;
    const handler = HANDLERS[recipeId];
    if (!handler) return null;
    if (!handler.meta.surfaces.includes(surface)) return null;
    return handler.resolve(entry, b);
}

export function isPlacementSymbol(
    entry: SymbolEntry | null | undefined,
    surface: PlacementSurface,
): boolean {
    return resolvePlacement(entry, surface) != null;
}

export function isColumnFillEntry(entry: SymbolEntry | null | undefined): boolean {
    return resolvePlacement(entry, 'main')?.recipeId === RECIPE_COLUMN_FILL;
}

export function isTopRowSpanEntry(entry: SymbolEntry | null | undefined): boolean {
    return resolvePlacement(entry, 'topStrip')?.recipeId === RECIPE_TOP_ROW_SPAN;
}

export {
    RECIPE_COLUMN_FILL,
    RECIPE_TOP_ROW_SPAN,
    PLACEMENT_RECIPE_IDS,
    readPlacementBinding,
};
export type {
    PlacementSurface,
    ResolvedPlacement,
    SymbolPlacementBinding,
    PlacementRecipeMeta,
} from './types.ts';
export {
    columnFillAnchorRow,
    findColumnFillRow,
} from './columnFill.ts';
export {
    topRowSpanAnchor,
    topRowSpanIndices,
    findTopRowSpanAnchorAt,
    listTopRowSpanAnchors,
} from './topRowSpan.ts';
