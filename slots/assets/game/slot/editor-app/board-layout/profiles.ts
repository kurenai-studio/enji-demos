/**
 * ways-6x7-top-mid4 — 由吕布无双盘面抽离的布局 profile。
 *
 * 主盘：6 列 × 7 行，列优先 flat（index = col*7 + row），共 42 格。
 * 顶条：4 格独立数据（frame.topStrip）；mapToMain 仅导出对齐参考。
 * 符号角色 / tall 编码与线上一致，供编辑器与后续 runtime 共用。
 */

import type { BoardLayoutProfile } from './BoardLayout.ts';
import { flatIndex } from './BoardLayout.ts';

const COLS = 6;
const ROWS = 7;

function uniform(n: number, v: number): number[] {
    return Array.from({ length: n }, () => v);
}

export const WAYS_6X7_TOP_MID4: BoardLayoutProfile = {
    id: 'ways-6x7-top-mid4',
    name: 'Ways 6×7 + 顶条中四格',
    sourceNote: '吕布无双 server msg.h / ChangeResultWild；客户端 gridcell2',
    /** 假轮带滚停；非 pack 绑定 */
    animStyleId: 'fake-reel',
    topology: {
        cols: COLS,
        visibleRows: uniform(COLS, ROWS),
        extraTop: uniform(COLS, 0),
        extraBottom: uniform(COLS, 0),
    },
    flat: {
        cols: COLS,
        rows: ROWS,
        gridCount: COLS * ROWS,
    },
    topStrip: {
        count: 4,
        // m_iTopCenterPos[i] = (i+1)*GAME_ROW_COUNT → col = i+1, row = 0
        mapToMain: [
            { col: 1, row: 0 },
            { col: 2, row: 0 },
            { col: 3, row: 0 },
            { col: 4, row: 0 },
        ],
    },
    roles: {
        bonus: 1,
        wild: 2,
        scatter: 3,
        highStart: 4,
        maxBaseId: 13,
    },
    encoding: {
        typeCount: 18,
        minHeight: 1,
        maxHeight: 6,
    },
    // 线上盘面：列与列紧贴、列内符号紧贴（无列距/行距）
    spacing: {
        colGap: 0,
        rowGap: 0,
        lockColGap: true,
        lockRowGap: true,
    },
};

/** 顶条 flat 下标（与服务端 m_iTopCenterPos 一致） */
export const WAYS_6X7_TOP_FLAT_INDICES: readonly number[] = WAYS_6X7_TOP_MID4.topStrip!.mapToMain.map(
    (c) => flatIndex(c.col, c.row, ROWS),
);

export const BOARD_LAYOUT_PROFILES: readonly BoardLayoutProfile[] = [WAYS_6X7_TOP_MID4];

export function getBoardLayoutProfile(id: string | null | undefined): BoardLayoutProfile {
    const found = BOARD_LAYOUT_PROFILES.find((p) => p.id === id);
    return found ?? WAYS_6X7_TOP_MID4;
}
