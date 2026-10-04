// =====================================================================
//  IAnim — 动画契约
//  ---------------------------------------------------------------------
//  设计目标：用一套统一的 IAnim 抽象覆盖项目里所有"会随时间改变状态"的
//  动画形态（cc.tween / cc.Animation / sp.Skeleton / ParticleSystem /
//  ShakeTool / RollingScore / RealCurve 自定义曲线 / …），让业务侧从
//  四散的工具调用统一为一种 API：
//
//      const anim = fadeIn(node, 0.3);
//      anim.play();          // 启动；返回 Promise
//      anim.cancel();        // 中断
//      anim.reset();         // 复用
//
//  并通过 seq / par / race / loop / forever 这些编排算子把动画组合成
//  时间结构，告别"await Utils.delay(ms)"式的隐式串联。
//
//  本文件只放契约本身，不放实现。实现见同目录 Anim.ts / compose.ts /
//  builders/*。
// =====================================================================

/**
 * 动画状态机。
 *
 *   idle ──play()──→ running ──complete──→ completed
 *                       │
 *                       └──cancel()──→ cancelled
 *
 *   completed / cancelled ──reset()──→ idle
 *
 * 不变式：
 *  · `running` 时一定有一个 in-flight Promise；
 *  · `completed` / `cancelled` 是终态，不会自动转回 idle，必须显式 reset；
 *  · `cancelled` 状态的 anim 不能再 play（会 reject）；
 *    业务侧要复用动画请用 `anim.replay()`（reset+play 的语法糖）。
 */
export type AnimState = "idle" | "running" | "completed" | "cancelled";

/**
 * cancel() 触发的 Promise 拒因。
 *
 * 业务侧可以用 `instanceof CancelledError` 区分"动画跑完"和"动画被中断"：
 *
 *     try { await anim.play(); } catch (e) {
 *         if (e instanceof CancelledError) { /* 被打断，不视为错误 *\/ }
 *         else { throw e; }
 *     }
 *
 * 框架内部（compose 算子）大量依赖这一区分来避免 "child cancelled →
 * parent rejected" 的连锁误判。
 */
export class CancelledError extends Error {
    public constructor(message = "anim cancelled") {
        super(message);
        this.name = "CancelledError";
    }
}

/**
 * 所有动画的统一接口。
 *
 * 实现者建议继承 {@link Anim} 抽象基类（处理状态机、cancel 协议、
 * 自动跟随 node destroy 取消等），不要从零实现 IAnim。
 *
 * 契约要点：
 *  · `play()` 幂等：在 `running` 时多次调用返回**同一个** Promise；
 *  · `play()` 在 `completed` 时返回已 resolve 的 Promise（视为成功幂等）；
 *  · `play()` 在 `cancelled` 时返回 reject(CancelledError)，业务侧若想
 *    复用请显式 `replay()`；
 *  · `cancel()` 在非 `running` 状态下是 no-op（不会抛错）；
 *  · `reset()` 把状态还原到 `idle`，若当时正在 running 会先 cancel；
 *  · 实现者**应该**在动画启动时把作用节点（如果有）通过自动取消机制
 *    挂上去，节点 destroy 时动画自动 cancel —— 避免遗留 tween。
 */
export interface IAnim {
    /** 当前状态。响应式只读字段（不带订阅）。 */
    readonly state: AnimState;

    /** state === "running" 的便捷判断。 */
    readonly isPlaying: boolean;

    /** state === "completed" || "cancelled" 的便捷判断。 */
    readonly isFinished: boolean;

    /**
     * 是否为无限长动画（在没有外部 cancel/gracefulStop 的情况下永远不会
     * 自然 complete）。
     *
     * 用法约定：
     *  · `isInfinite=true` 的 anim **不要 await**——会卡死。调 `play()` 后
     *    保留 handle，用 `cancel()` 控制结束；
     *  · 或用 `race(forever(idleBob), mainSeq)`，让前景完事时自动停掉
     *    后台无限动画；
     *  · 加载圈这种"想转完一圈再停"的场景，用 `IRepeatableAnim.gracefulStop()`
     *    而不是 `cancel()`。
     *
     * 编排算子根据该标志推算自身的 isInfinite，并在不合理组合处 warn：
     *  · seq([..., inf, ...rest])：rest 永远不会执行 → console.warn；
     *  · par([fin, inf])：par 整体变 infinite（永远等不到所有完成）；
     *  · race([fin, inf])：race 整体 finite（fin 决定结束，inf 自动 cancel）；
     *  · race([inf, inf, ...])：race 整体 infinite；
     *  · loop(n, inf)：内层一轮就跑不完，warn；
     *  · forever(inf)：无意义包装，warn。
     *
     * 该标志在构造时确定，运行期不可变。
     */
    readonly isInfinite: boolean;

    /**
     * 启动动画。
     *
     * - idle → running：执行 onStart，返回新 Promise；
     * - running → 返回原 in-flight Promise（幂等）；
     * - completed → 立即返回 resolved Promise（幂等成功）；
     * - cancelled → 返回 rejected Promise（业务请用 replay()）。
     *
     * 对 `isInfinite=true` 的 anim：返回的 Promise 永远不会自然 resolve，
     * 只可能因 `cancel()` 而 reject(CancelledError)。请勿 await。
     */
    play(): Promise<void>;

    /**
     * 中断动画。已 running 的 Promise 会 reject(CancelledError)。
     * 在 idle / completed / cancelled 状态下是 no-op。
     */
    cancel(): void;

    /**
     * 把状态还原到 idle，使下一次 play() 重新启动。
     * 若当时是 running，会先 cancel 一次（cancel 后立即转 idle）。
     */
    reset(): void;

    /**
     * 语法糖：reset() + play()。常用在循环/重播的业务场景。
     *
     *     button.node.on("click", () => anim.replay());
     */
    replay(): Promise<void>;
}

/**
 * 可循环动画扩展契约。`loop` 和 `forever` 的返回值会满足该接口。
 *
 * 提供 `gracefulStop()` —— 让动画在**当前轮**结束后自然 complete（resolve），
 * 区别于 `cancel()` 的"立刻打断 + reject(CancelledError)"。
 *
 * 典型场景：
 *  · spinner / loader：数据回来后让转完一圈再停，避免卡在中间帧；
 *  · idle bob / breath：玩家退出 idle 状态时让缩放回到原始尺寸再停；
 *  · 闪烁提示：保证最后停在"亮起"那一帧而不是"暗下"。
 *
 * 语义保证：
 *  · 在 idle / completed / cancelled 下调用是 no-op；
 *  · running 状态下调用：标记一个停止请求，当前轮迭代跑完后调 _complete 走
 *    completed → play() 的 Promise 正常 resolve（不是 reject）；
 *  · 若立即就要停（不等当前轮），用 cancel()。
 */
export interface IRepeatableAnim extends IAnim {
    /**
     * 请求"播完当前一轮后停止"。当前轮结束 → completed → play() Promise 正常 resolve。
     * 在 idle / completed / cancelled 状态下是 no-op。
     */
    gracefulStop(): void;
}
