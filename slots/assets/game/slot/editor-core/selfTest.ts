/**
 * editor-core 自测 — 不依赖 Cocos，可在预览页 / 浏览器控制台直接跑。
 * 返回 { ok, failures }；每条断言失败都收集，不抛异常中断。
 */

import {
    makeEmptyDoc,
    makeEmptyState,
    validateDoc,
    serializeDoc,
    deserializeDoc,
    resizeColumnVisibleRows,
    resizeBoardCols,
} from './session.ts';
import {
    AddStateCommand,
    RemoveStateCommand,
    SetResolvedCellCommand,
    SetFrameKindCommand,
    SetColumnVisibleRowsCommand,
    SetBoardColsCommand,
    CommandHistory,
} from './commands.ts';
import { readFrameExt } from './frameExt.ts';

export interface SelfTestResult {
    ok: boolean;
    total: number;
    failures: string[];
}

export function runEditorCoreSelfTest(): SelfTestResult {
    const failures: string[] = [];
    let total = 0;
    const check = (name: string, cond: boolean) => {
        total++;
        if (!cond) failures.push(name);
    };

    // 1. 空文档合法
    const doc = makeEmptyDoc('doc_test', '自测文档', 6, 5);
    check('empty doc valid', validateDoc(doc).length === 0);
    check('initial frameKind', readFrameExt(doc.states[0])?.frameKind === 'enter-table');

    // 2. 命令 + undo/redo
    const history = new CommandHistory(doc);
    history.execute(new AddStateCommand(1, doc.states[0], 'reveal'));
    check('addState count', doc.states.length === 2);
    check('addState kind', readFrameExt(doc.states[1])?.frameKind === 'reveal');

    history.execute(new SetResolvedCellCommand(1, 2, 3, 7));
    check('setCell value', doc.states[1].board.resolved[2][3].symbolId === 7);
    check('setCell isolated', doc.states[0].board.resolved[2][3].symbolId === null);

    history.execute(new SetFrameKindCommand(1, 'highlight'));
    check('setFrameKind', readFrameExt(doc.states[1])?.frameKind === 'highlight');

    history.undo();
    check('undo frameKind', readFrameExt(doc.states[1])?.frameKind === 'reveal');
    history.undo();
    check('undo setCell', doc.states[1].board.resolved[2][3].symbolId === null);
    history.redo();
    check('redo setCell', doc.states[1].board.resolved[2][3].symbolId === 7);

    // 3. removeState 守护
    let threw = false;
    const single = makeEmptyDoc('doc_single', '单帧', 2, 2);
    try {
        new RemoveStateCommand(0).apply(single);
    } catch {
        threw = true;
    }
    check('removeState guard', threw);

    // 4. 编辑后仍然是合法 SPIR
    check('doc valid after edits', validateDoc(doc).length === 0);

    // 5. serde round-trip（含 anchors Set）
    doc.states[0].board.anchors.locks.add('1,1');
    const restored = deserializeDoc(serializeDoc(doc));
    check('roundtrip states', restored.states.length === doc.states.length);
    check('roundtrip cell', restored.states[1].board.resolved[2][3].symbolId === 7);
    check('roundtrip Set', restored.states[0].board.anchors.locks.has('1,1'));
    check('roundtrip valid', validateDoc(restored).length === 0);

    // 6. makeEmptyState 各 frameKind 不变式
    const reveal = makeEmptyState({ sessionId: 's', cols: 3, rows: 3, frameKind: 'reveal' });
    check('reveal phase', reveal.phase === 'consequence');

    // 7. 每帧、每列可变 visibleRows（吕布类变数盘面的 SPIR 语义）
    const ragged = makeEmptyState({
        sessionId: 'ragged',
        cols: 6,
        visibleRows: [7, 5, 3, 6, 2, 4],
        frameKind: 'reveal',
    });
    check('ragged topology preserved', ragged.board.topology.visibleRows.join(',') === '7,5,3,6,2,4');
    check(
        'ragged grid dims',
        ragged.board.resolved.map((col) => col.length).join(',') === '7,5,3,6,2,4',
    );
    check('ragged state valid', validateDoc({ docVersion: 1, id: 'r', name: 'r', states: [ragged] }).length === 0);

    const raggedNext = makeEmptyState({
        sessionId: 'ragged',
        cols: 6,
        visibleRows: [2, 4, 7, 3, 6, 5],
        frameKind: 'reveal',
    });
    const raggedDoc = { docVersion: 1 as const, id: 'ragged', name: 'ragged', states: [ragged, raggedNext] };
    const raggedRestored = deserializeDoc(serializeDoc(raggedDoc));
    check(
        'per-frame topology roundtrip',
        raggedRestored.states[0].board.topology.visibleRows[0] === 7 &&
            raggedRestored.states[1].board.topology.visibleRows[0] === 2,
    );
    check('per-frame topology valid', validateDoc(raggedRestored).length === 0);

    // 8. 列高伸缩 + 命令 undo
    const heightDoc = makeEmptyDoc('doc_h', '列高', 6, [7, 7, 7, 7, 7, 7]);
    heightDoc.states[0].board.resolved[0][6].symbolId = 8;
    resizeColumnVisibleRows(heightDoc.states[0], 0, 4);
    check('resize shrink rows', heightDoc.states[0].board.topology.visibleRows[0] === 4);
    check('resize shrink drops bottom', heightDoc.states[0].board.resolved[0].length === 4);
    check('resize shrink drops symbol', heightDoc.states[0].board.resolved[0].every((c) => c.symbolId === null));
    resizeColumnVisibleRows(heightDoc.states[0], 0, 6);
    check('resize grow rows', heightDoc.states[0].board.topology.visibleRows[0] === 6);
    check('resize grow length', heightDoc.states[0].board.resolved[0].length === 6);

    const hHist = new CommandHistory(heightDoc);
    hHist.execute(new SetColumnVisibleRowsCommand(0, 1, 3));
    check('cmd set col rows', heightDoc.states[0].board.topology.visibleRows[1] === 3);
    hHist.undo();
    check('cmd undo col rows', heightDoc.states[0].board.topology.visibleRows[1] === 7);

    const colsDoc = makeEmptyDoc('doc_cols', '列数', 4, [3, 3, 3, 3]);
    resizeBoardCols(colsDoc.states[0], 6, 2);
    check('resize grow cols', colsDoc.states[0].board.topology.cols === 6);
    check('resize grow visibleRows len', colsDoc.states[0].board.topology.visibleRows.length === 6);
    check('resize grow new col rows', colsDoc.states[0].board.topology.visibleRows[5] === 2);
    resizeBoardCols(colsDoc.states[0], 3);
    check('resize shrink cols', colsDoc.states[0].board.topology.cols === 3);
    check('resize shrink grids', colsDoc.states[0].board.resolved.length === 3);

    const cmdCols = makeEmptyDoc('doc_cols_cmd', '列数cmd', 5, 4);
    const hist2 = new CommandHistory(cmdCols);
    hist2.execute(new SetBoardColsCommand(7));
    check('cmd set cols', cmdCols.states[0].board.topology.cols === 7);
    hist2.undo();
    check('cmd undo cols', cmdCols.states[0].board.topology.cols === 5);
    check('height doc valid', validateDoc(heightDoc).length === 0);

    return { ok: failures.length === 0, total, failures };
}
