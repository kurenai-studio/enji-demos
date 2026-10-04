import { animEventId, type AnimEventId } from "./AnimEventId.ts";

/** 带 payload 类型的 timeline event 定义；handler / emit 共用此 token。 */
export interface AnimEventDef<TPayload = void> {
    readonly id: AnimEventId;
    readonly __payload?: TPayload;
}

export type AnimEventPayload<E> = E extends AnimEventDef<infer P> ? P : never;

/** 从 defs 对象推导 event id → payload 映射（供 AnimEventScope 泛型）。 */
export type AnimEventMapFromDefs<TDefs extends Readonly<Record<string, AnimEventDef<unknown>>>> = {
    [K in keyof TDefs as TDefs[K]["id"] & string]: AnimEventPayload<TDefs[K]>;
};

/** 定义命名 event + payload 类型；保留 id 字面量供 TS 索引 TMap。 */
export function defineAnimEvent<TPayload = void, const T extends string = string>(
    id: T,
): AnimEventDef<TPayload> & { readonly id: AnimEventId & T } {
    return { id: animEventId(id) };
}
