import { BitmapFont, JsonAsset, Node, SpriteFrame, Vec2, resources, sp } from 'cc';
import { AssetEntry, AssetKind } from './slot/editor-app/AssetDefs.ts';
import { AssetLibrary } from './slot/editor-app/AssetLibrary.ts';
import { CellFxDef, SymbolEntry, SymbolKind } from './slot/editor-app/SymbolDefs.ts';
import { SymbolLibrary } from './slot/editor-app/SymbolLibrary.ts';
import { SymbolCatalog } from './slot/editor-app/SymbolCatalog.ts';

export const PACK_ROOT = 'spine-3.8/packs/power-of-thor2';

interface Manifest {
    designW: number;
    designH: number;
    boardColGap: number;
    boardRowGap: number;
    cellFxScale: number;
    multiDigitFontId: string;
    spines: { id: string; dir: string; file: string }[];
    fonts: { id: string; name: string; dir: string; file: string }[];
    effects: { id: string; name: string; dir: string; file: string; defaultAnim: string; front: boolean; role: string }[];
    symbols: {
        id: number;
        name: string;
        textureFile: string;
        textureId: string;
        spineId: string;
        winAnim: string;
        idleAnim: string;
        spineSkin: string;
        kind?: string;
    }[];
}

function load<T>(path: string, type: new (...args: never[]) => T): Promise<T> {
    return new Promise((resolve, reject) => {
        (resources.load as (p: string, t: unknown, cb: (err: Error | null, asset: T) => void) => void)(
            path,
            type,
            (err, asset) => (err ? reject(new Error(`${path}: ${err.message}`)) : resolve(asset)),
        );
    });
}

const noExt = (file: string) => file.replace(/\.[^.]+$/, '');

function cellFx(spine: sp.SkeletonData | null, anim: string, front: boolean, scale: number): CellFxDef {
    const fx = new CellFxDef();
    fx.spine = spine;
    fx.anim = spine ? anim || 'play' : '';
    fx.front = front;
    fx.scale = scale;
    fx.offset = new Vec2(0, 0);
    return fx;
}

/**
 * Builds the pack's AssetLibrary + SymbolLibrary in code from `manifest.json`
 * (the Creator project ships them as prefabs with script components).
 */
export async function loadThorCatalog(
    host: Node,
): Promise<{ catalog: SymbolCatalog; manifest: Manifest; digitFont: BitmapFont | null }> {
    const manifest = (await load(`${PACK_ROOT}/manifest`, JsonAsset)).json as Manifest;

    const assets: AssetEntry[] = [];
    const add = (id: string, kind: AssetKind, fill: (e: AssetEntry) => void) => {
        const e = new AssetEntry();
        e.id = id;
        e.name = id;
        e.kind = kind;
        fill(e);
        assets.push(e);
        return e;
    };

    const spines = await Promise.all(
        manifest.spines.map((s) => load(`${PACK_ROOT}/${s.dir}/${noExt(s.file)}`, sp.SkeletonData)),
    );
    manifest.spines.forEach((s, i) => add(s.id, AssetKind.spine, (e) => (e.spine = spines[i])));

    const frames = await Promise.all(
        manifest.symbols.map((s) => load(`${PACK_ROOT}/${noExt(s.textureFile)}/spriteFrame`, SpriteFrame)),
    );
    manifest.symbols.forEach((s, i) => add(s.textureId, AssetKind.texture, (e) => (e.texture = frames[i])));

    const fonts = await Promise.all(
        manifest.fonts.map((f) => load(`${PACK_ROOT}/${f.dir}/${noExt(f.file)}`, BitmapFont)),
    );
    manifest.fonts.forEach((f, i) => add(f.id, AssetKind.font, (e) => (e.font = fonts[i])));

    const fxSpines = await Promise.all(
        manifest.effects.map((f) => load(`${PACK_ROOT}/${f.dir}/${noExt(f.file)}`, sp.SkeletonData)),
    );
    const packFx: Record<string, CellFxDef> = {};
    manifest.effects.forEach((f, i) => {
        add(f.id, AssetKind.effect, (e) => {
            e.spine = fxSpines[i];
            e.defaultAnim = f.defaultAnim || 'play';
            e.effectFront = f.front !== false;
            e.effectScale = manifest.cellFxScale ?? 0.75;
        });
        packFx[f.role] = cellFx(fxSpines[i], f.defaultAnim, f.front !== false, manifest.cellFxScale ?? 0.75);
    });

    const node = new Node('thor-pack');
    host.addChild(node);
    node.active = false;
    const assetLib = node.addComponent(AssetLibrary);
    assetLib.assets = assets;

    const lib = node.addComponent(SymbolLibrary);
    lib.symbolWidth = manifest.designW;
    lib.symbolHeight = manifest.designH;
    lib.boardColGap = manifest.boardColGap ?? 0;
    lib.boardRowGap = manifest.boardRowGap ?? 0;
    lib.lockBoardColGap = true;
    lib.lockBoardRowGap = true;
    lib.winCellFx = packFx.win ?? cellFx(null, '', true, 1);
    lib.vanishCellFx = packFx.vanish ?? cellFx(null, '', true, 1);
    lib.multiDigitFont = fonts[manifest.fonts.findIndex((f) => f.id === manifest.multiDigitFontId)] ?? null;
    lib.symbols = manifest.symbols.map((s) => {
        const e = new SymbolEntry();
        e.id = s.id;
        e.name = s.name;
        e.kind = s.kind === 'multi' ? SymbolKind.multi : SymbolKind.normal;
        e.textureAssetId = s.textureId;
        e.spineAssetId = s.spineId;
        e.idleAnim = s.idleAnim || '';
        e.winAnim = s.winAnim || '';
        e.spineSkin = s.spineSkin || '';
        e.winCellFx = cellFx(null, '', true, 1);
        e.vanishCellFx = cellFx(null, '', true, 1);
        return e;
    });

    return { catalog: SymbolCatalog.fromLibrary(lib, assetLib), manifest, digitFont: lib.multiDigitFont };
}
