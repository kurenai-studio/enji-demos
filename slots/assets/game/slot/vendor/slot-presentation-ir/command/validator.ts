/**
 * CommandEnvelope schema 校验器。
 *
 * 覆盖 doc/05-command-design.md §7 中定义的全部不变式 CMD-1 ~ CMD-12。
 */

import type { CommandEnvelope, GameCommand } from './types';
import { GAME_COMMAND_KINDS, SPIN_MODES } from './types';

export type CommandInvariantCode =
  | 'CMD-1'
  | 'CMD-2'
  | 'CMD-3'
  | 'CMD-4'
  | 'CMD-5'
  | 'CMD-6'
  | 'CMD-7'
  | 'CMD-8'
  | 'CMD-9'
  | 'CMD-10'
  | 'CMD-11'
  | 'CMD-12';

export type CommandStructuralCode = 'STRUCT';

export type CommandValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: CommandInvariantCode | CommandStructuralCode;
      message: string;
      path?: string;
    };

function fail(
  code: CommandInvariantCode | CommandStructuralCode,
  message: string,
  path?: string,
): CommandValidationResult {
  return path === undefined ? { ok: false, code, message } : { ok: false, code, message, path };
}

const OK: CommandValidationResult = { ok: true };

const KNOWN_ENVELOPE_FIELDS = new Set(['version', 'commandId', 'command', 'extensions']);

const KNOWN_COMMAND_FIELDS: Record<GameCommand['kind'], Set<string>> = {
  init: new Set(['kind', 'gameId']),
  spin: new Set(['kind', 'bet', 'spinMode']),
  'buy-feature': new Set(['kind', 'featureId', 'bet']),
  continue: new Set(['kind', 'sessionId']),
  choose: new Set(['kind', 'sessionId', 'choiceId']),
};

const COMMAND_KIND_SET = new Set<string>(GAME_COMMAND_KINDS);
const SPIN_MODE_SET = new Set<string>(SPIN_MODES);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function hasOnlyKnownFields(obj: Record<string, unknown>, allowed: Set<string>, path: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return fail('CMD-11', `unknown field "${key}"`, `${path}.${key}`);
    }
  }
  return OK;
}

function validatePositiveBet(bet: unknown, path: string): CommandValidationResult {
  if (typeof bet !== 'number' || !Number.isFinite(bet) || bet <= 0) {
    return fail('CMD-5', 'bet must be a finite number > 0', path);
  }
  return OK;
}

function validateCommandBody(command: unknown): CommandValidationResult {
  if (!isObject(command)) {
    return fail('STRUCT', 'command must be object', 'command');
  }

  const kind = command['kind'];
  if (typeof kind !== 'string' || !COMMAND_KIND_SET.has(kind)) {
    return fail(
      'CMD-3',
      `command.kind must be one of: ${GAME_COMMAND_KINDS.join(', ')}`,
      'command.kind',
    );
  }

  const knownFields = KNOWN_COMMAND_FIELDS[kind as GameCommand['kind']];
  const fieldCheck = hasOnlyKnownFields(command, knownFields, 'command');
  if (!fieldCheck.ok) return fieldCheck;

  switch (kind) {
    case 'init': {
      if (!isNonEmptyString(command['gameId'])) {
        return fail('CMD-4', 'init.gameId must be a non-empty string', 'command.gameId');
      }
      break;
    }
    case 'spin': {
      const betCheck = validatePositiveBet(command['bet'], 'command.bet');
      if (!betCheck.ok) return betCheck;
      const spinMode = command['spinMode'];
      if (spinMode !== undefined) {
        if (typeof spinMode !== 'string' || !SPIN_MODE_SET.has(spinMode)) {
          return fail(
            'CMD-9',
            `spin.spinMode must be one of: ${SPIN_MODES.join(', ')}`,
            'command.spinMode',
          );
        }
      }
      break;
    }
    case 'buy-feature': {
      if (!isNonEmptyString(command['featureId'])) {
        return fail(
          'CMD-6',
          'buy-feature.featureId must be a non-empty string',
          'command.featureId',
        );
      }
      const betCheck = validatePositiveBet(command['bet'], 'command.bet');
      if (!betCheck.ok) {
        return { ...betCheck, code: 'CMD-6' };
      }
      break;
    }
    case 'continue': {
      if (!isNonEmptyString(command['sessionId'])) {
        return fail('CMD-7', 'continue.sessionId must be a non-empty string', 'command.sessionId');
      }
      break;
    }
    case 'choose': {
      if (!isNonEmptyString(command['sessionId'])) {
        return fail('CMD-8', 'choose.sessionId must be a non-empty string', 'command.sessionId');
      }
      if (!isNonEmptyString(command['choiceId'])) {
        return fail('CMD-8', 'choose.choiceId must be a non-empty string', 'command.choiceId');
      }
      break;
    }
  }

  return OK;
}

/**
 * 主入口：校验一份 `CommandEnvelope` 是否满足所有 CMD 不变式。
 * 失败时只返回第一条违反。
 */
export function validateCommand(envelope: unknown): CommandValidationResult {
  if (!isObject(envelope)) {
    return fail('STRUCT', 'envelope must be object');
  }

  const envelopeFieldCheck = hasOnlyKnownFields(envelope, KNOWN_ENVELOPE_FIELDS, '');
  if (!envelopeFieldCheck.ok) {
    return { ...envelopeFieldCheck, code: 'CMD-10' };
  }

  if (!isNonEmptyString(envelope['version'])) {
    return fail('CMD-1', 'version must be a non-empty string', 'version');
  }
  if (!isNonEmptyString(envelope['commandId'])) {
    return fail('CMD-2', 'commandId must be a non-empty string', 'commandId');
  }
  if (!isObject(envelope['extensions'])) {
    return fail('CMD-12', 'extensions must be a plain object', 'extensions');
  }

  return validateCommandBody(envelope['command']);
}

/** 类型收窄辅助：校验通过后 envelope 可视为 CommandEnvelope */
export function assertValidCommand(envelope: unknown): asserts envelope is CommandEnvelope {
  const result = validateCommand(envelope);
  if (!result.ok) {
    throw new Error(`Invalid CommandEnvelope [${result.code}]: ${result.message}`);
  }
}
