/**
 * CommandEnvelope 侧 port 接口。
 *
 * 游戏工程在 composition root 注入 `ICommandEncoder` 实现（IR → wire）；
 * validator / serde 默认由本仓库提供，也可替换。
 */

import type { CommandEnvelope } from '../command/types';
import type { CommandValidationResult } from '../command/validator';

/** CommandEnvelope schema 校验 */
export interface ICommandValidator {
  validate(envelope: unknown): CommandValidationResult;
  assertValid(envelope: unknown): asserts envelope is CommandEnvelope;
}

/** CommandEnvelope JSON 序列化 */
export interface ICommandSerde {
  serialize(envelope: CommandEnvelope, indent?: number): string;
  deserialize(json: string): CommandEnvelope;
  roundTrip(envelope: CommandEnvelope): CommandEnvelope;
}

/**
 * CommandEnvelope → wire format。
 *
 * `TWire` 由游戏工程定义；本仓库不引用任何 wire 类型。
 */
export interface ICommandEncoder<TWire = unknown> {
  encode(envelope: CommandEnvelope): TWire;
}

/** 上行发送：校验 + 编码（composition root 组装） */
export interface ICommandPort<TWire = unknown> {
  readonly validator: ICommandValidator;
  readonly encoder: ICommandEncoder<TWire>;
  send(envelope: CommandEnvelope): TWire;
}
