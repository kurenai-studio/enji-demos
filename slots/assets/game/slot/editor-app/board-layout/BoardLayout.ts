/**
 * BoardLayout — 盘面布局抽象（与「游戏名」解耦）。
 *
 * 一份 profile 描述：主盘拓扑、顶条映射、符号角色、可选规则与编码。
 * 吕布无双是第一份实例（ways-6x7-top-mid4），后续同类盘面复用同一套类型。
 */

import type { ReelTopology } from '../../vendor/slot-presentation-ir/types.ts';

export interface CellRef {
    col: number;
    row: number;
}

/** 符号角色（协议 / 规则用 base id，不是客户端 height 编码） */
export interface SymbolRoles {
    bonus: number;
    wild: number;
    scatter: number;
    /** 普通高价值起始 id（含） */
    highStart?: number;
    /** 合法 base id 上限（含） */
    maxBaseId?: number;
}

/**
 * 顶条：逻辑上独立的一排格（编辑器存 frame.topStrip）。
 * mapToMain 仅描述导出到服务端 flat 时的目标格，不表示编辑期与主盘共用数据。
 * 吕布：4 格对齐主盘 col 1..4（导出时可写入 row0）。
 */
export interface TopStripDef {
    /** 顶条格数 */
    count: number;
    /** 顶条第 i 格 → 主盘 CellRef */
    mapToMain: CellRef[];
}

/** 客户端 tall-symbol 编码：runtimeId = baseId + (height-1)*typeCount */
export interface TallSymbolEncoding {
    typeCount: number;
    minHeight: number;
    maxHeight: number;
}

export interface BoardLayoutProfile {
    /** 稳定 id，如 ways-6x7-top-mid4 */
    id: string;
    /** HUD / 文档显示名 */
    name: string;
    /** 来源备注（可写 IP 名；运行时不依赖） */
    sourceNote?: string;
    /** 主盘 SPIR 拓扑（不含独立顶条层时，顶条格已并入 visibleRows） */
    topology: ReelTopology;
    /** 列优先 flat：index = col * rowCount + row */
    flat: {
        cols: number;
        rows: number;
        gridCount: number;
    };
    topStrip?: TopStripDef;
    roles: SymbolRoles;
    encoding?: TallSymbolEncoding;
    /**
     * 编辑器 / 预览默认间距。
     * 吕布类：列距恒为 0（列与列紧贴）；行距也 0（列内符号按格高紧贴堆叠）。
     */
    spacing?: {
        colGap: number;
        rowGap: number;
        /** 为 true 时编辑器锁定列距，不允许 HUD 改掉 */
        lockColGap?: boolean;
        /** 为 true 时编辑器锁定行距 */
        lockRowGap?: boolean;
    };
    /**
     * 帧转移风格模板 id（见 animStyles.ANIM_STYLE_INDEX）。
     * 与 pack / IP 名无关：同类盘面挂同一 id 即可。
     * 缺省 cascade-drop（落入/落出）。
     */
    animStyleId?: string;
}

export function flatIndex(col: number, row: number, rowsPerCol: number): number {
    return col * rowsPerCol + row;
}

export function flatToCell(index: number, rowsPerCol: number): CellRef {
    return { col: Math.floor(index / rowsPerCol), row: index % rowsPerCol };
}

/** 客户端编码：runtimeId = baseId + (height-1)*typeCount（baseId 从 1 起） */
export function encodeTallSymbol(baseId: number, height: number, enc: TallSymbolEncoding): number {
    const h = Math.max(enc.minHeight, Math.min(enc.maxHeight, height | 0));
    return baseId + (h - 1) * enc.typeCount;
}

/** 逆变换；非法 runtimeId 仍按公式拆，不抛错 */
export function decodeTallSymbol(
    runtimeId: number,
    enc: TallSymbolEncoding,
): { baseId: number; height: number } {
    if (runtimeId <= 0) return { baseId: 0, height: enc.minHeight };
    const height = Math.floor((runtimeId - 1) / enc.typeCount) + 1;
    const baseId = ((runtimeId - 1) % enc.typeCount) + 1;
    return {
        baseId,
        height: Math.max(enc.minHeight, Math.min(enc.maxHeight, height)),
    };
}

/** 从 profile 生成 SPIR ReelTopology 的浅拷贝 */
export function cloneTopology(p: BoardLayoutProfile): ReelTopology {
    const t = p.topology;
    return {
        cols: t.cols,
        visibleRows: t.visibleRows.slice(),
        extraTop: t.extraTop.slice(),
        extraBottom: t.extraBottom.slice(),
    };
}
