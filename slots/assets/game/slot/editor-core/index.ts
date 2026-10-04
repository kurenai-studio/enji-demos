/**
 * editor-core 公开入口 — 纯逻辑，无 Cocos 依赖。
 */

export type { IrFrameKind, IrFrameExtension } from './frameExt.ts';
export {
    IR_FRAME_KINDS,
    IR_FRAME_KIND_LABELS,
    frameKindLabel,
    readFrameExt,
    writeFrameExt,
    ensureTopStripSymbols,
    isIrFrameKind,
} from './frameExt.ts';

export type {
    EditorDoc,
    EditorMultiDigitStyle,
    DocValidationIssue,
    MakeStateOptions,
} from './session.ts';
export {
    makeGrid,
    makeEmptyState,
    makeEmptyDoc,
    makeCompactedState,
    makeExpandedState,
    makeMultiCollectedState,
    resizeBoardCols,
    resizeColumnVisibleRows,
    validateDoc,
    serializeDoc,
    deserializeDoc,
} from './session.ts';

export type { EditorCommand } from './commands.ts';
export {
    AddStateCommand,
    RemoveStateCommand,
    MoveStateCommand,
    SetResolvedCellCommand,
    SetEntityMultiplierCommand,
    SetFrameKindCommand,
    SetColumnVisibleRowsCommand,
    SetBoardColsCommand,
    SetTopStripCellCommand,
    PatchFrameExtCommand,
    CompositeCommand,
    CommandHistory,
} from './commands.ts';

export { runEditorCoreSelfTest } from './selfTest.ts';
