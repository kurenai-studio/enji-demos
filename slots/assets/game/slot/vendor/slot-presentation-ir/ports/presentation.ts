/**
 * PresentationState 侧 port 接口。
 *
 * 游戏工程在 composition root 注入 `IPresentationDecoder` 实现（wire → IR）；
 * validator / serde 默认由本仓库提供，也可替换。
 */

import type { ValidationResult } from '../validator';
import type { PresentationState } from '../types';

/** PresentationState schema 校验 */
export interface IPresentationValidator {
  validate(state: unknown): ValidationResult;
}

/** PresentationState JSON 序列化 */
export interface IPresentationSerde {
  serialize(state: PresentationState, indent?: number): string;
  deserialize(json: string): PresentationState;
  roundTrip(state: PresentationState): PresentationState;
}

/**
 * wire format → PresentationState。
 *
 * `TWire` 由游戏工程定义（TCP struct、HTTP body、事件 payload 等）；
 * 本仓库不引用任何 wire 类型。
 */
export interface IPresentationDecoder<TWire = unknown> {
  decode(wire: TWire): PresentationState;
}
