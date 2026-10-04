/**
 * Timeline event id — 动画 play() 生命周期内的命名时刻（非 compose 起止）。
 * 业务域用 `animEventId("wheelboard.motion.symbolDrop")` 定义常量，集中注册 handler。
 */
export type AnimEventId = string & { readonly __animEventBrand?: unique symbol };

/** 构造 branded event id（保留字面量类型供 TMap 索引）。 */
export function animEventId<const T extends string>(id: T): AnimEventId & T {
    return id;
}
