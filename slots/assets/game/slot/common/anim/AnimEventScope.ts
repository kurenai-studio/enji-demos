import type { AnimEventDef, AnimEventMapFromDefs, AnimEventPayload } from "./AnimEventDef.ts";
import type { AnimEventId } from "./AnimEventId.ts";

/** event id → handler(payload) */
export type AnimEventHandlerMap<TMap extends Record<string, unknown> = Record<string, unknown>> = {
    [K in keyof TMap & string]?: (payload: TMap[K]) => void;
};

/** defs 对象 key → handler(payload)，payload 由 defineAnimEvent 推断。 */
export type AnimEventHandlerMapFromDefs<TDefs extends Readonly<Record<string, AnimEventDef<unknown>>>> = {
    [K in keyof TDefs]?: (payload: AnimEventPayload<TDefs[K]>) => void;
};

/**
 * 单次 buildAnim / play 会话内的 timeline event 通道。
 *
 * - **Emitter**（motion / IAnim 实现）：`scope.emit(eventId, payload)`
 * - **Handler**（编排层）：`bindAnimEventHandlers({ ... })` 构造 scope 传入 `IAnimBuildContext.events`
 *
 * 无 handler 的 emit 为 no-op（motion 层不必判空）。
 */
export class AnimEventScope<TMap extends Record<string, unknown> = Record<string, unknown>> {
    private static readonly _empty = new AnimEventScope();

    private readonly _handlers: Map<string, (payload: unknown) => void>;

    public constructor(handlers?: AnimEventHandlerMap<TMap>) {
        this._handlers = new Map();
        if (handlers) {
            for (const key of Object.keys(handlers) as (keyof TMap & string)[]) {
                const fn = handlers[key];
                if (fn) {
                    this._handlers.set(key, fn as (payload: unknown) => void);
                }
            }
        }
    }

    /** 永不 fire 的 scope；motion 层默认 fallback。 */
    public static empty(): AnimEventScope {
        return AnimEventScope._empty;
    }

    public hasHandler(eventId: AnimEventId): boolean {
        return this._handlers.has(eventId);
    }

    public emit<K extends keyof TMap & string>(eventId: K, payload: TMap[K]): void;
    public emit(eventId: AnimEventId, payload: unknown): void;
    public emit(eventId: AnimEventId, payload: unknown): void {
        this._handlers.get(eventId)?.(payload);
    }
}

/** 编排层：按 event id 绑定 handler，grep event id 即可定位处理点。 */
export function bindAnimEventHandlers<TMap extends Record<string, unknown>>(
    handlers: AnimEventHandlerMap<TMap>,
): AnimEventScope<TMap> {
    return new AnimEventScope(handlers);
}

/** 编排层：按 defs 对象 key 绑定 handler（推荐；payload 全推断）。 */
export function bindAnimEventHandlersFromDefs<
    TDefs extends Readonly<Record<string, AnimEventDef<unknown>>>,
>(
    defs: TDefs,
    handlers: AnimEventHandlerMapFromDefs<TDefs>,
): AnimEventScope<AnimEventMapFromDefs<TDefs>> {
    const byId: Record<string, (payload: unknown) => void> = {};
    for (const key of Object.keys(handlers) as (keyof TDefs)[]) {
        const fn = handlers[key];
        const def = defs[key];
        if (fn && def) {
            byId[def.id] = fn as (payload: unknown) => void;
        }
    }
    return new AnimEventScope(byId as AnimEventHandlerMap<AnimEventMapFromDefs<TDefs>>);
}
