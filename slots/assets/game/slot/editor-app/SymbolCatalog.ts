/**
 * SymbolCatalog — 运行时符号配置入口。
 *
 * 加载顺序：
 *   1) asset-library.prefab（素材库，可缺省 → 旧包直引模式）
 *   2) symbol-library.prefab（符号表，可引用素材 id）
 * 对外 getEntry 返回已解析副本，盘面编辑器只消费符号，不直接碰素材。
 */

import {
    Color,
    EffectAsset,
    Material,
    Prefab,
    SpriteFrame,
    Texture2D,
    js,
    resources,
} from 'cc';
import { DESIGN_CELL_H, DESIGN_CELL_W, isMultiEntry } from './SymbolDefs.ts';
import type { CellFxDef, DissolveFxConfig, SymbolEntry, SymbolProvider } from './SymbolDefs.ts';
import { SymbolLibrary } from './SymbolLibrary.ts';
import { AssetLibrary } from './AssetLibrary.ts';
import type { AssetProvider } from './AssetDefs.ts';
import { resolveSymbolEntryCopy, applyEffectAsset, matchCellFxAssetId } from './SymbolResolve.ts';
import { AssetKind } from './AssetDefs.ts';
import { resolveDraft, normalizePackLayout, type PackLayoutConfig, type SymbolSheetDoc } from './SymbolDraft.ts';
import {
    DEFAULT_GAME_ID,
    assertPackLibraryPath,
    assetLibraryPathFor,
    getGamePack,
    libraryPathFor,
    type SymbolPackDef,
} from './GamePack.ts';
import { packResourcePath } from './SpineZone.ts';

/** 避免 ESM 循环依赖时 import 绑定尚为 undefined，导致 getComponent(null) 抛 constructor */
function resolveAssetLibraryCtor(): typeof AssetLibrary | null {
    if (typeof AssetLibrary === 'function') return AssetLibrary;
    const byName = js.getClassByName('AssetLibrary') as typeof AssetLibrary | null;
    return byName ?? null;
}

function resolveSymbolLibraryCtor(): typeof SymbolLibrary | null {
    if (typeof SymbolLibrary === 'function') return SymbolLibrary;
    const byName = js.getClassByName('SymbolLibrary') as typeof SymbolLibrary | null;
    return byName ?? null;
}

export class SymbolCatalog implements SymbolProvider {
    private lib: SymbolLibrary | null = null;
    private assets: AssetLibrary | null = null;
    private resolved = new Map<number, SymbolEntry>();
    private vanishDissolve: DissolveFxConfig | null = null;

    /** 编辑期直接用现成组件构建（预览墙用） */
    static fromLibrary(lib: SymbolLibrary, assets: AssetLibrary | null = null): SymbolCatalog {
        const c = new SymbolCatalog();
        c.lib = lib;
        c.assets = assets;
        c.rebuildResolved();
        return c;
    }

    get assetLibrary(): AssetProvider | null {
        return this.assets;
    }

    /** 未解析的源符号表（prefab 上的 SymbolEntry，含 *AssetId） */
    getSourceEntries(): SymbolEntry[] {
        return this.lib?.symbols ?? [];
    }

    get all(): SymbolEntry[] {
        return [...this.resolved.values()];
    }

    getEntry(id: number): SymbolEntry | null {
        return this.resolved.get(id) ?? null;
    }

    get designW(): number {
        return this.lib?.designW ?? DESIGN_CELL_W;
    }

    get designH(): number {
        return this.lib?.designH ?? DESIGN_CELL_H;
    }

    /** 包级盘面间距（SymbolLibrary / H5 packLayout；无库时回落 2/2） */
    get boardSpacing(): {
        colGap: number;
        rowGap: number;
        lockColGap: boolean;
        lockRowGap: boolean;
    } {
        return (
            this.lib?.boardSpacing ?? {
                colGap: 2,
                rowGap: 2,
                lockColGap: false,
                lockRowGap: false,
            }
        );
    }

    /** 从当前库读出包布局（供 H5 草稿初始化） */
    readPackLayout(): PackLayoutConfig {
        const lib = this.lib;
        return normalizePackLayout({
            designW: lib?.designW,
            designH: lib?.designH,
            boardColGap: lib?.boardColGap,
            boardRowGap: lib?.boardRowGap,
            lockBoardColGap: lib?.lockBoardColGap,
            lockBoardRowGap: lib?.lockBoardRowGap,
            winCellFxScale: lib?.winCellFx?.scale,
            vanishCellFxScale: lib?.vanishCellFx?.scale,
            columnVAlign: lib?.columnVAlign,
        });
    }

    /** H5 packLayout → 写入库内存（不改 prefab 磁盘） */
    applyPackLayout(layout: PackLayoutConfig | null | undefined): void {
        if (!this.lib || !layout) return;
        const L = normalizePackLayout(layout);
        this.lib.symbolWidth = L.designW;
        this.lib.symbolHeight = L.designH;
        this.lib.boardColGap = L.boardColGap;
        this.lib.boardRowGap = L.boardRowGap;
        this.lib.lockBoardColGap = L.lockBoardColGap;
        this.lib.lockBoardRowGap = L.lockBoardRowGap;
        this.lib.columnVAlign = L.columnVAlign;
        if (this.lib.winCellFx) this.lib.winCellFx.scale = L.winCellFxScale;
        if (this.lib.vanishCellFx) this.lib.vanishCellFx.scale = L.vanishCellFxScale;
    }

    getFrame(id: number): SpriteFrame | null {
        return this.getEntry(id)?.texture ?? null;
    }

    winCellFxFor(id: number): CellFxDef | null {
        const e = this.getEntry(id);
        // 倍率球：只用符号级「收集特效」，不回落包级高亮
        if (isMultiEntry(e)) {
            return e?.winCellFx?.valid ? e.winCellFx : null;
        }
        if (e?.winCellFx?.valid) return e.winCellFx;
        return this.lib?.winCellFx.valid ? this.lib.winCellFx : null;
    }

    vanishCellFxFor(id: number): CellFxDef | null {
        const e = this.getEntry(id);
        if (e?.vanishCellFx?.valid) return e.vanishCellFx;
        return this.lib?.vanishCellFx.valid ? this.lib.vanishCellFx : null;
    }

    /** 包级通用中奖/消除特效当前绑定的素材 id（供编辑器展示） */
    packWinCellFxAssetId(): string {
        return matchCellFxAssetId(this.lib?.winCellFx, this.assets);
    }

    packVanishCellFxAssetId(): string {
        return matchCellFxAssetId(this.lib?.vanishCellFx, this.assets);
    }

    /** 设置包级通用格子特效；空 id = 清除 */
    setPackCellFx(which: 'win' | 'vanish', assetId: string): void {
        if (!this.lib) return;
        const fx = which === 'win' ? this.lib.winCellFx : this.lib.vanishCellFx;
        if (!this.assets) {
            if (!assetId) {
                fx.spine = null;
                fx.anim = '';
            }
            return;
        }
        applyEffectAsset(fx, assetId, this.assets, { forceAnim: true });
        // spine 类素材若无 defaultAnim，给个合理缺省
        if (assetId && !fx.anim) {
            const a = this.assets.getAsset(assetId);
            if (a?.kind === AssetKind.spine || a?.kind === AssetKind.effect) {
                fx.anim = which === 'win' ? 'win' : 'out';
            }
        }
    }

    vanishDissolveFor(id: number): DissolveFxConfig | null {
        const entry = this.getEntry(id);
        if (!entry?.texture || entry.vanishAnim) return null;
        return this.vanishDissolve;
    }

    digitFontFor(id: number) {
        const e = this.getEntry(id);
        if (!isMultiEntry(e)) return null;
        return e!.digitFont ?? this.lib?.multiDigitFont ?? null;
    }

    get expandSplitFx() {
        return (
            this.lib?.expandSplitFx ?? {
                splitParticle: null,
                splitB: null,
                splitBAnim: 'split_B',
            }
        );
    }

    /**
     * 按包加载：先素材库（可选），再符号库并解析。
     * @param libPath 符号库 resources 路径；缺省当前默认包
     * @param assetPath 素材库路径；缺省同包 asset-library
     */
    async load(
        libPath = getGamePack(DEFAULT_GAME_ID).libraryPath,
        assetPath?: string | null,
    ): Promise<void> {
        assertPackLibraryPath(libPath);

        this.assets = null;
        const tryAsset = assetPath === null ? null : (assetPath ?? guessAssetPath(libPath));
        if (tryAsset) {
            try {
                assertPackLibraryPath(tryAsset);
                const assetPrefab = await loadRes<Prefab>(tryAsset, Prefab);
                const AssetLibraryCtor = resolveAssetLibraryCtor();
                if (!AssetLibraryCtor) {
                    throw new Error(
                        'AssetLibrary 类未注册（import 为 undefined 或脚本未进包）',
                    );
                }
                this.assets =
                    assetPrefab.data?.getComponent(AssetLibraryCtor) ?? null;
                if (this.assets) {
                    console.log(
                        `[SymbolCatalog] asset-library ← ${tryAsset} (${this.assets.assets.length} assets)`,
                    );
                } else {
                    console.warn(
                        `[SymbolCatalog] ${tryAsset} 已加载但根节点无 AssetLibrary 组件`,
                    );
                }
            } catch (e) {
                console.warn(
                    `[SymbolCatalog] 无素材库 ${tryAsset}，符号将使用直接引用（旧包模式）`,
                    (e as Error)?.message ?? e,
                );
            }
        }

        const prefab = await loadRes<Prefab>(libPath, Prefab);
        const SymbolLibraryCtor = resolveSymbolLibraryCtor();
        if (!SymbolLibraryCtor) {
            throw new Error('SymbolLibrary 类未注册（import 为 undefined 或脚本未进包）');
        }
        const lib = prefab.data?.getComponent(SymbolLibraryCtor) ?? null;
        if (!lib) throw new Error(`${libPath} 根节点缺少 SymbolLibrary 组件`);
        this.lib = lib;
        this.rebuildResolved();
        const seen = new Set<number>();
        for (const e of this.resolved.values()) {
            if (seen.has(e.id)) console.warn(`[SymbolCatalog] 重复的 symbol id: ${e.id} (${e.name})`);
            seen.add(e.id);
        }
        const withTex = [...this.resolved.values()].filter((e) => !!e.texture || !!e.spine).length;
        console.log(
            `[SymbolCatalog] symbols ← ${libPath} (${this.resolved.size} resolved, assets=${this.assets ? 'yes' : 'no'}, withTexOrSpine=${withTex})`,
        );
    }

    /** 按 SymbolPackDef 加载（推荐） */
    async loadPack(pack: SymbolPackDef): Promise<void> {
        await this.load(libraryPathFor(pack), assetLibraryPathFor(pack));
        await this.loadOptionalDissolve(pack);
    }

    /**
     * 用 SymbolEditor 本地草稿覆盖已解析符号表（含清空 spine/贴图）与包布局。
     * 不改 prefab 源；切包/重载 library 后需再调一次。
     */
    applySymbolSheet(doc: SymbolSheetDoc | null | undefined): boolean {
        if (!doc?.symbols?.length) return false;
        if (doc.packLayout) this.applyPackLayout(doc.packLayout);
        if (doc.winCellFxAssetId != null) this.setPackCellFx('win', doc.winCellFxAssetId);
        if (doc.vanishCellFxAssetId != null) this.setPackCellFx('vanish', doc.vanishCellFxAssetId);
        // 再写一次 scale：setPackCellFx 会从 AssetEntry.effectScale 覆盖
        if (doc.packLayout) {
            if (this.lib?.winCellFx) this.lib.winCellFx.scale = doc.packLayout.winCellFxScale;
            if (this.lib?.vanishCellFx) this.lib.vanishCellFx.scale = doc.packLayout.vanishCellFxScale;
        }
        const fallbacks = new Map((this.lib?.symbols ?? []).map((e) => [e.id, e] as const));
        this.resolved.clear();
        for (const d of doc.symbols) {
            this.resolved.set(d.id, resolveDraft(d, this.assets, fallbacks.get(d.id) ?? null));
        }
        console.log(`[SymbolCatalog] applied symbol sheet pack=${doc.packId} symbols=${this.resolved.size}`);
        return true;
    }

    private async loadOptionalDissolve(pack: SymbolPackDef): Promise<void> {
        this.vanishDissolve = null;
        const maskPath = `${packResourcePath(pack.zone, pack.id, 'static/dissolve/dissolve-cloud')}/spriteFrame`;
        try {
            const [effect, maskFrame] = await Promise.all([
                loadRes<EffectAsset>('effects/lvbu-dissolve-sprite', EffectAsset),
                loadRes<SpriteFrame>(maskPath, SpriteFrame),
            ]);
            const material = new Material();
            material.initialize({ effectAsset: effect });
            this.vanishDissolve = {
                material,
                maskTexture: maskFrame.texture as Texture2D,
                duration: 0.33,
                softness: 0.045,
                edgeWidth: 0.13,
                edgeGlow: 2.2,
                edgeColor: new Color(255, 62, 8, 255),
            };
        } catch (e) {
            console.warn(`[SymbolCatalog] optional dissolve unavailable for ${pack.id}`, (e as Error)?.message ?? e);
        }
    }

    private rebuildResolved(): void {
        this.resolved.clear();
        if (!this.lib) return;
        for (const e of this.lib.symbols) {
            this.resolved.set(e.id, resolveSymbolEntryCopy(e, this.assets));
        }
    }
}

/** symbol-library → 同目录 asset-library */
function guessAssetPath(symbolLibPath: string): string {
    return symbolLibPath.replace(/symbol-library\/?$/, 'asset-library').replace(/symbol-library$/, 'asset-library');
}

function loadRes<T>(path: string, type: new (...args: never[]) => T): Promise<T> {
    return new Promise((resolve, reject) => {
        (resources.load as (p: string, t: unknown, cb: (err: Error | null, asset: T) => void) => void)(
            path,
            type,
            (err, asset) => {
                if (err) reject(new Error(`resources.load 失败: ${path}: ${err.message}`));
                else resolve(asset);
            },
        );
    });
}

export { loadRes };
