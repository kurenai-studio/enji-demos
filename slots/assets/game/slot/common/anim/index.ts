export { ANIM_CONTRACT_VERSION } from "./version.ts";

export type { IAnim, IRepeatableAnim, AnimState } from "./IAnim.ts";
export { CancelledError } from "./IAnim.ts";

export type { AnimId } from "./AnimId.ts";
export type { IAnimBuildContext } from "./IAnimBuildContext.ts";
export type { IAnimBuilder } from "./IAnimBuilder.ts";

export type { AnimEventId } from "./AnimEventId.ts";
export { animEventId } from "./AnimEventId.ts";
export type {
    AnimEventDef,
    AnimEventMapFromDefs,
    AnimEventPayload,
} from "./AnimEventDef.ts";
export { defineAnimEvent } from "./AnimEventDef.ts";
export type { AnimEventHandlerMap, AnimEventHandlerMapFromDefs } from "./AnimEventScope.ts";
export { AnimEventScope, bindAnimEventHandlers, bindAnimEventHandlersFromDefs } from "./AnimEventScope.ts";
export type { AnimEventSpec } from "./AnimEventSpec.ts";
export { animEventSpec, eventsForAnim, warnIfUndeclaredAnimEvent } from "./AnimEventSpec.ts";
export { emitAnimEvent } from "./emitAnimEvent.ts";
export { resolveAnimEvents } from "./resolveAnimEvents.ts";

export type { AnimOptions } from "./Anim.ts";
export { Anim } from "./Anim.ts";

export {
    seq,
    par,
    race,
    loop,
    forever,
    delay,
    call,
    starterAnim,
    playSpine,
    playClip,
    playParticleBurst,
} from "./compose.ts";
export type { PlaySpineOptions, PlayClipOptions, PlayParticleBurstOptions } from "./compose.ts";

export { SerialAnimQueue } from "./SerialAnimQueue.ts";
export type { AnimQueueTask } from "./SerialAnimQueue.ts";
