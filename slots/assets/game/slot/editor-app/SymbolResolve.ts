/**
 * SymbolResolve — 把符号上的素材 id 解析成可渲染的直接引用。
 *
 * 规则：assetId 非空 → 从 AssetLibrary 取；否则保留 SymbolEntry 上的直接引用（兼容旧包）。
 */

import { CellFxDef, SymbolEntry, SymbolVisualVariantDef } from './SymbolDefs.ts';
import { AssetKind, type AssetProvider } from './AssetDefs.ts';

function cloneEntry(entry: SymbolEntry): SymbolEntry {
    const copy = new SymbolEntry();
    copy.id = entry.id;
    copy.name = entry.name;
    copy.kind = entry.kind;
    copy.textureAssetId = entry.textureAssetId;
    copy.spineAssetId = entry.spineAssetId;
    copy.prefabAssetId = entry.prefabAssetId;
    copy.visualVariants = (entry.visualVariants ?? []).map(cloneVisualVariant);
    copy.placementMainId = entry.placementMainId || '';
    copy.placementTopStripId = entry.placementTopStripId || '';
    copy.placementTopStripCells = Math.max(1, entry.placementTopStripCells | 0 || 2);
    copy.placementTopStripVariantKey = entry.placementTopStripVariantKey || '';
    copy.enterSoundAssetId = entry.enterSoundAssetId;
    copy.winSoundAssetId = entry.winSoundAssetId;
    copy.vanishSoundAssetId = entry.vanishSoundAssetId;
    copy.digitFontAssetId = entry.digitFontAssetId;
    copy.winCellFxAssetId = entry.winCellFxAssetId;
    copy.vanishCellFxAssetId = entry.vanishCellFxAssetId;
    copy.texture = entry.texture;
    copy.spine = entry.spine;
    copy.prefab = entry.prefab;
    copy.idleAnim = entry.idleAnim;
    copy.enterAnim = entry.enterAnim;
    copy.winAnim = entry.winAnim;
    copy.vanishAnim = entry.vanishAnim;
    copy.spineSkin = entry.spineSkin || '';
    copy.enterSound = entry.enterSound;
    copy.winSound = entry.winSound;
    copy.vanishSound = entry.vanishSound;
    copy.enterFx = entry.enterFx;
    copy.scaleMul = entry.scaleMul;
    copy.digitFont = entry.digitFont;
    copy.winCellFx = cloneCellFx(entry.winCellFx);
    copy.vanishCellFx = cloneCellFx(entry.vanishCellFx);
    return copy;
}

function cloneVisualVariant(src: SymbolVisualVariantDef): SymbolVisualVariantDef {
    const copy = new SymbolVisualVariantDef();
    copy.key = src.key;
    copy.label = src.label;
    copy.textureAssetId = src.textureAssetId;
    copy.spineAssetId = src.spineAssetId;
    copy.prefabAssetId = src.prefabAssetId;
    copy.texture = src.texture;
    copy.spine = src.spine;
    copy.prefab = src.prefab;
    return copy;
}

function cloneCellFx(src: CellFxDef | null | undefined): CellFxDef {
    const fx = new CellFxDef();
    if (!src) return fx;
    fx.spine = src.spine;
    fx.anim = src.anim;
    fx.front = src.front;
    fx.scale = src.scale;
    fx.offset = src.offset?.clone?.() ?? src.offset;
    fx.sound = src.sound;
    fx.soundVolume = src.soundVolume;
    return fx;
}

/** 浅拷贝后再解析，避免污染 prefab 源数据 */
export function resolveSymbolEntryCopy(entry: SymbolEntry, assets: AssetProvider | null): SymbolEntry {
    return resolveSymbolEntry(cloneEntry(entry), assets);
}

/** 就地解析：写回 texture / spine / 音效等字段 */
export function resolveSymbolEntry(entry: SymbolEntry, assets: AssetProvider | null): SymbolEntry {
    if (!assets) return entry;

    const tex = assets.getAsset(entry.textureAssetId);
    if (tex?.texture) entry.texture = tex.texture;
    else if (!entry.textureAssetId) entry.texture = null;

    const spine = assets.getAsset(entry.spineAssetId);
    if (spine?.spine) {
        entry.spine = spine.spine;
        if (!entry.idleAnim && spine.defaultAnim) entry.idleAnim = spine.defaultAnim;
    } else if (!entry.spineAssetId) {
        entry.spine = null;
    }

    const prefab = assets.getAsset(entry.prefabAssetId);
    if (prefab?.prefab) entry.prefab = prefab.prefab;
    else if (!entry.prefabAssetId) entry.prefab = null;

    for (const variant of entry.visualVariants ?? []) {
        const variantTexture = assets.getAsset(variant.textureAssetId);
        if (variantTexture?.texture) variant.texture = variantTexture.texture;
        else if (!variant.textureAssetId) variant.texture = null;
        const variantSpine = assets.getAsset(variant.spineAssetId);
        if (variantSpine?.spine) variant.spine = variantSpine.spine;
        else if (!variant.spineAssetId) variant.spine = null;
        const variantPrefab = assets.getAsset(variant.prefabAssetId);
        if (variantPrefab?.prefab) variant.prefab = variantPrefab.prefab;
        else if (!variant.prefabAssetId) variant.prefab = null;
    }

    const enterSfx = assets.getAsset(entry.enterSoundAssetId);
    if (enterSfx?.audio) entry.enterSound = enterSfx.audio;

    const winSfx = assets.getAsset(entry.winSoundAssetId);
    if (winSfx?.audio) entry.winSound = winSfx.audio;

    const vanishSfx = assets.getAsset(entry.vanishSoundAssetId);
    if (vanishSfx?.audio) entry.vanishSound = vanishSfx.audio;

    const font = assets.getAsset(entry.digitFontAssetId);
    if (font?.font) entry.digitFont = font.font;

    applyEffectAsset(entry.winCellFx, entry.winCellFxAssetId, assets);
    applyEffectAsset(entry.vanishCellFx, entry.vanishCellFxAssetId, assets);

    return entry;
}

/** 把 effect/spine 素材写进 CellFxDef；assetId 空串则清空 */
export function applyEffectAsset(
    fx: CellFxDef,
    assetId: string,
    assets: AssetProvider,
    opts?: { forceAnim?: boolean },
): void {
    if (!assetId) {
        fx.spine = null;
        fx.anim = '';
        fx.sound = null;
        return;
    }
    const a = assets.getAsset(assetId);
    if (!a || (a.kind !== AssetKind.effect && a.kind !== AssetKind.spine)) return;
    if (a.spine) fx.spine = a.spine;
    if (a.defaultAnim && (opts?.forceAnim || !fx.anim)) fx.anim = a.defaultAnim;
    if (a.audio) fx.sound = a.audio;
    fx.front = a.effectFront;
    fx.scale = a.effectScale;
    if (a.effectOffset) fx.offset = a.effectOffset.clone();
    fx.soundVolume = a.volume;
}

/** 用 spine uuid + 动画名反查素材 id（优先 effect） */
export function matchCellFxAssetId(fx: CellFxDef | null | undefined, assets: AssetProvider | null): string {
    if (!fx?.spine || !assets) return '';
    const uuid = (fx.spine as { uuid?: string; _uuid?: string }).uuid
        || (fx.spine as { uuid?: string; _uuid?: string })._uuid
        || '';
    if (!uuid) return '';
    const anim = fx.anim || '';
    const candidates = assets.assets.filter((a) => {
        if (a.kind !== AssetKind.effect && a.kind !== AssetKind.spine) return false;
        if (!a.spine) return false;
        const au = (a.spine as { uuid?: string; _uuid?: string }).uuid
            || (a.spine as { uuid?: string; _uuid?: string })._uuid
            || '';
        return au === uuid;
    });
    if (!candidates.length) return '';
    const byAnim = anim
        ? candidates.find((a) => a.kind === AssetKind.effect && a.defaultAnim === anim)
            || candidates.find((a) => a.defaultAnim === anim)
        : null;
    const preferEffect = candidates.find((a) => a.kind === AssetKind.effect);
    return (byAnim || preferEffect || candidates[0])!.id;
}
