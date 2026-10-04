/**
 * BoardView — 渲染一个 PresentationState 的 resolved 盘面。
 * 节点两层：cell 节点（位移动画载体，scale 恒 1）→ SymbolView content（符号内容）。
 *
 * 吕布类：格子 = 设计框（280 × 档高），用于命中/选中/列堆叠。
 * 符号 pixelPerfect 按纹理 1:1 画在格心，允许超框（不把格子撑成包围盒）。
 */

import { _decorator, Component, Node, UITransform, Vec3, Color, Graphics, EventTouch } from 'cc';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import type { SymbolProvider } from './SymbolDefs.ts';
import { SymbolView } from './SymbolView.ts';
import { cellDesignHeightForColumn, columnCountToTier, type CellRef, type BoardLayoutProfile } from './board-layout/index.ts';
import { findColumnSpanRow } from './board-layout/index.ts';
import { isColumnFillEntry } from './placement/index.ts';
import type { ColumnVAlign } from './SymbolDraft.ts';
import { normalizeColumnVAlign } from './SymbolDraft.ts';

const { ccclass, property } = _decorator;

/** 顶条假轮带宿主（由 BoardEditor 注入；与 pack 无关） */
export interface TopStripReelHost {
    root: Node;
    count: number;
    cellW: number;
    cellH: number;
    /** 顶条第 i 格中心 X（相对 root） */
    slotCenterX(index: number): number;
    hideCells(): Node[];
    /** 停轮落帧（含 span 布局） */
    landState(state: PresentationState): void;
    getCellNode(index: number): Node | null;
    getSymbolView(index: number): import('./SymbolView').SymbolView | null;
}

@ccclass('BoardView')
export class BoardView extends Component {
    @property cellW = 100;
    @property cellH = 84;
    @property colGap = 0;
    @property rowGap = 0;
    @property cellFill = 0.9;
    @property showGridBg = true;
    /** 不等高列垂直对齐：top | center | bottom */
    @property columnVAlign: ColumnVAlign = 'top';

    onCellPress: ((col: number, row: number) => void) | null = null;
    onStrokeEnd: (() => void) | null = null;

    private catalog: SymbolProvider | null = null;
    private cellNodes: Node[][] = [];
    private symbolViews: SymbolView[][] = [];
    private gridBg: Node | null = null;
    /** 每格设计高（选中框 / 堆叠用；不等于纹理包围盒） */
    private cellHeights: number[][] = [];
    private topMappedKeys = new Set<string>();
    private layoutProfile: BoardLayoutProfile | null = null;
    /** 当前帧存在列占满符号的列 */
    private columnSpanCols = new Set<number>();
    private topStripReel: TopStripReelHost | null = null;

    setCatalog(catalog: SymbolProvider): void {
        this.catalog = catalog;
    }

    setTopStripReelHost(host: TopStripReelHost | null | undefined): void {
        this.topStripReel = host ?? null;
    }

    getTopStripReelHost(): TopStripReelHost | null {
        return this.topStripReel;
    }

    /** 当前网格拓扑是否与 state 一致（假轮带停轮后可免整盘重刷） */
    topologyMatches(state: PresentationState): boolean {
        const { cols, visibleRows } = state.board.topology;
        return (
            this.currentCols === cols &&
            this.currentVisibleRows.length === visibleRows.length &&
            this.currentVisibleRows.every((v, i) => v === visibleRows[i])
        );
    }

    hasReelMasks(): boolean {
        if (this.node.children.some((c) => c.name.startsWith('reelMask_'))) return true;
        const root = this.topStripReel?.root;
        return !!root?.isValid && root.children.some((c) => c.name.startsWith('reelMask_'));
    }

    /** 拆掉假轮带 Mask（停轮真格已落好时用，避免再 setSymbol） */
    clearReelMasks(): void {
        const doomed = this.node.children.filter((c) => c.name.startsWith('reelMask_'));
        for (const n of doomed) n.destroy();
        const root = this.topStripReel?.root;
        if (root?.isValid) {
            const topDoomed = root.children.filter((c) => c.name.startsWith('reelMask_'));
            for (const n of topDoomed) n.destroy();
        }
    }

    private settledFingerprint: string | null = null;

    /** 假轮带同帧落盘后标记，Director 跳过二次 render */
    markVisualSettled(state: PresentationState): void {
        this.settledFingerprint = this.fingerprintState(state);
    }

    consumeVisualSettled(state: PresentationState): boolean {
        const fp = this.fingerprintState(state);
        if (this.settledFingerprint && this.settledFingerprint === fp) {
            this.settledFingerprint = null;
            return true;
        }
        this.settledFingerprint = null;
        return false;
    }

    private fingerprintState(state: PresentationState): string {
        const { cols, visibleRows } = state.board.topology;
        const parts: string[] = [`${cols}:${visibleRows.join(',')}`];
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < visibleRows[c]!; r++) {
                parts.push(String(state.board.resolved[c]?.[r]?.symbolId ?? 'n'));
            }
        }
        const top = (state.extensions?.['frame'] as { topStrip?: unknown } | undefined)?.topStrip;
        if (Array.isArray(top)) parts.push(`T:${top.join(',')}`);
        return parts.join('|');
    }

    setLayoutProfile(profile: BoardLayoutProfile | null | undefined): void {
        this.layoutProfile = profile ?? null;
    }

    getLayoutProfile(): BoardLayoutProfile | null {
        return this.layoutProfile;
    }

    /** 给定列符号个数时的整列像素高（含行距） */
    columnHeightForCount(columnCount: number): number {
        return this.columnPixelHeight(0, columnCount);
    }

    /** 当前已渲染盘面每列 visibleRows */
    getVisibleRows(): readonly number[] {
        return this.currentVisibleRows;
    }

    setTopStripMap(refs: readonly CellRef[] | null | undefined): void {
        this.topMappedKeys = new Set((refs ?? []).map((r) => `${r.col},${r.row}`));
    }

    isTopMappedCell(col: number, row: number): boolean {
        return this.topMappedKeys.has(`${col},${row}`);
    }

    getCatalog(): SymbolProvider | null {
        return this.catalog;
    }

    getCellNode(col: number, row: number): Node | null {
        return this.cellNodes[col]?.[row] ?? null;
    }

    getSymbolView(col: number, row: number): SymbolView | null {
        return this.symbolViews[col]?.[row] ?? null;
    }

    /** 倍率字调试：对盘面所有已显示数字的 SymbolView 重排 times */
    refreshAllMultiDigitStyles(): void {
        for (const col of this.symbolViews) {
            for (const view of col) {
                view?.reapplyMultiplierStyle();
            }
        }
    }

    /** 间距/格尺寸变了但拓扑未变时，强制下一帧 render 重建网格 */
    invalidateLayout(): void {
        this.currentCols = -1;
        this.currentVisibleRows = [];
    }

    render(state: PresentationState, opts?: { suppressMultiDigits?: boolean }): void {
        const { cols, visibleRows } = state.board.topology;
        const sameTopo =
            this.currentCols === cols &&
            this.currentVisibleRows.length === visibleRows.length &&
            this.currentVisibleRows.every((v, i) => v === visibleRows[i]);
        if (!sameTopo) {
            this.rebuildGrid(cols, visibleRows);
        }
        const hideDigits = !!opts?.suppressMultiDigits;
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < visibleRows[c]!; r++) {
                const cell = state.board.resolved[c]![r]!;
                const ent = cell.entityRef ? state.board.entities[cell.entityRef] : null;
                const mult = hideDigits ? null : ent?.multiplier ?? null;
                const node = this.cellNodes[c]?.[r];
                if (node) node.active = true;
                this.applyCell(c, r, cell.symbolId, mult);
            }
        }
        for (let c = 0; c < cols; c++) {
            this.applyColumnSpanVisual(c, state);
        }
        if (this.selected) this.setSelected(this.selected.col, this.selected.row);
    }

    private selected: { col: number; row: number } | null = null;
    private selectionNode: Node | null = null;

    setSelected(col: number | null, row?: number): void {
        if (col === null) {
            this.selected = null;
            if (this.selectionNode) this.selectionNode.active = false;
            return;
        }
        this.selected = { col, row: row! };
        if (this.columnSpanCols.has(col)) {
            this.selectionForColumnSpan(col);
            return;
        }
        const cellH = this.cellHeights[col]?.[row!] ?? this.cellH;
        if (!this.selectionNode || !this.selectionNode.isValid || this.selectionNode.parent !== this.node) {
            const n = new Node('selection');
            n.addComponent(UITransform);
            n.addComponent(Graphics);
            this.node.addChild(n);
            this.selectionNode = n;
        }
        this.paintSelectionRect(this.cellW, cellH);
        this.selectionNode.active = true;
        this.selectionNode.setPosition(this.cellPosition(col, row!));
        this.selectionNode.setSiblingIndex(this.node.children.length - 1);
    }

    /**
     * 选中蒙板：半透填充标出设计格大小（与纹理超框区分），外加描边。
     * 锚点在矩形中心。
     */
    private paintSelectionRect(w: number, h: number): void {
        if (!this.selectionNode || !this.selectionNode.isValid) return;
        const g = this.selectionNode.getComponent(Graphics)!;
        g.clear();
        g.fillColor = new Color(255, 210, 60, 56);
        g.strokeColor = new Color(255, 210, 60, 255);
        g.lineWidth = 3;
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();
        g.stroke();
        this.selectionNode.getComponent(UITransform)?.setContentSize(w, h);
    }

    getSelected(): { col: number; row: number } | null {
        return this.selected ? { ...this.selected } : null;
    }

    applyCell(col: number, row: number, symbolId: number | null, multiplier: number | null = null): void {
        const view = this.symbolViews[col]?.[row];
        if (!view) return;
        // 主盘始终显示全部 visibleRows（含顶条映射的 row0）；顶条是同格镜像编辑入口
        view.node.active = true;
        const columnCount = this.currentVisibleRows[col] ?? null;
        const tier =
            this.layoutProfile && columnCount != null ? columnCountToTier(columnCount) : null;
        const cellH = this.cellHeights[col]?.[row] ?? this.cellPixelHeight(columnCount ?? 0);
        // 列占满符号由 applyColumnSpanVisual 统一画；此处先占位
        const entry = symbolId != null ? this.catalog?.getEntry(symbolId) : null;
        if (isColumnFillEntry(entry)) {
            view.setVariantKey(null);
            view.setSymbol(null);
            view.setMultiplier(null);
            return;
        }
        view.setVariantKey(null);
        view.setPixelPerfect(true);
        if (this.catalog) view.setup(this.catalog, this.cellW, cellH, 1);
        view.setColumnContext(this.layoutProfile ? columnCount : null, tier);
        view.setSymbol(symbolId);
        view.setMultiplier(multiplier);
    }

    private isColumnFillId = (symbolId: number): boolean => {
        return isColumnFillEntry(this.catalog?.getEntry(symbolId));
    };

    /**
     * column-fill：只在锚点行显示一只，高度=整列主盘设计高，其它主盘格隐藏。
     */
    applyColumnSpanVisual(col: number, state: PresentationState): void {
        // column-fill 只依赖 placementMainId；layoutProfile 仅用于顶条/档位。
        // 试玩 BoardStage 若未 setLayoutProfile，仍须画出整列占满（吕布 bonus 等）。
        const profile = this.layoutProfile;
        const columnCount = this.currentVisibleRows[col] ?? 0;
        const spanRow = findColumnSpanRow(
            profile,
            col,
            columnCount,
            state.board.resolved,
            this.isColumnFillId,
        );
        if (spanRow == null) {
            this.columnSpanCols.delete(col);
            for (let r = 0; r < columnCount; r++) {
                const n = this.cellNodes[col]?.[r];
                if (!n) continue;
                n.active = true;
                const cellH = this.cellPixelHeight(columnCount);
                n.getComponent(UITransform)?.setContentSize(this.cellW, cellH);
                n.setPosition(this.cellPosition(col, r));
            }
            return;
        }

        const spanId = state.board.resolved[col]?.[spanRow]?.symbolId ?? null;
        if (spanId == null) return;

        this.columnSpanCols.add(col);
        // 整列占满高度 = visibleRows × 档高，与「N 个小符号」同高
        const colH = this.columnSpanPixelHeight(columnCount);
        const x = this.columnCenterX(col);
        const { h: boardH } = this.boardSize(this.currentCols, this.currentVisibleRows);
        const centerY = this.columnTopY(col, boardH, colH) - colH / 2;

        for (let r = 0; r < columnCount; r++) {
            const n = this.cellNodes[col]?.[r];
            const view = this.symbolViews[col]?.[r];
            if (!n || !view) continue;
            if (r === spanRow) {
                n.active = true;
                n.getComponent(UITransform)?.setContentSize(this.cellW, colH);
                n.setPosition(x, centerY, 0);
                view.setPixelPerfect(false);
                if (this.catalog) view.setup(this.catalog, this.cellW, colH, 1);
                view.setColumnContext(null, null);
                view.setVariantKey(null);
                view.setSymbol(spanId);
                view.setMultiplier(null);
                this.forceHeightFill(view, colH);
            } else {
                n.active = false;
                view.setSymbol(null);
            }
        }
    }

    /** 列占满专用高度：按列符号数全算，不因顶条映射少一格 */
    private columnSpanPixelHeight(columnCount: number): number {
        if (columnCount <= 0) return 0;
        const cellH = this.cellPixelHeight(columnCount);
        return columnCount * cellH + Math.max(0, columnCount - 1) * this.rowGap;
    }

    /** 把符号 content 缩放到指定高度（宽随比例，可超设计格宽） */
    private forceHeightFill(view: SymbolView, targetH: number): void {
        const content = view.contentNode;
        if (!content || targetH <= 0) return;
        const ut = content.getComponent(UITransform);
        const h = ut?.contentSize.height ?? 0;
        if (!(h > 0)) return;
        const s = targetH / h;
        content.setScale(s, s, 1);
    }

    /** 选中列占满符号时，框住整列（与 N 个小格同高） */
    private selectionForColumnSpan(col: number): void {
        const colH = this.columnSpanPixelHeight(this.currentVisibleRows[col] ?? 0);
        const { h: boardH } = this.boardSize(this.currentCols, this.currentVisibleRows);
        const x = this.columnCenterX(col);
        const centerY = this.columnTopY(col, boardH, colH) - colH / 2;
        if (!this.selectionNode || !this.selectionNode.isValid || this.selectionNode.parent !== this.node) {
            const n = new Node('selection');
            n.addComponent(UITransform);
            n.addComponent(Graphics);
            this.node.addChild(n);
            this.selectionNode = n;
        }
        this.paintSelectionRect(this.cellW, colH);
        this.selectionNode.active = true;
        this.selectionNode.setPosition(x, centerY, 0);
        this.selectionNode.setSiblingIndex(this.node.children.length - 1);
    }

    boardSize(cols: number, rowsOrVisible: number | readonly number[]): { w: number; h: number } {
        const visibleRows =
            typeof rowsOrVisible === 'number'
                ? this.currentVisibleRows.length === cols
                    ? this.currentVisibleRows
                    : Array.from({ length: cols }, () => rowsOrVisible)
                : rowsOrVisible;
        const w = cols * this.cellW + Math.max(0, cols - 1) * this.colGap;
        let h = 0;
        for (let c = 0; c < cols; c++) {
            const colH = this.columnPixelHeight(c, visibleRows[c] ?? 0);
            if (colH > h) h = colH;
        }
        return { w, h };
    }

    private columnPixelHeight(_col: number, columnCount: number): number {
        if (columnCount <= 0) return 0;
        const cellH = this.cellPixelHeight(columnCount);
        return columnCount * cellH + Math.max(0, columnCount - 1) * this.rowGap;
    }

    private cellPixelHeight(columnCount: number): number {
        // 仅吕布类 profile 才按列符号数取档高；赛特等固定盘面用 catalog.designH
        if (!this.layoutProfile) return this.cellH;
        return cellDesignHeightForColumn(columnCount) ?? this.cellH;
    }

    columnCenterX(col: number): number {
        const { w } = this.boardSize(this.currentCols || col + 1, this.currentVisibleRows);
        return -w / 2 + this.cellW / 2 + col * (this.cellW + this.colGap);
    }

    setColumnVAlign(align: ColumnVAlign | string | null | undefined): void {
        this.columnVAlign = normalizeColumnVAlign(align);
    }

    getColumnVAlign(): ColumnVAlign {
        return normalizeColumnVAlign(this.columnVAlign);
    }

    /**
     * 列顶边的世界 Y（盘面原点为中心）：按 columnVAlign 把列放入整盘高度。
     * top → 贴齐盘顶；center → 垂直居中；bottom → 贴齐盘底。
     */
    private columnTopY(_col: number, boardH: number, colH: number): number {
        const align = this.getColumnVAlign();
        if (align === 'center') return colH / 2;
        if (align === 'bottom') return -boardH / 2 + colH;
        return boardH / 2;
    }

    /**
     * 格心坐标。不等高 ways 列按 columnVAlign 对齐；
     * 等高矩形盘三种对齐视觉相同。
     */
    cellPosition(col: number, row: number, _cols?: number, _rows?: number): Vec3 {
        const { h } = this.boardSize(this.currentCols, this.currentVisibleRows);
        const x = this.columnCenterX(col);
        const columnCount = this.currentVisibleRows[col] ?? 0;
        const cellH = this.cellPixelHeight(columnCount);
        const colH = this.columnPixelHeight(col, columnCount);
        let y = this.columnTopY(col, h, colH);
        for (let r = 0; r < row; r++) {
            y -= cellH + this.rowGap;
        }
        y -= cellH / 2;
        return new Vec3(x, y, 0);
    }

    hitCell(localX: number, localY: number): { col: number; row: number } | null {
        const cols = this.currentCols;
        const visibleRows = this.currentVisibleRows;
        const { w, h } = this.boardSize(cols, visibleRows);
        const x = localX + w / 2;
        if (x < 0 || x >= w) return null;
        const stride = this.cellW + this.colGap;
        const col = Math.floor(x / stride);
        if (col < 0 || col >= cols) return null;
        if (x - col * stride > this.cellW) return null;

        const columnCount = visibleRows[col] ?? 0;
        if (columnCount <= 0) return null;
        const cellH = this.cellPixelHeight(columnCount);
        const colH = this.columnPixelHeight(col, columnCount);
        const topY = this.columnTopY(col, h, colH);
        const yFromColTop = topY - localY;
        if (yFromColTop < 0 || yFromColTop >= colH) return null;
        let cursor = 0;
        for (let r = 0; r < columnCount; r++) {
            if (yFromColTop >= cursor && yFromColTop < cursor + cellH) return { col, row: r };
            cursor += cellH + this.rowGap;
        }
        return null;
    }

    private currentCols = 0;
    private currentVisibleRows: number[] = [];

    private rebuildGrid(cols: number, visibleRows: readonly number[]): void {
        this.node.removeAllChildren();
        this.cellNodes = [];
        this.symbolViews = [];
        this.cellHeights = [];
        this.columnSpanCols.clear();
        this.gridBg = null;
        this.selectionNode = null;
        this.currentCols = cols;
        this.currentVisibleRows = visibleRows.slice();
        this.ensureTouch();
        if (this.showGridBg) this.drawGridBg(cols, visibleRows);
        for (let c = 0; c < cols; c++) {
            const colNodes: Node[] = [];
            const colViews: SymbolView[] = [];
            const colHeights: number[] = [];
            const columnCount = visibleRows[c]!;
            const cellH = this.cellPixelHeight(columnCount);
            const tier = this.layoutProfile ? columnCountToTier(columnCount) : null;
            for (let r = 0; r < columnCount; r++) {
                const n = new Node(`cell_${c}_${r}`);
                // 设计框尺寸；符号可超框画出
                n.addComponent(UITransform).setContentSize(this.cellW, cellH);
                n.active = true;
                const view = n.addComponent(SymbolView);
                if (this.catalog) {
                    view.setup(this.catalog, this.cellW, cellH, 1);
                    view.setPixelPerfect(true);
                }
                view.setColumnContext(this.layoutProfile ? columnCount : null, tier);
                n.setPosition(this.cellPosition(c, r));
                this.node.addChild(n);
                colNodes.push(n);
                colViews.push(view);
                colHeights.push(cellH);
            }
            this.cellNodes.push(colNodes);
            this.symbolViews.push(colViews);
            this.cellHeights.push(colHeights);
        }
    }

    private drawGridBg(cols: number, visibleRows: readonly number[]): void {
        const bg = new Node('grid_bg');
        const ui = bg.addComponent(UITransform);
        const { w, h } = this.boardSize(cols, visibleRows);
        ui.setContentSize(w, h);
        const g = bg.addComponent(Graphics);
        g.lineWidth = 1;
        g.strokeColor = new Color(255, 255, 255, 60);
        g.fillColor = new Color(20, 24, 40, 160);
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < visibleRows[c]!; r++) {
                const cellH = this.cellPixelHeight(visibleRows[c]!);
                const p = this.cellPosition(c, r);
                g.rect(p.x - this.cellW / 2, p.y - cellH / 2, this.cellW, cellH);
            }
        }
        g.stroke();
        this.node.addChild(bg);
        this.gridBg = bg;
    }

    private touchBound = false;
    private lastPainted: { col: number; row: number } | null = null;

    private ensureTouch(): void {
        const ui = this.node.getComponent(UITransform) ?? this.node.addComponent(UITransform);
        const { w, h } = this.boardSize(this.currentCols, this.currentVisibleRows);
        ui.setContentSize(w, h);
        if (this.touchBound) return;
        this.touchBound = true;

        const hitFromEvent = (e: EventTouch): { col: number; row: number } | null => {
            const uiPos = e.getUILocation();
            const local = ui.convertToNodeSpaceAR(new Vec3(uiPos.x, uiPos.y, 0));
            return this.hitCell(local.x, local.y);
        };
        const press = (e: EventTouch): void => {
            const hit = hitFromEvent(e);
            if (!hit) return;
            if (this.lastPainted && this.lastPainted.col === hit.col && this.lastPainted.row === hit.row) {
                return;
            }
            this.lastPainted = hit;
            this.onCellPress?.(hit.col, hit.row);
        };
        const end = (): void => {
            this.lastPainted = null;
            this.onStrokeEnd?.();
        };
        this.node.on(Node.EventType.TOUCH_START, press);
        this.node.on(Node.EventType.TOUCH_MOVE, press);
        this.node.on(Node.EventType.TOUCH_END, end);
        this.node.on(Node.EventType.TOUCH_CANCEL, end);
    }
}
