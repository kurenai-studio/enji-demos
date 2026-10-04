/**
 * Slot Command Schema — 客户端 → 服务端动作意图定义。
 *
 * 详见 doc/05-command-design.md。
 */

// ============================================================================
// 顶层：CommandEnvelope
// ============================================================================

/**
 * 一次客户端动作的完整 envelope。
 * 业务层（UI / FSM / Presenter）产出此结构，Encoder 将其映射为后端 wire format。
 */
export interface CommandEnvelope {
  /** schema 版本号，便于 Encoder 按版本分支处理 */
  version: string;

  /** 客户端侧命令实例标识（日志 / 回放 / 对账） */
  commandId: string;

  /** 具体动作 */
  command: GameCommand;

  /**
   * 游戏私有参数命名空间。
   * 各游戏特有请求参数按玩法族在此安放。
   */
  extensions: Record<string, unknown>;
}

// ============================================================================
// GameCommand 联合
// ============================================================================

export type GameCommand =
  | InitCommand
  | SpinCommand
  | BuyFeatureCommand
  | ContinueCommand
  | ChooseCommand;

export type GameCommandKind = GameCommand['kind'];

/** 进入游戏 / 拉取初始态 */
export interface InitCommand {
  kind: 'init';
  gameId: string;
}

export type SpinMode = 'normal' | 'turbo' | 'auto';

/** 普通 spin */
export interface SpinCommand {
  kind: 'spin';
  /** 本次 spin 下注额（统一隐含单位） */
  bet: number;
  /**
   * 播放 / 控制提示。
   * Encoder 可映射到后端 turbo / auto 标志；不是演出层状态。
   */
  spinMode?: SpinMode;
}

/** 买特色 */
export interface BuyFeatureCommand {
  kind: 'buy-feature';
  featureId: string;
  bet: number;
}

/** hold-spin 续转 / 断线续玩 */
export interface ContinueCommand {
  kind: 'continue';
  /** 关联 spin 会话；通常与 PresentationState.sessionId 对应 */
  sessionId: string;
}

/** 玩家选择（FG 选项、gamble 等） */
export interface ChooseCommand {
  kind: 'choose';
  sessionId: string;
  choiceId: string;
}

/**
 * CommandEnvelope.extensions.session 标准提示（可选）。
 * 权威流程态仍在 PresentationState.sessionContext；此处仅作 Encoder 只读提示。
 */
export interface CommandSessionHint {
  /** 预期流程模式（如 FG 续玩 spin） */
  flowMode?: string;
}

/**
 * Command schema 当前版本号。
 * 业务层写入 CommandEnvelope.version 时使用此值。
 */
export const COMMAND_SCHEMA_VERSION = '0.1.0';

export const GAME_COMMAND_KINDS = [
  'init',
  'spin',
  'buy-feature',
  'continue',
  'choose',
] as const satisfies readonly GameCommandKind[];

export const SPIN_MODES = ['normal', 'turbo', 'auto'] as const satisfies readonly SpinMode[];
