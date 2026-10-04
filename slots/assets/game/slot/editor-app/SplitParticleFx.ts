/**
 * 扩散飞弹粒子 —— 对齐 harExplore particle-player / BlueTimesMoving。
 *
 * 关键规则（ParticlePlayerHost）：
 * - custom=true，不要走 ParticleAsset.file
 * - Sprite / MotionStreak / ParticleSystem2D 不能同节点（都是 UIRenderer）
 * - PositionType.FREE + 移动发射器 = 拖尾
 */

import {
    Color,
    Node,
    ParticleSystem2D,
    Sprite,
    SpriteFrame,
    UITransform,
    Vec2,
} from 'cc';

/** gfx.BlendFactor 数值 */
const BF_ONE = 1;
const BF_SRC_ALPHA = 2;

/** BlueTimesMoving prefab 参数（HAR 抽出） */
export const BLUE_TIMES_MOVING_PARAMS = {
    duration: -1,
    emissionRate: 2000,
    life: 0.22,
    lifeVar: 0,
    totalParticles: 2000,
    startSize: 30,
    startSizeVar: 45,
    endSize: 0,
    endSizeVar: 0,
    startSpin: 30,
    startSpinVar: 0,
    endSpin: 0,
    endSpinVar: 0,
    angle: 50,
    angleVar: 50,
    speed: 1,
    speedVar: 5,
    tangentialAccel: -5,
    tangentialAccelVar: 0,
    radialAccel: -2,
    radialAccelVar: 0,
    /** FREE：粒子留在发射坐标，发射器飞走形成拖尾 */
    positionType: 0,
    emitterMode: 0,
    rotationIsDir: true,
    blendFuncSource: BF_SRC_ALPHA,
    blendFuncDestination: BF_ONE,
    posVar: { x: 10, y: 8 },
    gravity: { x: 50, y: 0 },
    startColor: { r: 15, g: 104, b: 218, a: 255 },
    endColor: { r: 0, g: 20, b: 255, a: 255 },
} as const;

/** 仅接受 SymbolLibrary.expandSplitParticle；不再硬编码 golden-seth 路径 */
export function resolveTrailSprite(prefabRef: SpriteFrame | null): SpriteFrame | null {
    return prefabRef?.isValid ? prefabRef : null;
}

/** 与 ParticlePlayerHost._applyParams 同构 */
export function applyParticleParams(ps: ParticleSystem2D, p: Record<string, unknown>): void {
    const numKeys = [
        'duration',
        'emissionRate',
        'life',
        'lifeVar',
        'totalParticles',
        'startSize',
        'startSizeVar',
        'endSize',
        'endSizeVar',
        'startSpin',
        'startSpinVar',
        'endSpin',
        'endSpinVar',
        'angle',
        'angleVar',
        'speed',
        'speedVar',
        'tangentialAccel',
        'tangentialAccelVar',
        'radialAccel',
        'radialAccelVar',
        'emitterMode',
        'positionType',
    ] as const;

    for (const k of numKeys) {
        if (typeof p[k] === 'number' && Number.isFinite(p[k] as number)) {
            (ps as unknown as Record<string, number>)[k] = p[k] as number;
        }
    }

    if (typeof p.rotationIsDir === 'boolean') {
        ps.rotationIsDir = p.rotationIsDir;
    }

    if (typeof p.blendFuncSource === 'number') {
        ps.srcBlendFactor = p.blendFuncSource;
    }
    if (typeof p.blendFuncDestination === 'number') {
        (ps as unknown as { _dstBlendFactor: number })._dstBlendFactor = p.blendFuncDestination;
    }

    const asVec = (v: unknown): Vec2 | null => {
        if (!v || typeof v !== 'object') return null;
        const o = v as { x?: number; y?: number };
        if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
        return new Vec2(o.x, o.y);
    };
    const g = asVec(p.gravity);
    if (g) ps.gravity = g;
    const pv = asVec(p.posVar);
    if (pv) ps.posVar = pv;
    // 预览/飞行都用节点坐标，清掉 HAR 里 bake 的 sourcePos
    ps.sourcePos = new Vec2(0, 0);

    const asColor = (v: unknown): Color | null => {
        if (!v || typeof v !== 'object') return null;
        const o = v as { r?: number; g?: number; b?: number; a?: number };
        return new Color(o.r ?? 255, o.g ?? 255, o.b ?? 255, o.a ?? 255);
    };
    const sc = asColor(p.startColor);
    if (sc) ps.startColor = sc;
    const ec = asColor(p.endColor);
    if (ec) ps.endColor = ec;
}

/**
 * 创建拖尾飞弹：根节点可 tween；粒子在独立子节点（FREE）。
 * @param opts.startSize 粒子起始大小（默认 30）；startSizeVar 默认 startSize*1.5
 */
export function spawnBlueTimesTrail(
    host: Node,
    sprite: SpriteFrame,
    pos: { x: number; y: number },
    opts?: { startSize?: number; startSizeVar?: number },
): { root: Node; ps: ParticleSystem2D } {
    const startSize = opts?.startSize ?? BLUE_TIMES_MOVING_PARAMS.startSize;
    const startSizeVar = opts?.startSizeVar ?? Math.round(startSize * 1.5);

    const root = new Node('split_fly');
    root.layer = host.layer;
    root.addComponent(UITransform).setContentSize(8, 8);

    // 飞头：单独节点，避免与 ParticleSystem2D 抢 UIRenderer
    const head = new Node('head');
    head.layer = host.layer;
    const headPx = Math.max(16, startSize * 0.9);
    head.addComponent(UITransform).setContentSize(headPx, headPx);
    const headSp = head.addComponent(Sprite);
    headSp.spriteFrame = sprite;
    headSp.sizeMode = Sprite.SizeMode.CUSTOM;
    headSp.color = new Color(80, 180, 255, 255);
    head.setScale(1.15, 1.15, 1);
    root.addChild(head);

    // 粒子：独立子节点；随 root 移动，FREE 留下拖尾
    const psNode = new Node('trail_ps');
    psNode.layer = host.layer;
    psNode.addComponent(UITransform).setContentSize(2, 2);
    const ps = psNode.addComponent(ParticleSystem2D);
    ps.playOnLoad = false;
    ps.autoRemoveOnFinish = false;
    // ParticlePlayerHost 路径：custom + 清 file，再贴图/参数
    ps.custom = true;
    ps.file = null;
    ps.spriteFrame = sprite;
    applyParticleParams(ps, {
        ...BLUE_TIMES_MOVING_PARAMS,
        startSize,
        startSizeVar,
        posVar: { x: Math.max(4, startSize * 0.33), y: Math.max(3, startSize * 0.27) },
    });
    root.addChild(psNode);

    root.setPosition(pos.x, pos.y, 0);
    host.addChild(root);
    root.setSiblingIndex(host.children.length - 1);

    try {
        const priv = ps as unknown as {
            _updateMaterial?: () => void;
            _updateBlendFunc?: () => void;
        };
        priv._updateMaterial?.();
        priv._updateBlendFunc?.();
    } catch (err) {
        console.warn('[SplitParticleFx] blend update skip', err);
    }
    ps.resetSystem();
    return { root, ps };
}
