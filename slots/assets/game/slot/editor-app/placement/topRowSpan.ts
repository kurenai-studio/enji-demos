/**
 * top-row-span — 顶条连续 N 格写入同一符号，视觉合并为一格。
 */

import type { PlacementHandler, SymbolPlacementBinding } from './types.ts';
import { RECIPE_TOP_ROW_SPAN } from './types.ts';
import type { SymbolEntry } from '../SymbolDefs.ts';

export const topRowSpanHandler: PlacementHandler = {
    meta: {
        id: RECIPE_TOP_ROW_SPAN,
        label: '顶条横跨 N 格',
        surfaces: ['topStrip'],
    },
    resolve(_entry: SymbolEntry, binding: SymbolPlacementBinding) {
        if (binding.topStripId !== RECIPE_TOP_ROW_SPAN) return null;
        return {
            recipeId: RECIPE_TOP_ROW_SPAN,
            surface: 'topStrip' as const,
            cells: binding.topStripCells,
            variantKey: binding.topStripVariantKey,
        };
    },
};

/** 点击 stripIndex 时的锚点（保证 anchor..anchor+cells-1 不越界） */
export function topRowSpanAnchor(stripIndex: number, stripCount: number, cells: number): number | null {
    const n = Math.max(1, cells | 0);
    if (stripCount < n || stripIndex < 0 || stripIndex >= stripCount) return null;
    return Math.min(stripIndex, stripCount - n);
}

/** 从锚点展开占用下标 */
export function topRowSpanIndices(anchor: number, cells: number): number[] {
    const n = Math.max(1, cells | 0);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(anchor + i);
    return out;
}

/**
 * 若 stripIndex 落在某段「连续同 id 且该 id 为 top-row-span」内，返回该段左锚点。
 * isTopRowSpanId：symbolId → 是否挂了 top-row-span。
 * spanCellsOf：该符号声明的 cells（用于段长；缺省 2）。
 */
export function findTopRowSpanAnchorAt(
    symbols: ReadonlyArray<number | null | undefined>,
    stripIndex: number,
    isTopRowSpanId: (symbolId: number) => boolean,
    spanCellsOf: (symbolId: number) => number,
): number | null {
    if (stripIndex < 0 || stripIndex >= symbols.length) return null;
    const id = symbols[stripIndex] ?? null;
    if (id == null || !isTopRowSpanId(id)) return null;
    const cells = Math.max(1, spanCellsOf(id) | 0);
    // 向左扩到连续同 id 段起点
    let left = stripIndex;
    while (left > 0 && symbols[left - 1] === id) left--;
    // 段内任意点都归到「按 cells 对齐」的锚：left 起每 cells 一截
    const offset = stripIndex - left;
    const anchor = left + Math.floor(offset / cells) * cells;
    if (anchor + cells > symbols.length) return null;
    for (let i = 0; i < cells; i++) {
        if (symbols[anchor + i] !== id) return null;
    }
    return anchor;
}

/** 列出顶条上所有 top-row-span 段的左锚点（不重叠扫描） */
export function listTopRowSpanAnchors(
    symbols: ReadonlyArray<number | null | undefined>,
    isTopRowSpanId: (symbolId: number) => boolean,
    spanCellsOf: (symbolId: number) => number,
): Array<{ anchor: number; symbolId: number; cells: number }> {
    const out: Array<{ anchor: number; symbolId: number; cells: number }> = [];
    let i = 0;
    while (i < symbols.length) {
        const id = symbols[i] ?? null;
        if (id == null || !isTopRowSpanId(id)) {
            i++;
            continue;
        }
        const cells = Math.max(1, spanCellsOf(id) | 0);
        let ok = i + cells <= symbols.length;
        if (ok) {
            for (let k = 1; k < cells; k++) {
                if (symbols[i + k] !== id) {
                    ok = false;
                    break;
                }
            }
        }
        if (ok) {
            out.push({ anchor: i, symbolId: id, cells });
            i += cells;
        } else {
            i++;
        }
    }
    return out;
}
