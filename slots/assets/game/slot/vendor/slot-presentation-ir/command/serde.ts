/**
 * CommandEnvelope 的 JSON 序列化 / 反序列化。
 *
 * Command schema 不含 Set / Map 等特殊类型，可直接 JSON 序列化。
 */

import type { CommandEnvelope } from './types';

export class CommandSerdeError extends Error {
  override readonly name = 'CommandSerdeError';
}

/**
 * 把 CommandEnvelope 序列化为 JSON 字符串。
 */
export function serializeCommand(envelope: CommandEnvelope, indent?: number): string {
  return JSON.stringify(envelope, null, indent);
}

/**
 * 把 JSON 字符串反序列化为 CommandEnvelope。
 *
 * 本函数**不**校验 schema 合法性——只做 JSON 解析。
 * 如需校验，请把结果交给 `validateCommand`。
 */
export function deserializeCommand(json: string): CommandEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CommandSerdeError('invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CommandSerdeError('CommandEnvelope must be a JSON object');
  }
  return parsed as CommandEnvelope;
}

/** serialize → deserialize round-trip */
export function roundTripCommand(envelope: CommandEnvelope): CommandEnvelope {
  return deserializeCommand(serializeCommand(envelope));
}
