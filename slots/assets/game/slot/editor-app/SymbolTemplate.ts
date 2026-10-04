/**
 * SymbolTemplate — 放在 symbol prefab 根节点上的动画钩子组件。
 * 美术/开发做带动效的 symbol 时继承本类并 override 对应方法；
 * 返回 null 表示该钩子无动画。
 *
 * （Cocos 约束：一个脚本文件只能定义一个 Component，故与 SymbolView 分文件。）
 */

import { _decorator, Component } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';

const { ccclass } = _decorator;

@ccclass('SymbolTemplate')
export class SymbolTemplate extends Component {
    buildEnterAnim(): IAnim | null {
        return null;
    }
    buildWinAnim(): IAnim | null {
        return null;
    }
    buildVanishAnim(): IAnim | null {
        return null;
    }
}
