/**
 * SymbolDefs — 符号定义（由素材库条目组合而成）。
 *
 * 最小单位是 AssetLibrary 里的素材；SymbolEntry 优先通过 *AssetId 引用素材，
 * 运行时由 SymbolCatalog + SymbolResolve 解析。直接拖引用字段保留，兼容旧包。
 * CellFxDef：格子级通用特效；设计像素空间，缺省符号设计尺寸 152×128。
 */

import {
    _decorator,
    AudioClip,
    BitmapFont,
    Color,
    Material,
    Node,
    Prefab,
    SpriteFrame,
    Texture2D,
    UITransform,
    Vec2,
    ccenum,
    sp,
} from 'cc';
import { EnterFx } from './symbolFx.ts';

const { ccclass, property } = _decorator;

/** 格子设计尺寸（格子级特效的缩放基准） */
export const DESIGN_CELL_W = 152;
export const DESIGN_CELL_H = 128;

/**
 * 符号业务分类（同库分型，不另起符号库）。
 * - normal：常规 enter / win / vanish + 格子特效
 * - multi：倍率球；不走中奖高亮；数字读 entity.multiplier，字体用 digitFont
 */
export enum SymbolKind {
    normal = 0,
    multi = 1,
}
ccenum(SymbolKind);

export function isMultiEntry(entry: SymbolEntry | null | undefined): boolean {
    return !!entry && entry.kind === SymbolKind.multi;
}

/** Runtime-only shared Sprite dissolve. The symbol asset itself remains independent. */
export interface DissolveFxConfig {
    material: Material;
    maskTexture: Texture2D;
    duration: number;
    softness: number;
    edgeWidth: number;
    edgeGlow: number;
    edgeColor: Color;
}

@ccclass('CellFxDef')
export class CellFxDef {
    @property({ type: sp.SkeletonData, tooltip: '格子特效 spine；留空 = 不启用（条目上留空 = 用全局）' })
    spine: sp.SkeletonData | null = null;

    @property({ tooltip: '播放的动画名（如 win / out）' })
    anim = '';

    @property({ tooltip: '盖在符号上层；不勾则垫在符号下层' })
    front = true;

    @property({ tooltip: '缩放微调（设计像素自适应之上再乘）' })
    scale = 1;

    @property({ tooltip: '相对格子中心的偏移（设计像素）' })
    offset = new Vec2(0, 0);

    @property({ type: AudioClip, tooltip: '特效音效：与 spine 同时触发（多媒体特效的音频半边）' })
    sound: AudioClip | null = null;

    @property({ tooltip: '音效音量', range: [0, 1, 0.05], slide: true })
    soundVolume = 1;

    /** 有视觉或有声音都算有效（可以只配音效不配 spine） */
    get valid(): boolean {
        return (!!this.spine && this.anim.length > 0) || !!this.sound;
    }

    get hasVisual(): boolean {
        return !!this.spine && this.anim.length > 0;
    }
}

/**
 * 同一逻辑符号下的视觉变体。
 *
 * key 是资源包内稳定键（如 tier-1）；选择规则不存这里，而由盘面 profile
 * 根据 columnCount 等上下文决定 key。这样赛特可以不配变体，吕布可配 6 档，
 * 其它游戏也可使用 orientation / state 等不同键。
 */
@ccclass('SymbolVisualVariantDef')
export class SymbolVisualVariantDef {
    @property({ tooltip: '包内稳定键，如 tier-1 / tier-2；同一符号内唯一' })
    key = '';

    @property({ tooltip: '编辑器显示名，如「7个/列 · 112px」' })
    label = '';

    @property({ tooltip: '该变体使用的 texture 素材 id' })
    textureAssetId = '';

    @property({ tooltip: '该变体使用的 spine 素材 id（可选）' })
    spineAssetId = '';

    @property({ tooltip: '该变体使用的 prefab 素材 id（可选）' })
    prefabAssetId = '';

    /** 由 AssetLibrary 解析；保留直接引用兼容手工配置。 */
    @property({ type: SpriteFrame })
    texture: SpriteFrame | null = null;

    @property({ type: sp.SkeletonData })
    spine: sp.SkeletonData | null = null;

    @property({ type: Prefab })
    prefab: Prefab | null = null;
}

@ccclass('SymbolEntry')
export class SymbolEntry {
    @property({ tooltip: '盘面数据(SPIR Cell.symbolId)引用的稳定 id；不要与其它条目重复' })
    id = 0;

    @property({ tooltip: '显示名（刷子面板 / 预览墙标注）' })
    name = '';

    @property({ type: SymbolKind, tooltip: '符号分类：normal=常规；multi=倍率球（不走中奖高亮，可挂倍数字体）' })
    kind = SymbolKind.normal;

    @property({ tooltip: '素材库 texture id；非空则覆盖下方直接引用' })
    textureAssetId = '';

    @property({ tooltip: '素材库 spine id' })
    spineAssetId = '';

    @property({ tooltip: '素材库 prefab id' })
    prefabAssetId = '';

    @property({
        type: [SymbolVisualVariantDef],
        tooltip: '同一逻辑 id 的视觉变体；选择规则由盘面 profile / placement 决定，空数组表示只有基础素材',
    })
    visualVariants: SymbolVisualVariantDef[] = [];

    @property({
        tooltip: '主盘落盘 recipeId（placement 索引）；空=普通单格。例：column-fill',
    })
    placementMainId = '';

    @property({
        tooltip: '顶条落盘 recipeId（placement 索引）；空=普通单格。例：top-row-span',
    })
    placementTopStripId = '';

    @property({
        tooltip: '顶条 top-row-span 占用格数',
        min: 1,
        max: 8,
    })
    placementTopStripCells = 2;

    @property({
        tooltip: '顶条显示用 visualVariant.key（如 top-horizontal-wide）',
    })
    placementTopStripVariantKey = '';

    @property({ tooltip: '素材库入场音效 id' })
    enterSoundAssetId = '';

    @property({ tooltip: '素材库中奖音效 id' })
    winSoundAssetId = '';

    @property({ tooltip: '素材库消除音效 id' })
    vanishSoundAssetId = '';

    @property({ tooltip: '素材库倍率字体 id（kind=multi）' })
    digitFontAssetId = '';

    @property({ tooltip: '素材库中奖格子特效 id（effect）' })
    winCellFxAssetId = '';

    @property({ tooltip: '素材库消除格子特效 id（effect）' })
    vanishCellFxAssetId = '';

    @property({ type: SpriteFrame, tooltip: '静态纹理（或由 textureAssetId 解析）：无 spine 时显示 / 刷子图标' })
    texture: SpriteFrame | null = null;

    @property({ type: sp.SkeletonData, tooltip: '骨骼（或由 spineAssetId 解析）；优先于纹理' })
    spine: sp.SkeletonData | null = null;

    @property({ type: Prefab, tooltip: '特殊符号 prefab（或由 prefabAssetId 解析）' })
    prefab: Prefab | null = null;

    @property({ tooltip: 'spine 常驻循环动画名；空 = setup pose（可继承素材 defaultAnim）' })
    idleAnim = '';

    @property({ tooltip: 'spine 入场动画名；空 = 用下方内置入场动效' })
    enterAnim = '';

    @property({ tooltip: 'spine 中奖动画名（highlight 帧播）；倍率球收集转一下默认也可用，空则用 function' })
    winAnim = '';

    @property({ tooltip: 'spine 消除动画名（postClear 帧播）' })
    vanishAnim = '';

    @property({
        tooltip: 'spine skin 名（如 AKQJ 共用骨骼时的 A/K/Q/J）；空 = 默认皮肤',
    })
    spineSkin = '';

    @property({ type: AudioClip, tooltip: '入场音效：与入场演出同时触发' })
    enterSound: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '中奖音效：与中奖演出同时触发' })
    winSound: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '消除音效：与消除演出同时触发' })
    vanishSound: AudioClip | null = null;

    @property({ type: EnterFx, tooltip: '内置入场动效（tween，无 spine 入场动画时用）' })
    enterFx = EnterFx.none;

    @property({ tooltip: '缩放微调（设计尺寸自适应之上再乘）' })
    scaleMul = 1;

    @property({
        type: BitmapFont,
        tooltip: '倍率球数字位图字（仅 kind=multi）；空 = 用 SymbolLibrary.multiDigitFont',
    })
    digitFont: BitmapFont | null = null;

    @property({ type: CellFxDef, tooltip: '本符号专用中奖格子特效；spine 留空 = 用全局' })
    winCellFx = new CellFxDef();

    @property({ type: CellFxDef, tooltip: '本符号专用消除格子特效；spine 留空 = 用全局' })
    vanishCellFx = new CellFxDef();

    /** 内容形态：prefab > spine > 纹理（含未解析的 assetId） */
    get contentKind(): 'prefab' | 'spine' | 'sprite' {
        if (this.prefab || this.prefabAssetId) return 'prefab';
        if (this.spine || this.spineAssetId) return 'spine';
        return 'sprite';
    }
}

/** SymbolView 取符号配置的抽象（运行时 SymbolCatalog / 编辑期 SymbolLibrary 都实现它） */
export interface SymbolProvider {
    getEntry(id: number): SymbolEntry | null;
    /** 全局符号设计尺寸（px，所有符号资产统一按此尺寸制作） */
    readonly designW: number;
    readonly designH: number;
    /** 解析后的中奖格子特效（条目覆盖 > 全局；无则 null） */
    winCellFxFor(id: number): CellFxDef | null;
    vanishCellFxFor(id: number): CellFxDef | null;
    /** Optional shared Sprite dissolve; normally supplied by the active resource pack. */
    vanishDissolveFor?(id: number): DissolveFxConfig | null;
    /** 倍率球位图字（条目覆盖 > 库默认；非 multi 返回 null） */
    digitFontFor?(id: number): BitmapFont | null;
    /** 扩散帧：split 粒子飞弹 + split_B 落地 */
    expandSplitFx?: {
        splitParticle: SpriteFrame | null;
        splitB: sp.SkeletonData | null;
        splitBAnim: string;
    };
}

/**
 * 在 host（格子节点）上生成一个格子特效 spine 节点。
 * unitScale：设计像素 → host 实际像素的换算比。
 * 返回骨骼组件；播放与销毁由调用方负责。
 */
export function spawnCellFx(def: CellFxDef, host: Node, unitScale: number): sp.Skeleton | null {
    const data = def.spine;
    if (!data || !def.anim) return null;
    const n = new Node('cellFx');
    n.addComponent(UITransform);
    const sk = n.addComponent(sp.Skeleton);
    sk.skeletonData = data;
    sk.premultipliedAlpha = false;
    const s = unitScale * def.scale;
    n.setScale(s, s, 1);
    n.setPosition(def.offset.x * unitScale, def.offset.y * unitScale, 0);
    host.addChild(n);
    n.setSiblingIndex(def.front ? host.children.length - 1 : 0);
    return sk;
}
