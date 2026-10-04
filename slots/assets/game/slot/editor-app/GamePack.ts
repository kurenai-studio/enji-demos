/**
 * SymbolPack — 符号包注册表（按 Spine 区分区，不再按「游戏」）。
 *
 * 资源约定：
 *   assets/resources/<spine-3.8|spine-4.2>/packs/<packId>/
 *     asset-library.prefab   # 素材库（最小单位：纹理/spine/音频/特效…）
 *     symbol-library.prefab  # 符号表（引用素材 id，再给盘面用）
 *     symbols/  oriSymbols/  font/  effects/ …
 *
 * 编辑分层：素材库 → 符号表 → 盘面（BoardEditor）。
 * 运行时只枚举 / 加载「当前激活 Spine 区」下的包。
 */

import {
    assertResourceInActiveZone,
    getActiveSpineZoneSync,
    packResourcePath,
    type SpineZoneId,
} from './SpineZone.ts';

export interface SymbolPackDef {
    /** 稳定 id，对应 packs/<id>/ 目录名 */
    id: string;
    /** HUD 显示名 */
    name: string;
    /** 所属 Spine 资源区 */
    zone: SpineZoneId;
    /**
     * 默认盘面种子（resources 路径，无扩展名）。
     * BoardEditor 切包时加载；缺省则用 doc_example。
     */
    seedDocId?: string;
    seedDocPath?: string;
    /** 升高后清掉该 doc 的 localStorage 自动存档 */
    seedRev?: number;
    /**
     * 是否支持不等高列（ways）。true 时 BoardEditor 显示「列格数」面板。
     * 矩形固定盘（赛特/雷神）保持 false，避免空盘上误调列高。
     */
    variableColumns?: boolean;
    /** 吕布类 tall-symbol 刷子档；仅 variableColumns 时有意义 */
    tallSymbolTiers?: boolean;
}

/** 全量登记（含各区）；UI / 加载会按激活区过滤 — 包↔种子盘面由此表自由选择 */
export const SYMBOL_PACKS: readonly SymbolPackDef[] = [
    {
        id: 'golden-seth',
        name: 'Golden Seth',
        zone: 'spine-3.8',
        seedDocId: 'doc_example',
        seedDocPath: 'configs/presentation/doc_example',
        variableColumns: true,
    },
    {
        id: 'power-of-thor2',
        name: 'Power of Thor 2',
        zone: 'spine-3.8',
        seedDocId: 'doc_thor2_recovered',
        seedDocPath: 'configs/presentation/doc_thor2_recovered',
        seedRev: 2,
        variableColumns: true,
    },
    {
        id: 'bounty-hunter',
        name: 'Bounty Hunter',
        zone: 'spine-3.8',
        seedDocId: 'doc_bounty_hunter_recovered',
        seedDocPath: 'configs/presentation/doc_bounty_hunter_recovered',
        seedRev: 2,
        variableColumns: true,
    },
    {
        id: 'lvbu',
        name: 'LvBu (ways-6x7)',
        zone: 'spine-4.2',
        seedDocId: 'doc_lvbu_ways67',
        seedDocPath: 'configs/presentation/doc_lvbu_ways67',
        seedRev: 1,
        variableColumns: true,
        tallSymbolTiers: true,
    },
];

export function libraryPathFor(pack: SymbolPackDef): string {
    return packResourcePath(pack.zone, pack.id, 'symbol-library');
}

/** 同包素材库 resources 路径（可缺省；旧包无此文件） */
export function assetLibraryPathFor(pack: SymbolPackDef): string {
    return packResourcePath(pack.zone, pack.id, 'asset-library');
}

export function packsInZone(zone: SpineZoneId = getActiveSpineZoneSync()): SymbolPackDef[] {
    return SYMBOL_PACKS.filter((p) => p.zone === zone);
}

export function getSymbolPack(id: string | null | undefined, zone = getActiveSpineZoneSync()): SymbolPackDef {
    const inZone = packsInZone(zone);
    if (inZone.length === 0) {
        throw new Error(
            `当前 Spine 区 ${zone} 下没有登记符号包。请导入 packs/ 并在 SYMBOL_PACKS 登记，或切回有资源的区。`,
        );
    }
    const found = inZone.find((p) => p.id === id);
    return found ?? inZone[0]!;
}

export function tryGetSymbolPack(
    id: string | null | undefined,
    zone = getActiveSpineZoneSync(),
): SymbolPackDef | null {
    const inZone = packsInZone(zone);
    if (inZone.length === 0) return null;
    return inZone.find((p) => p.id === id) ?? inZone[0]!;
}

export function defaultPackId(zone = getActiveSpineZoneSync()): string {
    return packsInZone(zone)[0]?.id ?? SYMBOL_PACKS[0]?.id ?? 'golden-seth';
}

export const PACK_ID_STORE_KEY = 'symbolEditor.packId';

export function loadStoredPackId(zone = getActiveSpineZoneSync()): string {
    try {
        const raw = localStorage.getItem(PACK_ID_STORE_KEY);
        if (raw && packsInZone(zone).some((p) => p.id === raw)) return raw;
    } catch {
        /* 预览容器无 localStorage */
    }
    return defaultPackId(zone);
}

export function storePackId(id: string): void {
    try {
        localStorage.setItem(PACK_ID_STORE_KEY, id);
    } catch {
        /* ignore */
    }
}

/** 在当前激活区内循环切换（dir=±1） */
export function cyclePackId(currentId: string, dir: 1 | -1, zone = getActiveSpineZoneSync()): SymbolPackDef {
    const list = packsInZone(zone);
    if (list.length === 0) {
        throw new Error(`当前 Spine 区 ${zone} 下没有登记任何符号包`);
    }
    const i = Math.max(0, list.findIndex((p) => p.id === currentId));
    const next = (i + dir + list.length) % list.length;
    return list[next]!;
}

export function assertPackLibraryPath(resPath: string): void {
    assertResourceInActiveZone(resPath);
}

// ——— 兼容旧 GamePack 命名（HUD / 导出过渡） ———

export type GamePackDef = SymbolPackDef & { libraryPath: string };

function withLibraryPath(p: SymbolPackDef): GamePackDef {
    return { ...p, libraryPath: libraryPathFor(p) };
}

/** 当前激活区内的包（带 libraryPath） */
export function listActiveGamePacks(): GamePackDef[] {
    return packsInZone().map(withLibraryPath);
}

export const DEFAULT_GAME_ID = 'golden-seth';
export const GAME_ID_STORE_KEY = PACK_ID_STORE_KEY;

export function getGamePack(id: string | null | undefined): GamePackDef {
    return withLibraryPath(getSymbolPack(id));
}

export function loadStoredGameId(): string {
    return loadStoredPackId();
}

export function storeGameId(id: string): void {
    storePackId(id);
}

export function cycleGameId(currentId: string, dir: 1 | -1): GamePackDef {
    return withLibraryPath(cyclePackId(currentId, dir));
}
