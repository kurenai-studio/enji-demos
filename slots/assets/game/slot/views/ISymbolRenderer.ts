// =====================================================================
//  ISymbolRenderer — 符号渲染器契约（ViewWeaver 双类模型的符号侧扩展）
//  ---------------------------------------------------------------------
//  设计约束：symbol prefab 是纯节点树（美术资产），不挂任何脚本。
//  渲染逻辑写在 ViewWeaver 生成的 <Prefab>.view.ts 里，由 SymbolView
//  在实例化 prefab 后运行时 addComponent + bind(root) + applyLayout(ctx) 注入。
//
//  与 IView 的关系：
//    IView.bind(root)      —— 解析节点引用（.gen.ts 基类自动生成）
//    applyLayout(ctx)      —— 按格子尺寸/档位排版（LvBu：低符号 panel+letter
//                             自适应、H 类精合成图允许溢出格子）
//    buildXxxAnim()        —— 可选动画钩子，返回统一 IAnim（可编排可取消）
//
//  取代原先"prefab 根节点挂 SymbolTemplate 组件"的形态；SymbolTemplate
//  仅作为旧资源包的兼容回退保留。
// =====================================================================

import type { IView } from './IView.ts';
import type { IAnim } from '../common/anim/IAnim.ts';

/** 排版上下文：SymbolView 在挂载与格子变化时传入。 */
export interface SymbolRenderContext {
    /** 当前符号 id（同一 prefab 服务多个符号时据此选内容，如低符号换字母） */
    symbolId: number | null;
    /** 实际格子尺寸（px） */
    cellW: number;
    cellH: number;
    /** 内容在格子内的占比（0~1） */
    cellFill: number;
    /** 全局符号设计尺寸（px） */
    designW: number;
    designH: number;
    /** 本列符号数（LvBu 变数盘面档位依据）；编辑器预览墙等无列语义场景为 null */
    columnCount?: number | null;
    /** 资源档位（LvBu：2..7 → _1.._6）；无档位语义时为 null */
    tier?: number | null;
}

/** 符号渲染器：ViewWeaver view 类实现它，SymbolView 只面向这个接口。 */
export interface ISymbolRenderer extends IView {
    /**
     * 按上下文排版。挂载后立即调用一次；格子尺寸/档位变化时可再调。
     * 实现方自行决定：9 宫格底板拉伸、字母层等比缩放、精合成图溢出等。
     */
    applyLayout(ctx: SymbolRenderContext): void;

    /** 入场演出；返回 null = 交回 SymbolView 的缺省链（spine/enterFx） */
    buildEnterAnim?(): IAnim | null;
    /** 中奖演出 */
    buildWinAnim?(): IAnim | null;
    /** 消除演出（播完不必还原显示，格子随后会被清空） */
    buildVanishAnim?(): IAnim | null;
}
