/**
 * EditorDoc — 盘面编辑器的文档模型。
 *
 * canonical 数据就是 SPIR：一份文档 = 有序的 PresentationState[]。
 * Editor UI 直接反射本结构，不另设中间层。
 */

import type { PresentationState, SymbolGrid, Cell } from '../vendor/slot-presentation-ir/index.ts';
import { SCHEMA_VERSION, serialize, deserialize, validateSchema } from '../vendor/slot-presentation-ir/index.ts';
import type { IrFrameKind } from './frameExt.ts';
import { readFrameExt, writeFrameExt } from './frameExt.ts';

/** 倍率球位图字布局（与 editor-app/multiDigitStyle 对齐；合入 PA 后由 BoardStage 应用） */
export interface EditorMultiDigitStyle {
    fontSize: number;
    lineHeight: number;
    boxH: number;
    offsetX: number;
    offsetY: number;
    anchorY: number;
    valign: 'bottom' | 'center';
}

export interface EditorDoc {
    /** 文档格式版本（editor-core 自己的，不是 SPIR schema 版本） */
    docVersion: 1;
    id: string;
    name: string;
    states: PresentationState[];
    /** 符号包 id（如 lvbu）；试玩 BoardStage 用来挂 layoutProfile / column-fill 档高 */
    packId?: string;
    /** 盘面级倍率数字样式；写回 cfg 后 PA 运行时生效（不依赖 localStorage） */
    multiDigitStyle?: EditorMultiDigitStyle;
}

export interface DocValidationIssue {
    stateIndex: number;
    code: string;
    message: string;
    path?: string;
}

// ============================================================================
// 工厂
// ============================================================================

/**
 * 创建规则或非等高网格。
 *
 * rows 传 number 时保持旧行为（每列等高）；传 number[] 时按列创建 ragged grid。
 */
export function makeGrid(
    cols: number,
    rows: number | readonly number[],
    symbolId: number | null = null,
): SymbolGrid {
    const rowCounts = normalizeVisibleRows(
        cols,
        typeof rows === 'number' ? Array.from({ length: cols }, () => rows) : rows,
    );
    const grid: SymbolGrid = [];
    for (let c = 0; c < cols; c++) {
        const col: Cell[] = [];
        for (let r = 0; r < rowCounts[c]!; r++) {
            col.push({ symbolId, entityRef: null });
        }
        grid.push(col);
    }
    return grid;
}

interface MakeStateBaseOptions {
    sessionId: string;
    cols: number;
    frameKind: IrFrameKind;
    cascadeIndex?: number;
    frameIndex?: number;
    fillSymbolId?: number | null;
}

/** 等高 rows 与逐列 visibleRows 在类型上互斥，避免产生两个真源。 */
export type MakeStateOptions = MakeStateBaseOptions &
    (
        | {
              /** 等高盘面的行数。保留用于兼容赛特等现有调用。 */
              rows: number;
              visibleRows?: never;
          }
        | {
              /**
               * 当前帧每列的逻辑位置数，允许相邻 state 使用不同数组。
               * 例：[7,5,3,6,2,4]。
               */
              rows?: never;
              visibleRows: readonly number[];
          }
    );

/** 生成一个结构合法的最小 PresentationState */
export function makeEmptyState(opts: MakeStateOptions): PresentationState {
    const { sessionId, cols, frameKind } = opts;
    const visibleRows = opts.visibleRows
        ? normalizeVisibleRows(cols, opts.visibleRows)
        : normalizeVisibleRows(cols, Array.from({ length: cols }, () => opts.rows));
    const extra: number[] = [];
    for (let c = 0; c < cols; c++) {
        extra.push(0);
    }
    const state: PresentationState = {
        version: SCHEMA_VERSION,
        sessionId,
        board: {
            topology: { cols, visibleRows, extraTop: extra.slice(), extraBottom: extra.slice() },
            display: makeGrid(cols, visibleRows, opts.fillSymbolId ?? null),
            resolved: makeGrid(cols, visibleRows, opts.fillSymbolId ?? null),
            entities: {},
            anchors: { locks: new Set<string>(), sticks: new Set<string>() },
            overlays: [],
            wins: [],
        },
        phase: frameKind === 'enter-table' || frameKind === 'spinEnd' ? 'idle' : 'consequence',
        sessionContext: { mode: 'ng' },
        totalWinDisplay: 0,
        extensions: {},
    };
    writeFrameExt(state, {
        cascadeIndex: opts.cascadeIndex ?? 0,
        frameIndex: opts.frameIndex ?? 0,
        frameKind,
    });
    return state;
}

function normalizeVisibleRows(cols: number, rows: readonly number[]): number[] {
    if (!Number.isInteger(cols) || cols < 1) {
        throw new Error(`cols 必须是正整数，收到 ${String(cols)}`);
    }
    if (rows.length !== cols) {
        throw new Error(`visibleRows 长度 ${rows.length} 必须等于 cols ${cols}`);
    }
    return rows.map((value, col) => {
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`visibleRows[${col}] 必须是 >= 1 的整数，收到 ${String(value)}`);
        }
        return value;
    });
}

/**
 * 由 source 生成压缩后的盘面：每列非空符号保序下沉到底部，空格聚到顶部。
 * 用于「自动生成 compact 帧」，保证 compact 前后帧的数据关联性一定正确。
 * 返回 null 表示盘面已经是压缩态（无需生成）。
 */
export function makeCompactedState(source: PresentationState): PresentationState | null {
    const next = deserialize(serialize(source));
    const { cols, visibleRows } = next.board.topology;
    let changed = false;
    for (let c = 0; c < cols; c++) {
        const rows = visibleRows[c];
        const ids: number[] = [];
        for (let r = 0; r < rows; r++) {
            const id = next.board.resolved[c][r].symbolId;
            if (id !== null) ids.push(id);
        }
        for (let r = 0; r < rows; r++) {
            const newId = r < rows - ids.length ? null : ids[r - (rows - ids.length)];
            if (next.board.resolved[c][r].symbolId !== newId) {
                next.board.resolved[c][r].symbolId = newId;
                changed = true;
            }
        }
    }
    if (!changed) return null;
    const ext = readFrameExt(next);
    writeFrameExt(next, {
        cascadeIndex: ext?.cascadeIndex ?? 0,
        frameIndex: (ext?.frameIndex ?? 0) + 1,
        frameKind: 'compact',
    });
    return next;
}

/**
 * 由 source 生成倍率球扩散后的盘面：每个 multi 实体向四邻空格复制一份（同符号/同倍率），
 * 并在新 entity.meta.expandFrom 记录源格，供 multiExpand 动画飞入。
 * 返回 null 表示无可扩散目标。
 */
export function makeExpandedState(source: PresentationState): PresentationState | null {
    const next = deserialize(serialize(source));
    const { cols, visibleRows } = next.board.topology;
    const dirs: Array<[number, number]> = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
    ];

    type Src = { col: number; row: number; symbolId: number; multiplier: number };
    const sources: Src[] = [];
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            const cell = next.board.resolved[c][r];
            if (cell.symbolId === null || !cell.entityRef) continue;
            const ent = next.board.entities[cell.entityRef];
            if (!ent || ent.kind !== 'multi') continue;
            sources.push({
                col: c,
                row: r,
                symbolId: cell.symbolId,
                multiplier: Math.max(1, ent.multiplier ?? 1),
            });
        }
    }
    if (!sources.length) return null;

    // 先快照空位，避免同一轮扩散互相占格
    const empty = new Set<string>();
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            if (next.board.resolved[c][r].symbolId === null) empty.add(`${c},${r}`);
        }
    }

    let placed = 0;
    const stamp = Date.now().toString(36);
    for (const src of sources) {
        for (const [dc, dr] of dirs) {
            const tc = src.col + dc;
            const tr = src.row + dr;
            const key = `${tc},${tr}`;
            if (!empty.has(key)) continue;
            if (tc < 0 || tc >= cols || tr < 0 || tr >= visibleRows[tc]) continue;
            empty.delete(key);
            const id = `m_exp_${tc}_${tr}_${stamp}_${placed}`;
            next.board.entities[id] = {
                id,
                symbolId: src.symbolId,
                anchor: { col: tc, row: tr },
                footprint: [[0, 0]],
                kind: 'multi',
                multiplier: src.multiplier,
                meta: { expandFrom: { col: src.col, row: src.row } },
            };
            next.board.resolved[tc][tr] = { symbolId: src.symbolId, entityRef: id };
            placed++;
        }
    }
    if (!placed) return null;

    const ext = readFrameExt(next);
    writeFrameExt(next, {
        cascadeIndex: ext?.cascadeIndex ?? 0,
        frameIndex: (ext?.frameIndex ?? 0) + 1,
        frameKind: 'expandPost',
        templateId: 'multiExpand',
    });
    return next;
}

/**
 * 由 source 生成「倍率收集」后的盘面：倍率球保留，清掉 entity.multiplier，
 * 并把原数字写入 meta.lastMultiplier（动画/事件用）。
 */
export function makeMultiCollectedState(source: PresentationState): PresentationState | null {
    const next = deserialize(serialize(source));
    const { cols, visibleRows } = next.board.topology;
    let collected = 0;
    for (let c = 0; c < cols; c++) {
        for (let r = 0; r < visibleRows[c]; r++) {
            const cell = next.board.resolved[c][r];
            if (cell.symbolId === null || !cell.entityRef) continue;
            const ent = next.board.entities[cell.entityRef];
            if (!ent || ent.kind !== 'multi') continue;
            if (typeof ent.multiplier !== 'number' || !Number.isFinite(ent.multiplier) || ent.multiplier <= 0) {
                continue;
            }
            const meta =
                ent.meta && typeof ent.meta === 'object' && !Array.isArray(ent.meta)
                    ? { ...(ent.meta as Record<string, unknown>) }
                    : {};
            meta.lastMultiplier = ent.multiplier;
            ent.meta = meta;
            delete ent.multiplier;
            collected++;
        }
    }
    if (!collected) return null;

    const ext = readFrameExt(next);
    writeFrameExt(next, {
        cascadeIndex: ext?.cascadeIndex ?? 0,
        frameIndex: (ext?.frameIndex ?? 0) + 1,
        frameKind: 'multiCollect',
        templateId: 'multiCollect',
    });
    return next;
}

/** rows 可传统一行数或逐列 visibleRows。 */
export function makeEmptyDoc(
    id: string,
    name: string,
    cols: number,
    rows: number | readonly number[],
): EditorDoc {
    return {
        docVersion: 1,
        id,
        name,
        states: [
            makeEmptyState({
                sessionId: id,
                cols,
                ...(typeof rows === 'number' ? { rows } : { visibleRows: rows }),
                frameKind: 'enter-table',
            }),
        ],
    };
}

/**
 * 调整盘面列数（从右侧增减）。
 * 伸长：追加空列（默认 defaultRows 格）；缩短：丢掉最右列并清理 entity。
 */
export function resizeBoardCols(
    state: PresentationState,
    nextCols: number,
    defaultRows = 5,
): void {
    const topo = state.board.topology;
    const prevCols = topo.cols;
    if (!Number.isInteger(nextCols) || nextCols < 1) {
        throw new Error(`cols 必须是 >= 1 的整数，收到 ${String(nextCols)}`);
    }
    if (nextCols === prevCols) return;

    const rowsPerNew =
        Number.isInteger(defaultRows) && defaultRows >= 1
            ? defaultRows
            : Math.max(1, ...topo.visibleRows, 5);

    if (nextCols > prevCols) {
        for (let c = prevCols; c < nextCols; c++) {
            topo.visibleRows.push(rowsPerNew);
            topo.extraTop.push(0);
            topo.extraBottom.push(0);
            const colCells = [];
            for (let r = 0; r < rowsPerNew; r++) {
                colCells.push({ symbolId: null, entityRef: null });
            }
            state.board.resolved.push(colCells.map((cell) => ({ ...cell })));
            state.board.display.push(colCells.map((cell) => ({ ...cell })));
        }
    } else {
        for (let c = nextCols; c < prevCols; c++) {
            for (const grid of [state.board.resolved, state.board.display]) {
                const column = grid[c];
                if (!column) continue;
                for (const cell of column) {
                    if (cell?.entityRef) delete state.board.entities[cell.entityRef];
                }
            }
        }
        topo.visibleRows.length = nextCols;
        topo.extraTop.length = nextCols;
        topo.extraBottom.length = nextCols;
        state.board.resolved.length = nextCols;
        state.board.display.length = nextCols;
        for (const id of Object.keys(state.board.entities)) {
            const ent = state.board.entities[id];
            if (!ent) continue;
            if (ent.anchor.col >= nextCols) delete state.board.entities[id];
        }
    }
    topo.cols = nextCols;
}

/**
 * 调整某列 visibleRows，并同步 resolved/display 列长度。
 * 伸长：底部追加空格；缩短：从底部截断并清理越界 entity。
 */
export function resizeColumnVisibleRows(state: PresentationState, col: number, nextRows: number): void {
    const { cols, visibleRows } = state.board.topology;
    if (!Number.isInteger(col) || col < 0 || col >= cols) {
        throw new Error(`col 越界：${col}（cols=${cols}）`);
    }
    if (!Number.isInteger(nextRows) || nextRows < 1) {
        throw new Error(`visibleRows[${col}] 必须是 >= 1 的整数，收到 ${String(nextRows)}`);
    }
    const prev = visibleRows[col]!;
    if (nextRows === prev) return;

    visibleRows[col] = nextRows;
    for (const grid of [state.board.resolved, state.board.display]) {
        const column = grid[col]!;
        if (nextRows > prev) {
            for (let r = prev; r < nextRows; r++) {
                column.push({ symbolId: null, entityRef: null });
            }
        } else {
            for (let r = nextRows; r < prev; r++) {
                const cell = column[r];
                if (cell?.entityRef) delete state.board.entities[cell.entityRef];
            }
            column.length = nextRows;
        }
    }

    for (const id of Object.keys(state.board.entities)) {
        const ent = state.board.entities[id];
        if (!ent) continue;
        if (ent.anchor.col === col && ent.anchor.row >= nextRows) {
            delete state.board.entities[id];
        }
    }
    for (let r = 0; r < nextRows; r++) {
        for (const grid of [state.board.resolved, state.board.display]) {
            const cell = grid[col]![r]!;
            if (cell.entityRef && !state.board.entities[cell.entityRef]) {
                cell.entityRef = null;
            }
        }
    }
}

// ============================================================================
// 校验
// ============================================================================

/** 逐帧跑 vendor validateSchema；返回全部问题（空数组 = 通过） */
export function validateDoc(doc: EditorDoc): DocValidationIssue[] {
    const issues: DocValidationIssue[] = [];
    if (!doc || doc.docVersion !== 1) {
        issues.push({ stateIndex: -1, code: 'DOC', message: 'docVersion 必须为 1' });
        return issues;
    }
    if (!Array.isArray(doc.states) || doc.states.length === 0) {
        issues.push({ stateIndex: -1, code: 'DOC', message: 'states 不能为空' });
        return issues;
    }
    doc.states.forEach((state, i) => {
        const r = validateSchema(state);
        if (!r.ok) {
            issues.push({ stateIndex: i, code: r.code, message: r.message, path: r.path });
        }
    });
    return issues;
}

// ============================================================================
// 序列化（Set ⇄ $set 由 vendor serde 处理）
// ============================================================================

export function serializeDoc(doc: EditorDoc, indent = 2): string {
    const plain: Record<string, unknown> = {
        docVersion: doc.docVersion,
        id: doc.id,
        name: doc.name,
        states: doc.states.map((s) => JSON.parse(serialize(s))),
    };
    if (doc.packId) plain.packId = doc.packId;
    if (doc.multiDigitStyle) plain.multiDigitStyle = doc.multiDigitStyle;
    return JSON.stringify(plain, null, indent);
}

export function deserializeDoc(json: string): EditorDoc {
    const raw = JSON.parse(json) as {
        docVersion: number;
        id: string;
        name: string;
        states: unknown[];
        packId?: string;
        multiDigitStyle?: EditorMultiDigitStyle;
    };
    const doc: EditorDoc = {
        docVersion: 1,
        id: raw.id,
        name: raw.name,
        states: (raw.states ?? []).map((s) => deserialize(JSON.stringify(s))),
    };
    const packId = String(raw.packId || '').trim();
    if (packId) doc.packId = packId;
    if (raw.multiDigitStyle && typeof raw.multiDigitStyle === 'object') {
        doc.multiDigitStyle = raw.multiDigitStyle;
    }
    return doc;
}
