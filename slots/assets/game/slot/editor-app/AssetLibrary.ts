/**
 * AssetLibrary — 素材库（符号配置的最小单位）。
 *
 * 登记纹理 / Spine / 音频 / 字体等，用稳定 string id 供 SymbolEntry 引用。
 * 配置与预览请走 H5「符号编辑器」(SymbolEditor)；本组件仅作运行时数据容器。
 */

import { _decorator, Component } from 'cc';
import { AssetEntry, type AssetProvider } from './AssetDefs.ts';

const { ccclass, property } = _decorator;

@ccclass('AssetLibrary')
export class AssetLibrary extends Component implements AssetProvider {
    @property({ type: [AssetEntry], tooltip: '素材条目；由 migrate 脚本或 SymbolEditor 维护' })
    assets: AssetEntry[] = [];

    getAsset(id: string): AssetEntry | null {
        if (!id) return null;
        return this.assets.find((a) => a.id === id) ?? null;
    }
}
