/**
 * animTemplates — frameKind → 动画模板注册表（M3）。
 *
 * 模板契约：给 (prev, curr[, next]) 两帧快照 + BoardView，产出一个 IAnim。
 * frameKind ↔ 模板存在兼容约束（KIND_ALLOWED），每个 frameKind 只能选列表内模板，
 * 首项为 auto 默认。例如（cascade / 赛特）：
 *   enter-table / reveal → dropIn | noop（屏外落入）
 *   highlight            → symbolWin | pulse | noop
 *   postClear            → vanish | dropOut | noop（cascade）；fake-reel 默认 fadeOut
 *   compact              → compactFall | noop（存活下沉；顶空新符可落入）
 * 吕布类盘面挂 layout.animStyleId=fake-reel 后：
 *   reveal→reelSpin，postClear→fadeOut，compact→compactFall，
 *   expandPost→jiDiffuse（横JI→竖JI），topStep→topStep（横栏左移）。
 * 「满盘换新盘」cascade-drop = postClear(dropOut) + compact + reveal(dropIn)；
 * fake-reel = postClear(fadeOut) + compact + reveal(reelSpin)。
 * 帧可用 extensions.frame.templateId / templateParams 在允许范围内覆盖默认模板。
 */

import { Node, ParticleSystem2D, Tween, UIOpacity, UITransform, Vec3, sp, tween, view } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call, delay, par, seq, starterAnim } from '../common/anim/compose.ts';
import { loop } from '../common/anim/compose.ts';
import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import type { IrFrameKind } from '../editor-core/index.ts';
import { readFrameExt } from '../editor-core/index.ts';
import type { BoardView } from './BoardView.ts';
import type { BoardEvents, BoardEventType } from './boardEvents.ts';
import { resolveTrailSprite, spawnBlueTimesTrail } from './SplitParticleFx.ts';
import { buildReelSpin } from './reelSpin.ts';
import { buildFadeOut } from './fadeOut.ts';
import { buildCompactFall } from './compactFall.ts';
import { buildJiDiffuse } from './jiDiffuse.ts';
import { buildTopStep } from './topStep.ts';
import {
    ANIM_STYLE_CASCADE_DROP,
    ANIM_STYLE_FAKE_REEL,
    getAnimStyleMeta,
    resolveAnimStyleId,
    type AnimStyleId,
} from './animStyles.ts';

// ============================================================================
// 上下文 / 参数
// ============================================================================

export interface TemplateContext {
    boardView: BoardView;
    prev: PresentationState;
    curr: PresentationState;
    /** 时间轴上的下一帧（highlight 推断消除格用；可缺省） */
    next?: PresentationState;
    params: Record<string, unknown>;
    /** 播放事件总线（BoardDirector 注入；模板在动画连接处发事件） */
    events?: BoardEvents;
    /** 本转移的目标帧 index（事件 payload 用） */
    frameIndex?: number;
}

export interface ParamField {
    key: string;
    label: string;
    type: 'number' | 'select';
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: string; label: string }>;
}

export interface AnimTemplate {
    id: string;
    label: string;
    defaultParams: Record<string, unknown>;
    paramSchema: ParamField[];
    build(ctx: TemplateContext): IAnim;
}

// ============================================================================
// 工具
// ============================================================================

function num(params: Record<string, unknown>, key: string, fallback: number): number {
    const v = params[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 把 cc.tween 包成 IAnim 步 */
function tweenStep(node: Node, setup: (t: Tween<Node>) => Tween<Node>): IAnim {
    return starterAnim((finish) => {
        const t = setup(tween(node)).call(() => finish()).start();
        return () => t.stop();
    });
}

function ensureOpacity(node: Node): UIOpacity {
    return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
}

interface CellDiff {
    col: number;
    row: number;
    prevId: number | null;
    currId: number | null;
}

function diffCells(prev: PresentationState, curr: PresentationState): CellDiff[] {
    const out: CellDiff[] = [];
    const { cols, visibleRows } = curr.board.topology;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            const p = prev.board.resolved[c]?.[r]?.symbolId ?? null;
            const q = curr.board.resolved[c]?.[r]?.symbolId ?? null;
            if (p !== q) out.push({ col: c, row: r, prevId: p, currId: q });
        }
    }
    return out;
}

// ============================================================================
// 模板实现
// ============================================================================

/**
 * 事件步：在动画连接处发一个盘面事件并等待所有 handler。
 * handler 返回 Promise 时动画链会停在这里直到 resolve（暂停/继续语义）。
 */
function eventStep(
    ctx: TemplateContext,
    type: BoardEventType,
    cell?: { col: number; row: number; symbolId: number | null; multiplier?: number },
): IAnim {
    const ev = ctx.events;
    if (!ev) return call(() => undefined);
    return call(() =>
        ev.emit({
            type,
            frameIndex: ctx.frameIndex ?? -1,
            frameKind: readFrameExt(ctx.curr)?.frameKind ?? null,
            col: cell?.col,
            row: cell?.row,
            symbolId: cell?.symbolId,
            multiplier: cell?.multiplier,
        }),
    );
}

/** 播放时才构建（symbol 钩子必须等落地/生效时再取） */
function lazyCellAnim(build: () => IAnim | null): IAnim {
    return starterAnim((finish) => {
        const anim = build();
        if (!anim) {
            finish();
            return;
        }
        void anim.play().then(
            () => finish(),
            () => finish(),
        );
        return () => {
            if (anim.isPlaying) anim.cancel();
        };
    });
}

/** 惰性播放格子 symbol 的入场动效（prefab SymbolTemplate 或 spine enterAnim / 内置 enterFx；无则直接完成） */
function symbolEnterStep(boardView: BoardView, col: number, row: number): IAnim {
    return lazyCellAnim(() => boardView.getSymbolView(col, row)?.buildEnterAnim() ?? null);
}

/** 盘面节点局部坐标系下「屏幕上缘之外」的起始 y（保证从屏外落入） */
function offscreenTopY(boardView: BoardView): number {
    const ui = boardView.node.getComponent(UITransform);
    const screenTopLocal = ui
        ? ui.convertToNodeSpaceAR(new Vec3(0, view.getVisibleSize().height, 0)).y
        : 400;
    return screenTopLocal + boardView.cellH;
}

/**
 * 下落进场阶段：curr 有值且与 prev 不同的格子从屏外落下。
 * 下排先落（rowStagger 按 rows-1-row 计），重力加速（quadIn），落地后可配弹跳，不淡入。
 */
function buildDropInPhase(
    ctx: TemplateContext,
    opts: { dur: number; rowStagger: number; colStagger: number; bouncePx: number; bounceDur: number },
): IAnim {
    const { boardView, prev, curr } = ctx;
    const { cols, visibleRows } = curr.board.topology;
    const rows = Math.max(...visibleRows);
    const startY = offscreenTopY(boardView);
    const changed = diffCells(prev, curr).filter((d) => d.currId !== null);
    // 落距最长的格子用满 opts.dur，其余按距离等比缩短 → 各 symbol 下落速度一致
    const maxDist = Math.max(
        1,
        ...changed.map((d) => startY - boardView.cellPosition(d.col, d.row, cols, rows).y),
    );

    const steps: IAnim[] = changed.map((d) => {
        const node = boardView.getCellNode(d.col, d.row);
        if (!node) return call(() => undefined);
        const target = boardView.cellPosition(d.col, d.row, cols, rows);
        const fallDur = opts.dur * ((startY - target.y) / maxDist);
        return seq(
            delay(d.col * opts.colStagger + (rows - 1 - d.row) * opts.rowStagger),
            call(() => {
                boardView.applyCell(d.col, d.row, d.currId);
                node.setPosition(target.x, startY, 0);
                ensureOpacity(node).opacity = 255;
            }),
            tweenStep(node, (t) => {
                let tw = t.to(fallDur, { position: new Vec3(target.x, target.y, 0) }, { easing: 'quadIn' });
                if (opts.bouncePx > 0 && opts.bounceDur > 0) {
                    tw = tw
                        .to(opts.bounceDur * 0.5, { position: new Vec3(target.x, target.y + opts.bouncePx, 0) }, { easing: 'quadOut' })
                        .to(opts.bounceDur * 0.5, { position: new Vec3(target.x, target.y, 0) }, { easing: 'quadIn' });
                }
                return tw;
            }),
            eventStep(ctx, 'symbol-land', { col: d.col, row: d.row, symbolId: d.currId }),
            symbolEnterStep(boardView, d.col, d.row),
        );
    });
    return par(...steps);
}

/** 重力掉出阶段：prev 有值且将变化的格子加速掉出盘面下缘 */
function buildDropOutPhase(
    ctx: TemplateContext,
    opts: { dur: number; rowStagger: number; colStagger: number },
): IAnim {
    const { boardView, prev, curr } = ctx;
    const { cols, visibleRows } = curr.board.topology;
    const rows = Math.max(...visibleRows);
    const { h } = boardView.boardSize(cols, rows);
    const gone = diffCells(prev, curr).filter((d) => d.prevId !== null);

    const steps: IAnim[] = gone.map((d) => {
        const node = boardView.getCellNode(d.col, d.row);
        if (!node) return call(() => undefined);
        const home = boardView.cellPosition(d.col, d.row, cols, rows);
        const exitY = -h / 2 - boardView.cellH * 1.3;
        return seq(
            delay(d.col * opts.colStagger + (rows - 1 - d.row) * opts.rowStagger),
            par(
                tweenStep(node, (t) =>
                    t.to(opts.dur, { position: new Vec3(home.x, exitY, 0) }, { easing: 'quadIn' }),
                ),
                starterAnim((finish) => {
                    const op = ensureOpacity(node);
                    const tw = tween(op).delay(opts.dur * 0.5).to(opts.dur * 0.5, { opacity: 0 }).call(() => finish()).start();
                    return () => tw.stop();
                }),
            ),
            call(() => {
                // 掉出后清格并归位（若 curr 有新值，dropIn 阶段会重新摆）
                boardView.applyCell(d.col, d.row, null);
                node.setPosition(home);
                ensureOpacity(node).opacity = 255;
            }),
        );
    });
    return par(...steps);
}

const dropInTemplate: AnimTemplate = {
    id: 'dropIn',
    label: '下落进场',
    defaultParams: { fallDuration: 0.45, rowStagger: 0.06, colStagger: 0.05, bouncePx: 18, bounceDuration: 0.12 },
    paramSchema: [
        { key: 'fallDuration', label: '时长(s)', type: 'number', min: 0.05, max: 2, step: 0.05 },
        { key: 'rowStagger', label: '行交错(s)', type: 'number', min: 0, max: 0.5, step: 0.01 },
        { key: 'colStagger', label: '列交错(s)', type: 'number', min: 0, max: 0.5, step: 0.01 },
        { key: 'bouncePx', label: '弹跳高度(px)', type: 'number', min: 0, max: 80, step: 2 },
        { key: 'bounceDuration', label: '弹跳时长(s)', type: 'number', min: 0, max: 0.5, step: 0.02 },
    ],
    build(ctx: TemplateContext): IAnim {
        return buildDropInPhase(ctx, {
            dur: num(ctx.params, 'fallDuration', 0.45),
            rowStagger: num(ctx.params, 'rowStagger', 0.06),
            colStagger: num(ctx.params, 'colStagger', 0.05),
            bouncePx: num(ctx.params, 'bouncePx', 18),
            bounceDur: num(ctx.params, 'bounceDuration', 0.12),
        });
    },
};

// ---------------------------------------------------------------------------
// compactFall：压缩补位（存活下沉 + 可选顶部新符落入）
// ---------------------------------------------------------------------------

const compactFallTemplate: AnimTemplate = {
    id: 'compactFall',
    label: '压缩补位',
    defaultParams: { fallDuration: 0.3, colStagger: 0, bouncePx: 14, bounceDuration: 0.1 },
    paramSchema: [
        { key: 'fallDuration', label: '时长(s)', type: 'number', min: 0.05, max: 2, step: 0.05 },
        { key: 'colStagger', label: '列交错(s)', type: 'number', min: 0, max: 0.5, step: 0.01 },
        { key: 'bouncePx', label: '弹跳高度(px)', type: 'number', min: 0, max: 80, step: 2 },
        { key: 'bounceDuration', label: '弹跳时长(s)', type: 'number', min: 0, max: 0.5, step: 0.02 },
    ],
    build(ctx: TemplateContext): IAnim {
        return buildCompactFall(ctx);
    },
};

const dropOutTemplate: AnimTemplate = {
    id: 'dropOut',
    label: '重力掉出',
    defaultParams: { fallDuration: 0.4, rowStagger: 0.05, colStagger: 0.05 },
    paramSchema: [
        { key: 'fallDuration', label: '时长(s)', type: 'number', min: 0.05, max: 2, step: 0.05 },
        { key: 'rowStagger', label: '行交错(s)', type: 'number', min: 0, max: 0.5, step: 0.01 },
        { key: 'colStagger', label: '列交错(s)', type: 'number', min: 0, max: 0.5, step: 0.01 },
    ],
    build(ctx: TemplateContext): IAnim {
        return buildDropOutPhase(ctx, {
            dur: num(ctx.params, 'fallDuration', 0.4),
            rowStagger: num(ctx.params, 'rowStagger', 0.05),
            colStagger: num(ctx.params, 'colStagger', 0.05),
        });
    },
};

const pulseTemplate: AnimTemplate = {
    id: 'pulse',
    label: '中奖脉冲',
    defaultParams: { scaleUp: 1.25, pulseDuration: 0.18, times: 2 },
    paramSchema: [
        { key: 'scaleUp', label: '放大倍数', type: 'number', min: 1, max: 2, step: 0.05 },
        { key: 'pulseDuration', label: '单次时长(s)', type: 'number', min: 0.05, max: 1, step: 0.01 },
        { key: 'times', label: '次数', type: 'number', min: 1, max: 6, step: 1 },
    ],
    build(ctx: TemplateContext): IAnim {
        const { boardView, curr, next, params } = ctx;
        const scaleUp = num(params, 'scaleUp', 1.25);
        const dur = num(params, 'pulseDuration', 0.18);
        const times = Math.round(num(params, 'times', 2));

        const cells = highlightCells(curr, next);
        if (!cells.length) return call(() => undefined);

        const steps: IAnim[] = cells.map(({ col, row }) => {
            const node = boardView.getCellNode(col, row);
            if (!node) return call(() => undefined);
            const base = node.scale.x;
            return loop(
                times,
                seq(
                    tweenStep(node, (t) =>
                        t.to(dur, { scale: new Vec3(base * scaleUp, base * scaleUp, 1) }, { easing: 'quadOut' }),
                    ),
                    tweenStep(node, (t) =>
                        t.to(dur, { scale: new Vec3(base, base, 1) }, { easing: 'quadIn' }),
                    ),
                ),
            );
        });
        return par(...steps);
    },
};

/** 高亮格集合：优先 wins；否则用「下一帧会变化的格子」推断 */
function highlightCells(
    curr: PresentationState,
    next: PresentationState | undefined,
): Array<{ col: number; row: number }> {
    const cells: Array<{ col: number; row: number }> = [];
    for (const win of curr.board.wins) cells.push(...win.cells);
    if (!cells.length && next) {
        for (const d of diffCells(curr, next)) cells.push({ col: d.col, row: d.row });
    }
    return cells;
}

const symbolWinTemplate: AnimTemplate = {
    id: 'symbolWin',
    label: '符号中奖动画',
    defaultParams: { stagger: 0 },
    paramSchema: [
        { key: 'stagger', label: '交错(s)', type: 'number', min: 0, max: 0.3, step: 0.01 },
    ],
    build(ctx: TemplateContext): IAnim {
        const { boardView, curr, next, params } = ctx;
        const stagger = num(params, 'stagger', 0);
        const cells = highlightCells(curr, next);
        if (!cells.length) return call(() => undefined);

        const steps: IAnim[] = cells.map(({ col, row }, i) =>
            seq(
                delay(i * stagger),
                eventStep(ctx, 'symbol-win', {
                    col,
                    row,
                    symbolId: curr.board.resolved[col]?.[row]?.symbolId ?? null,
                }),
                lazyCellAnim(() => {
                    // 符号自身 winAnim + 格子特效；都没配则回落一次小脉冲
                    const custom = boardView.getSymbolView(col, row)?.buildWinAnim();
                    if (custom) return custom;
                    const node = boardView.getCellNode(col, row);
                    if (!node) return null;
                    const base = node.scale.x;
                    return seq(
                        tweenStep(node, (t) =>
                            t.to(0.14, { scale: new Vec3(base * 1.2, base * 1.2, 1) }, { easing: 'quadOut' }),
                        ),
                        tweenStep(node, (t) =>
                            t.to(0.14, { scale: new Vec3(base, base, 1) }, { easing: 'quadIn' }),
                        ),
                    );
                }),
            ),
        );
        return par(...steps);
    },
};

const vanishTemplate: AnimTemplate = {
    id: 'vanish',
    label: '消除',
    defaultParams: { vanishDuration: 0.25, stagger: 0.02 },
    paramSchema: [
        { key: 'vanishDuration', label: '时长(s)', type: 'number', min: 0.05, max: 1, step: 0.05 },
        { key: 'stagger', label: '交错(s)', type: 'number', min: 0, max: 0.3, step: 0.01 },
    ],
    build(ctx: TemplateContext): IAnim {
        const { boardView, prev, curr, params } = ctx;
        const dur = num(params, 'vanishDuration', 0.25);
        const stagger = num(params, 'stagger', 0.02);
        const gone = diffCells(prev, curr).filter((d) => d.prevId !== null && d.currId === null);

        const steps: IAnim[] = gone.map((d, i) => {
            const node = boardView.getCellNode(d.col, d.row);
            if (!node) return call(() => undefined);
            return seq(
                delay(i * stagger),
                // 消除连接处事件：加分等业务挂这里；handler 返回 Promise 可暂停动画链
                eventStep(ctx, 'symbol-vanish', { col: d.col, row: d.row, symbolId: d.prevId }),
                lazyCellAnim(() =>
                    // 符号自身演出 + 格子特效并行；本体缺省缩淡由 SymbolView 内部
                    // 作用在 content 子节点上（不缩 cell，避免波及格子特效）
                    boardView.getSymbolView(d.col, d.row)?.buildVanishAnim(dur) ?? null,
                ),
                call(() => {
                    boardView.applyCell(d.col, d.row, null);
                    // cell 节点是动画载体，消除后仍归位一次（防其它模板残留缩放/透明度）
                    node.setScale(1, 1, 1);
                    ensureOpacity(node).opacity = 255;
                }),
            );
        });
        return par(...steps);
    },
};

interface MultiHop {
    fromCol: number;
    fromRow: number;
    toCol: number;
    toRow: number;
    symbolId: number;
    multiplier: number;
}

function readMultiCell(
    state: PresentationState,
    col: number,
    row: number,
): { symbolId: number; multiplier: number; expandFrom?: { col: number; row: number } } | null {
    const cell = state.board.resolved[col]?.[row];
    if (!cell || cell.symbolId === null || !cell.entityRef) return null;
    const ent = state.board.entities[cell.entityRef];
    if (!ent || ent.kind !== 'multi') return null;
    const raw = ent.meta?.expandFrom;
    let expandFrom: { col: number; row: number } | undefined;
    if (raw && typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        if (typeof o.col === 'number' && typeof o.row === 'number') expandFrom = { col: o.col, row: o.row };
    }
    return {
        symbolId: cell.symbolId,
        multiplier: Math.max(1, ent.multiplier ?? 1),
        expandFrom,
    };
}

/** 收集 prev→curr 新出现的 multi 格，并解析飞入源格 */
function collectMultiHops(prev: PresentationState, curr: PresentationState): MultiHop[] {
    const { cols, visibleRows } = curr.board.topology;
    const prevMultis: Array<{ col: number; row: number; symbolId: number }> = [];
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            const m = readMultiCell(prev, c, r);
            if (m) prevMultis.push({ col: c, row: r, symbolId: m.symbolId });
        }
    }

    const hops: MultiHop[] = [];
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            const cur = readMultiCell(curr, c, r);
            if (!cur) continue;
            const was = readMultiCell(prev, c, r);
            if (was && was.symbolId === cur.symbolId) continue; // 原位保留

            let fromCol = cur.expandFrom?.col;
            let fromRow = cur.expandFrom?.row;
            if (
                fromCol === undefined ||
                fromRow === undefined ||
                !readMultiCell(prev, fromCol, fromRow)
            ) {
                // 最近 prev multi（同 symbol 优先）
                let best: { col: number; row: number; d: number; same: boolean } | null = null;
                for (const p of prevMultis) {
                    const d = Math.abs(p.col - c) + Math.abs(p.row - r);
                    const same = p.symbolId === cur.symbolId;
                    if (
                        !best ||
                        (same && !best.same) ||
                        (same === best.same && d < best.d)
                    ) {
                        best = { col: p.col, row: p.row, d, same };
                    }
                }
                if (!best) continue;
                fromCol = best.col;
                fromRow = best.row;
            }
            hops.push({
                fromCol,
                fromRow,
                toCol: c,
                toRow: r,
                symbolId: cur.symbolId,
                multiplier: cur.multiplier,
            });
        }
    }
    return hops;
}

const multiExpandTemplate: AnimTemplate = {
    id: 'multiExpand',
    label: '倍率球扩散',
    defaultParams: { flyDuration: 0.4, particleSize: 30, stagger: 0.05 },
    paramSchema: [
        { key: 'flyDuration', label: '飞行时长(s)', type: 'number', min: 0.05, max: 1.5, step: 0.05 },
        { key: 'particleSize', label: '粒子大小', type: 'number', min: 8, max: 120, step: 2 },
        { key: 'stagger', label: '交错(s)', type: 'number', min: 0, max: 0.3, step: 0.01 },
    ],
    build(ctx: TemplateContext): IAnim {
        const { boardView, prev, curr, params } = ctx;
        const dur = num(params, 'flyDuration', 0.4);
        const particleSize = num(params, 'particleSize', 30);
        const stagger = num(params, 'stagger', 0.05);
        const hops = collectMultiHops(prev, curr);
        if (!hops.length) {
            return call(() => boardView.render(curr));
        }

        const { cols, visibleRows } = curr.board.topology;
        const rows = Math.max(...visibleRows);
        const fx = boardView.getCatalog()?.expandSplitFx;
        const trailSprite = resolveTrailSprite(fx?.splitParticle ?? null);
        const splitB = fx?.splitB ?? null;
        const animB = fx?.splitBAnim || 'split_B';

        if (!trailSprite || !splitB) {
            console.warn('[multiExpand] 缺少 trail sprite / expandSplitB，回落格节点飞入', {
                hasSprite: !!trailSprite,
                hasSplitB: !!splitB,
            });
            return buildLegacyMultiFly(ctx, hops, dur, stagger, cols, rows);
        }

        const hopsAnim: IAnim[] = hops.map((h, i) => {
            const from = boardView.cellPosition(h.fromCol, h.fromRow, cols, rows);
            const to = boardView.cellPosition(h.toCol, h.toRow, cols, rows);
            return seq(
                delay(i * stagger),
                eventStep(ctx, 'multi-expand', {
                    col: h.toCol,
                    row: h.toRow,
                    symbolId: h.symbolId,
                    multiplier: h.multiplier,
                }),
                // 飞弹与 split_B 略重叠：落地提前开，尾迹很快收进爆炸
                par(
                    starterAnim((finish) => {
                        const host = boardView.node;
                        let root: Node | null = null;
                        let ps: ParticleSystem2D | null = null;
                        let tw: Tween<Node> | null = null;
                        let drain: IAnim | null = null;
                        try {
                            const spawned = spawnBlueTimesTrail(host, trailSprite, from, {
                                startSize: particleSize,
                            });
                            root = spawned.root;
                            ps = spawned.ps;
                            tw = tween(root)
                                .to(dur, { position: new Vec3(to.x, to.y, 0) }, { easing: 'quadOut' })
                                .call(() => {
                                    if (ps?.isValid) ps.stopSystem();
                                    const head = root?.getChildByName('head');
                                    if (head?.isValid) head.active = false;
                                    finish();
                                    drain = delay(0.24);
                                    void drain.play().then(
                                        () => {
                                            if (root?.isValid) root.destroy();
                                        },
                                        () => undefined,
                                    );
                                })
                                .start();
                        } catch (err) {
                            console.warn('[multiExpand] trail 飞弹失败，直接落地', err);
                            if (root?.isValid) root.destroy();
                            finish();
                        }
                        return () => {
                            tw?.stop();
                            if (drain?.isPlaying) drain.cancel();
                            if (root?.isValid) root.destroy();
                        };
                    }),
                    seq(
                        delay(Math.max(0, dur - 0.08)),
                        starterAnim((finish) => {
                            const host = boardView.node;
                            const n = new Node('split_B_land');
                            n.layer = host.layer;
                            n.addComponent(UITransform);
                            const sk = n.addComponent(sp.Skeleton);
                            sk.skeletonData = splitB;
                            sk.premultipliedAlpha = false;
                            n.setPosition(to.x, to.y, 0);
                            host.addChild(n);
                            n.setSiblingIndex(host.children.length - 1);

                            let shown = false;
                            const showBall = (): void => {
                                if (shown) return;
                                shown = true;
                                boardView.applyCell(h.toCol, h.toRow, h.symbolId, h.multiplier);
                            };

                            sk.setEventListener((_entry, ev) => {
                                const name = (ev as { data?: { name?: string } })?.data?.name ?? '';
                                if (name === 'show symbol' || name === 'show_symbol' || name === 'split_B') {
                                    showBall();
                                }
                            });

                            let track: { animation?: { duration?: number } } | null = null;
                            try {
                                track = sk.setAnimation(0, animB, false) as {
                                    animation?: { duration?: number };
                                } | null;
                            } catch {
                                showBall();
                                if (n.isValid) n.destroy();
                                finish();
                                return () => undefined;
                            }

                            const mid = delay(Math.max(0.12, (track?.animation?.duration ?? 0.8) * 0.28));
                            void mid.play().then(
                                () => showBall(),
                                () => undefined,
                            );

                            sk.setCompleteListener(() => {
                                showBall();
                                if (n.isValid) n.destroy();
                                finish();
                            });

                            return () => {
                                if (mid.isPlaying) mid.cancel();
                                if (n.isValid) n.destroy();
                            };
                        }),
                    ),
                ),
                eventStep(ctx, 'multi-expand-land', {
                    col: h.toCol,
                    row: h.toRow,
                    symbolId: h.symbolId,
                    multiplier: h.multiplier,
                }),
            );
        });

        return par(...hopsAnim);
    },
};

/** 无 split 粒子时的旧飞入（格节点 tween） */
function buildLegacyMultiFly(
    ctx: TemplateContext,
    hops: MultiHop[],
    dur: number,
    stagger: number,
    cols: number,
    rows: number,
): IAnim {
    const { boardView } = ctx;
    const flies: IAnim[] = hops.map((h, i) => {
        const node = boardView.getCellNode(h.toCol, h.toRow);
        if (!node) return call(() => undefined);
        const from = boardView.cellPosition(h.fromCol, h.fromRow, cols, rows);
        const to = boardView.cellPosition(h.toCol, h.toRow, cols, rows);
        return seq(
            delay(i * stagger),
            eventStep(ctx, 'multi-expand', {
                col: h.toCol,
                row: h.toRow,
                symbolId: h.symbolId,
                multiplier: h.multiplier,
            }),
            call(() => {
                boardView.applyCell(h.toCol, h.toRow, h.symbolId, h.multiplier);
                node.setPosition(from.x, from.y, 0);
                node.setScale(0.35, 0.35, 1);
            }),
            tweenStep(node, (t) =>
                t.to(dur, { position: new Vec3(to.x, to.y, 0), scale: new Vec3(1, 1, 1) }, { easing: 'quadOut' }),
            ),
            call(() => {
                node.setScale(1, 1, 1);
                node.setPosition(to.x, to.y, 0);
            }),
            eventStep(ctx, 'multi-expand-land', {
                col: h.toCol,
                row: h.toRow,
                symbolId: h.symbolId,
                multiplier: h.multiplier,
            }),
        );
    });
    return par(...flies);
}

/** 当前帧（curr）上所有倍率球 — 全员参与收集，不求差、不看上一帧格子集合 */
function collectAllMultiBallsOnFrame(state: PresentationState): MultiHop[] {
    const { cols, visibleRows } = state.board.topology;
    const out: MultiHop[] = [];
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            const cell = state.board.resolved[c]?.[r];
            if (!cell?.entityRef || cell.symbolId === null) continue;
            const ent = state.board.entities[cell.entityRef];
            if (!ent || ent.kind !== 'multi') continue;

            let multiplier: number | null = null;
            if (typeof ent.multiplier === 'number' && Number.isFinite(ent.multiplier) && ent.multiplier > 0) {
                multiplier = ent.multiplier;
            } else if (ent.meta && typeof ent.meta === 'object') {
                const last = (ent.meta as Record<string, unknown>).lastMultiplier;
                if (typeof last === 'number' && Number.isFinite(last) && last > 0) multiplier = last;
            }
            if (multiplier === null) continue;

            out.push({
                fromCol: c,
                fromRow: r,
                toCol: c,
                toRow: r,
                symbolId: cell.symbolId,
                multiplier,
            });
        }
    }
    return out;
}

const multiCollectTemplate: AnimTemplate = {
    id: 'multiCollect',
    label: '倍率收集',
    defaultParams: { stagger: 0.04 },
    paramSchema: [
        { key: 'stagger', label: '交错(s)', type: 'number', min: 0, max: 0.3, step: 0.01 },
    ],
    build(ctx: TemplateContext): IAnim {
        const { boardView, prev, curr, params } = ctx;
        const stagger = num(params, 'stagger', 0.04);
        // 数字在 prev；curr 应为已收集（清掉 multiplier）。curr 误留数字时仍从 prev 取采集值。
        let collects = collectAllMultiBallsOnFrame(prev);
        if (!collects.length) collects = collectAllMultiBallsOnFrame(curr);
        if (!collects.length) {
            return call(() => boardView.render(curr, { suppressMultiDigits: true }));
        }

        // 播转移时 Director 会先渲染 prev；若 curr 已清掉数字，先把数字贴回再演收集
        const ensureDigits = call(() => {
            for (const h of collects) {
                boardView.applyCell(h.toCol, h.toRow, h.symbolId, h.multiplier);
            }
        });

        const steps: IAnim[] = collects.map((h, i) => {
            return seq(
                delay(i * stagger),
                eventStep(ctx, 'multi-collect', {
                    col: h.toCol,
                    row: h.toRow,
                    symbolId: h.symbolId,
                    multiplier: h.multiplier,
                }),
                // 数字与 spine 同时开始：倍率立刻消失，球播 function 转一下
                par(
                    call(() => {
                        boardView.applyCell(h.toCol, h.toRow, h.symbolId, null);
                    }),
                    lazyCellAnim(() => boardView.getSymbolView(h.toCol, h.toRow)?.buildMultiSpinAnim() ?? null),
                ),
            );
        });
        // 收尾再刷一次 curr 并压制数字，防止中途并行步骤写回
        const settle = call(() => boardView.render(curr, { suppressMultiDigits: true }));
        return seq(ensureDigits, par(...steps), settle);
    },
};

const fadeOutTemplate: AnimTemplate = {
    id: 'fadeOut',
    label: '淡出消除',
    defaultParams: { duration: 0.28, stagger: 0.02, scaleTo: 0.88 },
    paramSchema: [
        { key: 'duration', label: '时长(s)', type: 'number', min: 0.05, max: 1.5, step: 0.05 },
        { key: 'stagger', label: '交错(s)', type: 'number', min: 0, max: 0.3, step: 0.01 },
        { key: 'scaleTo', label: '缩到', type: 'number', min: 0.5, max: 1, step: 0.02 },
    ],
    build(ctx: TemplateContext): IAnim {
        return buildFadeOut(ctx);
    },
};

const jiDiffuseTemplate: AnimTemplate = {
    id: 'jiDiffuse',
    label: '戟扩散(横→竖)',
    defaultParams: {},
    paramSchema: [],
    build(ctx: TemplateContext): IAnim {
        return buildJiDiffuse(ctx);
    },
};

const topStepTemplate: AnimTemplate = {
    id: 'topStep',
    label: '横栏左移一格',
    defaultParams: { duration: 0.35 },
    paramSchema: [{ key: 'duration', label: '时长(s)', type: 'number', min: 0.08, max: 1.5, step: 0.05 }],
    build(ctx: TemplateContext): IAnim {
        return buildTopStep(ctx);
    },
};

const reelSpinTemplate: AnimTemplate = {
    id: 'reelSpin',
    label: '假轮带滚停',
    defaultParams: { duration: 1.15, colStagger: 0.08, minCycles: 2, maxCycles: 4 },
    paramSchema: [
        { key: 'duration', label: '时长(s)', type: 'number', min: 0.15, max: 4, step: 0.05 },
        { key: 'colStagger', label: '列交错(s)', type: 'number', min: 0, max: 0.5, step: 0.01 },
        { key: 'minCycles', label: '最少圈(列高)', type: 'number', min: 1, max: 8, step: 1 },
        { key: 'maxCycles', label: '最多圈(列高)', type: 'number', min: 1, max: 8, step: 1 },
    ],
    build(ctx: TemplateContext): IAnim {
        return buildReelSpin(ctx);
    },
};

const noopTemplate: AnimTemplate = {
    id: 'noop',
    label: '无动画',
    defaultParams: {},
    paramSchema: [],
    build(): IAnim {
        return call(() => undefined);
    },
};

// ============================================================================
// 注册表
// ============================================================================

const TEMPLATES: Record<string, AnimTemplate> = {
    reelSpin: reelSpinTemplate,
    fadeOut: fadeOutTemplate,
    jiDiffuse: jiDiffuseTemplate,
    topStep: topStepTemplate,
    dropIn: dropInTemplate,
    dropOut: dropOutTemplate,
    compactFall: compactFallTemplate,
    pulse: pulseTemplate,
    symbolWin: symbolWinTemplate,
    vanish: vanishTemplate,
    multiExpand: multiExpandTemplate,
    multiCollect: multiCollectTemplate,
    noop: noopTemplate,
};

/**
 * frameKind → 允许的模板列表（兼容表）。
 * 第一项为 cascade-drop 默认；fake-reel 由 allowedTemplateIds 置顶 reelSpin / fadeOut / jiDiffuse。
 */
const KIND_ALLOWED: Record<IrFrameKind, string[]> = {
    'enter-table': ['dropIn', 'noop'],
    reveal: ['dropIn', 'noop'],
    'bonus-reveal': ['dropIn', 'noop'],
    highlight: ['symbolWin', 'pulse', 'noop'],
    'bonus-highlight': ['symbolWin', 'pulse', 'noop'],
    'enter-table-mid-cascade': ['dropIn', 'noop'],
    postClear: ['vanish', 'dropOut', 'fadeOut', 'noop'],
    compact: ['compactFall', 'noop'],
    expandPre: ['pulse', 'noop'],
    expandPost: ['multiExpand', 'jiDiffuse', 'noop'],
    topStep: ['topStep', 'noop'],
    multiCollect: ['multiCollect', 'noop'],
    spinEnd: ['noop', 'pulse'],
};

/** @deprecated 用 AnimStyleId；保留别名避免外部断引用 */
export type AnimTemplateStyle = AnimStyleId;

export function animStyleFromBoardView(
    boardView: { getLayoutProfile(): { animStyleId?: string } | null } | null | undefined,
): AnimStyleId {
    return resolveAnimStyleId(boardView?.getLayoutProfile()?.animStyleId);
}

export function getTemplate(id: string): AnimTemplate | null {
    return TEMPLATES[id] ?? null;
}

export function allTemplates(): AnimTemplate[] {
    return Object.values(TEMPLATES);
}

/** 某 frameKind 允许的模板 id 列表（首项为当前风格的默认） */
export function allowedTemplateIds(kind: IrFrameKind, style: AnimStyleId = ANIM_STYLE_CASCADE_DROP): string[] {
    const base = KIND_ALLOWED[kind] ?? ['noop'];
    const meta = getAnimStyleMeta(style);
    if (style === ANIM_STYLE_FAKE_REEL && meta.reelRevealKinds?.includes(kind)) {
        const def = meta.defaultRevealTemplateId ?? 'reelSpin';
        return [def, ...base.filter((id) => id !== def)];
    }
    if (style === ANIM_STYLE_FAKE_REEL && kind === 'postClear' && meta.defaultPostClearTemplateId) {
        const def = meta.defaultPostClearTemplateId;
        return [def, ...base.filter((id) => id !== def)];
    }
    if (style === ANIM_STYLE_FAKE_REEL && kind === 'expandPost' && meta.defaultExpandPostTemplateId) {
        const def = meta.defaultExpandPostTemplateId;
        return [def, ...base.filter((id) => id !== def)];
    }
    return base;
}

/** override 对该 frameKind + 风格是否合法 */
export function isTemplateAllowed(
    kind: IrFrameKind,
    templateId: string,
    style: AnimStyleId = ANIM_STYLE_CASCADE_DROP,
): boolean {
    return allowedTemplateIds(kind, style).includes(templateId);
}

/** 按帧的 frameKind + templateId override 解析模板与参数（非法 override 回落默认） */
export function resolveTemplateForState(
    state: PresentationState,
    style: AnimStyleId = ANIM_STYLE_CASCADE_DROP,
): {
    template: AnimTemplate;
    params: Record<string, unknown>;
} {
    const ext = readFrameExt(state);
    const allowed = ext ? allowedTemplateIds(ext.frameKind, style) : ['noop'];
    const overrideId = ext?.templateId;
    const effectiveId = overrideId && allowed.includes(overrideId) ? overrideId : allowed[0];
    const template = TEMPLATES[effectiveId] ?? noopTemplate;
    const params = { ...template.defaultParams, ...(ext?.templateParams ?? {}) };
    return { template, params };
}
