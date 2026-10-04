/**
 * 编辑命令层 — 所有对 EditorDoc 的修改都经由 Command，天然支持 undo/redo。
 *
 * M0 只提供最小集：addState / removeState / moveState / setResolvedCell / setFrameKind。
 * revert 采用 apply 时捕获的逆数据（非全文档快照）。
 */

import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';
import { deserialize, serialize } from '../vendor/slot-presentation-ir/index.ts';
import type { EditorDoc } from './session.ts';
import { resizeBoardCols, resizeColumnVisibleRows } from './session.ts';
import type { IrFrameKind, IrFrameExtension } from './frameExt.ts';
import { readFrameExt, writeFrameExt, ensureTopStripSymbols } from './frameExt.ts';

export interface EditorCommand {
    readonly label: string;
    apply(doc: EditorDoc): void;
    revert(doc: EditorDoc): void;
}

function cloneState(state: PresentationState): PresentationState {
    return deserialize(serialize(state));
}

// ============================================================================
// 命令实现
// ============================================================================

/** 在 index 处插入 state（默认克隆前一帧，保持盘面连续） */
export class AddStateCommand implements EditorCommand {
    readonly label = 'addState';
    private inserted: PresentationState;
    constructor(
        private index: number,
        source: PresentationState,
        frameKind?: IrFrameKind,
    ) {
        this.inserted = cloneState(source);
        if (frameKind) {
            const ext = readFrameExt(this.inserted);
            writeFrameExt(this.inserted, {
                ...(ext ?? { cascadeIndex: 0, frameIndex: 0, frameKind: 'reveal' }),
                cascadeIndex: ext?.cascadeIndex ?? 0,
                frameIndex: (ext?.frameIndex ?? 0) + 1,
                frameKind,
                topStrip: ext?.topStrip ? ext.topStrip.slice() : ext?.topStrip,
            });
        }
    }
    apply(doc: EditorDoc): void {
        doc.states.splice(this.index, 0, this.inserted);
    }
    revert(doc: EditorDoc): void {
        doc.states.splice(this.index, 1);
    }
}

export class RemoveStateCommand implements EditorCommand {
    readonly label = 'removeState';
    private removed: PresentationState | null = null;
    constructor(private index: number) {}
    apply(doc: EditorDoc): void {
        if (doc.states.length <= 1) throw new Error('至少保留一帧');
        this.removed = doc.states.splice(this.index, 1)[0] ?? null;
    }
    revert(doc: EditorDoc): void {
        if (this.removed) doc.states.splice(this.index, 0, this.removed);
    }
}

export class MoveStateCommand implements EditorCommand {
    readonly label = 'moveState';
    constructor(
        private from: number,
        private to: number,
    ) {}
    apply(doc: EditorDoc): void {
        const [s] = doc.states.splice(this.from, 1);
        doc.states.splice(this.to, 0, s);
    }
    revert(doc: EditorDoc): void {
        const [s] = doc.states.splice(this.to, 1);
        doc.states.splice(this.from, 0, s);
    }
}

/** 改 resolved 某格 symbolId（Editor 网格点击的核心命令） */
export class SetResolvedCellCommand implements EditorCommand {
    readonly label = 'setResolvedCell';
    private prevSymbolId: number | null = null;
    private prevEntityRef: string | null = null;
    private prevEntityJson: string | null = null;
    private createdEntityId: string | null = null;

    constructor(
        private stateIndex: number,
        private col: number,
        private row: number,
        private symbolId: number | null,
        /** 刷 multi 球时传入：写入 1×1 entity + multiplier */
        private multi?: { multiplier: number } | null,
    ) {}

    apply(doc: EditorDoc): void {
        const board = doc.states[this.stateIndex].board;
        const cell = board.resolved[this.col][this.row];
        this.prevSymbolId = cell.symbolId;
        this.prevEntityRef = cell.entityRef;
        this.prevEntityJson = null;
        this.createdEntityId = null;

        if (cell.entityRef) {
            const ent = board.entities[cell.entityRef];
            if (ent) this.prevEntityJson = JSON.stringify(ent);
            delete board.entities[cell.entityRef];
            cell.entityRef = null;
        }

        cell.symbolId = this.symbolId;

        if (this.symbolId !== null && this.multi) {
            const id = `m_${this.col}_${this.row}_${this.stateIndex}_${Date.now().toString(36)}`;
            board.entities[id] = {
                id,
                symbolId: this.symbolId,
                anchor: { col: this.col, row: this.row },
                footprint: [[0, 0]],
                kind: 'multi',
                multiplier: Math.max(1, this.multi.multiplier),
            };
            cell.entityRef = id;
            this.createdEntityId = id;
        }
    }

    revert(doc: EditorDoc): void {
        const board = doc.states[this.stateIndex].board;
        const cell = board.resolved[this.col][this.row];
        if (this.createdEntityId) {
            delete board.entities[this.createdEntityId];
            cell.entityRef = null;
        }
        cell.symbolId = this.prevSymbolId;
        cell.entityRef = this.prevEntityRef;
        if (this.prevEntityRef && this.prevEntityJson) {
            board.entities[this.prevEntityRef] = JSON.parse(this.prevEntityJson);
        }
    }
}

/** 修改某格关联 entity 的 multiplier（仅 multi 球） */
export class SetEntityMultiplierCommand implements EditorCommand {
    readonly label = 'setEntityMultiplier';
    private prev: number | undefined = undefined;
    private entityId: string | null = null;

    constructor(
        private stateIndex: number,
        private col: number,
        private row: number,
        private next: number,
    ) {}

    apply(doc: EditorDoc): void {
        const board = doc.states[this.stateIndex].board;
        const cell = board.resolved[this.col]?.[this.row];
        const id = cell?.entityRef ?? null;
        this.entityId = id;
        if (!id || !board.entities[id]) return;
        this.prev = board.entities[id].multiplier;
        board.entities[id].multiplier = Math.max(1, this.next);
    }

    revert(doc: EditorDoc): void {
        if (!this.entityId) return;
        const ent = doc.states[this.stateIndex].board.entities[this.entityId];
        if (!ent) return;
        if (this.prev === undefined) delete ent.multiplier;
        else ent.multiplier = this.prev;
    }
}

export class SetFrameKindCommand implements EditorCommand {
    readonly label = 'setFrameKind';
    private prev: IrFrameKind | null = null;
    constructor(
        private stateIndex: number,
        private frameKind: IrFrameKind,
    ) {}
    apply(doc: EditorDoc): void {
        const state = doc.states[this.stateIndex];
        const ext = readFrameExt(state);
        this.prev = ext?.frameKind ?? null;
        writeFrameExt(state, {
            cascadeIndex: ext?.cascadeIndex ?? 0,
            frameIndex: ext?.frameIndex ?? this.stateIndex,
            frameKind: this.frameKind,
            clearTime: ext?.clearTime,
            clearType: ext?.clearType,
            templateId: ext?.templateId,
            templateParams: ext?.templateParams,
        });
    }
    revert(doc: EditorDoc): void {
        if (this.prev === null) return;
        const state = doc.states[this.stateIndex];
        const ext = readFrameExt(state);
        writeFrameExt(state, {
            cascadeIndex: ext?.cascadeIndex ?? 0,
            frameIndex: ext?.frameIndex ?? this.stateIndex,
            frameKind: this.prev,
            clearTime: ext?.clearTime,
            clearType: ext?.clearType,
            templateId: ext?.templateId,
            templateParams: ext?.templateParams,
        });
    }
}

/** 调整当前帧某列 visibleRows（伸长追加空底格，缩短截断底格） */
export class SetColumnVisibleRowsCommand implements EditorCommand {
    readonly label = 'setColumnVisibleRows';
    private prevRows = 0;
    private prevResolvedJson = '';
    private prevDisplayJson = '';
    private prevEntitiesJson = '';

    constructor(
        private stateIndex: number,
        private col: number,
        private nextRows: number,
    ) {}

    apply(doc: EditorDoc): void {
        const state = doc.states[this.stateIndex];
        const board = state.board;
        this.prevRows = board.topology.visibleRows[this.col]!;
        this.prevResolvedJson = JSON.stringify(board.resolved[this.col]);
        this.prevDisplayJson = JSON.stringify(board.display[this.col]);
        this.prevEntitiesJson = JSON.stringify(board.entities);
        resizeColumnVisibleRows(state, this.col, this.nextRows);
    }

    revert(doc: EditorDoc): void {
        const board = doc.states[this.stateIndex].board;
        board.topology.visibleRows[this.col] = this.prevRows;
        board.resolved[this.col] = JSON.parse(this.prevResolvedJson);
        board.display[this.col] = JSON.parse(this.prevDisplayJson);
        board.entities = JSON.parse(this.prevEntitiesJson);
    }
}

/**
 * 调整文档所有帧的列数（从右侧增减），保持各帧拓扑列数一致。
 * 新列默认格数取当前帧已有列的最大值（至少 1）。
 */
export class SetBoardColsCommand implements EditorCommand {
    readonly label = 'setBoardCols';
    private prevBoardsJson: string[] = [];

    constructor(private nextCols: number) {}

    apply(doc: EditorDoc): void {
        this.prevBoardsJson = doc.states.map((s) => JSON.stringify(s.board));
        const refRows = Math.max(
            1,
            ...(doc.states[0]?.board.topology.visibleRows ?? [5]),
        );
        for (const state of doc.states) {
            resizeBoardCols(state, this.nextCols, refRows);
        }
    }

    revert(doc: EditorDoc): void {
        for (let i = 0; i < doc.states.length; i++) {
            const raw = this.prevBoardsJson[i];
            if (!raw) continue;
            doc.states[i]!.board = JSON.parse(raw);
        }
    }
}

/** 修改帧扩展（templateId / templateParams / clearTime…），整体快照回退 */
export class PatchFrameExtCommand implements EditorCommand {
    readonly label = 'patchFrameExt';
    private prev: IrFrameExtension | null = null;
    constructor(
        private stateIndex: number,
        private patch: Partial<IrFrameExtension>,
    ) {}
    apply(doc: EditorDoc): void {
        const state = doc.states[this.stateIndex];
        const ext = readFrameExt(state);
        this.prev = ext ? JSON.parse(JSON.stringify(ext)) : null;
        const base: IrFrameExtension = ext ?? {
            cascadeIndex: 0,
            frameIndex: this.stateIndex,
            frameKind: 'reveal',
        };
        const merged: IrFrameExtension = { ...base, ...this.patch };
        // patch 里显式给 undefined 的键 = 删除该键
        for (const key of Object.keys(this.patch) as Array<keyof IrFrameExtension>) {
            if (this.patch[key] === undefined) delete merged[key];
        }
        writeFrameExt(state, merged);
    }
    revert(doc: EditorDoc): void {
        if (this.prev) writeFrameExt(doc.states[this.stateIndex], this.prev);
    }
}

/** 顶条独立格（不写主盘 resolved） */
export class SetTopStripCellCommand implements EditorCommand {
    readonly label = 'setTopStripCell';
    private prev: number | null = null;

    constructor(
        private stateIndex: number,
        private stripIndex: number,
        private symbolId: number | null,
        private stripCount: number,
    ) {}

    apply(doc: EditorDoc): void {
        const state = doc.states[this.stateIndex];
        const ext = readFrameExt(state);
        const base: IrFrameExtension = ext ?? {
            cascadeIndex: 0,
            frameIndex: this.stateIndex,
            frameKind: 'reveal',
        };
        const arr = ensureTopStripSymbols(base, this.stripCount);
        this.prev = arr[this.stripIndex] ?? null;
        arr[this.stripIndex] = this.symbolId;
        writeFrameExt(state, { ...base, topStrip: arr });
    }

    revert(doc: EditorDoc): void {
        const state = doc.states[this.stateIndex];
        const ext = readFrameExt(state);
        const base: IrFrameExtension = ext ?? {
            cascadeIndex: 0,
            frameIndex: this.stateIndex,
            frameKind: 'reveal',
        };
        const arr = ensureTopStripSymbols(base, this.stripCount);
        arr[this.stripIndex] = this.prev;
        writeFrameExt(state, { ...base, topStrip: arr });
    }
}

/** 复合命令：一组命令合成一次 undo（如刷子一笔）。 */
export class CompositeCommand implements EditorCommand {
    constructor(
        readonly label: string,
        private commands: EditorCommand[],
    ) {}
    get size(): number {
        return this.commands.length;
    }
    apply(doc: EditorDoc): void {
        for (const c of this.commands) c.apply(doc);
    }
    revert(doc: EditorDoc): void {
        for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].revert(doc);
    }
}

// ============================================================================
// 历史栈
// ============================================================================

export class CommandHistory {
    private undoStack: EditorCommand[] = [];
    private redoStack: EditorCommand[] = [];
    constructor(private doc: EditorDoc) {}

    execute(cmd: EditorCommand): void {
        cmd.apply(this.doc);
        this.undoStack.push(cmd);
        this.redoStack.length = 0;
    }

    /** 命令已被外部逐步 apply 过（如刷子一笔），只入栈不再执行 */
    pushApplied(cmd: EditorCommand): void {
        this.undoStack.push(cmd);
        this.redoStack.length = 0;
    }

    undo(): boolean {
        const cmd = this.undoStack.pop();
        if (!cmd) return false;
        cmd.revert(this.doc);
        this.redoStack.push(cmd);
        return true;
    }

    redo(): boolean {
        const cmd = this.redoStack.pop();
        if (!cmd) return false;
        cmd.apply(this.doc);
        this.undoStack.push(cmd);
        return true;
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }
    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }
}
