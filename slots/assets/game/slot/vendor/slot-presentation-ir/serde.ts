/**
 * PresentationState 的 JSON 序列化 / 反序列化。
 *
 * 由于 schema 中 AnchorSet.locks / sticks 使用 `Set<string>`，
 * 而 JSON 不原生支持 Set，本模块通过 replacer/reviver 把它们
 * 转换为带 tag 的中间形态：
 *   `Set<string>` ⇄ `{ "$set": ["k1", "k2", ...] }`
 *
 * 该 tag 名故意取 `$set` 以避免与可能的业务字段冲突。
 */

import type { PresentationState } from './types';

const SET_TAG = '$set';

interface SerializedSet {
  [SET_TAG]: string[];
}

function isSerializedSet(v: unknown): v is SerializedSet {
  return (
    typeof v === 'object' &&
    v !== null &&
    SET_TAG in v &&
    Array.isArray((v)[SET_TAG])
  );
}

/**
 * `JSON.stringify` 的 replacer：把 Set 转换为 `{ $set: [...] }`。
 */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) {
    const arr: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        throw new SerdeError(`Unsupported Set member type: expected string, got ${typeof item}`);
      }
      arr.push(item);
    }
    arr.sort();
    return { [SET_TAG]: arr };
  }
  return value;
}

/**
 * `JSON.parse` 的 reviver：把 `{ $set: [...] }` 还原为 Set。
 */
function reviver(_key: string, value: unknown): unknown {
  if (isSerializedSet(value)) {
    return new Set(value[SET_TAG]);
  }
  return value;
}

/**
 * 序列化错误（例如 Set 中含非 string 成员）。
 */
export class SerdeError extends Error {
  override readonly name = 'SerdeError';
}

/**
 * 把 PresentationState 序列化为 JSON 字符串。
 *
 * @param state 任意合法的 PresentationState（不强制要求先通过 validator；
 *              如要严格性请先调用 validateSchema）
 * @param indent 可选缩进；默认无缩进（紧凑输出）
 */
export function serialize(state: PresentationState, indent?: number): string {
  return JSON.stringify(state, replacer, indent);
}

/**
 * 把 JSON 字符串反序列化为 PresentationState。
 *
 * 注意：本函数**不**校验 schema 合法性——只做形态转换（包括 Set 还原）。
 * 如需校验，请把结果交给 `validateSchema`。
 */
export function deserialize(json: string): PresentationState {
  return JSON.parse(json, reviver) as PresentationState;
}

/**
 * 便利方法：对一个 state 做 round-trip（serialize → deserialize），
 * 用于测试与调试。如果 round-trip 后结构与原对象不等价，validator 会报错。
 */
export function roundTrip(state: PresentationState): PresentationState {
  return deserialize(serialize(state));
}
