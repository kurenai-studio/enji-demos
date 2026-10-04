/**
 * 盘面帧转移风格模板索引（与游戏 pack 解耦）。
 * BoardLayoutProfile.animStyleId 挂这里的 id；缺省 cascade-drop。
 */

import type { IrFrameKind } from '../editor-core/index';

/** 稳定模板 id */
export const ANIM_STYLE_CASCADE_DROP = 'cascade-drop';
export const ANIM_STYLE_FAKE_REEL = 'fake-reel';

export const ANIM_STYLE_IDS = [ANIM_STYLE_CASCADE_DROP, ANIM_STYLE_FAKE_REEL] as const;
export type AnimStyleId = (typeof ANIM_STYLE_IDS)[number];

export interface AnimStyleMeta {
    id: AnimStyleId;
    /** HUD 显示名 */
    label: string;
    /** 这些 frameKind 的默认模板改为 defaultRevealTemplateId（首项） */
    reelRevealKinds?: readonly IrFrameKind[];
    /** reveal 族默认模板；缺省用 KIND_ALLOWED 首项 */
    defaultRevealTemplateId?: string;
    /** postClear 默认模板（假轮带用淡出） */
    defaultPostClearTemplateId?: string;
    /** expandPost 默认模板（假轮带：横 JI→竖 JI） */
    defaultExpandPostTemplateId?: string;
}

const FAKE_REEL_REVEAL_KINDS: readonly IrFrameKind[] = [
    'enter-table',
    'reveal',
    'bonus-reveal',
    'enter-table-mid-cascade',
];

export const ANIM_STYLE_INDEX: Readonly<Record<AnimStyleId, AnimStyleMeta>> = {
    [ANIM_STYLE_CASCADE_DROP]: {
        id: ANIM_STYLE_CASCADE_DROP,
        label: '落入/落出',
    },
    [ANIM_STYLE_FAKE_REEL]: {
        id: ANIM_STYLE_FAKE_REEL,
        label: '假轮带',
        reelRevealKinds: FAKE_REEL_REVEAL_KINDS,
        defaultRevealTemplateId: 'reelSpin',
        defaultPostClearTemplateId: 'fadeOut',
        defaultExpandPostTemplateId: 'jiDiffuse',
    },
};

export function isAnimStyleId(v: unknown): v is AnimStyleId {
    return typeof v === 'string' && (ANIM_STYLE_IDS as readonly string[]).includes(v);
}

export function resolveAnimStyleId(raw: string | null | undefined): AnimStyleId {
    return isAnimStyleId(raw) ? raw : ANIM_STYLE_CASCADE_DROP;
}

export function getAnimStyleMeta(id: string | null | undefined): AnimStyleMeta {
    return ANIM_STYLE_INDEX[resolveAnimStyleId(id)];
}
