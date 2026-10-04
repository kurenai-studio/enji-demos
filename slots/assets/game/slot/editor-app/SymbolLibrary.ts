/**
 * SymbolLibrary — 符号表运行时数据容器（用素材库 id 组装逻辑符号）。
 *
 * 分层：
 *   1) asset-library.prefab  — 素材库
 *   2) symbol-library.prefab — 本组件（序列化包数据；不要在 Creator Inspector 配）
 *   3) H5 SymbolEditor / BoardEditor — 唯一配置入口（SymbolSheetDoc.packLayout + symbols）
 *
 * 设计格 / 行列距 / FX scale 等请在 H5「符号编辑器」改；本组件仅承载运行时字段。
 */

import { _decorator, BitmapFont, Component, SpriteFrame, sp } from 'cc';
import {
    CellFxDef,
    DESIGN_CELL_H,
    DESIGN_CELL_W,
    SymbolEntry,
    isMultiEntry,
} from './SymbolDefs.ts';
import type { SymbolProvider } from './SymbolDefs.ts';

const { ccclass, property } = _decorator;

@ccclass('SymbolLibrary')
export class SymbolLibrary extends Component implements SymbolProvider {
    @property({ type: [SymbolEntry], tooltip: '符号条目；优先填 *AssetId，由 SymbolCatalog 解析' })
    symbols: SymbolEntry[] = [];

    /** @deprecated 请在 H5 符号编辑器改；仅作运行时/包序列化字段 */
    @property({ visible: false })
    symbolWidth = DESIGN_CELL_W;

    /** @deprecated 请在 H5 符号编辑器改 */
    @property({ visible: false })
    symbolHeight = DESIGN_CELL_H;

    /** @deprecated 请在 H5 符号编辑器改 */
    @property({ visible: false })
    boardColGap = 2;

    /** @deprecated 请在 H5 符号编辑器改 */
    @property({ visible: false })
    boardRowGap = 2;

    /** @deprecated 请在 H5 符号编辑器改 */
    @property({ visible: false })
    lockBoardColGap = false;

    /** @deprecated 请在 H5 符号编辑器改 */
    @property({ visible: false })
    lockBoardRowGap = false;

    /** @deprecated 请在 H5「包布局」改：top | center | bottom */
    @property({ visible: false })
    columnVAlign = 'top';

    /** @deprecated 包级 FX 请在 H5 选素材 + 调 scale；此处仅运行时 */
    @property({ type: CellFxDef, visible: false })
    winCellFx = new CellFxDef();

    /** @deprecated 同上 */
    @property({ type: CellFxDef, visible: false })
    vanishCellFx = new CellFxDef();

    @property({
        type: BitmapFont,
        visible: false,
        tooltip: '倍率球默认位图字（kind=multi 且条目 digitFont 为空时用）',
    })
    multiDigitFont: BitmapFont | null = null;

    @property({
        type: SpriteFrame,
        visible: false,
        tooltip: '扩散拖尾粒子贴图（timesParticle / BlueTimesMoving）',
    })
    expandSplitParticle: SpriteFrame | null = null;

    @property({
        type: sp.SkeletonData,
        visible: false,
        tooltip: '扩散落地 spine（split_B）',
    })
    expandSplitB: sp.SkeletonData | null = null;

    @property({ visible: false, tooltip: '落地动画名' })
    expandSplitBAnim = 'split_B';

    getEntry(id: number): SymbolEntry | null {
        return this.symbols.find((e) => e.id === id) ?? null;
    }

    get designW(): number {
        return this.symbolWidth > 0 ? this.symbolWidth : DESIGN_CELL_W;
    }

    get designH(): number {
        return this.symbolHeight > 0 ? this.symbolHeight : DESIGN_CELL_H;
    }

    /** 盘面默认间距（H5 packLayout 叠加后供 BoardEditor 读取） */
    get boardSpacing(): {
        colGap: number;
        rowGap: number;
        lockColGap: boolean;
        lockRowGap: boolean;
        columnVAlign: string;
    } {
        return {
            colGap: this.boardColGap,
            rowGap: this.boardRowGap,
            lockColGap: this.lockBoardColGap,
            lockRowGap: this.lockBoardRowGap,
            columnVAlign: this.columnVAlign || 'top',
        };
    }

    winCellFxFor(id: number): CellFxDef | null {
        const entry = this.getEntry(id);
        // 倍率球：只用符号级「收集特效」，不回落包级高亮
        if (isMultiEntry(entry)) {
            return entry?.winCellFx?.valid ? entry.winCellFx : null;
        }
        const override = entry?.winCellFx;
        if (override?.valid) return override;
        return this.winCellFx.valid ? this.winCellFx : null;
    }

    digitFontFor(id: number): BitmapFont | null {
        const entry = this.getEntry(id);
        if (!isMultiEntry(entry)) return null;
        return entry!.digitFont ?? this.multiDigitFont;
    }

    get expandSplitFx() {
        return {
            splitParticle: this.expandSplitParticle,
            splitB: this.expandSplitB,
            splitBAnim: this.expandSplitBAnim || 'split_B',
        };
    }

    vanishCellFxFor(id: number): CellFxDef | null {
        const override = this.getEntry(id)?.vanishCellFx;
        if (override?.valid) return override;
        return this.vanishCellFx.valid ? this.vanishCellFx : null;
    }
}
