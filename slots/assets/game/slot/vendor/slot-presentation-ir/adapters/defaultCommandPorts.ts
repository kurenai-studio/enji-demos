import { serializeCommand, deserializeCommand, roundTripCommand } from '../command/serde';
import { validateCommand, assertValidCommand } from '../command/validator';
import type { ICommandSerde, ICommandValidator } from '../ports/command';

/** 默认 CommandEnvelope 校验器（wrap `validateCommand`） */
export const defaultCommandValidator: ICommandValidator = {
  validate: validateCommand,
  assertValid: assertValidCommand,
};

/** 默认 CommandEnvelope JSON serde */
export const defaultCommandSerde: ICommandSerde = {
  serialize: serializeCommand,
  deserialize: deserializeCommand,
  roundTrip: roundTripCommand,
};
