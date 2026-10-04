/**
 * boardEvents — 盘面播放事件总线。
 *
 * 事件发射点在动画的「连接处」（帧转移边界 / 单格演出边界），handler 可以：
 *   · 同步做副作用（加分、记账、打点）；
 *   · 返回 Promise —— emit 会等待它 resolve，动画链在该连接处暂停，
 *     resolve 后继续（实现"消除时弹加分飘字，飘完再继续"这类编排）。
 *
 * 监听方式：
 *   events.on('symbol-vanish', h)   // 监听具体事件
 *   events.on('*', h)               // 监听所有事件（h 收到完整 BoardEvent，按 type 分流）
 *   const off = events.on(...); off();  // 返回值即解绑函数
 *
 * handler 抛错/被 reject 只记日志，不打断动画播放。
 */

import type { IrFrameKind } from '../editor-core/index.ts';

export type BoardEventType =
    /** 整段播放开始 / 结束（playRange 边界） */
    | 'play-start'
    | 'play-end'
    /** 单帧转移开始 / 结束（frameIndex 为转移的目标帧） */
    | 'transition-start'
    | 'transition-end'
    /** dropIn 单格落地（弹跳结束、入场动效开始前） */
    | 'symbol-land'
    /** highlight 单格中奖演出开始前 */
    | 'symbol-win'
    /** postClear 单格本体消失开始前（加分挂这里，symbolId 为被消除的符号） */
    | 'symbol-vanish'
    /** expandPost 单格倍率球飞出开始（音效槽；带 multiplier） */
    | 'multi-expand'
    /** expandPost 单格倍率球落地/现身（音效槽；带 multiplier） */
    | 'multi-expand-land'
    /** multiCollect 单格倍率数字开始被收集（音效/结算槽；带 multiplier；球本身保留） */
    | 'multi-collect';

export interface BoardEvent {
    type: BoardEventType;
    /** 相关帧 index（转移事件 = 目标帧；play 事件 = 起始/停留帧） */
    frameIndex: number;
    frameKind: IrFrameKind | null;
    col?: number;
    row?: number;
    symbolId?: number | null;
    /** multi 相关事件携带实体倍率 */
    multiplier?: number;
}

export type BoardEventHandler = (e: BoardEvent) => void | Promise<void>;

export class BoardEvents {
    private handlers = new Map<string, Set<BoardEventHandler>>();

    /** 注册监听；type 传 '*' 监听全部。返回解绑函数。 */
    on(type: BoardEventType | '*', handler: BoardEventHandler): () => void {
        let set = this.handlers.get(type);
        if (!set) {
            set = new Set();
            this.handlers.set(type, set);
        }
        set.add(handler);
        return () => this.off(type, handler);
    }

    off(type: BoardEventType | '*', handler: BoardEventHandler): void {
        this.handlers.get(type)?.delete(handler);
    }

    /**
     * 发射事件并顺序等待所有 handler（具体监听在前，'*' 在后）。
     * 任何 handler 返回 Promise 都会让动画停在连接处直到 resolve。
     */
    async emit(e: BoardEvent): Promise<void> {
        const hs = [
            ...(this.handlers.get(e.type) ?? []),
            ...(this.handlers.get('*') ?? []),
        ];
        for (const h of hs) {
            try {
                await h(e);
            } catch (err) {
                console.error(`[BoardEvents] handler for '${e.type}' threw`, err);
            }
        }
    }
}
