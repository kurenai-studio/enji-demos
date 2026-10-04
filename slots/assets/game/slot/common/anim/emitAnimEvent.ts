import type { AnimEventDef } from "./AnimEventDef.ts";
import type { AnimEventScope } from "./AnimEventScope.ts";

/** motion 层：按 def 发射 event，payload 与 def 泛型对齐。 */
export function emitAnimEvent<TPayload>(
    scope: AnimEventScope,
    def: AnimEventDef<TPayload>,
    payload: TPayload,
): void {
    scope.emit(def.id, payload);
}
