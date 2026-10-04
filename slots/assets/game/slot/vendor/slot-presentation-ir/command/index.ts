/**
 * slot-presentation-ir/command 公开入口。
 *
 * 发送侧 Command schema：类型、序列化、校验。
 */

export type {
  CommandEnvelope,
  GameCommand,
  GameCommandKind,
  InitCommand,
  SpinCommand,
  SpinMode,
  BuyFeatureCommand,
  ContinueCommand,
  ChooseCommand,
  CommandSessionHint,
} from './types';

export { COMMAND_SCHEMA_VERSION, GAME_COMMAND_KINDS, SPIN_MODES } from './types';

export {
  serializeCommand,
  deserializeCommand,
  roundTripCommand,
  CommandSerdeError,
} from './serde';

export type {
  CommandInvariantCode,
  CommandStructuralCode,
  CommandValidationResult,
} from './validator';

export { validateCommand, assertValidCommand } from './validator';

export type {
  ICommandValidator,
  ICommandSerde,
  ICommandEncoder,
  ICommandPort,
} from '../ports/command';

export { defaultCommandValidator, defaultCommandSerde } from '../adapters/defaultCommandPorts';
