// =====================================================================
//  compose — 动画编排算子
//  ---------------------------------------------------------------------
//  把一组 IAnim 组合成"时间结构"：
//
//    seq(a, b, c)       —— 串联：a 完成 → b → c
//    par(a, b, c)       —— 并行：所有都完成才完成
//    race(a, b, c)      —— 赛跑：第一个完成就完成，其他自动 cancel
//    loop(n, a)         —— 循环 n 次
//    forever(a)         —— 永远循环（直到外部 cancel）
//    delay(seconds)     —— 等若干秒（受 director 暂停影响）
//    call(fn)           —— 同步/异步函数包装为 anim 步
//
//  这些算子的返回值都是 IAnim，可以再被组合 —— 业务侧拿到的最终就是
//  一个 anim 树，play() / cancel() / replay() 就能控制整棵树。
//
//  cancel 语义统一：父 anim cancel → 所有 in-flight 子 anim cancel。
//  child 主动 cancel（外部直接拿 child.cancel）→ 父 anim 也走 cancel
//  路径（CancelledError 被吸收，不当作 _fail）。
// =====================================================================

import { Animation, ParticleSystem, Tween, tween } from "cc";
import type { sp } from "cc";
import { LogUtils } from "../misc/LogUtils.ts";
import { Anim } from "./Anim.ts";
import type { IAnim, IRepeatableAnim } from "./IAnim.ts";
import { CancelledError } from "./IAnim.ts";

// =====================================================================
//  delay(seconds) —— 用 cc.tween 的空对象当 timer，跟着 director 走
// =====================================================================

class DelayAnim extends Anim {
    /** cc.tween 的 host 对象，必须保留引用让 stopAllByTarget 能停掉它。 */
    private readonly _host: Record<string, unknown> = {};
    /** 启动后保存 tween 句柄（这里没什么用，但留着便于调试）。 */
    private _tween: Tween<Record<string, unknown>> | undefined = undefined;

    public constructor(private readonly _seconds: number) {
        // delay 永远是有限的（即便传 Infinity 也不合理；那种情况业务该用 forever）。
        super({ infinite: false });
    }

    protected onStart(): void {
        if (this._seconds <= 0) {
            // 0 / 负值：立即完成，跳过 tween 调度，避免至少一帧延迟。
            this._complete();
            return;
        }
        // 用 cc.tween 而不是 setTimeout：
        //   1) 跟着 director 暂停，符合"游戏暂停时动画也暂停"的直觉；
        //   2) 与其他 anim 共享同一个 tweenSystem，cancel 路径统一。
        this._tween = tween(this._host)
            .delay(this._seconds)
            .call(() => this._complete())
            .start();
    }

    protected onCancel(): void {
        // stopAllByTarget 接受 host 对象引用，把绑在 _host 上的所有 tween 全停。
        Tween.stopAllByTarget(this._host);
        this._tween = undefined;
    }
}

/**
 * 等若干秒后完成。受 director.pause() 影响（cc.tween 的标准行为）。
 *
 *   await delay(0.3).play();    // 单独使用
 *   seq(fadeIn(...), delay(0.5), fadeOut(...))   // 组合
 */
export function delay(seconds: number): IAnim {
    return new DelayAnim(seconds);
}

// =====================================================================
//  call(fn) —— 把同步/异步函数包成一个 anim 步
// =====================================================================

class CallAnim extends Anim {
    public constructor(private readonly _fn: () => void | Promise<void>) {
        // call 默认有限：同步函数立刻完成；异步函数等其 Promise。
        // 真正"无限的副作用"应改写成具体 IAnim（比如自定义 ForeverAnim 子类），
        // 不要塞进 call 里以免误用 await。
        super({ infinite: false });
    }

    protected onStart(): void {
        let result: void | Promise<void>;
        try {
            result = this._fn();
        } catch (e) {
            // 同步抛错：直接走 fail 路径。
            this._fail(e);
            return;
        }

        if (result && typeof (result).then === "function") {
            // 异步函数：等 Promise resolve/reject 后再切状态。
            // 注意 cancel 时我们没法真的取消用户的 Promise，但状态机已经切走了，
            // 它后来的 resolve 会被 _complete 的"非 running 直接 no-op"过滤掉。
            (result).then(
                () => this._complete(),
                (err: unknown) => this._fail(err),
            );
        } else {
            // 同步函数：执行完即完成。
            this._complete();
        }
    }

    protected onCancel(): void {
        // 函数本身不可取消；状态机切到 cancelled 后，
        // 用户函数后续的 resolve/reject 会被 _complete/_fail 的状态守卫吞掉。
    }
}

/**
 * 把任意函数（同步或返回 Promise）包成 anim 步，用于 `seq` 编排。
 *
 *   seq(
 *     fadeIn(node, 0.3),
 *     call(() => audio.play("ding")),       // 同步副作用
 *     call(async () => await loadSomething()), // 异步步骤
 *     fadeOut(node, 0.3),
 *   )
 *
 * 注意：异步 `call` 在 cancel 时只切状态、不真的中断用户的 Promise。
 * 如果函数体很长，请显式做好 abort 检查（或拆成更细的 anim）。
 */
export function call(fn: () => void | Promise<void>): IAnim {
    return new CallAnim(fn);
}

// =====================================================================
//  starterAnim(starter) —— 外部载荷启动后调 finish() 结束（IAnim 原生步，非 Promise/call 异步）
// =====================================================================

class StarterAnim extends Anim {
    private _dispose: (() => void) | undefined;

    public constructor(private readonly _starter: (finish: () => void) => void | (() => void)) {
        super({ infinite: false });
    }

    protected onStart(): void {
        try {
            const dispose = this._starter(() => this._complete());
            this._dispose = typeof dispose === "function" ? dispose : undefined;
        } catch (e) {
            this._fail(e);
        }
    }

    protected override _complete(): void {
        this._runDispose();
        super._complete();
    }

    protected override onCancel(): void {
        this._runDispose();
    }

    protected override onReset(): void {
        this._runDispose();
    }

    private _runDispose(): void {
        const dispose = this._dispose;
        this._dispose = undefined;
        if (!dispose) {
            return;
        }
        try {
            dispose();
        } catch (e) {
            LogUtils.error("[StarterAnim] dispose threw:", e);
        }
    }
}

/**
 * 把「启动外部 time-based 载荷，完成后调用 finish()」桥成 IAnim 步。
 *
 *   seq(
 *     par(...symbols.map((m) => buildSymbolFallDownAnim(m, col, sim, scope))),
     *     call(() => finalizeRefillLayout(col)),
 *   )
 *
 * starter 返回的 dispose 在 complete / cancel / reset 时同步调用（清 listener / 停 tween 等）。
 */
export function starterAnim(starter: (finish: () => void) => void | (() => void)): IAnim {
    return new StarterAnim(starter);
}

// =====================================================================
//  seq(...) —— 串联
// =====================================================================

class SeqAnim extends Anim {
    /** 当前播到第几个；onStart 时归零。 */
    private _idx = 0;

    public constructor(private readonly _anims: ReadonlyArray<IAnim>) {
        // seq 整体 infinite 当且仅当任一子 infinite —— infinite 子出现后流程就停在那。
        // 同时检查是否有非末尾 infinite child（其后续永不可达）。
        const hasInfiniteChild = _anims.some((a) => a.isInfinite);
        super({ infinite: hasInfiniteChild });

        // 仅在"非末尾位置出现 infinite"时报警；末尾位置 infinite 是合法的
        // "做完前面的事，然后转入永久循环背景"模式。
        for (let i = 0; i < _anims.length - 1; i++) {
            const child = _anims[i];
            if (child?.isInfinite) {
                LogUtils.warn(
                    `[anim] seq(): child #${i} is infinite; the following ${
                        _anims.length - 1 - i
                    } child(ren) will never run. ` +
                        `Did you mean race(infinite, ...) or to play the infinite child separately?`,
                );
                break; // 报一次就够，避免刷屏
            }
        }
    }

    protected onStart(): void {
        this._idx = 0;
        this._next();
    }

    /** 推进到下一个子 anim；状态守卫保证 cancel 后不会继续执行。 */
    private _next(): void {
        if (this.state !== "running") return;
        if (this._idx >= this._anims.length) {
            this._complete();
            return;
        }
        const cur = this._anims[this._idx++];
        if (!cur) {
            this._next();
            return;
        }
        // 强制把子 anim 拉回 idle 再 play —— 防御"该实例之前被外部
        // play/cancel 过、现在状态是 completed/cancelled"导致 play() 直接
        // resolve/reject、seq 跳过或悬挂的坑。compose 算子拥有子 anim 的
        // 生命周期所有权，重置是正当行为。
        if (cur.state !== "idle") cur.reset();
        void cur.play().then(
            () => this._next(),
            (err: unknown) => {
                if (err instanceof CancelledError) {
                    // 父已 cancel：连锁 reject，不再 fail。
                    // 父仍在 running：子被外部 cancel → 整棵 seq 失败。
                    if (this.state === "running") {
                        this._fail(err);
                    }
                    return;
                }
                this._fail(err);
            },
        );
    }

    protected override onCancel(): void {
        // 取消当前正在跑的子 anim；之前的已完成，之后的还没启动。
        const cur = this._anims[this._idx - 1];
        if (cur && cur.isPlaying) cur.cancel();
    }

    protected override onReset(): void {
        // 把整条链路一起 reset，保证下次 play 从头开始。
        for (const a of this._anims) a.reset();
        this._idx = 0;
    }
}

/**
 * 串联：依次播放 a, b, c... 全部完成才算完成。
 * 任一子 anim 被外部 cancel → seq 整体 cancel。
 */
export function seq(...anims: IAnim[]): IAnim {
    if (anims.length === 0) {
        // 空序列：直接返回一个"立即完成"的 anim。
        return new CallAnim(() => undefined);
    }
    if (anims.length === 1) {
        // 退化为单个 anim：避免没意义的包装层。
        return anims[0]!;
    }
    return new SeqAnim(anims);
}

// =====================================================================
//  par(...) —— 并行（all settle）
// =====================================================================

class ParAnim extends Anim {
    /** 已完成（resolve 或 reject）的子 anim 计数。 */
    private _done = 0;

    public constructor(private readonly _anims: ReadonlyArray<IAnim>) {
        // par 等所有子 settle —— 任一子 infinite 就永远等不齐 → 整体 infinite。
        // 不报警：业务上"主体动画 + 永久背景闪烁"用 par 是合理写法，
        // 由外层 race 或显式 cancel 控制结束时机。
        super({ infinite: _anims.some((a) => a.isInfinite) });
    }

    protected onStart(): void {
        this._done = 0;
        for (const a of this._anims) {
            // 同 SeqAnim：把子 anim 拉回 idle 再 play，避免被复用过的
            // completed/cancelled 实例污染并行编排。
            if (a.state !== "idle") a.reset();
            void a.play().then(
                () => this._onChildDone(),
                (err: unknown) => this._onChildFailed(err),
            );
        }
    }

    private _onChildDone(): void {
        if (this.state !== "running") return;
        this._done++;
        if (this._done >= this._anims.length) {
            this._complete();
        }
    }

    private _onChildFailed(err: unknown): void {
        if (this.state !== "running") return;
        if (err instanceof CancelledError) {
            // 子 anim 被外部直接 cancel：视为整组 cancel，停掉其他。
            for (const a of this._anims) if (a.isPlaying) a.cancel();
            // 切到 cancelled 状态——不要走 _complete，否则父级以为成功了。
            // 通过 fail(CancelledError) 让父链知道我们是被取消的。
            this._fail(err);
            return;
        }
        // 真正的子 anim 错误：停掉其他，整组失败。
        for (const a of this._anims) if (a.isPlaying) a.cancel();
        this._fail(err);
    }

    protected override onCancel(): void {
        for (const a of this._anims) if (a.isPlaying) a.cancel();
    }

    protected override onReset(): void {
        for (const a of this._anims) a.reset();
        this._done = 0;
    }
}

/**
 * 并行：所有子 anim 同时开始，**全部**完成才算完成。
 * 任一子 anim 失败/被取消 → 其他全部 cancel，整组失败/取消。
 */
export function par(...anims: IAnim[]): IAnim {
    if (anims.length === 0) return new CallAnim(() => undefined);
    if (anims.length === 1) return anims[0]!;
    return new ParAnim(anims);
}

// =====================================================================
//  race(...) —— 赛跑（first settle）
// =====================================================================

class RaceAnim extends Anim {
    public constructor(private readonly _anims: ReadonlyArray<IAnim>) {
        // race 等任一子 settle —— 只要有一个 finite，race 就一定会 settle → finite。
        // 仅当所有子都 infinite 时整体才 infinite。
        super({ infinite: _anims.length > 0 && _anims.every((a) => a.isInfinite) });
    }

    protected onStart(): void {
        for (const a of this._anims) {
            // 同 Seq/Par：拉回 idle 再 play，避免复用过的实例造成 race 立即
            // 被某个已 completed 子 anim 一瞬秒赢、其他子来不及启动。
            if (a.state !== "idle") a.reset();
            a.play().then(
                () => this._onChildDone(),
                (err: unknown) => this._onChildFailed(err),
            );
        }
    }

    private _onChildDone(): void {
        if (this.state !== "running") return;
        // 第一个完成的赢家：停掉其他，整组完成。
        for (const a of this._anims) if (a.isPlaying) a.cancel();
        this._complete();
    }

    private _onChildFailed(err: unknown): void {
        if (this.state !== "running") return;
        if (err instanceof CancelledError) {
            // 某个子被取消：不影响 race，继续等其他子完成。
            // 但如果**所有**子都被取消了，race 永远不会完成——加个守卫：
            const anyAlive = this._anims.some((a) => a.isPlaying);
            if (!anyAlive) {
                this._fail(new CancelledError("all race participants cancelled"));
            }
            return;
        }
        // 真正错误：停掉其他，整组 fail。
        for (const a of this._anims) if (a.isPlaying) a.cancel();
        this._fail(err);
    }

    protected override onCancel(): void {
        for (const a of this._anims) if (a.isPlaying) a.cancel();
    }

    protected override onReset(): void {
        for (const a of this._anims) a.reset();
    }
}

/**
 * 赛跑：所有子 anim 同时开始，**第一个**完成就算完成（其他自动取消）。
 * 常用于"动画播完 or 玩家点击跳过 or 超时"这类多源等待。
 */
export function race(...anims: IAnim[]): IAnim {
    if (anims.length === 0) {
        // 空 race 没有完成源——立即视为完成（避免悬挂）。
        return new CallAnim(() => undefined);
    }
    if (anims.length === 1) return anims[0]!;
    return new RaceAnim(anims);
}

// =====================================================================
//  loop(n, a) —— 重复若干次
// =====================================================================

class LoopAnim extends Anim implements IRepeatableAnim {
    /** 剩余次数；进入每个 iteration 前 -1。 */
    private _remaining = 0;
    /** gracefulStop 标记：当前轮跑完后走 _complete 而不是继续下一轮。 */
    private _gracefulStopRequested = false;

    public constructor(
        private readonly _times: number,
        private readonly _anim: IAnim,
    ) {
        // 校验 + 推算 isInfinite：
        //   · 子 infinite：内层一轮就跑不完，loop 没意义 → warn；
        //     此时 loop 整体也是 infinite（永远停在第一轮）；
        //   · times = Infinity / 非有限值：loop 整体 infinite，等价于 forever。
        if (_anim.isInfinite) {
            LogUtils.warn(
                `[anim] loop(${_times}, ...): inner anim is infinite; the first iteration ` +
                    `never completes. Did you mean to play it directly, or use race() to bound it?`,
            );
        }
        const inf = !Number.isFinite(_times) || _anim.isInfinite;
        super({ infinite: inf });
    }

    protected onStart(): void {
        this._gracefulStopRequested = false;
        if (this._times <= 0) {
            // 0 / 负值循环：直接完成，避免死循环或语义混乱。
            this._complete();
            return;
        }
        this._remaining = this._times;
        this._next();
    }

    private _next(): void {
        if (this.state !== "running") return;
        // gracefulStop 路径：礼貌停止，整体走 completed → Promise resolve。
        if (this._gracefulStopRequested) {
            this._complete();
            return;
        }
        if (this._remaining <= 0) {
            this._complete();
            return;
        }
        this._remaining--;
        // 每次迭代前 reset 一次，保证子 anim 是从头跑的（subAnim 的状态机
        // 是终态，需要 reset 才能再 play）。
        this._anim.reset();
        this._anim.play().then(
            () => this._next(),
            (err: unknown) => {
                if (err instanceof CancelledError) return;
                this._fail(err);
            },
        );
    }

    public gracefulStop(): void {
        if (this.state !== "running") return;
        // 仅打标记，不打断当前轮；当前轮完成时 _next() 看到标记走 _complete。
        this._gracefulStopRequested = true;
    }

    protected override onCancel(): void {
        if (this._anim.isPlaying) this._anim.cancel();
    }

    protected override onReset(): void {
        this._anim.reset();
        this._remaining = 0;
        this._gracefulStopRequested = false;
    }
}

/**
 * 重复 `times` 次。`times <= 0` 视为立即完成；`Infinity` 等价于 `forever`。
 *
 *   loop(3, scalePop(node, 1.2, 0.15))   // 弹三下
 *
 * 返回的 IRepeatableAnim 支持 `gracefulStop()` —— 让当前轮跑完再停，
 * 不像 cancel() 那样立刻打断。
 */
export function loop(times: number, anim: IAnim): IRepeatableAnim {
    return new LoopAnim(times, anim);
}

// =====================================================================
//  forever(a) —— 无限循环（外部 cancel 才停）
// =====================================================================

class ForeverAnim extends Anim implements IRepeatableAnim {
    /** gracefulStop 标记：当前轮跑完后走 _complete 而不是继续下一轮。 */
    private _gracefulStopRequested = false;

    public constructor(private readonly _anim: IAnim) {
        if (_anim.isInfinite) {
            // 内层已 infinite：第一轮就永远跑不完，wrap 在 forever 里没有任何效果。
            // 仍然标记 isInfinite=true 让语义自洽，但报警提示业务侧。
            LogUtils.warn(
                `[anim] forever(): inner anim is already infinite; wrapping has no effect. ` +
                    `Did you mean to play it directly?`,
            );
        }
        super({ infinite: true });
    }

    protected onStart(): void {
        this._gracefulStopRequested = false;
        this._next();
    }

    private _next(): void {
        if (this.state !== "running") return;
        if (this._gracefulStopRequested) {
            // 礼貌停止：当前轮已 settle，下一轮不再启动 → completed → resolve。
            this._complete();
            return;
        }
        this._anim.reset();
        this._anim.play().then(
            () => this._next(),
            (err: unknown) => {
                if (err instanceof CancelledError) return;
                this._fail(err);
            },
        );
    }

    public gracefulStop(): void {
        if (this.state !== "running") return;
        this._gracefulStopRequested = true;
    }

    protected override onCancel(): void {
        if (this._anim.isPlaying) this._anim.cancel();
    }

    protected override onReset(): void {
        this._anim.reset();
        this._gracefulStopRequested = false;
    }
}

/**
 * 无限循环。永远不会自然走到 completed，必须通过：
 *  · `cancel()`：立刻停，play() Promise reject(CancelledError)；
 *  · `gracefulStop()`：当前轮播完再停，play() Promise 正常 resolve。
 *
 *   const breath = forever(seq(scaleTo(node, 1.05, 0.4), scaleTo(node, 1, 0.4)));
 *   breath.play();            // 不要 await，永不自然完成
 *   // ... 某个时机
 *   breath.gracefulStop();    // 转完一整轮停在原位（推荐）
 *   // 或：breath.cancel();   // 立即打断（中间帧停下）
 *
 * 经典模式 —— "无限背景 + 有限前景"：
 *   await race(forever(idleBob), mainSeq).play();
 *   // 当 mainSeq 完成，race 自动 cancel 掉 idleBob
 */
export function forever(anim: IAnim): IRepeatableAnim {
    return new ForeverAnim(anim);
}

// =====================================================================
//  playSpine — sp.Skeleton 播 track（无 Cocos Animation 状态机）
// =====================================================================

export type PlaySpineOptions = {
    loop?: boolean;
    trackIndex?: number;
    /**
     * loop=true 时默认立即 complete（idle 背景）。
     * false 时 seq 会等到外部 cancel。
     */
    completeWhenStarted?: boolean;
    /**
     * 进入本动画时与 track 上正在播的动画做 crossfade 的时长（秒）。
     * 解决 idle → enter 这类硬切 pop。
     */
    mixIn?: number;
    /**
     * 本动画播完后无缝接续的动画（spine 原生 addAnimation 排队，
     * 用 setMix 做 crossfade —— 解决 enter → loop 硬切）。
     * anim 完成事件仍以「本动画播完」为准，followUp 只是背景接续。
     */
    followUp?: { anim: string; loop?: boolean; mix?: number };
};

class PlaySpineAnim extends Anim {
    private _trackEntry: ReturnType<sp.Skeleton["setAnimation"]> | null = null;

    public constructor(
        private readonly _skeleton: sp.Skeleton,
        private readonly _animName: string,
        private readonly _options: PlaySpineOptions,
    ) {
        const loop = _options.loop ?? false;
        super({ infinite: loop && _options.completeWhenStarted === false });
    }

    protected onStart(): void {
        if (!this._skeleton?.isValid || !this._skeleton.skeletonData) {
            this._fail(new Error(`playSpine: invalid skeleton or missing data (${this._animName})`));
            return;
        }

        this._autoCancelOnDestroy(this._skeleton.node);

        const loop = this._options.loop ?? false;
        const trackIndex = this._options.trackIndex ?? 0;
        const followUp = this._options.followUp;

        try {
            // 与 track 上正在播的动画 crossfade 进入（idle → enter 不硬切）
            const mixIn = this._options.mixIn ?? 0;
            if (mixIn > 0) {
                const current = this._skeleton.getCurrent(trackIndex)?.animation?.name;
                if (current && current !== this._animName) {
                    this._skeleton.setMix(current, this._animName, mixIn);
                }
            }
            // 播完接续动画的 crossfade（enter → loop 不硬切）
            if (followUp) {
                this._skeleton.setMix(this._animName, followUp.anim, followUp.mix ?? 0.2);
            }

            this._skeleton.setCompleteListener((entry) => {
                if (loop || this.state !== "running") return;
                // 不能用 entry === trackEntry 引用比对：wasm spine 运行时传入的
                // TrackEntry 包装对象与 setAnimation 返回值可能不是同一引用。
                // 按动画名过滤（followUp 的 complete 是别的名字，不会误触发）。
                const name = entry?.animation?.name;
                if (name !== undefined && name !== this._animName) return;
                this._skeleton.setCompleteListener(undefined as never);
                this._complete();
            });
            this._trackEntry = this._skeleton.setAnimation(trackIndex, this._animName, loop);
            if (!this._trackEntry && !loop) {
                this._fail(new Error(`playSpine: setAnimation failed (${this._animName})`));
                return;
            }
            // followUp 用 spine 原生队列接在后面：状态机在混合窗口内平滑过渡，
            // 而 anim 的 complete 仍以主动画播完为准（followUp 是背景延续）。
            if (followUp) {
                this._skeleton.addAnimation(trackIndex, followUp.anim, followUp.loop ?? true, 0);
            }
            if (loop && this._options.completeWhenStarted !== false) {
                this._complete();
            }
        } catch (err) {
            this._fail(err);
        }
    }

    protected onCancel(): void {
        if (!this._skeleton?.isValid) {
            return;
        }
        this._skeleton.setCompleteListener(undefined as never);
        this._skeleton.clearTrack(this._options.trackIndex ?? 0);
        this._trackEntry = null;
    }
}

/**
 * 播放 Spine track。非 loop 时等待 complete；loop 默认启动后即 complete（可叠加 par/seq）。
 */
export function playSpine(
    skeleton: sp.Skeleton,
    animName: string,
    options: PlaySpineOptions = {},
): IAnim {
    return new PlaySpineAnim(skeleton, animName, options);
}

// =====================================================================
//  playClip — cc.Animation 播 clip（不走 AnimationController）
// =====================================================================

export type PlayClipOptions = {
    /** clip 缺失或 getState 失败时的兜底时长 */
    durationSec?: number;
    /** loop clip 且 completeWhenStarted=false 时标记 infinite */
    loop?: boolean;
    completeWhenStarted?: boolean;
};

class PlayClipAnim extends Anim {
    private _finishedHandler: (() => void) | undefined;

    public constructor(
        private readonly _animation: Animation,
        private readonly _clipName: string,
        private readonly _options: PlayClipOptions,
    ) {
        const loop = _options.loop ?? false;
        super({ infinite: loop && _options.completeWhenStarted === false });
    }

    protected onStart(): void {
        if (!this._animation?.isValid) {
            this._fail(new Error(`playClip: invalid Animation (${this._clipName})`));
            return;
        }

        this._autoCancelOnDestroy(this._animation.node);

        const loop = this._options.loop ?? false;
        const state = this._animation.getState(this._clipName);
        if (!state) {
            const fallback = this._options.durationSec;
            if (fallback != null && fallback >= 0) {
                delay(fallback)
                    .play()
                    .then(
                        () => this._complete(),
                        (err: unknown) => this._fail(err),
                    );
                return;
            }
            this._fail(new Error(`playClip: clip not found (${this._clipName})`));
            return;
        }

        if (loop) {
            state.wrapMode = 2; // Loop
        }

        this._finishedHandler = () => {
            if (!loop && this.state === "running") {
                this._animation.off(Animation.EventType.FINISHED, this._finishedHandler!, this);
                this._complete();
            }
        };

        if (!loop) {
            this._animation.on(Animation.EventType.FINISHED, this._finishedHandler, this);
        }

        this._animation.play(this._clipName);

        if (loop && this._options.completeWhenStarted !== false) {
            this._complete();
        }
    }

    protected onCancel(): void {
        if (!this._animation?.isValid) {
            return;
        }
        if (this._finishedHandler) {
            this._animation.off(Animation.EventType.FINISHED, this._finishedHandler, this);
            this._finishedHandler = undefined;
        }
        this._animation.stop();
    }
}

/** 播放 cc.Animation clip；非 loop 时等待 FINISHED 或 durationSec 兜底。 */
export function playClip(
    animation: Animation,
    clipName: string,
    options: PlayClipOptions = {},
): IAnim {
    return new PlayClipAnim(animation, clipName, options);
}

// =====================================================================
//  playParticleBurst — 触发粒子 burst 并等待 drain
// =====================================================================

export type PlayParticleBurstOptions = {
    /** 粒子播完后的等待时长（秒）；Cocos 3.8 无 FINISHED 回调时用硬编码 */
    drainSec?: number;
    /** 播放前激活粒子节点（默认 true） */
    activateNodes?: boolean;
};

class PlayParticleBurstAnim extends Anim {
    public constructor(
        private readonly _particles: readonly ParticleSystem[],
        private readonly _options: PlayParticleBurstOptions,
    ) {
        super({ infinite: false });
    }

    protected onStart(): void {
        const activate = this._options.activateNodes !== false;
        for (const particle of this._particles) {
            if (!particle?.isValid) {
                continue;
            }
            if (activate) {
                particle.node.active = true;
            }
            particle.play();
        }
        const drain = this._options.drainSec ?? 0;
        if (drain <= 0) {
            this._complete();
            return;
        }
        delay(drain)
            .play()
            .then(
                () => this._complete(),
                (err: unknown) => this._fail(err),
            );
    }

    protected onCancel(): void {
        for (const particle of this._particles) {
            if (!particle?.isValid) {
                continue;
            }
            particle.stop();
        }
    }
}

/** 触发一组 ParticleSystem burst，等待 drainSec 后完成。 */
export function playParticleBurst(
    particles: readonly ParticleSystem[],
    options: PlayParticleBurstOptions = {},
): IAnim {
    return new PlayParticleBurstAnim(particles, options);
}
