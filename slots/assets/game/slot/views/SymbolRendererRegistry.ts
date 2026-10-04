// =====================================================================
//  SymbolRendererRegistry — prefab 素材 id → 符号渲染器 view 类 的运行时注册表
//  ---------------------------------------------------------------------
//  prefab 本身不挂脚本；哪个 prefab 用哪个 ViewWeaver view 类，由资源包
//  代码在加载期显式注册（通常在 pack 的 catalog 初始化处）：
//
//      import { LvbuLowSymbolView } from './lvbu_low_symbol/lvbu_low_symbol.view';
//      registerSymbolRenderer('lvbu-low-symbol', LvbuLowSymbolView);
//
//  SymbolView 实例化 prefab 后按 SymbolEntry.prefabAssetId 查表，
//  运行时 addComponent + bind + applyLayout。查不到则回退 SymbolTemplate
//  （旧资源包兼容），再回退纹理/spine 缺省链。
// =====================================================================

import type { Component } from 'cc';
import type { ISymbolRenderer } from './ISymbolRenderer.ts';

export type SymbolRendererCtor = new () => Component & ISymbolRenderer;

const registry = new Map<string, SymbolRendererCtor>();

/** 注册（同 id 重复注册以最后一次为准，支持热替换调试） */
export function registerSymbolRenderer(prefabAssetId: string, ctor: SymbolRendererCtor): void {
    registry.set(prefabAssetId, ctor);
}

export function unregisterSymbolRenderer(prefabAssetId: string): void {
    registry.delete(prefabAssetId);
}

export function symbolRendererFor(prefabAssetId: string): SymbolRendererCtor | null {
    return registry.get(prefabAssetId) ?? null;
}
