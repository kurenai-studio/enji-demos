/**
 * reelSpin — 假轮带揭晓（A → 滚动 → 停到 B）。
 *
 * 主盘竖滚（向下）+ 顶条横滚（向左）。
 * 停轮：同帧内先落 B 再拆 Mask，避免闪一下。
 */

import { Mask, Node, UITransform, Vec3, tween } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call, delay, par, seq, starterAnim } from '../common/anim/compose.ts';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import { readFrameExt, ensureTopStripSymbols } from '../editor-core/index.ts';
import {
    LVBU_COLUMN_COUNT_MAX,
    LVBU_COLUMN_COUNT_MIN,
    LVBU_TOP_STRIP_COLUMN_COUNT,
    cellDesignHeightForColumn,
    columnCountToTier,
} from './board-layout/index.ts';
import { isColumnFillEntry, isTopRowSpanEntry, resolvePlacement, listTopRowSpanAnchors } from './placement/index.ts';
import type { SymbolEntry, SymbolProvider } from './SymbolDefs.ts';
import { isMultiEntry } from './SymbolDefs.ts';
import { SymbolView } from './SymbolView.ts';
import type { BoardView, TopStripReelHost } from './BoardView.ts';

export interface ReelSpinContext {
    boardView: BoardView;
    prev: PresentationState;
    curr: PresentationState;
    params: Record<string, unknown>;
}

interface StripItem {
    symbolId: number;
    columnCount: number;
    height: number;
    width?: number;
    /** 顶条 visualVariant.key */
    variantKey?: string | null;
}

function probe(tag: string, extra?: Record<string, unknown>): void {
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (extra) console.log(`[reelFlash] ${tag}`, { t: +t.toFixed(2), ...extra });
    else console.log(`[reelFlash] ${tag}`, { t: +t.toFixed(2) });
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function randInt(min: number, max: number): number {
    const a = Math.ceil(min);
    const b = Math.floor(max);
    if (b <= a) return a;
    return a + Math.floor(Math.random() * (b - a + 1));
}

function pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

function columnHeight(boardView: BoardView, columnCount: number): number {
    if (columnCount <= 0) return boardView.columnHeightForCount(LVBU_COLUMN_COUNT_MAX);
    return boardView.columnHeightForCount(columnCount);
}

function cellH(boardView: BoardView, columnCount: number): number {
    return cellDesignHeightForColumn(columnCount) ?? boardView.cellH;
}

function isColumnFillId(catalog: SymbolProvider | null, symbolId: number | null): boolean {
    if (symbolId == null || !catalog) return false;
    return isColumnFillEntry(catalog.getEntry(symbolId));
}

function buildMainPool(
    catalog: SymbolProvider | null,
    prev: PresentationState,
    curr: PresentationState,
): number[] {
    const ids = new Set<number>();
    const consider = (id: number | null | undefined): void => {
        if (id == null || id <= 0) return;
        const e = catalog?.getEntry(id) ?? null;
        if (isColumnFillEntry(e) || isMultiEntry(e)) return;
        ids.add(id);
    };
    const scan = (state: PresentationState): void => {
        const { cols, visibleRows } = state.board.topology;
        for (let c = 0; c < cols; c++) {
            for (let r = 0; r < visibleRows[c]!; r++) {
                consider(state.board.resolved[c]?.[r]?.symbolId ?? null);
            }
        }
    };
    scan(prev);
    scan(curr);
    const withAll = catalog as (SymbolProvider & { all?: SymbolEntry[] }) | null;
    if (withAll?.all) for (const e of withAll.all) consider(e.id);
    if (ids.size === 0) for (let i = 2; i <= 13; i++) consider(i);
    return [...ids];
}

/** 顶条假带：只用顶条出现过的 id + 带 top* variant / 非列占满 的符号 */
function buildTopPool(
    catalog: SymbolProvider | null,
    prev: PresentationState,
    curr: PresentationState,
): number[] {
    const ids = new Set<number>();
    const consider = (id: number | null | undefined): void => {
        if (id == null || id <= 0 || !catalog) return;
        const e = catalog.getEntry(id);
        if (!e || isMultiEntry(e)) return;
        // 列占满竖戟不进顶条随机；有 top 变体或 top-row-span 的可以
        if (isColumnFillEntry(e) && !isTopRowSpanEntry(e)) return;
        ids.add(id);
    };
    for (const state of [prev, curr]) {
        const top = readFrameExt(state)?.topStrip;
        if (top) for (const id of top) consider(id);
    }
    const withAll = catalog as (SymbolProvider & { all?: SymbolEntry[] }) | null;
    if (withAll?.all) {
        for (const e of withAll.all) {
            if (isMultiEntry(e)) continue;
            if (isTopRowSpanEntry(e)) {
                ids.add(e.id);
                continue;
            }
            if (isColumnFillEntry(e)) continue;
            const hasTopVariant = (e.visualVariants ?? []).some((v) => v.key.startsWith('top'));
            if (hasTopVariant || !isColumnFillEntry(e)) ids.add(e.id);
        }
    }
    if (ids.size === 0) return buildMainPool(catalog, prev, curr);
    return [...ids];
}

function blockFromState(
    boardView: BoardView,
    catalog: SymbolProvider | null,
    state: PresentationState,
    col: number,
    windowH: number,
): StripItem[] {
    const n = state.board.topology.visibleRows[col] ?? 0;
    if (n <= 0) return [];

    for (let r = 0; r < n; r++) {
        const id = state.board.resolved[col]?.[r]?.symbolId ?? null;
        if (isColumnFillId(catalog, id)) {
            return [{ symbolId: id!, columnCount: 0, height: windowH }];
        }
    }

    const h = cellH(boardView, n);
    const out: StripItem[] = [];
    for (let r = 0; r < n; r++) {
        const id = state.board.resolved[col]?.[r]?.symbolId ?? null;
        if (id == null) continue;
        out.push({ symbolId: id, columnCount: n, height: h });
    }
    return out;
}

function blockRandom(boardView: BoardView, pool: readonly number[], windowH: number): StripItem[] {
    if (pool.length === 0) return [];
    const n = randInt(LVBU_COLUMN_COUNT_MIN, LVBU_COLUMN_COUNT_MAX);
    const h = cellH(boardView, n);
    const out: StripItem[] = [];
    for (let i = 0; i < n; i++) {
        out.push({ symbolId: pick(pool), columnCount: n, height: h });
    }
    void windowH;
    return out;
}

function applyHeightFill(view: SymbolView, boxH: number): void {
    const content = view.contentNode;
    const ut = content?.getComponent(UITransform);
    const ih = ut?.contentSize.height ?? 0;
    if (content && ih > 0 && boxH > 0) {
        const s = boxH / ih;
        content.setScale(s, s, 1);
    }
}

function mountStripItemsVertical(
    holder: Node,
    items: StripItem[],
    boardView: BoardView,
    catalog: SymbolProvider,
    cellW: number,
    anchorTopY: number,
): void {
    let y = anchorTopY;
    for (const it of items) {
        const node = new Node(`sym_${it.symbolId}`);
        const ut = node.addComponent(UITransform);
        ut.setContentSize(cellW, it.height);
        const view = node.addComponent(SymbolView);
        view.setup(catalog, cellW, it.height, 1);
        if (it.columnCount <= 0) {
            view.setPixelPerfect(false);
            view.setColumnContext(null, null);
            view.setSymbol(it.symbolId);
            applyHeightFill(view, it.height);
        } else {
            view.setPixelPerfect(true);
            view.setColumnContext(it.columnCount, columnCountToTier(it.columnCount));
            view.setSymbol(it.symbolId);
        }
        y -= it.height / 2;
        node.setPosition(0, y, 0);
        y -= it.height / 2 + boardView.rowGap;
        holder.addChild(node);
    }
}

function mountTopStripItems(
    holder: Node,
    items: StripItem[],
    catalog: SymbolProvider,
    cellH: number,
    anchorLeftX: number,
    gap: number,
): void {
    let x = anchorLeftX;
    for (const it of items) {
        const w = it.width ?? 0;
        if (!(w > 0)) continue;
        x += w / 2;
        if (it.symbolId > 0) {
            const node = new Node(`top_${it.symbolId}`);
            node.addComponent(UITransform).setContentSize(w, cellH);
            const view = node.addComponent(SymbolView);
            view.setup(catalog, w, cellH, 1);
            view.setPixelPerfect(false);
            view.setVariantKey(it.variantKey ?? null);
            if (it.variantKey) {
                view.setColumnContext(null, null);
            } else {
                view.setColumnContext(LVBU_TOP_STRIP_COLUMN_COUNT, null);
            }
            view.setSymbol(it.symbolId);
            applyHeightFill(view, cellH);
            node.setPosition(x, 0, 0);
            holder.addChild(node);
        }
        x += w / 2 + gap;
    }
}

function hideColumnCells(boardView: BoardView, col: number, visibleRows: readonly number[]): Node[] {
    const hidden: Node[] = [];
    const n = visibleRows[col] ?? 0;
    for (let r = 0; r < n; r++) {
        const node = boardView.getCellNode(col, r);
        if (node?.active) {
            node.active = false;
            hidden.push(node);
        }
    }
    return hidden;
}

function restoreNodes(nodes: Node[]): void {
    for (const n of nodes) {
        if (n.isValid) n.active = true;
    }
}

function destroyNode(node: Node | null): void {
    if (node?.isValid) node.destroy();
}

function landColumn(boardView: BoardView, col: number, state: PresentationState): void {
    const rows = state.board.topology.visibleRows[col] ?? 0;
    for (let r = 0; r < rows; r++) {
        const node = boardView.getCellNode(col, r);
        if (node) node.active = true;
        const cell = state.board.resolved[col]?.[r];
        const ent = cell?.entityRef ? state.board.entities[cell.entityRef] : null;
        boardView.applyCell(col, r, cell?.symbolId ?? null, ent?.multiplier ?? null);
    }
    boardView.applyColumnSpanVisual(col, state);
}

function spinOneColumn(
    ctx: ReelSpinContext,
    col: number,
    pool: readonly number[],
    cycles: number,
    duration: number,
    stagger: number,
): IAnim {
    const { boardView, prev, curr } = ctx;
    const catalog = boardView.getCatalog();
    if (!catalog) return call(() => undefined);

    const countA = prev.board.topology.visibleRows[col] ?? 0;
    const countB = curr.board.topology.visibleRows[col] ?? 0;
    const windowH = Math.max(
        columnHeight(boardView, countA),
        columnHeight(boardView, countB),
        columnHeight(boardView, LVBU_COLUMN_COUNT_MAX),
    );
    if (!(windowH > 0)) return call(() => undefined);

    // 自上而下 B ← 填料 ← A；strip.y 减小 = 符号向下
    const blocks: StripItem[][] = [];
    blocks.push(blockFromState(boardView, catalog, curr, col, windowH));
    for (let i = 0; i < cycles; i++) blocks.push(blockRandom(boardView, pool, windowH));
    blocks.push(blockFromState(boardView, catalog, prev, col, windowH));

    const blockCount = blocks.length;
    const stripH = blockCount * windowH;

    let maskNode: Node | null = null;
    let hidden: Node[] = [];

    const setup = call(() => {
        hidden = hideColumnCells(boardView, col, prev.board.topology.visibleRows);
        const { h: boardH } = boardView.boardSize(
            prev.board.topology.cols,
            prev.board.topology.visibleRows,
        );
        const cx = boardView.columnCenterX(col);
        const cy = boardH / 2 - windowH / 2;

        maskNode = new Node(`reelMask_c${col}`);
        maskNode.addComponent(UITransform).setContentSize(boardView.cellW, windowH);
        maskNode.addComponent(Mask).type = Mask.Type.RECT;
        maskNode.setPosition(cx, cy, 0);
        boardView.node.addChild(maskNode);

        const strip = new Node('strip');
        strip.addComponent(UITransform).setContentSize(boardView.cellW, stripH);
        maskNode.addChild(strip);

        for (let bi = 0; bi < blockCount; bi++) {
            const items = blocks[bi]!;
            if (!items.length) continue;
            const holder = new Node(`block_${bi}`);
            holder.addComponent(UITransform).setContentSize(boardView.cellW, windowH);
            holder.setPosition(0, stripH / 2 - bi * windowH, 0);
            strip.addChild(holder);
            mountStripItemsVertical(holder, items, boardView, catalog, boardView.cellW, 0);
        }

        const yForBlock = (bi: number) => -(stripH / 2 - windowH / 2) + bi * windowH;
        strip.setPosition(0, yForBlock(blockCount - 1), 0);
        (strip as Node & { __reelEndY?: number }).__reelEndY = yForBlock(0);
        probe(`col${col}:setup`, { cycles, windowH });
    });

    let moveCompleted = false;
    const move = starterAnim((finish) => {
        const strip = maskNode?.getChildByName('strip');
        if (!strip) {
            finish();
            return () => undefined;
        }
        probe(`col${col}:moveStart`);
        const endY = (strip as Node & { __reelEndY?: number }).__reelEndY ?? strip.position.y;
        const tw = tween(strip)
            .to(duration, { position: new Vec3(0, endY, 0) }, { easing: 'cubicOut' })
            .call(() => {
                moveCompleted = true;
                probe(`col${col}:moveEnd`);
                finish();
            })
            .start();
        // StarterAnim 在 complete 时也会调 dispose；绝不能在正常结束时拆 Mask
        return () => {
            tw.stop();
            if (!moveCompleted) {
                probe(`col${col}:moveCancel`);
                destroyNode(maskNode);
                maskNode = null;
                restoreNodes(hidden);
                hidden = [];
            }
        };
    });

    // Mask 留到整批 settle；此处只清 hidden 引用（节点仍 inactive）
    return seq(delay(col * stagger), setup, move, call(() => undefined));
}

function topSymbolsOf(state: PresentationState, count: number): Array<number | null> {
    return ensureTopStripSymbols(readFrameExt(state), count);
}

function topVariantFor(catalog: SymbolProvider, symbolId: number, spanCells: number): string | null {
    const entry = catalog.getEntry(symbolId);
    if (!entry) return null;
    const placed = resolvePlacement(entry, 'topStrip');
    if (spanCells > 1 && placed?.recipeId === 'top-row-span') {
        return placed.variantKey || null;
    }
    // 单格：优先 top-horizontal（非 wide）
    const variants = entry.visualVariants ?? [];
    const hit =
        variants.find((v) => v.key === 'top-horizontal') ??
        variants.find((v) => v.key.startsWith('top-') && !v.key.includes('wide'));
    return hit?.key ?? null;
}

/** 按 refreshTopStrip 同规则生成一块横条（含 span 占宽） */
function topBlockFromState(
    catalog: SymbolProvider,
    symbols: Array<number | null>,
    cellW: number,
    cellH: number,
): StripItem[] {
    const isSpan = (id: number) => isTopRowSpanEntry(catalog.getEntry(id));
    const cellsOf = (id: number) => {
        const p = resolvePlacement(catalog.getEntry(id), 'topStrip');
        return Math.max(1, p?.cells ?? 2);
    };
    const spans = listTopRowSpanAnchors(symbols, isSpan, cellsOf);
    const coverOf = new Map<number, { anchor: number; cells: number; symbolId: number }>();
    for (const s of spans) {
        for (let k = 0; k < s.cells; k++) coverOf.set(s.anchor + k, s);
    }

    const out: StripItem[] = [];
    for (let i = 0; i < symbols.length; i++) {
        const cover = coverOf.get(i);
        if (cover && i !== cover.anchor) continue;
        const symbolId = cover ? cover.symbolId : symbols[i];
        const spanCells = cover ? cover.cells : 1;
        const id = symbolId != null && symbolId > 0 ? symbolId : 0;
        out.push({
            symbolId: id,
            columnCount: LVBU_TOP_STRIP_COLUMN_COUNT,
            height: cellH,
            width: cellW * spanCells,
            variantKey: id > 0 ? topVariantFor(catalog, id, spanCells) : null,
        });
    }
    return out;
}

function topBlockRandom(
    catalog: SymbolProvider,
    pool: readonly number[],
    count: number,
    cellW: number,
    cellH: number,
): StripItem[] {
    const out: StripItem[] = [];
    for (let i = 0; i < count; i++) {
        if (!pool.length) {
            out.push({ symbolId: 0, columnCount: 1, height: cellH, width: cellW, variantKey: null });
            continue;
        }
        // 随机填料：单格，不用 wide span（避免宽度撑破窗）
        let id = pick(pool);
        let guard = 0;
        while (isTopRowSpanEntry(catalog.getEntry(id)) && guard++ < 8) {
            id = pick(pool);
        }
        out.push({
            symbolId: id,
            columnCount: LVBU_TOP_STRIP_COLUMN_COUNT,
            height: cellH,
            width: cellW,
            variantKey: topVariantFor(catalog, id, 1),
        });
    }
    return out;
}

function spinTopStrip(
    ctx: ReelSpinContext,
    host: TopStripReelHost,
    pool: readonly number[],
    cycles: number,
    duration: number,
): IAnim {
    const catalog = ctx.boardView.getCatalog();
    if (!catalog || host.count <= 0) return call(() => undefined);

    const { cellW, cellH, count } = host;
    const gap = 0;
    const windowW = count * cellW + Math.max(0, count - 1) * gap;
    if (!(windowW > 0)) return call(() => undefined);

    const symA = topSymbolsOf(ctx.prev, count);
    const symB = topSymbolsOf(ctx.curr, count);
    probe('top:symbols', { A: symA, B: symB, pool: pool.slice(0, 12) });

    const blocks: StripItem[][] = [];
    blocks.push(topBlockFromState(catalog, symA, cellW, cellH));
    for (let i = 0; i < cycles; i++) blocks.push(topBlockRandom(catalog, pool, count, cellW, cellH));
    blocks.push(topBlockFromState(catalog, symB, cellW, cellH));

    const blockCount = blocks.length;
    const stripW = blockCount * windowW;

    let maskNode: Node | null = null;
    let hidden: Node[] = [];

    const setup = call(() => {
        hidden = host.hideCells();
        const leftX = host.slotCenterX(0) - cellW / 2;
        const centerX = leftX + windowW / 2;

        maskNode = new Node('reelMask_top');
        maskNode.addComponent(UITransform).setContentSize(windowW, cellH);
        maskNode.addComponent(Mask).type = Mask.Type.RECT;
        maskNode.setPosition(centerX, 0, 0);
        host.root.addChild(maskNode);

        const strip = new Node('strip');
        strip.addComponent(UITransform).setContentSize(stripW, cellH);
        maskNode.addChild(strip);

        for (let bi = 0; bi < blockCount; bi++) {
            const holder = new Node(`block_${bi}`);
            holder.addComponent(UITransform).setContentSize(windowW, cellH);
            holder.setPosition(-stripW / 2 + bi * windowW, 0, 0);
            strip.addChild(holder);
            mountTopStripItems(holder, blocks[bi]!, catalog, cellH, 0, gap);
        }

        const xForBlock = (bi: number) => stripW / 2 - windowW / 2 - bi * windowW;
        strip.setPosition(xForBlock(0), 0, 0);
        (strip as Node & { __reelEndX?: number }).__reelEndX = xForBlock(blockCount - 1);
        probe('top:setup', { cycles, windowW, block0: blocks[0]?.map((i) => i.symbolId) });
    });

    let moveCompleted = false;
    const move = starterAnim((finish) => {
        const strip = maskNode?.getChildByName('strip');
        if (!strip) {
            finish();
            return () => undefined;
        }
        probe('top:moveStart');
        const endX = (strip as Node & { __reelEndX?: number }).__reelEndX ?? strip.position.x;
        const tw = tween(strip)
            .to(duration, { position: new Vec3(endX, 0, 0) }, { easing: 'cubicOut' })
            .call(() => {
                moveCompleted = true;
                probe('top:moveEnd');
                finish();
            })
            .start();
        return () => {
            tw.stop();
            if (!moveCompleted) {
                probe('top:moveCancel');
                destroyNode(maskNode);
                maskNode = null;
                restoreNodes(hidden);
                hidden = [];
            }
        };
    });

    return seq(setup, move, call(() => undefined));
}

function settleBoard(ctx: ReelSpinContext): void {
    const { boardView, curr } = ctx;
    probe('settle:begin', { hasMasks: boardView.hasReelMasks() });
    (globalThis as { __reelFlashLog?: boolean }).__reelFlashLog = true;

    const cols = curr.board.topology.cols;
    for (let c = 0; c < cols; c++) {
        const have = boardView.getVisibleRows()[c] ?? -1;
        const need = curr.board.topology.visibleRows[c] ?? 0;
        if (have === need) landColumn(boardView, c, curr);
        else probe('settle:skipCol', { c, have, need });
    }
    probe('settle:mainLanded');

    const topHost = boardView.getTopStripReelHost();
    if (topHost) {
        topHost.landState(curr);
        probe('settle:topLanded');
    }

    boardView.clearReelMasks();
    boardView.markVisualSettled(curr);
    (globalThis as { __reelFlashLog?: boolean }).__reelFlashLog = false;
    probe('settle:masksCleared', { hasMasks: boardView.hasReelMasks() });
}

/** 供 animTemplates 注册 */
export function buildReelSpin(ctx: ReelSpinContext): IAnim {
    const duration = Math.max(0.15, num(ctx.params, 'duration', 1.15));
    const colStagger = Math.max(0, num(ctx.params, 'colStagger', 0.08));
    const minCycles = Math.max(1, Math.round(num(ctx.params, 'minCycles', 2)));
    const maxCycles = Math.max(minCycles, Math.round(num(ctx.params, 'maxCycles', 4)));

    const { prev, curr, boardView } = ctx;
    const cols = Math.max(prev.board.topology.cols, curr.board.topology.cols);
    const mainPool = buildMainPool(boardView.getCatalog(), prev, curr);
    const topPool = buildTopPool(boardView.getCatalog(), prev, curr);

    probe('build', {
        cols,
        mainPoolN: mainPool.length,
        topPoolN: topPool.length,
        hasTopHost: !!boardView.getTopStripReelHost(),
    });

    const anims: IAnim[] = [];
    for (let c = 0; c < cols; c++) {
        anims.push(spinOneColumn(ctx, c, mainPool, randInt(minCycles, maxCycles), duration, colStagger));
    }

    const topHost = boardView.getTopStripReelHost();
    if (topHost?.root?.isValid && topHost.count > 0) {
        anims.push(spinTopStrip(ctx, topHost, topPool, randInt(minCycles, maxCycles), duration));
    } else {
        console.warn('[reelSpin] 无顶条宿主，跳过横栏');
    }

    if (anims.length === 0) return call(() => undefined);
    return seq(par(...anims), call(() => settleBoard(ctx)));
}
