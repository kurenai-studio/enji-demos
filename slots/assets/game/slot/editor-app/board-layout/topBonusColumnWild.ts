/**
 * 顶条连续 Bonus → 整列变 Wild（吕布 ChangeResultWild 的纯逻辑抽取）。
 *
 * 服务端语义摘要：
 * - 顶条从左到右扫；遇非 Bonus 则清空「当前连续段」
 * - 连续 Bonus ≥ 2 才触发；取该连续段涉及的列，把主盘非顶条格写成 wild
 * - CheckHaveWildFeature：顶条 Bonus 总数 > 1，且「第一个 Bonus 的顶条下标」相对上局发生了移动
 *
 * 此处只做「给定顶条符号 → 应变野的主盘列」；是否与上局比较由调用方决定。
 */

import type { BoardLayoutProfile, CellRef } from './BoardLayout.ts';

export interface TopBonusWildInput {
    /** 顶条从左到右的 base symbolId（长度 = topStrip.count） */
    topSymbols: number[];
    /** 若提供，则与上局第一个 Bonus 顶条下标比较（0-based；无 Bonus = -1） */
    prevFirstBonusIndex?: number;
}

export interface TopBonusWildResult {
    triggered: boolean;
    /** 连续 Bonus 段在顶条上的下标（0-based） */
    streakIndices: number[];
    /** 应整列变野的主盘 col */
    wildCols: number[];
    /** 本局顶条第一个 Bonus 下标；无则 -1 */
    firstBonusIndex: number;
}

function firstBonusIndex(top: number[], bonusId: number): number {
    for (let i = 0; i < top.length; i++) {
        if (top[i] === bonusId) return i;
    }
    return -1;
}

function countBonus(top: number[], bonusId: number): number {
    let n = 0;
    for (const s of top) if (s === bonusId) n++;
    return n;
}

/**
 * 找「从左扫到第一次断裂前」的最长连续 Bonus 前缀段；
 * 服务端在连续数 > 1 时 break，故实际取的是**最左侧**那段连续 Bonus（长度≥2）。
 */
function leftmostBonusStreak(top: number[], bonusId: number): number[] {
    const indices: number[] = [];
    for (let i = 0; i < top.length; i++) {
        if (top[i] === bonusId) {
            indices.push(i);
        } else if (indices.length > 0) {
            break;
        }
    }
    return indices.length >= 2 ? indices : [];
}

export function resolveTopBonusColumnWild(
    profile: BoardLayoutProfile,
    input: TopBonusWildInput,
): TopBonusWildResult {
    const strip = profile.topStrip;
    const bonusId = profile.roles.bonus;
    const empty: TopBonusWildResult = {
        triggered: false,
        streakIndices: [],
        wildCols: [],
        firstBonusIndex: -1,
    };
    if (!strip || strip.count <= 0) return empty;

    const top = input.topSymbols.slice(0, strip.count);
    while (top.length < strip.count) top.push(0);

    const first = firstBonusIndex(top, bonusId);
    const bonusCount = countBonus(top, bonusId);

    // CheckHaveWildFeature：Bonus 数须 > 1；且第一个 Bonus 位置相对上局有移动
    if (bonusCount <= 1) {
        return { ...empty, firstBonusIndex: first };
    }
    if (input.prevFirstBonusIndex !== undefined) {
        if (first >= 0 && first === input.prevFirstBonusIndex) {
            return { ...empty, firstBonusIndex: first };
        }
    }

    const streak = leftmostBonusStreak(top, bonusId);
    if (streak.length < 2) {
        return { ...empty, firstBonusIndex: first };
    }

    const wildCols: number[] = [];
    for (const ti of streak) {
        const main = strip.mapToMain[ti];
        if (!main) continue;
        if (!wildCols.includes(main.col)) wildCols.push(main.col);
    }

    return {
        triggered: wildCols.length > 0,
        streakIndices: streak,
        wildCols,
        firstBonusIndex: first,
    };
}

/** 对 flat[col*rows+row] 写入 wild；跳过顶条映射格 */
export function applyColumnWildToFlat(
    profile: BoardLayoutProfile,
    flat: number[],
    wildCols: number[],
): number[] {
    const { rows, gridCount } = profile.flat;
    const wildId = profile.roles.wild;
    const out = flat.slice(0, gridCount);
    while (out.length < gridCount) out.push(0);

    const topSet = new Set<string>();
    for (const c of profile.topStrip?.mapToMain ?? []) {
        topSet.add(`${c.col},${c.row}`);
    }

    for (const col of wildCols) {
        for (let row = 0; row < rows; row++) {
            if (topSet.has(`${col},${row}`)) continue;
            out[col * rows + row] = wildId;
        }
    }
    return out;
}

export function topSymbolsFromFlat(profile: BoardLayoutProfile, flat: number[]): number[] {
    const strip = profile.topStrip;
    if (!strip) return [];
    const { rows } = profile.flat;
    return strip.mapToMain.map((c: CellRef) => flat[c.col * rows + c.row] ?? 0);
}
