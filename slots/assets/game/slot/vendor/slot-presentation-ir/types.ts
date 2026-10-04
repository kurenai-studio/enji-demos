/**
 * Slot Presentation Schema — 演出层数据形态定义。
 *
 * 本模块只导出类型，不包含运行时代码。
 * 详见 doc/03-detailed-design.md。
 */

// ============================================================================
// 会话 / 流程模式（跨 spin，非演出 phase）
// ============================================================================

/** 跨 spin 会话的游戏流程模式（非 `PresentationState.phase` 演出阶段） */
export type GameFlowMode = 'ng' | 'fg' | 'sfg' | (string & {});

/** 流程模式切换语义（边界帧可观测） */
export type SessionTransition = 'none' | 'enter-fg' | 'leave-fg' | 'mode-change';

/**
 * 会话级流程态；每个 snapshot 均携带，便于 DEBUG / 回放 / 断线恢复。
 *
 * 权威来源：游戏侧 Decoder 从进桌 / 局末同步包等 wire 字段写入；
 * schema 不演算 remaining 的单调递减。
 */
export interface SessionContext {
  /** 当前流程模式 */
  mode: GameFlowMode;
  /** 模式切换；默认 `none` 或未写 */
  transition?: SessionTransition;
  /** 免费局剩余次数（NG 时为 0 或省略） */
  freeSpinsRemaining?: number;
  /** 免费局总数（HUD x/y 分母） */
  freeSpinsTotal?: number;
  /** FG 累计展示赢分（断线恢复 / HUD 展示用） */
  freeSpinWinAccumulated?: number;
}

/** 本 spin / cascade **新获得** FG 次数（非 session remaining） */
export interface FGAwardExtension {
  awarded: number;
  superType?: number;
}

export const GAME_FLOW_MODES = ['ng', 'fg', 'sfg'] as const;
export const SESSION_TRANSITIONS = ['none', 'enter-fg', 'leave-fg', 'mode-change'] as const;

// ============================================================================
// 顶层：PresentationState
// ============================================================================

/**
 * 一场 Spin 中"任意一刻"的演出层数据。
 * 所有可被订阅的字段在这里聚合。
 */
export interface PresentationState {
  /** schema 版本号，便于翻译器与消费者按版本分支处理 */
  version: string;

  /** 全局会话标识（一场 Spin） */
  sessionId: string;

  /** 盘面分层 */
  board: BoardState;

  /**
   * 当前演出阶段（滚轮 / 结果揭晓）。
   * **不得**混用为 NG/FG 流程模式——见 `sessionContext.mode`。
   */
  phase: Phase;

  /**
   * 会话级流程态（NG / FG / SFG、剩余次数、模式切换）。
   * 每个 snapshot 均携带；进桌恢复可在首帧写入。
   */
  sessionContext: SessionContext;

  /**
   * 本次 Spin 累计的演出展示用奖额。
   * 大屏中央 "WIN: X" 跳字的目标值——是演出层的展示数字，
   * 不是钱包余额，也不是账户层真相。
   * Anticipation 期间应为 0。
   */
  totalWinDisplay: number;

  /**
   * 私有字段命名空间。
   * 凡是属于"演出层需要让 View 看到、但不是所有 slot 共有"的字段，
   * 都按玩法族在此安放（如 extensions['fg'] 表本局 award、extensions['collection']）。
   * `extensions['fg']` 标准形态见 {@link FGAwardExtension}；remaining 在 `sessionContext`。
   */
  extensions: Record<string, unknown>;
}

export type Phase = 'idle' | 'anticipation' | 'consequence';

// ============================================================================
// BoardState
// ============================================================================

export interface BoardState {
  /**
   * 当前帧的盘面拓扑：列数、每列高度（支持非等高 reel）。
   *
   * topology 属于 PresentationState，而不是 session 级静态配置，因此相邻帧
   * 可以拥有不同的 visibleRows。例如某帧为 [7,5,3,6,2,4]，下一帧可变为
   * [4,7,6,2,5,3]。display / resolved 必须随各自帧的 topology 改变长度。
   *
   * 这里描述的是逻辑位置数量，不描述像素高度、资源 tier 或布局算法；
   * 后三者由 presentation profile / symbol pack 根据本字段推导。
   */
  topology: ReelTopology;

  /** 滚动期显示层（含模糊带、占位符） */
  display: SymbolGrid;

  /** 已揭晓的结果层 */
  resolved: SymbolGrid;

  /** 多格实体集合（异形 1×2 / 1×3 / 整列粘贴等） */
  entities: Record<EntityId, SymbolEntity>;

  /** 锁格 / 粘格 */
  anchors: AnchorSet;

  /** 叠层（叠层 WILD 框、倍率框；底层格仍可见） */
  overlays: Overlay[];

  /**
   * 当前画面上活跃的中奖组合集合。
   * Anticipation 期间为空数组；consequence 期间填入当前应被高亮的组合。
   */
  wins: WinGroup[];

  /**
   * 当前盘面级演出倍率（屏角总倍率计量条 / 累积连锁倍率）。
   * 无全局倍率时省略。
   */
  multiplier?: number;
}

export interface ReelTopology {
  cols: number;
  /**
   * 当前帧每列的可见逻辑位置数；数组长度必须等于 cols，可不等高。
   * 该值可逐帧变化，不要求整个 session 固定。
   */
  visibleRows: number[];
  /** 每列额外行（上） */
  extraTop: number[];
  /** 每列额外行（下） */
  extraBottom: number[];
}

/** [col][row] */
export type SymbolGrid = Cell[][];

export interface Cell {
  /**
   * 该格当前的 symbol id。
   * `null` 表示"此刻该格为空"——典型出现在消除完成、尚未下落补满的瞬间。
   */
  symbolId: number | null;

  /** 引用到 entities 中的多格实体；null 表示 1×1 */
  entityRef: EntityId | null;

  /** 占位符标记（值无意义，仅指示该格当前为占位） */
  isPlaceholder?: boolean;
}

// ============================================================================
// 多格实体
// ============================================================================

export type EntityId = string;

export interface SymbolEntity {
  id: EntityId;
  symbolId: number;
  /** 锚点格 (col, row) */
  anchor: CellRef;
  /**
   * 相对锚点的偏移列表，描述该实体占据哪些格。
   * 例：[[0,0],[0,1]] 表示 1×2（同列两行）。
   */
  footprint: Array<[number, number]>;
  kind?: 'wild' | 'mystery' | 'multi' | 'jp' | string;
  /**
   * 该实体当前展示的倍率。
   * **唯一性约定**：任何"挂在符号上的倍率"都通过 entity 表达——
   * 哪怕只是 1×1 倍率球，也包成 1×1 entity 把倍率挂在这里。
   */
  multiplier?: number;
  meta?: Record<string, unknown>;
}

export interface CellRef {
  col: number;
  row: number;
}

// ============================================================================
// 锚点
// ============================================================================

export interface AnchorSet {
  /** 不可消除 / 不可下落带走；key = `${col},${row}` */
  locks: Set<string>;
  /** 粘格：消除链结束保留；key = `${col},${row}` */
  sticks: Set<string>;
}

// ============================================================================
// 叠层
// ============================================================================

export interface Overlay {
  id: string;
  kind: 'wild-frame' | 'multiplier-frame' | string;
  cells: CellRef[];
  /** 该叠层当前展示的倍率（如倍率框上写 x10）。无倍率时省略。 */
  multiplier?: number;
  meta?: Record<string, unknown>;
}

// ============================================================================
// 中奖组合
// ============================================================================

export interface WinGroup {
  /** 本组稳定标识 */
  id: string;
  /** 中奖类型 */
  kind: 'line' | 'ways' | 'cluster' | 'scatter' | string;
  /** 参与本组的格坐标 */
  cells: CellRef[];
  /** 参与符号 id（如所有格同一 symbol；混合 WILD 等情况可省略） */
  symbolId?: number;
  /** 该组展示用奖额（浮字动画用，非钱包真相） */
  amount?: number;
  /**
   * 该组的本地倍率。
   * 与 BoardState.multiplier / SymbolEntity.multiplier 无数学关系。
   */
  multiplier?: number;
  /** 玩法特定的描线 / 排序信息 */
  meta?: Record<string, unknown>;
}

// ============================================================================
// 工具类型
// ============================================================================

/**
 * 把 (col, row) 编码为 anchors.locks / anchors.sticks 使用的 key。
 * 由 schema 约定为 `${col},${row}`。
 */
export function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

/**
 * 从 anchor key 解出 (col, row)。
 * 不做校验；不合法的 key 在 validator 中按 INV-2 报错。
 */
export function parseCellKey(key: string): { col: number; row: number } | null {
  const parts = key.split(',');
  if (parts.length !== 2) return null;
  const col = Number(parts[0]);
  const row = Number(parts[1]);
  if (!Number.isInteger(col) || !Number.isInteger(row)) return null;
  return { col, row };
}

/**
 * schema 当前版本号常量。
 * 翻译器写入 PresentationState.version 时使用此值；
 * 升版本时同步 bump。
 */
export const SCHEMA_VERSION = '0.2.0';
