import { CancelledError, type IAnim } from "./IAnim.ts";

/** 串行队列中的一步（与 reel / 盘面无关） */
export type AnimQueueTask = () => Promise<void>;

/**
 * 纯抽象动画串行队列：只负责排队、顺序 await、取消当前 IAnim。
 * Presenter 对 CascadePlanStep：playStep → IAnim，再 enqueue + playOne 串行播放。
 */
export class SerialAnimQueue {
    private readonly _tasks: AnimQueueTask[] = [];
    private _running = false;
    private _currentAnim: IAnim | null = null;

    public enqueue(task: AnimQueueTask): void {
        this._tasks.push(task);
    }

    public enqueueAll(tasks: Iterable<AnimQueueTask>): void {
        for (const task of tasks) {
            this.enqueue(task);
        }
    }

    /** 将单个 IAnim 作为一步入队 */
    public enqueueAnim(anim: IAnim): void {
        this.enqueue(() => this.playOne(anim));
    }

    public clear(): void {
        this._tasks.length = 0;
    }

    public get pendingCount(): number {
        return this._tasks.length;
    }

    public get isRunning(): boolean {
        return this._running;
    }

    public cancelAll(): void {
        this._currentAnim?.cancel();
        this._currentAnim = null;
        this.clear();
    }

    public async run(): Promise<void> {
        if (this._running) {
            throw new Error("[SerialAnimQueue] already running");
        }
        this._running = true;
        try {
            while (this._tasks.length > 0) {
                const task = this._tasks.shift()!;
                await task();
            }
        } finally {
            this._currentAnim = null;
            this._running = false;
        }
    }

    /** 立即播放一个 IAnim（供队列 task 内部或外部单次调用） */
    public async playOne(anim: IAnim): Promise<void> {
        this.trackAnim(anim);
        try {
            await anim.play();
        } catch (e) {
            if (!(e instanceof CancelledError)) {
                throw e;
            }
        } finally {
            if (this._currentAnim === anim) {
                this._currentAnim = null;
            }
        }
    }

    private trackAnim(anim: IAnim | null): void {
        if (this._currentAnim && this._currentAnim !== anim) {
            this._currentAnim.cancel();
        }
        this._currentAnim = anim;
    }
}
