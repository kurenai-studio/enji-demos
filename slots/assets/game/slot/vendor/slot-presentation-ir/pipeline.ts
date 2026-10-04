/**
 * 基于注入 port 的 IR 管线辅助函数。
 *
 * 不含 wire 实现；Encoder / Decoder 由调用方通过 `IrContext` 注入。
 */

import type { CommandEnvelope } from './command/types';
import type { PresentationState } from './types';
import type { IrContext } from './context';

export class MissingEncoderError extends Error {
  override readonly name = 'MissingEncoderError';
  constructor() {
    super('IrContext.command.encoder is not configured');
  }
}

export class MissingDecoderError extends Error {
  override readonly name = 'MissingDecoderError';
  constructor() {
    super('IrContext.presentation.decoder is not configured');
  }
}

export class CommandValidationError extends Error {
  override readonly name = 'CommandValidationError';
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class PresentationValidationError extends Error {
  override readonly name = 'PresentationValidationError';
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 校验 CommandEnvelope 并编码为 wire format */
export function sendCommand<TWire>(ctx: IrContext<TWire>, envelope: CommandEnvelope): TWire {
  const result = ctx.command.validator.validate(envelope);
  if (!result.ok) {
    throw new CommandValidationError(result.code, result.message);
  }
  const encoder = ctx.command.encoder;
  if (!encoder) {
    throw new MissingEncoderError();
  }
  return encoder.encode(envelope);
}

/** 从 wire format 解码并校验 PresentationState */
export function receivePresentation<TWire>(ctx: IrContext<TWire>, wire: TWire): PresentationState {
  const decoder = ctx.presentation.decoder;
  if (!decoder) {
    throw new MissingDecoderError();
  }
  const state = decoder.decode(wire);
  const result = ctx.presentation.validator.validate(state);
  if (!result.ok) {
    throw new PresentationValidationError(result.code, result.message);
  }
  return state;
}
