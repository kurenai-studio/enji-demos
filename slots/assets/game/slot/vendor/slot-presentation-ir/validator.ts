/**
 * PresentationState schema 校验器。
 *
 * 覆盖 doc/03-detailed-design.md §5 中定义的全部不变式 INV-1 ~ INV-13、INV-M1 ~ INV-M3。
 * 详细语义见该文件；本模块只负责实现。
 *
 * 设计原则：
 * - 纯函数；不修改输入。
 * - 失败模式收敛到 `ValidationResult.ok === false` 并附带 `code` 与可读 `message`；
 *   只报告第一条违反——若需全量检查，调用方可按字段缩小范围循环。
 * - 静态检查与运行时检查二合一：先做结构 / 类型形态检查（防止运行时崩），
 *   再做语义不变式检查。
 */

import type {
  PresentationState,
  BoardState,
  Cell,
  SymbolEntity,
  Overlay,
  WinGroup,
  AnchorSet,
  ReelTopology,
  SessionContext,
  SessionTransition,
} from './types';
import { parseCellKey, SESSION_TRANSITIONS } from './types';

// ============================================================================
// 结果类型
// ============================================================================

export type InvariantCode =
  | 'INV-1'
  | 'INV-2'
  | 'INV-3'
  | 'INV-4'
  | 'INV-5'
  | 'INV-6'
  | 'INV-7'
  | 'INV-8'
  | 'INV-9'
  | 'INV-10'
  | 'INV-11'
  | 'INV-12'
  | 'INV-13'
  | 'INV-M1'
  | 'INV-M2'
  | 'INV-M3';

/** schema 结构形态错误（不变式无法运行前的前置校验失败）。 */
export type StructuralCode = 'STRUCT';

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: InvariantCode | StructuralCode;
      message: string;
      /** 字段路径，例：`board.resolved[1][2].symbolId` */
      path?: string;
    };

function fail(
  code: InvariantCode | StructuralCode,
  message: string,
  path?: string,
): ValidationResult {
  return path === undefined ? { ok: false, code, message } : { ok: false, code, message, path };
}

const OK: ValidationResult = { ok: true };

// ============================================================================
// 入口
// ============================================================================

/** 已知的 schema 顶层字段集合（用于 INV-7 守护） */
const KNOWN_TOP_FIELDS = new Set([
  'version',
  'sessionId',
  'board',
  'phase',
  'sessionContext',
  'totalWinDisplay',
  'extensions',
]);

const KNOWN_SESSION_CONTEXT_FIELDS = new Set([
  'mode',
  'transition',
  'freeSpinsRemaining',
  'freeSpinsTotal',
  'freeSpinWinAccumulated',
]);

const SESSION_TRANSITION_VALUES = new Set<string>(SESSION_TRANSITIONS);
const FG_MODES = new Set(['fg', 'sfg']);

/** 已知的 BoardState 字段集合（用于 INV-7 守护） */
const KNOWN_BOARD_FIELDS = new Set([
  'topology',
  'display',
  'resolved',
  'entities',
  'anchors',
  'overlays',
  'wins',
  'multiplier',
]);

const PHASE_VALUES = new Set(['idle', 'anticipation', 'consequence']);

/**
 * 主入口：校验一份 `PresentationState` 是否满足所有 INV。
 * 失败时只返回第一条违反。
 */
export function validateSchema(state: unknown): ValidationResult {
  // 前置结构形态检查
  if (!isObject(state)) {
    return fail('STRUCT', 'state is not an object');
  }
  if (typeof state['version'] !== 'string') {
    return fail('STRUCT', 'version must be string', 'version');
  }
  if (typeof state['sessionId'] !== 'string') {
    return fail('STRUCT', 'sessionId must be string', 'sessionId');
  }
  if (!isObject(state['board'])) {
    return fail('STRUCT', 'board must be object', 'board');
  }
  if (!isObject(state['extensions'])) {
    return fail('STRUCT', 'extensions must be object', 'extensions');
  }
  if (!isObject(state['sessionContext'])) {
    return fail('STRUCT', 'sessionContext must be object', 'sessionContext');
  }

  const s = state as unknown as PresentationState;

  const sessionResult = validateSessionContext(s.sessionContext);
  if (!sessionResult.ok) return sessionResult;

  const fgExtResult = validateFgExtension(s.extensions);
  if (!fgExtResult.ok) return fgExtResult;

  // INV-6：phase 取值
  if (!PHASE_VALUES.has(s.phase)) {
    return fail('INV-6', `invalid phase value: ${JSON.stringify(s.phase)}`, 'phase');
  }

  // INV-7：顶层无未知字段（"中间数据"逃生口的守护）
  for (const k of Object.keys(s)) {
    if (!KNOWN_TOP_FIELDS.has(k)) {
      return fail('INV-7', `unexpected top-level field: ${k}`, k);
    }
  }
  for (const k of Object.keys(s.board)) {
    if (!KNOWN_BOARD_FIELDS.has(k)) {
      return fail('INV-7', `unexpected board field: ${k}`, `board.${k}`);
    }
  }

  // INV-11：totalWinDisplay >= 0
  if (typeof s.totalWinDisplay !== 'number' || !Number.isFinite(s.totalWinDisplay)) {
    return fail('STRUCT', 'totalWinDisplay must be a finite number', 'totalWinDisplay');
  }
  if (s.totalWinDisplay < 0) {
    return fail(
      'INV-11',
      `totalWinDisplay must be >= 0, got ${s.totalWinDisplay}`,
      'totalWinDisplay',
    );
  }

  // Board 内部检查
  const boardResult = validateBoard(s.board, s.phase);
  if (!boardResult.ok) return boardResult;

  // INV-5 的运行时反映（serialize/deserialize 同构）在 serde 测试中守护；
  // 这里不做实际 round-trip——避免每次 validate 都做一次完整序列化。

  return OK;
}

// ============================================================================
// BoardState 内部检查
// ============================================================================

function validateBoard(board: BoardState, phase: PresentationState['phase']): ValidationResult {
  // 结构形态
  if (!isObject(board.topology)) {
    return fail('STRUCT', 'topology must be object', 'board.topology');
  }
  if (!Array.isArray(board.display)) {
    return fail('STRUCT', 'board.display must be array', 'board.display');
  }
  if (!Array.isArray(board.resolved)) {
    return fail('STRUCT', 'board.resolved must be array', 'board.resolved');
  }
  if (!isObject(board.entities)) {
    return fail('STRUCT', 'board.entities must be object', 'board.entities');
  }
  if (!isObject(board.anchors)) {
    return fail('STRUCT', 'board.anchors must be object', 'board.anchors');
  }
  if (!Array.isArray(board.overlays)) {
    return fail('STRUCT', 'board.overlays must be array', 'board.overlays');
  }
  if (!Array.isArray(board.wins)) {
    return fail('STRUCT', 'board.wins must be array', 'board.wins');
  }

  const topoResult = validateTopology(board.topology);
  if (!topoResult.ok) return topoResult;

  // INV-1：display / resolved 维度
  const dimsResult = checkGridDims('board.display', board.display, board.topology);
  if (!dimsResult.ok) return dimsResult;
  const dimsResult2 = checkGridDims('board.resolved', board.resolved, board.topology);
  if (!dimsResult2.ok) return dimsResult2;

  // INV-10：board.multiplier 若存在必须 > 0
  if (board.multiplier !== undefined) {
    if (typeof board.multiplier !== 'number' || !Number.isFinite(board.multiplier)) {
      return fail('STRUCT', 'board.multiplier must be a finite number', 'board.multiplier');
    }
    if (board.multiplier <= 0) {
      return fail(
        'INV-10',
        `board.multiplier must be > 0, got ${board.multiplier}`,
        'board.multiplier',
      );
    }
  }

  // INV-12：空格不能携带 entityRef
  for (let col = 0; col < board.resolved.length; col++) {
    const column = board.resolved[col]!;
    for (let row = 0; row < column.length; row++) {
      const cell = column[row]!;
      const inv12 = checkEmptyCellNoEntityRef(cell, `board.resolved[${col}][${row}]`);
      if (!inv12.ok) return inv12;
    }
  }
  for (let col = 0; col < board.display.length; col++) {
    const column = board.display[col]!;
    for (let row = 0; row < column.length; row++) {
      const cell = column[row]!;
      const inv12 = checkEmptyCellNoEntityRef(cell, `board.display[${col}][${row}]`);
      if (!inv12.ok) return inv12;
    }
  }

  // INV-2 + entities 校验依赖 anchors
  const anchorsResult = validateAnchors(board.anchors, board.topology);
  if (!anchorsResult.ok) return anchorsResult;

  // INV-3 / INV-13：entities ↔ resolved 引用闭合
  const entitiesResult = validateEntities(board.entities, board.resolved, board.topology);
  if (!entitiesResult.ok) return entitiesResult;

  // INV-4：overlays 坐标合法、INV-10：overlay.multiplier > 0
  for (let i = 0; i < board.overlays.length; i++) {
    const r = validateOverlay(board.overlays[i]!, i, board.topology);
    if (!r.ok) return r;
  }

  // INV-8 / INV-9 / INV-10：wins
  if (phase === 'anticipation' && board.wins.length > 0) {
    return fail(
      'INV-9',
      `board.wins must be empty during anticipation, got ${board.wins.length} group(s)`,
      'board.wins',
    );
  }
  for (let i = 0; i < board.wins.length; i++) {
    const r = validateWinGroup(board.wins[i]!, i, board.topology);
    if (!r.ok) return r;
  }

  return OK;
}

// ============================================================================
// 子结构检查
// ============================================================================

function validateTopology(t: ReelTopology): ValidationResult {
  if (!Number.isInteger(t.cols) || t.cols < 1) {
    return fail(
      'STRUCT',
      `topology.cols must be positive integer, got ${t.cols}`,
      'board.topology.cols',
    );
  }
  for (const name of ['visibleRows', 'extraTop', 'extraBottom'] as const) {
    const arr = t[name];
    if (!Array.isArray(arr) || arr.length !== t.cols) {
      return fail(
        'STRUCT',
        `topology.${name} must be an array of length cols=${t.cols}`,
        `board.topology.${name}`,
      );
    }
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]!;
      if (!Number.isInteger(v) || v < 0) {
        return fail(
          'STRUCT',
          `topology.${name}[${i}] must be a non-negative integer, got ${v}`,
          `board.topology.${name}[${i}]`,
        );
      }
    }
    if (name === 'visibleRows') {
      for (let i = 0; i < arr.length; i++) {
        if (arr[i]! < 1) {
          return fail(
            'STRUCT',
            `topology.visibleRows[${i}] must be >= 1`,
            `board.topology.visibleRows[${i}]`,
          );
        }
      }
    }
  }
  return OK;
}

function checkGridDims(gridPath: string, grid: Cell[][], topo: ReelTopology): ValidationResult {
  if (grid.length !== topo.cols) {
    return fail(
      'INV-1',
      `${gridPath}.length=${grid.length} != topology.cols=${topo.cols}`,
      gridPath,
    );
  }
  for (let col = 0; col < topo.cols; col++) {
    const expected = topo.visibleRows[col]! + topo.extraTop[col]! + topo.extraBottom[col]!;
    const actual = grid[col]!.length;
    if (actual !== expected) {
      return fail(
        'INV-1',
        `${gridPath}[${col}].length=${actual} != visibleRows[${col}]+extraTop[${col}]+extraBottom[${col}]=${expected}`,
        `${gridPath}[${col}]`,
      );
    }
  }
  return OK;
}

function checkEmptyCellNoEntityRef(cell: Cell, path: string): ValidationResult {
  if (cell.symbolId === null && cell.entityRef !== null) {
    return fail(
      'INV-12',
      `empty cell (symbolId=null) must have entityRef=null, got entityRef=${JSON.stringify(cell.entityRef)}`,
      path,
    );
  }
  return OK;
}

function validateAnchors(a: AnchorSet, topo: ReelTopology): ValidationResult {
  if (!(a.locks instanceof Set)) {
    return fail('STRUCT', 'anchors.locks must be a Set', 'board.anchors.locks');
  }
  if (!(a.sticks instanceof Set)) {
    return fail('STRUCT', 'anchors.sticks must be a Set', 'board.anchors.sticks');
  }
  for (const name of ['locks', 'sticks'] as const) {
    for (const k of a[name]) {
      const parsed = parseCellKey(k);
      if (parsed === null) {
        return fail(
          'INV-2',
          `anchors.${name} key not in 'col,row' integer form: ${JSON.stringify(k)}`,
          `board.anchors.${name}`,
        );
      }
      if (!isCellInTopo(parsed.col, parsed.row, topo)) {
        return fail(
          'INV-2',
          `anchors.${name} key out of topology bounds: ${k}`,
          `board.anchors.${name}`,
        );
      }
    }
  }
  return OK;
}

function validateEntities(
  entities: Record<string, SymbolEntity>,
  resolved: Cell[][],
  topo: ReelTopology,
): ValidationResult {
  // INV-3 正向：每个 entity 的 footprint 所覆盖到的格 Cell.entityRef 必须等于该 entity 的 id
  for (const [id, entity] of Object.entries(entities)) {
    if (entity.id !== id) {
      return fail(
        'STRUCT',
        `entities map key ${JSON.stringify(id)} != entity.id ${JSON.stringify(entity.id)}`,
        `board.entities.${id}`,
      );
    }
    if (entity.multiplier !== undefined) {
      if (typeof entity.multiplier !== 'number' || !Number.isFinite(entity.multiplier)) {
        return fail(
          'STRUCT',
          `entity ${id} multiplier must be a finite number`,
          `board.entities.${id}.multiplier`,
        );
      }
      if (entity.multiplier <= 0) {
        return fail(
          'INV-10',
          `entity ${id} multiplier must be > 0, got ${entity.multiplier}`,
          `board.entities.${id}.multiplier`,
        );
      }
    }
    for (const [dcol, drow] of entity.footprint) {
      const col = entity.anchor.col + dcol;
      const row = entity.anchor.row + drow;
      if (!isCellInTopo(col, row, topo)) {
        return fail(
          'INV-3',
          `entity ${id} footprint cell (${col},${row}) out of topology bounds`,
          `board.entities.${id}.footprint`,
        );
      }
      const cell = resolved[col]?.[row];
      if (cell === undefined) {
        return fail(
          'INV-3',
          `entity ${id} footprint references missing cell (${col},${row})`,
          `board.entities.${id}.footprint`,
        );
      }
      if (cell.entityRef !== id) {
        return fail(
          'INV-3',
          `entity ${id} footprint cell (${col},${row}).entityRef=${JSON.stringify(cell.entityRef)} != ${JSON.stringify(id)}`,
          `board.resolved[${col}][${row}].entityRef`,
        );
      }
    }
  }
  // INV-3 反向 + INV-13：任意 Cell.entityRef !== null 必须能在 entities 中查到，且该 entity 的 footprint 必须涵盖该 cell
  for (let col = 0; col < resolved.length; col++) {
    const column = resolved[col]!;
    for (let row = 0; row < column.length; row++) {
      const cell = column[row]!;
      if (cell.entityRef === null) continue;
      const entity = entities[cell.entityRef];
      if (entity === undefined) {
        return fail(
          'INV-3',
          `cell (${col},${row}).entityRef=${JSON.stringify(cell.entityRef)} not found in entities`,
          `board.resolved[${col}][${row}].entityRef`,
        );
      }
      const dcol = col - entity.anchor.col;
      const drow = row - entity.anchor.row;
      const inFootprint = entity.footprint.some(([fc, fr]) => fc === dcol && fr === drow);
      if (!inFootprint) {
        return fail(
          'INV-13',
          `cell (${col},${row}) references entity ${cell.entityRef} but is not in its footprint`,
          `board.resolved[${col}][${row}]`,
        );
      }
    }
  }
  return OK;
}

function validateOverlay(o: Overlay, idx: number, topo: ReelTopology): ValidationResult {
  for (let i = 0; i < o.cells.length; i++) {
    const c = o.cells[i]!;
    if (!isCellInTopo(c.col, c.row, topo)) {
      return fail(
        'INV-4',
        `overlay[${idx}].cells[${i}]=(${c.col},${c.row}) out of topology bounds`,
        `board.overlays[${idx}].cells[${i}]`,
      );
    }
  }
  if (o.multiplier !== undefined) {
    if (typeof o.multiplier !== 'number' || !Number.isFinite(o.multiplier)) {
      return fail(
        'STRUCT',
        `overlay[${idx}].multiplier must be a finite number`,
        `board.overlays[${idx}].multiplier`,
      );
    }
    if (o.multiplier <= 0) {
      return fail(
        'INV-10',
        `overlay[${idx}].multiplier must be > 0, got ${o.multiplier}`,
        `board.overlays[${idx}].multiplier`,
      );
    }
  }
  return OK;
}

function validateWinGroup(w: WinGroup, idx: number, topo: ReelTopology): ValidationResult {
  for (let i = 0; i < w.cells.length; i++) {
    const c = w.cells[i]!;
    if (!isCellInTopo(c.col, c.row, topo)) {
      return fail(
        'INV-8',
        `wins[${idx}].cells[${i}]=(${c.col},${c.row}) out of topology bounds`,
        `board.wins[${idx}].cells[${i}]`,
      );
    }
  }
  if (w.multiplier !== undefined) {
    if (typeof w.multiplier !== 'number' || !Number.isFinite(w.multiplier)) {
      return fail(
        'STRUCT',
        `wins[${idx}].multiplier must be a finite number`,
        `board.wins[${idx}].multiplier`,
      );
    }
    if (w.multiplier <= 0) {
      return fail(
        'INV-10',
        `wins[${idx}].multiplier must be > 0, got ${w.multiplier}`,
        `board.wins[${idx}].multiplier`,
      );
    }
  }
  if (w.amount !== undefined) {
    if (typeof w.amount !== 'number' || !Number.isFinite(w.amount)) {
      return fail(
        'STRUCT',
        `wins[${idx}].amount must be a finite number`,
        `board.wins[${idx}].amount`,
      );
    }
    if (w.amount < 0) {
      return fail(
        'INV-11',
        `wins[${idx}].amount must be >= 0, got ${w.amount}`,
        `board.wins[${idx}].amount`,
      );
    }
  }
  return OK;
}

// ============================================================================
// SessionContext（INV-M1 ~ INV-M3）
// ============================================================================

function validateSessionContext(ctx: SessionContext): ValidationResult {
  if (typeof ctx.mode !== 'string' || ctx.mode.length === 0) {
    return fail('STRUCT', 'sessionContext.mode must be a non-empty string', 'sessionContext.mode');
  }

  for (const k of Object.keys(ctx)) {
    if (!KNOWN_SESSION_CONTEXT_FIELDS.has(k)) {
      return fail('INV-7', `unexpected sessionContext field: ${k}`, `sessionContext.${k}`);
    }
  }

  if (ctx.transition !== undefined && !SESSION_TRANSITION_VALUES.has(ctx.transition)) {
    return fail(
      'STRUCT',
      `invalid sessionContext.transition: ${JSON.stringify(ctx.transition)}`,
      'sessionContext.transition',
    );
  }

  const remaining = ctx.freeSpinsRemaining;
  const total = ctx.freeSpinsTotal;
  const accumulated = ctx.freeSpinWinAccumulated;

  if (remaining !== undefined) {
    if (!isNonNegativeInt(remaining)) {
      return fail(
        'INV-M3',
        `freeSpinsRemaining must be a non-negative integer, got ${String(remaining)}`,
        'sessionContext.freeSpinsRemaining',
      );
    }
  }
  if (total !== undefined) {
    if (!isNonNegativeInt(total)) {
      return fail(
        'INV-M3',
        `freeSpinsTotal must be a non-negative integer, got ${String(total)}`,
        'sessionContext.freeSpinsTotal',
      );
    }
  }
  if (accumulated !== undefined) {
    if (typeof accumulated !== 'number' || !Number.isFinite(accumulated) || accumulated < 0) {
      return fail(
        'INV-M3',
        `freeSpinWinAccumulated must be >= 0, got ${accumulated}`,
        'sessionContext.freeSpinWinAccumulated',
      );
    }
  }

  // INV-M1：NG 模式下 remaining 不得 > 0
  if (ctx.mode === 'ng') {
    if (remaining !== undefined && remaining > 0) {
      return fail(
        'INV-M1',
        `freeSpinsRemaining must be 0 when mode is ng, got ${remaining}`,
        'sessionContext.freeSpinsRemaining',
      );
    }
  }

  // INV-M2：transition 与 mode 一致
  const transition: SessionTransition = ctx.transition ?? 'none';
  if (transition === 'enter-fg' && !FG_MODES.has(ctx.mode)) {
    return fail(
      'INV-M2',
      `transition enter-fg requires mode fg or sfg, got ${ctx.mode}`,
      'sessionContext.transition',
    );
  }
  if (transition === 'leave-fg' && ctx.mode !== 'ng') {
    return fail(
      'INV-M2',
      `transition leave-fg requires mode ng, got ${ctx.mode}`,
      'sessionContext.transition',
    );
  }

  // INV-M3：FG 模式下 remaining <= total（若两者均存在）
  if (
    FG_MODES.has(ctx.mode) &&
    remaining !== undefined &&
    total !== undefined &&
    remaining > total
  ) {
    return fail(
      'INV-M3',
      `freeSpinsRemaining (${remaining}) must be <= freeSpinsTotal (${total})`,
      'sessionContext.freeSpinsRemaining',
    );
  }

  return OK;
}

/** 可选：`extensions.fg` 标准 award 形态 */
function validateFgExtension(extensions: Record<string, unknown>): ValidationResult {
  const fg = extensions['fg'];
  if (fg === undefined) return OK;
  if (!isObject(fg)) {
    return fail('STRUCT', 'extensions.fg must be an object when present', 'extensions.fg');
  }
  if ('awarded' in fg) {
    const awarded = fg['awarded'];
    if (!isNonNegativeInt(awarded)) {
      return fail(
        'STRUCT',
        `extensions.fg.awarded must be a non-negative integer, got ${String(awarded)}`,
        'extensions.fg.awarded',
      );
    }
  }
  if ('superType' in fg) {
    const superType = fg['superType'];
    if (!isNonNegativeInt(superType)) {
      return fail(
        'STRUCT',
        `extensions.fg.superType must be a non-negative integer, got ${String(superType)}`,
        'extensions.fg.superType',
      );
    }
  }
  return OK;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// ============================================================================
// 工具
// ============================================================================

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCellInTopo(col: number, row: number, topo: ReelTopology): boolean {
  if (!Number.isInteger(col) || !Number.isInteger(row)) return false;
  if (col < 0 || col >= topo.cols) return false;
  const total = topo.visibleRows[col]! + topo.extraTop[col]! + topo.extraBottom[col]!;
  if (row < 0 || row >= total) return false;
  return true;
}
