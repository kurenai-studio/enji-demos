/**
 * SpineZone — 资源按 Spine 运行时分区，与「游戏」解耦。
 *
 * 约定：
 *   assets/resources/spine-3.8/packs/<packId>/
 *   assets/resources/spine-4.2/packs/<packId>/
 *
 * 当前激活区由 configs/spine-zone.active.json 声明，且必须与
 * settings/v2/packages/engine.json 的 spine 模块一致。
 * 切换：node tools/switch-spine-zone.cjs 3.8|4.2 后重启 Creator 预览。
 */

import { JsonAsset, resources } from 'cc';

export type SpineZoneId = 'spine-3.8' | 'spine-4.2';

export const SPINE_ZONE_IDS: readonly SpineZoneId[] = ['spine-3.8', 'spine-4.2'];

export const DEFAULT_SPINE_ZONE: SpineZoneId = 'spine-3.8';

/** resources.load 路径（无扩展名） */
export const SPINE_ZONE_ACTIVE_RES = 'configs/spine-zone.active';

let _active: SpineZoneId | null = null;

export function isSpineZoneId(v: unknown): v is SpineZoneId {
    return v === 'spine-3.8' || v === 'spine-4.2';
}

export function packsRoot(zone: SpineZoneId): string {
    return `${zone}/packs`;
}

/** pack 内相对路径 → resources 全路径（无扩展名） */
export function packResourcePath(zone: SpineZoneId, packId: string, relWithinPack = 'symbol-library'): string {
    const rel = relWithinPack.replace(/^\/+/, '');
    return `${packsRoot(zone)}/${packId}/${rel}`.replace(/\/+/g, '/');
}

export function getActiveSpineZoneSync(): SpineZoneId {
    return _active ?? DEFAULT_SPINE_ZONE;
}

export function setActiveSpineZoneForTests(zone: SpineZoneId | null): void {
    _active = zone;
}

/**
 * 从 resources 读取激活区；失败则回落默认 3.8。
 * 预览启动时应先 await 本函数，再加载符号包。
 */
export function loadActiveSpineZone(): Promise<SpineZoneId> {
    if (_active) return Promise.resolve(_active);
    return new Promise((resolve) => {
        resources.load(SPINE_ZONE_ACTIVE_RES, JsonAsset, (err, asset) => {
            const raw = !err && asset ? (asset.json as { zone?: unknown } | null) : null;
            const z = raw?.zone;
            _active = isSpineZoneId(z) ? z : DEFAULT_SPINE_ZONE;
            if (err) {
                console.warn(
                    `[SpineZone] 未读到 ${SPINE_ZONE_ACTIVE_RES}，使用默认 ${_active}`,
                    err.message ?? err,
                );
            } else {
                console.log(`[SpineZone] active → ${_active}`);
            }
            resolve(_active);
        });
    });
}

/** 拒绝跨区 resources 路径（启动后只允许访问当前区） */
export function assertResourceInActiveZone(resPath: string, zone = getActiveSpineZoneSync()): void {
    const norm = resPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const prefix = `${zone}/`;
    if (!norm.startsWith(prefix)) {
        throw new Error(`[SpineZone] 当前为 ${zone}，拒绝加载跨区资源: ${resPath}`);
    }
}
