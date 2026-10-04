import type { IAnimBuildContext } from "./IAnimBuildContext.ts";
import { AnimEventScope } from "./AnimEventScope.ts";

/** motion / builder 侧：从 ctx 取 event scope，缺省为 no-op empty。 */
export function resolveAnimEvents(ctx: IAnimBuildContext): AnimEventScope {
    return ctx.events ?? AnimEventScope.empty();
}
