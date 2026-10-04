// =====================================================================
//  Anim — IAnim 抽象基类
//  ---------------------------------------------------------------------
//  封装：
//    · 状态机（idle / running / completed / cancelled）
//    · in-flight Promise 缓存（让 play() 幂等）
//    · cancel 协议（cancel → reject(CancelledError)）
//    · 自动跟随 node destroy 取消（避免节点没了 tween 还在跑的脏 tween）
//
//  子类只需实现：
//    · onStart()  —— 启动具体的 cc.tween / Spine / Particle / 计时器；
//                    完成时调用 this._complete()；
//                    出错时调用 this._fail(err)。
//    · onCancel() —— 中断 onStart 启动的资源（停 tween、unschedule、…）。
//    · onReset()  —— [可选] 清理子类私有状态，让动画可被再次 play。
//
//  绝大多数原语（fade / scale / move / spine / particle / shake / …）
//  都从这里继承，统一行为。
// =====================================================================

import { Node } from "cc";
import { LogUtils } from "../misc/LogUtils.ts";
import type { AnimState, IAnim } from "./IAnim.ts";
import { CancelledError } from "./IAnim.ts";

/**
 * IAnim 的标准实现底座。
 *
 * 重要：`onStart`/`onCancel`/`onReset` 是模板方法，子类必须按契约实现：
 *
 *  · `onStart`：必须最终走到 `_complete()` 或 `_fail()` 之一，
 *    否则 in-flight Promise 永远悬挂（业务 await 会卡死）；
 *  · `onCancel`：必须**同步**释放掉 onStart 申请的资源，禁止
 *    在 onCancel 里 await 异步操作 —— cancel 必须立刻生效，否则
 *    "race 完毕后取消其他 anim" 这类编排逻辑会失序。
 */
/**
 * Anim 构造选项。子类构造里可选地传入：
 *  · `infinite`: 标记该动画为无限长（默认 false）。详见 IAnim.isInfinite 注释。
 */
export interface AnimOptions {
    infinite?: boolean;
}

export abstract class Anim implements IAnim {
    /** 当前状态机槽位；外部只读，仅 Anim 自己改写。 */
    private _state: AnimState = "idle";

    /** 当前 in-flight Promise（仅 running 状态下非空）。 */
    private _promise: Promise<void> | undefined = undefined;

    /** 当前 in-flight Promise 的 resolve 句柄。 */
    private _resolve: (() => void) | undefined = undefined;

    /** 当前 in-flight Promise 的 reject 句柄。 */
    private _reject: ((reason?: unknown) => void) | undefined = undefined;

    /** 自动取消挂载的节点（onStart 时通过 `_autoCancelOnDestroy` 注册）。 */
    private _autoCancelTarget: Node | undefined = undefined;

    /** 自动取消用的事件回调，反挂载时需要原引用。 */
    private _autoCancelHandler: (() => void) | undefined = undefined;

    /**
     * 标记该 anim 是否无限长。构造时确定，整个生命周期不可变。
     * 详见 IAnim.isInfinite 注释。
     */
    public readonly isInfinite: boolean;

    /**
     * 子类构造里通过 `super(opts)` 传入元属性。
     * 不传或传 undefined 等价于 `{ infinite: false }`（绝大多数 anim）。
     */
    protected constructor(opts?: AnimOptions) {
        this.isInfinite = opts?.infinite ?? false;
    }

    // -------------------------------------------------------------------
    //  public IAnim 实现
    // -------------------------------------------------------------------

    public get state(): AnimState {
        return this._state;
    }

    public get isPlaying(): boolean {
        return this._state === "running";
    }

    public get isFinished(): boolean {
        return this._state === "completed" || this._state === "cancelled";
    }

    public play(): Promise<void> {
        if (this._state === "running") {
            // 已经在跑：返回同一个 Promise，保证多次 await 等的是同一件事。
            return this._promise as Promise<void>;
        }
        if (this._state === "completed") {
            // 已成功完成：play() 视为幂等成功，立即 resolved。
            return Promise.resolve();
        }
        if (this._state === "cancelled") {
            // 已被取消：明确告知业务侧"想重放请显式 replay()/reset()"，
            // 避免"cancel 完了 await 又拿到一个永远不会触发的 Promise"。
            return Promise.reject(
                new CancelledError("Anim is cancelled; call replay() or reset() before playing again."),
            );
        }

        // state === "idle"：真正启动一次新的动画。
        this._state = "running";
        const inflight = new Promise<void>((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
        this._promise = inflight;

        try {
            this.onStart();
        } catch (err) {
            // onStart 同步抛异常：直接走 fail 路径，不让 Promise 悬挂。
            this._fail(err);
        }
        // onStart 可能同步 _complete() 并清空 _promise；仍返回 inflight 供 seq/par 链式 .then()
        return inflight;
    }

    public cancel(): void {
        if (this._state !== "running") return;

        // 先做内部清理（卸载 destroy 监听），再调子类的 onCancel 释放资源。
        // 顺序很重要：onCancel 里可能间接触发 destroy 事件，先卸载避免重入。
        this._unwireAutoCancel();

        try {
            this.onCancel();
        } catch (e) {
            // 子类 onCancel 抛错通常是 bug，但 cancel 必须成功；吞掉，
            // 让状态机推进到 cancelled，免得"cancel 一半，永远不结束"。
            LogUtils.error("[Anim] onCancel threw:", e);
        }

        this._state = "cancelled";
        const reject = this._reject;
        this._resolve = undefined;
        this._reject = undefined;
        this._promise = undefined;
        reject?.(new CancelledError());
    }

    public reset(): void {
        if (this._state === "running") {
            // 先 cancel：cancel 内部会清掉 promise / handlers，并把状态置为 cancelled。
            this.cancel();
        }
        // 不论是从 cancelled / completed / 已经 idle 进来，统一推回 idle。
        this._state = "idle";
        this._promise = undefined;
        this._resolve = undefined;
        this._reject = undefined;
        this._unwireAutoCancel();

        try {
            this.onReset();
        } catch (e) {
            LogUtils.error("[Anim] onReset threw:", e);
        }
    }

    public replay(): Promise<void> {
        this.reset();
        return this.play();
    }

    // -------------------------------------------------------------------
    //  protected 子类钩子
    // -------------------------------------------------------------------

    /**
     * 启动具体的动画载荷。
     * 子类实现完成后必须最终调用 `_complete()`（成功）或 `_fail()`（失败），
     * 否则 in-flight Promise 永久悬挂。
     */
    protected abstract onStart(): void;

    /**
     * 中断 onStart 启动的资源（停 tween、清 timer、停 spine、…）。
     * 必须**同步**完成。状态机切换由 Anim 基类负责，这里只负责释放资源。
     */
    protected abstract onCancel(): void;

    /**
     * [可选] reset() 时清理子类的私有状态（迭代器位置、循环计数等），
     * 让 anim 实例可以再次 play()。默认不做事。
     */
    protected onReset(): void {
        /* default: nothing */
    }

    /**
     * 子类调用：通知"动画自然结束"。
     * 内部把状态切到 completed 并 resolve in-flight Promise。
     * 在非 running 状态调用是 no-op（防御性，避免双触发）。
     */
    protected _complete(): void {
        if (this._state !== "running") return;

        this._unwireAutoCancel();
        this._state = "completed";
        const resolve = this._resolve;
        this._resolve = undefined;
        this._reject = undefined;
        this._promise = undefined;
        resolve?.();
    }

    /**
     * 子类调用：通知"动画异常失败"。极少用——大多数动画"被打断"
     * 应该走 cancel 路径。这里仅用于"onStart 抛异常"或"内部资源加载失败"
     * 这种真正的错误。
     * 走 cancelled 状态（非 completed），promise 会 reject。
     */
    protected _fail(err: unknown): void {
        if (this._state !== "running") return;

        this._unwireAutoCancel();
        this._state = "cancelled";
        const reject = this._reject;
        this._resolve = undefined;
        this._reject = undefined;
        this._promise = undefined;
        reject?.(err instanceof Error ? err : new Error(String(err)));
    }

    /**
     * 子类在 onStart 时调用：把动画绑定到节点，节点 destroy 时自动 cancel。
     * 避免"prefab 已销毁，tween 还在改 destroy 节点的属性"导致的脏数据。
     *
     * 一个 anim 只允许绑一个节点；如需挂多个目标，请在 onCancel 里手动
     * 释放——或者拆成多个子 anim 用 par() 组合。
     */
    protected _autoCancelOnDestroy(node: Node): void {
        if (!node || !node.isValid) return;

        // 已经绑过别的目标：先解绑老的，避免"挂了多个 destroy 监听"。
        this._unwireAutoCancel();

        const handler = (): void => {
            // 节点没了：直接走 cancel 路径，让 in-flight Promise reject。
            this.cancel();
        };
        this._autoCancelTarget = node;
        this._autoCancelHandler = handler;

        // NODE_DESTROYED 在节点真正释放时触发，比 onDestroy 更靠后。
        // 用 once 避免反复触发；但保险起见 _unwireAutoCancel 还是显式 off。
        node.once(Node.EventType.NODE_DESTROYED, handler);
    }

    /** 解绑 destroy 监听；幂等。 */
    private _unwireAutoCancel(): void {
        if (this._autoCancelTarget && this._autoCancelHandler) {
            // 节点本身可能已经 destroy；调 off 时容错（cocos 在已 destroy 的
            // 节点上 off 是 no-op，不会抛）。
            this._autoCancelTarget.off(Node.EventType.NODE_DESTROYED, this._autoCancelHandler);
        }
        this._autoCancelTarget = undefined;
        this._autoCancelHandler = undefined;
    }
}
