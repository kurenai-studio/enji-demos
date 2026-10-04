/**
 * symbolFx — 内置 symbol 动效注册表（无需 prefab 即可用）。
 *
 * catalog 条目通过 `enterFx: "squashLand"` 之类的名字引用；
 * 动效作用在 SymbolView 的 content 子节点上（不动 cell 节点，
 * cell 节点是位移动画/脉冲的载体，两层互不干扰）。
 */

import { ccenum, Node, Tween, tween, Vec3 } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call, starterAnim } from '../common/anim/compose.ts';

/** 内置入场动效枚举（SymbolLibrary Inspector 下拉用） */
export enum EnterFx {
    none = 0,
    squashLand = 1,
    popIn = 2,
    spinIn = 3,
}
ccenum(EnterFx);

const ENTER_FX_NAMES: Record<EnterFx, string | null> = {
    [EnterFx.none]: null,
    [EnterFx.squashLand]: 'squashLand',
    [EnterFx.popIn]: 'popIn',
    [EnterFx.spinIn]: 'spinIn',
};

export function enterFxName(fx: EnterFx): string | null {
    return ENTER_FX_NAMES[fx] ?? null;
}

export type SymbolFxBuilder = (target: Node) => IAnim;

function tweenStep(node: Node, setup: (t: Tween<Node>) => Tween<Node>): IAnim {
    return starterAnim((finish) => {
        const t = setup(tween(node)).call(() => finish()).start();
        return () => t.stop();
    });
}

/** 落地压扁回弹：横向压扁 → 过冲拉伸 → 恢复 */
function squashLand(target: Node): IAnim {
    const base = target.scale.clone();
    return tweenStep(target, (t) =>
        t
            .to(0.07, { scale: new Vec3(base.x * 1.18, base.y * 0.78, base.z) }, { easing: 'quadOut' })
            .to(0.09, { scale: new Vec3(base.x * 0.94, base.y * 1.1, base.z) }, { easing: 'quadInOut' })
            .to(0.08, { scale: base.clone() }, { easing: 'quadOut' }),
    );
}

/** 缩放过冲入场：从小弹到略大再回正 */
function popIn(target: Node): IAnim {
    const base = target.scale.clone();
    return tweenStep(target, (t) => {
        target.setScale(base.x * 0.3, base.y * 0.3, base.z);
        return t
            .to(0.16, { scale: new Vec3(base.x * 1.12, base.y * 1.12, base.z) }, { easing: 'quadOut' })
            .to(0.1, { scale: base.clone() }, { easing: 'quadIn' });
    });
}

/** 旋转入场：带一点转角落定 */
function spinIn(target: Node): IAnim {
    return tweenStep(target, (t) => {
        target.setRotationFromEuler(0, 0, -75);
        return t.to(0.22, { eulerAngles: new Vec3(0, 0, 0) }, { easing: 'backOut' });
    });
}

const FX_REGISTRY: Record<string, SymbolFxBuilder> = {
    squashLand,
    popIn,
    spinIn,
};

/** 按名字构建动效；未注册的名字返回空动画并告警 */
export function buildSymbolFx(name: string, target: Node): IAnim {
    const builder = FX_REGISTRY[name];
    if (!builder) {
        console.warn(`[symbolFx] 未注册的动效: ${name}`);
        return call(() => undefined);
    }
    return builder(target);
}

export function hasSymbolFx(name: string): boolean {
    return name in FX_REGISTRY;
}
