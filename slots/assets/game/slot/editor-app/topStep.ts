/**
 * topStep — 横栏向左步进一格。
 * 视觉：顶条整体左移一个槽位宽；右侧带上 curr 补入的符号一起滑进视野。
 * 符号尺寸/变体与 refreshTopStrip、reelSpin.mountTopStripItems 对齐。
 */

import { Mask, Node, UITransform, Vec3, tween } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call, seq, starterAnim } from '../common/anim/compose.ts';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import { ensureTopStripSymbols, readFrameExt, writeFrameExt } from '../editor-core/index.ts';
import { serialize, deserialize } from '../vendor/slot-presentation-ir/index.ts';
import { LVBU_TOP_STRIP_COLUMN_COUNT } from './board-layout/index.ts';
import { isTopRowSpanEntry, listTopRowSpanAnchors, resolvePlacement } from './placement/index.ts';
import { SymbolView } from './SymbolView.ts';
import type { BoardView, TopStripReelHost } from './BoardView.ts';
import type { SymbolProvider } from './SymbolDefs.ts';

export interface TopStepContext {
    boardView: BoardView;
    prev: PresentationState;
    curr: PresentationState;
    params: Record<string, unknown>;
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function destroyNode(n: Node | null): void {
    if (n?.isValid) n.destroy();
}

/** 与 refreshTopStrip / reelSpin 一致：跨格用 placement 变体；单格不强制 top-horizontal */
function topVariantFor(catalog: SymbolProvider, symbolId: number, spanCells: number): string | null {
    const entry = catalog.getEntry(symbolId);
    if (!entry) return null;
    const placed = resolvePlacement(entry, 'topStrip');
    if (spanCells > 1 && placed?.recipeId === 'top-row-span') {
        return placed.variantKey || null;
    }
    return null;
}

interface TopBlock {
    symbolId: number;
    width: number;
    height: number;
    variantKey: string | null;
    /** 覆盖的起始槽 index（可超出可见窗，落在右侧补位） */
    anchor: number;
    cells: number;
}

function topBlocks(catalog: SymbolProvider, symbols: Array<number | null>, cellW: number, cellH: number): TopBlock[] {
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
    const out: TopBlock[] = [];
    for (let i = 0; i < symbols.length; i++) {
        const cover = coverOf.get(i);
        if (cover && i !== cover.anchor) continue;
        const symbolId = cover ? cover.symbolId : symbols[i];
        const cells = cover ? cover.cells : 1;
        const id = symbolId != null && symbolId > 0 ? symbolId : 0;
        out.push({
            symbolId: id,
            width: cellW * cells,
            height: cellH,
            variantKey: id > 0 ? topVariantFor(catalog, id, cells) : null,
            anchor: i,
            cells,
        });
    }
    return out;
}

/** 高度铺满顶条格（与 reelSpin.applyHeightFill / refreshTopStrip 相同） */
function applyHeightFill(view: SymbolView, boxH: number): void {
    const content = view.contentNode;
    const ut = content?.getComponent(UITransform);
    const ih = ut?.contentSize.height ?? 0;
    if (content && ih > 0 && boxH > 0) {
        const s = boxH / ih;
        content.setScale(s, s, 1);
    }
}

/**
 * 动画用扩展条：prev 全槽 + 右侧补入 curr 末格（步进后新进视野的符号）。
 * 例 prev=[A,B,C,D] curr=[B,C,D,E] → 条=[A,B,C,D,E]，左移一格后窗内变 B,C,D,E。
 */
function extendedStepSymbols(
    symPrev: Array<number | null>,
    symCurr: Array<number | null>,
    count: number,
): Array<number | null> {
    const out = symPrev.slice(0, count);
    while (out.length < count) out.push(null);
    const fill = count > 0 ? (symCurr[count - 1] ?? null) : null;
    out.push(fill);
    return out;
}

/** 顶条左移一格；右侧补 null。主盘不变。 */
export function makeTopStepState(source: PresentationState, stripCount: number): PresentationState | null {
    const ext = readFrameExt(source);
    const prev = ensureTopStripSymbols(ext, stripCount);
    const nextStrip: Array<number | null> = [];
    for (let i = 0; i < stripCount; i++) {
        nextStrip.push(i + 1 < stripCount ? (prev[i + 1] ?? null) : null);
    }
    const same = nextStrip.every((v, i) => v === (prev[i] ?? null));
    if (same) return null;
    const next = deserialize(serialize(source));
    const nextExt = readFrameExt(next);
    writeFrameExt(next, {
        cascadeIndex: nextExt?.cascadeIndex ?? 0,
        frameIndex: (nextExt?.frameIndex ?? 0) + 1,
        frameKind: 'topStep',
        templateId: 'topStep',
        topStrip: nextStrip,
    });
    return next;
}

function buildTempStrip(
    catalog: SymbolProvider,
    host: TopStripReelHost,
    symbols: Array<number | null>,
): { mask: Node; strip: Node; stepPx: number } {
    const { cellW, cellH, count, root } = host;
    const stepPx = Math.abs(host.slotCenterX(1) - host.slotCenterX(0)) || cellW;
    const windowW = count * cellW;
    const windowH = cellH + 8;
    const slotCount = Math.max(count, symbols.length);

    const mask = new Node('topStepMask');
    mask.addComponent(UITransform).setContentSize(windowW + 24, windowH);
    const m = mask.addComponent(Mask);
    m.type = Mask.Type.GRAPHICS_RECT;
    const leftX = host.slotCenterX(0) - cellW / 2;
    mask.setPosition(leftX + windowW / 2, 0, 0);
    root.addChild(mask);

    const strip = new Node('topStepStrip');
    strip.addComponent(UITransform).setContentSize(slotCount * cellW, cellH);
    mask.addChild(strip);

    const blocks = topBlocks(catalog, symbols, cellW, cellH);
    for (const b of blocks) {
        if (b.symbolId <= 0) continue;
        const n = new Node(`blk_${b.anchor}`);
        n.addComponent(UITransform).setContentSize(b.width, cellH);
        const view = n.addComponent(SymbolView);
        view.setup(catalog, b.width, cellH, 1);
        view.setPixelPerfect(false);
        view.setVariantKey(b.variantKey);
        if (b.variantKey) {
            view.setColumnContext(null, null);
        } else {
            view.setColumnContext(LVBU_TOP_STRIP_COLUMN_COUNT, null);
        }
        view.setSymbol(b.symbolId);
        applyHeightFill(view, cellH);
        // 相对 mask：可见窗左缘为 -windowW/2；anchor>=count 的在窗右侧外
        const centerX = -windowW / 2 + b.anchor * cellW + b.width / 2;
        n.setPosition(centerX, 0, 0);
        strip.addChild(n);
    }
    strip.setPosition(0, 0, 0);
    return { mask, strip, stepPx };
}

export function buildTopStep(ctx: TopStepContext): IAnim {
    const { boardView, prev, curr, params } = ctx;
    const host = boardView.getTopStripReelHost();
    const catalog = boardView.getCatalog();
    const dur = Math.max(0.08, num(params, 'duration', 0.35));

    if (!host?.root?.isValid || !catalog || host.count <= 0) {
        return call(() => host?.landState(curr));
    }

    const symPrev = ensureTopStripSymbols(readFrameExt(prev), host.count);
    const symCurr = ensureTopStripSymbols(readFrameExt(curr), host.count);
    if (symPrev.every((v, i) => v === symCurr[i])) {
        return call(() => host.landState(curr));
    }

    let maskNode: Node | null = null;
    let hidden: Node[] = [];

    const setup = call(() => {
        hidden = host.hideCells();
        // prev 全量 + curr 右端补格，一起左移进窗
        const extended = extendedStepSymbols(symPrev, symCurr, host.count);
        const built = buildTempStrip(catalog, host, extended);
        maskNode = built.mask;
        (maskNode as Node & { __strip?: Node; __stepPx?: number }).__strip = built.strip;
        (maskNode as Node & { __strip?: Node; __stepPx?: number }).__stepPx = built.stepPx;
    });

    const move = starterAnim((finish) => {
        if (!maskNode?.isValid) {
            finish();
            return () => undefined;
        }
        const strip = (maskNode as Node & { __strip?: Node }).__strip;
        const stepPx = (maskNode as Node & { __stepPx?: number }).__stepPx ?? host.cellW;
        if (!strip?.isValid) {
            finish();
            return () => undefined;
        }
        const tw = tween(strip)
            .to(dur, { position: new Vec3(-stepPx, 0, 0) }, { easing: 'quadInOut' })
            .call(() => finish())
            .start();
        return () => tw.stop();
    });

    const settle = call(() => {
        destroyNode(maskNode);
        maskNode = null;
        for (const n of hidden) {
            if (n.isValid) n.active = true;
        }
        hidden = [];
        host.landState(curr);
    });

    return seq(setup, move, settle);
}
