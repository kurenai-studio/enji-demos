/**
 * slot-presentation-ir 公开入口。
 *
 * 暴露三件事：
 * 1. schema 类型定义（来自 types）
 * 2. JSON 序列化 / 反序列化（来自 serde）
 * 3. schema validator（来自 validator）
 */

export type {
  PresentationState,
  Phase,
  BoardState,
  ReelTopology,
  SymbolGrid,
  Cell,
  EntityId,
  SymbolEntity,
  CellRef,
  AnchorSet,
  Overlay,
  WinGroup,
  GameFlowMode,
  SessionTransition,
  SessionContext,
  FGAwardExtension,
} from './types';

export {
  cellKey,
  parseCellKey,
  SCHEMA_VERSION,
  GAME_FLOW_MODES,
  SESSION_TRANSITIONS,
} from './types';

export { serialize, deserialize, roundTrip, SerdeError } from './serde';

export type { ValidationResult, InvariantCode, StructuralCode } from './validator';
export { validateSchema } from './validator';

export type {
  IPresentationValidator,
  IPresentationSerde,
  IPresentationDecoder,
  ICommandValidator,
  ICommandSerde,
  ICommandEncoder,
  ICommandPort,
} from './ports/index';

export {
  defaultPresentationValidator,
  defaultPresentationSerde,
  defaultCommandValidator,
  defaultCommandSerde,
} from './adapters/index';

export type { IrContext, CreateIrContextOptions } from './context';
export { createIrContext, createCommandPort } from './context';

export {
  sendCommand,
  receivePresentation,
  MissingEncoderError,
  MissingDecoderError,
  CommandValidationError,
  PresentationValidationError,
} from './pipeline';
