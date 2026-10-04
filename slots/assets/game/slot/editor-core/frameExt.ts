/**
 * 帧级 extensions.frame 的类型与读写工具。
 * 与 illyasviel-candy `game/ir/core/irFrameExtensions.ts` 对齐（frameKind 枚举一致），
 * 但归属 editor-core：Editor 写入、Playfield/Director 读取。
 */

import type { PresentationState } from '../vendor/slot-presentation-ir/index.ts';

export type IrFrameKind =
    | 'reveal'
    | 'bonus-reveal'
    | 'highlight'
    | 'bonus-highlight'
    | 'enter-table-mid-cascade'
    | 'postClear'
    | 'compact'
    | 'expandPre'
    | 'expandPost'
    | 'topStep'
    | 'multiCollect'
    | 'spinEnd'
    | 'enter-table';

export const IR_FRAME_KINDS: IrFrameKind[] = [
    'enter-table',
    'reveal',
    'bonus-reveal',
    'highlight',
    'bonus-highlight',
    'enter-table-mid-cascade',
    'postClear',
    'compact',
    'expandPre',
    'expandPost',
    'topStep',
    'multiCollect',
    'spinEnd',
];

/** Inspector / HUD 用中文名；序列化与 SPIR 仍写英文 id */
export const IR_FRAME_KIND_LABELS: Record<IrFrameKind, string> = {
    'enter-table': '进桌',
    reveal: '揭晓',
    'bonus-reveal': 'Bonus揭晓',
    highlight: '中奖高亮',
    'bonus-highlight': 'Bonus高亮',
    'enter-table-mid-cascade': '中段进桌',
    postClear: '消除后',
    compact: '压缩补位',
    expandPre: '扩散前',
    expandPost: '扩散后',
    topStep: '横栏步进',
    multiCollect: '倍率收集',
    spinEnd: '停轮结束',
};

export function frameKindLabel(kind: string | null | undefined): string {
    if (!kind) return '?';
    return (IR_FRAME_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export interface IrFrameExtension {
    cascadeIndex: number;
    frameIndex: number;
    frameKind: IrFrameKind;
    clearTime?: number;
    clearType?: number;
    /** Editor 专用：本帧动画模板 override（缺省时按 frameKind 走默认模板） */
    templateId?: string;
    /** Editor 专用：模板参数 override */
    templateParams?: Record<string, unknown>;
    /** Editor 专用：本帧转移与上一帧转移并行播放（如 compact 与 reveal 同播） */
    playWithPrev?: boolean;
    /**
     * 吕布顶条独立符号（长度 = topStrip.count）。
     * 与主盘 resolved 分离，避免「顶条 / 主盘 row0」刷一处两处都变。
     * 导出服务端 flat 时再按 profile.mapToMain 写回。
     */
    topStrip?: Array<number | null>;
}

export function readFrameExt(state: PresentationState): IrFrameExtension | null {
    const frame = state.extensions?.['frame'];
    if (!frame || typeof frame !== 'object') return null;
    const ext = frame as Record<string, unknown>;
    if (typeof ext.frameKind !== 'string') return null;
    return frame as unknown as IrFrameExtension;
}

export function writeFrameExt(state: PresentationState, ext: IrFrameExtension): void {
    state.extensions = state.extensions ?? {};
    state.extensions['frame'] = ext;
}

/** 保证 topStrip 数组长度；缺省填 null */
export function ensureTopStripSymbols(
    ext: IrFrameExtension | null | undefined,
    count: number,
): Array<number | null> {
    const src = ext?.topStrip ?? [];
    const out: Array<number | null> = [];
    for (let i = 0; i < count; i++) {
        const v = src[i];
        out.push(v === undefined ? null : v);
    }
    return out;
}

export function isIrFrameKind(v: unknown): v is IrFrameKind {
    return typeof v === 'string' && (IR_FRAME_KINDS as string[]).indexOf(v) >= 0;
}
