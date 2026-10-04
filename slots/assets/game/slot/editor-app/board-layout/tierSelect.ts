/**
 * 吕布类 ways 盘面：列内符号个数 → 视觉档 key / 设计高度。
 *
 * mapping（与 static/manifest.json policy 一致）：
 *   columnCount 7→tier-1(112) … 2→tier-6(392)
 */

import type { SymbolEntry, SymbolVisualVariantDef } from '../SymbolDefs.ts';

/** tier-1 .. tier-6 设计高（px） */
export const LVBU_TIER_DESIGN_HEIGHTS: readonly number[] = [112, 130, 156, 196, 262, 392];

export const LVBU_COLUMN_COUNT_MIN = 2;
export const LVBU_COLUMN_COUNT_MAX = 7;

/**
 * 顶条单格设计高：与「主盘一列 4 个符号」同档（tier-4 / 196px），
 * 不是满列 7 个时的 tier-1。
 */
export const LVBU_TOP_STRIP_COLUMN_COUNT = 4;

export function topStripDesignHeight(): number {
    const tier = columnCountToTier(LVBU_TOP_STRIP_COLUMN_COUNT);
    return tier != null ? tierDesignHeight(tier) : tierDesignHeight(4);
}

/** columnCount ∈ [2,7] → tier ∈ [1,6]；否则 null */
export function columnCountToTier(columnCount: number): number | null {
    const n = Math.trunc(Number(columnCount));
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (n < LVBU_COLUMN_COUNT_MIN || n > LVBU_COLUMN_COUNT_MAX) return null;
    return LVBU_COLUMN_COUNT_MAX + 1 - n;
}

export function tierKey(tier: number): string {
    return `tier-${tier}`;
}

export function tierDesignHeight(tier: number): number {
    return LVBU_TIER_DESIGN_HEIGHTS[tier - 1] ?? LVBU_TIER_DESIGN_HEIGHTS[0]!;
}

/** 按列占位选 visualVariants；无匹配则 null（调用方回退基础纹理） */
export function pickVisualVariant(
    entry: SymbolEntry | null | undefined,
    columnCount: number | null | undefined,
): SymbolVisualVariantDef | null {
    if (!entry || columnCount == null) return null;
    const tier = columnCountToTier(columnCount);
    if (tier == null) return null;
    const key = tierKey(tier);
    const variants = entry.visualVariants ?? [];
    return variants.find((v) => v.key === key) ?? null;
}

/** 有档位语义时返回该列格子设计高；否则 null（用库全局 designH） */
export function cellDesignHeightForColumn(columnCount: number): number | null {
    const tier = columnCountToTier(columnCount);
    return tier != null ? tierDesignHeight(tier) : null;
}
