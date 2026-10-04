/**
 * SymbolDraft — H5 符号表可序列化草稿（只存 id 引用 + 动画名，不嵌 UUID）。
 * 运行时经 AssetLibrary 解析成 SymbolEntry 供预览墙 / 盘面使用。
 */

import {
    DESIGN_CELL_H,
    DESIGN_CELL_W,
    SymbolEntry,
    SymbolKind,
    SymbolVisualVariantDef,
} from './SymbolDefs.ts';
import type { AssetProvider } from './AssetDefs.ts';
import { resolveSymbolEntry } from './SymbolResolve.ts';

export interface SymbolDraft {
    id: number;
    name: string;
    kind: SymbolKind;
    textureAssetId: string;
    spineAssetId: string;
    prefabAssetId: string;
    /** 同一逻辑符号的视觉变体；选择规则由盘面 profile / placement 决定。 */
    visualVariants: SymbolVisualVariantDraft[];
    /** 主盘落盘 recipeId；空=普通单格 */
    placementMainId: string;
    /** 顶条落盘 recipeId；空=普通单格 */
    placementTopStripId: string;
    placementTopStripCells: number;
    placementTopStripVariantKey: string;
    enterSoundAssetId: string;
    winSoundAssetId: string;
    vanishSoundAssetId: string;
    digitFontAssetId: string;
    winCellFxAssetId: string;
    vanishCellFxAssetId: string;
    idleAnim: string;
    enterAnim: string;
    winAnim: string;
    vanishAnim: string;
    /** spine skin（AKQJ 等共用骨骼时用） */
    spineSkin: string;
    scaleMul: number;
}

export interface SymbolVisualVariantDraft {
    key: string;
    label: string;
    textureAssetId: string;
    spineAssetId: string;
    prefabAssetId: string;
}

export interface SymbolSheetDoc {
    docVersion: 1;
    packId: string;
    zone: string;
    symbols: SymbolDraft[];
    updatedAt: string;
    /** 包级通用中奖高亮（所有符号默认） */
    winCellFxAssetId?: string;
    /** 包级通用消除特效 */
    vanishCellFxAssetId?: string;
    /**
     * 包级盘面/格子布局（原 Creator Inspector：symbolWidth/Height、行列距、FX scale）。
     * H5 符号编辑器为唯一编辑入口；运行时叠加到 SymbolLibrary 内存。
     */
    packLayout?: PackLayoutConfig;
}

/** 不等高列在整盘高度内的垂直对齐 */
export type ColumnVAlign = 'top' | 'center' | 'bottom';

export const COLUMN_VALIGN_CYCLE: readonly ColumnVAlign[] = ['top', 'center', 'bottom'];

export function columnVAlignLabel(v: ColumnVAlign): string {
    if (v === 'center') return '中心';
    if (v === 'bottom') return '底对齐';
    return '顶对齐';
}

export function normalizeColumnVAlign(raw: unknown): ColumnVAlign {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'center' || s === 'middle') return 'center';
    if (s === 'bottom') return 'bottom';
    return 'top';
}

/** 包级布局（设计格 / 间距 / 格子特效缩放 / 列对齐）— 只在 H5 编辑 */
export interface PackLayoutConfig {
    designW: number;
    designH: number;
    boardColGap: number;
    boardRowGap: number;
    lockBoardColGap: boolean;
    lockBoardRowGap: boolean;
    /** 包级 winCellFx.scale */
    winCellFxScale: number;
    /** 包级 vanishCellFx.scale */
    vanishCellFxScale: number;
    /**
     * 不等高列垂直对齐：顶 / 中 / 底。
     * 等高矩形盘三种效果相同；ways 菱形盘（如赏金猎人）才看得出差别。
     */
    columnVAlign: ColumnVAlign;
}

export function defaultPackLayout(): PackLayoutConfig {
    return {
        designW: DESIGN_CELL_W,
        designH: DESIGN_CELL_H,
        boardColGap: 2,
        boardRowGap: 2,
        lockBoardColGap: false,
        lockBoardRowGap: false,
        winCellFxScale: 1,
        vanishCellFxScale: 1,
        columnVAlign: 'top',
    };
}

export function normalizePackLayout(raw: Partial<PackLayoutConfig> | null | undefined): PackLayoutConfig {
    const d = defaultPackLayout();
    if (!raw) return d;
    return {
        designW: Math.max(32, Math.round(Number(raw.designW) || d.designW)),
        designH: Math.max(32, Math.round(Number(raw.designH) || d.designH)),
        boardColGap: Math.round(Number(raw.boardColGap) || 0),
        boardRowGap: Math.round(Number(raw.boardRowGap) || 0),
        lockBoardColGap: !!raw.lockBoardColGap,
        lockBoardRowGap: !!raw.lockBoardRowGap,
        winCellFxScale: Math.max(0.1, Math.round((Number(raw.winCellFxScale) || d.winCellFxScale) * 100) / 100),
        vanishCellFxScale: Math.max(
            0.1,
            Math.round((Number(raw.vanishCellFxScale) || d.vanishCellFxScale) * 100) / 100,
        ),
        columnVAlign: normalizeColumnVAlign((raw as PackLayoutConfig).columnVAlign),
    };
}

export function draftFromEntry(e: SymbolEntry): SymbolDraft {
    return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        textureAssetId: e.textureAssetId || '',
        spineAssetId: e.spineAssetId || '',
        prefabAssetId: e.prefabAssetId || '',
        visualVariants: (e.visualVariants ?? []).map((variant) => ({
            key: variant.key || '',
            label: variant.label || '',
            textureAssetId: variant.textureAssetId || '',
            spineAssetId: variant.spineAssetId || '',
            prefabAssetId: variant.prefabAssetId || '',
        })),
        placementMainId: e.placementMainId || '',
        placementTopStripId: e.placementTopStripId || '',
        placementTopStripCells: Math.max(1, e.placementTopStripCells | 0 || 2),
        placementTopStripVariantKey: e.placementTopStripVariantKey || '',
        enterSoundAssetId: e.enterSoundAssetId || '',
        winSoundAssetId: e.winSoundAssetId || '',
        vanishSoundAssetId: e.vanishSoundAssetId || '',
        digitFontAssetId: e.digitFontAssetId || '',
        winCellFxAssetId: e.winCellFxAssetId || '',
        vanishCellFxAssetId: e.vanishCellFxAssetId || '',
        idleAnim: e.idleAnim || '',
        enterAnim: e.enterAnim || '',
        winAnim: e.winAnim || '',
        vanishAnim: e.vanishAnim || '',
        spineSkin: e.spineSkin || '',
        scaleMul: e.scaleMul > 0 ? e.scaleMul : 1,
    };
}

export function entryFromDraft(d: SymbolDraft): SymbolEntry {
    const e = new SymbolEntry();
    e.id = d.id;
    e.name = d.name;
    e.kind = d.kind;
    e.textureAssetId = d.textureAssetId;
    e.spineAssetId = d.spineAssetId;
    e.prefabAssetId = d.prefabAssetId;
    e.visualVariants = (d.visualVariants ?? []).map((variant) => {
        const def = new SymbolVisualVariantDef();
        def.key = variant.key;
        def.label = variant.label;
        def.textureAssetId = variant.textureAssetId;
        def.spineAssetId = variant.spineAssetId;
        def.prefabAssetId = variant.prefabAssetId;
        return def;
    });
    e.placementMainId = d.placementMainId || '';
    e.placementTopStripId = d.placementTopStripId || '';
    e.placementTopStripCells = Math.max(1, d.placementTopStripCells | 0 || 2);
    e.placementTopStripVariantKey = d.placementTopStripVariantKey || '';
    e.enterSoundAssetId = d.enterSoundAssetId;
    e.winSoundAssetId = d.winSoundAssetId;
    e.vanishSoundAssetId = d.vanishSoundAssetId;
    e.digitFontAssetId = d.digitFontAssetId;
    e.winCellFxAssetId = d.winCellFxAssetId;
    e.vanishCellFxAssetId = d.vanishCellFxAssetId;
    e.idleAnim = d.idleAnim;
    e.enterAnim = d.enterAnim;
    e.winAnim = d.winAnim;
    e.vanishAnim = d.vanishAnim;
    e.spineSkin = d.spineSkin || '';
    e.scaleMul = d.scaleMul > 0 ? d.scaleMul : 1;
    return e;
}

/**
 * 旧包无 assetId、只有直接引用时：把当前解析结果的直接引用抄到 entry，
 * 再叠加草稿字段（H5 仍可预览；导出 sheet 不带 UUID，需素材库才可迁移）。
 *
 * 空串 assetId = 用户明确清空，禁止再从库表 fallback 抄回 spine/贴图（否则「去掉 Spine」不生效）。
 */
export function resolveDraft(d: SymbolDraft, assets: AssetProvider | null, fallback?: SymbolEntry | null): SymbolEntry {
    const e = entryFromDraft(d);
    if (fallback) {
        // 有素材库：只按 assetId 解析；空 id 表示清除，不抄 fallback 直接引用
        // 无素材库（旧包）：才把 fallback 的直接引用补上
        if (!assets) {
            if (!e.texture) e.texture = fallback.texture;
            if (!e.spine) e.spine = fallback.spine;
            if (!e.prefab) e.prefab = fallback.prefab;
            if (!e.enterSound) e.enterSound = fallback.enterSound;
            if (!e.winSound) e.winSound = fallback.winSound;
            if (!e.vanishSound) e.vanishSound = fallback.vanishSound;
            if (!e.digitFont) e.digitFont = fallback.digitFont;
            for (const variant of e.visualVariants) {
                const source = fallback.visualVariants?.find((candidate) => candidate.key === variant.key);
                if (!source) continue;
                if (!variant.texture) variant.texture = source.texture;
                if (!variant.spine) variant.spine = source.spine;
                if (!variant.prefab) variant.prefab = source.prefab;
            }
        }
    }
    return resolveSymbolEntry(e, assets);
}

export function makeEmptyDraft(id: number): SymbolDraft {
    return {
        id,
        name: `symbol_${id}`,
        kind: SymbolKind.normal,
        textureAssetId: '',
        spineAssetId: '',
        prefabAssetId: '',
        visualVariants: [],
        placementMainId: '',
        placementTopStripId: '',
        placementTopStripCells: 2,
        placementTopStripVariantKey: '',
        enterSoundAssetId: '',
        winSoundAssetId: '',
        vanishSoundAssetId: '',
        digitFontAssetId: '',
        winCellFxAssetId: '',
        vanishCellFxAssetId: '',
        idleAnim: '',
        enterAnim: '',
        winAnim: '',
        vanishAnim: '',
        spineSkin: '',
        scaleMul: 1,
    };
}

export function serializeSheet(doc: SymbolSheetDoc, space = 2): string {
    return JSON.stringify(doc, null, space);
}

export function parseSheet(json: string): SymbolSheetDoc {
    const raw = JSON.parse(json) as SymbolSheetDoc;
    if (!raw || raw.docVersion !== 1 || !Array.isArray(raw.symbols)) {
        throw new Error('不是合法 SymbolSheetDoc');
    }
    raw.symbols = raw.symbols.map((symbol) => ({
        ...symbol,
        visualVariants: Array.isArray(symbol.visualVariants) ? symbol.visualVariants : [],
    }));
    if (raw.packLayout) raw.packLayout = normalizePackLayout(raw.packLayout);
    return raw;
}

/** SymbolEditor / BoardEditor 共用的本地符号草稿键前缀 */
export const SYMBOL_SHEET_STORE_PREFIX = 'symbolEditor.symbolSheet.';

/** 读 SymbolEditor 持久化的符号表草稿（盘面切回时叠加到 catalog） */
export function loadSymbolSheetDoc(packId: string): SymbolSheetDoc | null {
    if (!packId) return null;
    try {
        const raw = localStorage.getItem(SYMBOL_SHEET_STORE_PREFIX + packId);
        if (!raw) return null;
        const doc = parseSheet(raw);
        if (doc.packId !== packId || !doc.symbols.length) return null;
        return doc;
    } catch {
        return null;
    }
}

/** 写回 SymbolEditor 共用草稿（BoardEditor 改间距等也走这里） */
export function saveSymbolSheetDoc(doc: SymbolSheetDoc): void {
    if (!doc?.packId || !doc.symbols?.length) return;
    if (doc.packLayout) doc.packLayout = normalizePackLayout(doc.packLayout);
    try {
        localStorage.setItem(SYMBOL_SHEET_STORE_PREFIX + doc.packId, serializeSheet(doc, 0));
    } catch {
        /* ignore */
    }
}
