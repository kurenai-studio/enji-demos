import type { AnimEventScope } from "./AnimEventScope.ts";

/**
 * 构建 IAnim 时的通用上下文（无 Node）。
 * 业务域可 extends 追加字段（如 spinMode、列 mask）。
 *
 * Timeline event（play 内 marker，非 seq/par 起止）：
 * - 编排层：`bindAnimEventHandlers()` → `ctx.events`
 * - motion 层：`resolveAnimEvents(ctx).emit(eventId, payload)`
 * - 索引：`AnimEventSpec` 表 + grep `animEventId("…")`
 */
export interface IAnimBuildContext {
    readonly fast?: boolean;
    /** 本会话 timeline handler；见 common/anim/AnimEventScope.ts */
    readonly events?: AnimEventScope;
}
