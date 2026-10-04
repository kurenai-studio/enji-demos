/**
 * AssetDefs — 素材库最小单位。
 *
 * 纹理 / Spine / 音频 / 字体 / Prefab / 格子特效 都登记为 AssetEntry，
 * 用稳定 string id 引用。符号（SymbolEntry）只引用这些 id，运行时再解析，
 * 从而符号表可热改、可序列化，不必把 UUID 写进符号配置。
 */

import { _decorator, AudioClip, BitmapFont, Prefab, SpriteFrame, Vec2, ccenum, sp } from 'cc';

const { ccclass, property } = _decorator;

export enum AssetKind {
    texture = 0,
    spine = 1,
    audio = 2,
    font = 3,
    prefab = 4,
    /** 格子特效：spine + 默认动画名 + 可选音效 */
    effect = 5,
}
ccenum(AssetKind);

@ccclass('AssetEntry')
export class AssetEntry {
    @property({ tooltip: '稳定 id（符号表引用）；包内唯一，建议 tex_ / spine_ / sfx_ / fx_ 前缀' })
    id = '';

    @property({ tooltip: '显示名（素材墙 / 下拉）' })
    name = '';

    @property({ type: AssetKind, tooltip: '素材类型' })
    kind = AssetKind.texture;

    @property({ type: SpriteFrame, tooltip: 'kind=texture' })
    texture: SpriteFrame | null = null;

    @property({ type: sp.SkeletonData, tooltip: 'kind=spine | effect' })
    spine: sp.SkeletonData | null = null;

    @property({ type: AudioClip, tooltip: 'kind=audio；effect 可选附带' })
    audio: AudioClip | null = null;

    @property({ type: BitmapFont, tooltip: 'kind=font' })
    font: BitmapFont | null = null;

    @property({ type: Prefab, tooltip: 'kind=prefab' })
    prefab: Prefab | null = null;

    @property({ tooltip: 'kind=spine|effect 默认动画名（可被符号侧覆盖）' })
    defaultAnim = '';

    @property({ tooltip: 'kind=effect：盖在符号上层' })
    effectFront = true;

    @property({ tooltip: 'kind=effect：缩放微调' })
    effectScale = 1;

    @property({ tooltip: 'kind=effect：相对格子中心偏移（设计像素）' })
    effectOffset = new Vec2(0, 0);

    @property({ tooltip: 'kind=audio|effect 音量', range: [0, 1, 0.05], slide: true })
    volume = 1;
}

export interface AssetProvider {
    getAsset(id: string): AssetEntry | null;
    readonly assets: readonly AssetEntry[];
}

export function assetLabel(e: AssetEntry): string {
    return e.name || e.id || '(unnamed)';
}
