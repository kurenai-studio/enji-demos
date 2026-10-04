/**
 * IR 依赖注入 composition root。
 *
 * 业务层 / Presenter 只依赖 `IrContext` 中的 port 接口；
 * wire Encoder / Decoder 由游戏工程在 `createIrContext` 时注入。
 */

import type {
  ICommandEncoder,
  ICommandPort,
  ICommandSerde,
  ICommandValidator,
} from './ports/command';
import type {
  IPresentationDecoder,
  IPresentationSerde,
  IPresentationValidator,
} from './ports/presentation';
import {
  defaultCommandSerde,
  defaultCommandValidator,
  defaultPresentationSerde,
  defaultPresentationValidator,
} from './adapters/index';

/** 完整 IR 运行时依赖（发送 + 接收两侧） */
export interface IrContext<TWire = unknown> {
  command: {
    validator: ICommandValidator;
    serde: ICommandSerde;
    /** 未注入时 `sendCommand` 不可用 */
    encoder?: ICommandEncoder<TWire>;
  };
  presentation: {
    validator: IPresentationValidator;
    serde: IPresentationSerde;
    /** 未注入时 `receivePresentation` 不可用 */
    decoder?: IPresentationDecoder<TWire>;
  };
}

export interface CreateIrContextOptions<TWire = unknown> {
  commandValidator?: ICommandValidator;
  commandSerde?: ICommandSerde;
  commandEncoder?: ICommandEncoder<TWire>;
  presentationValidator?: IPresentationValidator;
  presentationSerde?: IPresentationSerde;
  presentationDecoder?: IPresentationDecoder<TWire>;
}

/**
 * 创建默认 IR 上下文：validator / serde 使用本仓库实现；
 * Encoder / Decoder 可选注入（游戏 composition root 提供）。
 */
export function createIrContext<TWire = unknown>(
  options: CreateIrContextOptions<TWire> = {},
): IrContext<TWire> {
  return {
    command: {
      validator: options.commandValidator ?? defaultCommandValidator,
      serde: options.commandSerde ?? defaultCommandSerde,
      encoder: options.commandEncoder,
    },
    presentation: {
      validator: options.presentationValidator ?? defaultPresentationValidator,
      serde: options.presentationSerde ?? defaultPresentationSerde,
      decoder: options.presentationDecoder,
    },
  };
}

/** 从 context 组装上行 port（校验 → 编码） */
export function createCommandPort<TWire>(
  ctx: IrContext<TWire> & {
    command: { encoder: ICommandEncoder<TWire> };
  },
): ICommandPort<TWire> {
  const validator: ICommandValidator = ctx.command.validator;
  const encoder = ctx.command.encoder;
  return {
    validator,
    encoder,
    send(envelope) {
      validator.assertValid(envelope);
      return encoder.encode(envelope);
    },
  };
}
