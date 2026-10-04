import type { AnimEventDef } from "./AnimEventDef.ts";
import type { AnimId } from "./AnimId.ts";
import type { AnimEventId } from "./AnimEventId.ts";

/** 由 defineAnimEvent 列表构造 spec 表项。 */
export function animEventSpec(
    animId: AnimId,
    emits: readonly AnimEventDef<unknown>[],
): AnimEventSpec {
    return { animId, emits: emits.map((e) => e.id) };
}

/**
 * 声明某个 animId 在 play() 期间可能 emit 的 timeline event。
 * 业务域维护一张总表，读代码前先查 spec → 再 grep event id → 直达 handler。
 */
export interface AnimEventSpec {
    readonly animId: AnimId;
    readonly emits: readonly AnimEventId[];
}

/** 从 spec 表查 animId 会 emit 哪些 event（无则 []）。 */
export function eventsForAnim(specs: readonly AnimEventSpec[], animId: AnimId): readonly AnimEventId[] {
    return specs.find((s) => s.animId === animId)?.emits ?? [];
}

/** 开发期：emit 了 spec 未声明的 event 时 warn（不 throw，避免阻塞线上）。 */
export function warnIfUndeclaredAnimEvent(
    specs: readonly AnimEventSpec[],
    animId: AnimId,
    eventId: AnimEventId,
): void {
    const declared = eventsForAnim(specs, animId);
    if (declared.includes(eventId)) {
        return;
    }
    console.warn(
        `[anim:event] animId=${animId} emitted undeclared event=${eventId}. ` +
            `Update AnimEventSpec or fix emit site.`,
    );
}
