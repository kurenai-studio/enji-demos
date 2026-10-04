// =====================================================================
//  IView — ViewWeaver 运行时视图契约
//  ---------------------------------------------------------------------
//  ViewWeaver 生成的 <prefab>.gen.ts 基类都 `implements IView`。
//  设计意图：prefab 只保存节点树（美术资产），不挂业务脚本；
//  视图逻辑由 Presenter / 挂载器在运行时 addComponent + bind(root) 注入。
//
//  - IView          ：最小绑定契约，bind(root) 解析并持有子节点/组件引用。
//  - IAnimatedView  ：可选进/退场动画契约，返回本工程统一的 IAnim
//                     （见 assets/scripts/common/anim/IAnim.ts）以便编排与取消。
//
//  本文件是手写的运行时契约，ViewWeaver 不会覆盖它。
// =====================================================================

import type { Component, Node } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';

/** 最小视图契约：把运行时实例化出的 root 绑定到视图。 */
export interface IView {
    bind(root: Node): void;
}

/** 需要进/退场表现的视图，额外实现可组合、可取消的动画。 */
export interface IAnimatedView extends IView {
    playEnter(): IAnim;
    playExit(): IAnim;
}

/** 运行时以组件形式挂载的视图（addComponent 的产物即满足此形态）。 */
export type IViewComponent = Component & IView;
export type IAnimatedViewComponent = Component & IAnimatedView;
