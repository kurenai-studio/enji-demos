/**
 * 倍率球位图字布局（调试可调）。
 * SymbolView.setMultiplier 读取这里；EditorHud 步进器改完即时刷新盘面。
 *
 * 持久化：
 * - localStorage `se.multiDigitStyle.v2`（本机预览覆盖）
 * - 盘面 EditorDoc.multiDigitStyle（合入 PA 后由 BoardStage 应用，真源）
 */

export type MultiDigitVAlign = 'bottom' | 'center';

export interface MultiDigitStyle {
    /** Label.fontSize（相对 BMFont 声明 size 缩放） */
    fontSize: number;
    lineHeight: number;
    /** UITransform 内容盒高度 */
    boxH: number;
    offsetX: number;
    offsetY: number;
    /** 0=底锚点（旧 times），0.5=中心锚点 */
    anchorY: number;
    valign: MultiDigitVAlign;
}

/** 历史默认：对齐旧 H5 times（fontSize=10 + 底锚 + y≈12） */
export const MULTI_DIGIT_STYLE_LEGACY: MultiDigitStyle = {
    fontSize: 10,
    lineHeight: 58,
    boxH: 26,
    offsetX: 0,
    offsetY: 12,
    anchorY: 0,
    valign: 'bottom',
};

/**
 * 大字号 BMFont（如 font_symbolF size=116）居中预设。
 * 设计格约 116×96 时，字高约 42 较易看清。
 */
export const MULTI_DIGIT_STYLE_CENTER: MultiDigitStyle = {
    fontSize: 42,
    lineHeight: 48,
    boxH: 48,
    offsetX: 0,
    offsetY: 0,
    anchorY: 0.5,
    valign: 'center',
};

const STORAGE_KEY = 'se.multiDigitStyle.v2';

/** font_symbolF(size=116) 等大 BMFont 默认居中；LEGACY(fontSize=10) 几乎不可见 */
let current: MultiDigitStyle = { ...MULTI_DIGIT_STYLE_CENTER };

try {
    if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<MultiDigitStyle>;
            current = normalizeStyle({ ...MULTI_DIGIT_STYLE_CENTER, ...parsed });
        }
    }
} catch {
    /* ignore */
}

export function getMultiDigitStyle(): MultiDigitStyle {
    return { ...current };
}

export function setMultiDigitStyle(partial: Partial<MultiDigitStyle>, persist = true): MultiDigitStyle {
    current = normalizeStyle({ ...current, ...partial });
    if (persist) {
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
            }
        } catch {
            /* ignore */
        }
    }
    return { ...current };
}

export function resetMultiDigitStyle(preset: 'legacy' | 'center' = 'center'): MultiDigitStyle {
    return setMultiDigitStyle(
        preset === 'center' ? MULTI_DIGIT_STYLE_CENTER : MULTI_DIGIT_STYLE_LEGACY,
        true,
    );
}

export function formatMultiDigitStyle(s: MultiDigitStyle = current): string {
    return `字${s.fontSize} lh${s.lineHeight} y${s.offsetY} x${s.offsetX} ${s.valign}`;
}

function normalizeStyle(s: MultiDigitStyle): MultiDigitStyle {
    const fontSize = clamp(Math.round(Number(s.fontSize) || 10), 4, 120);
    const lineHeight = clamp(Math.round(Number(s.lineHeight) || fontSize + 6), 8, 200);
    const boxH = clamp(Math.round(Number(s.boxH) || lineHeight), 8, 200);
    const offsetX = clamp(Math.round(Number(s.offsetX) || 0), -80, 80);
    const offsetY = clamp(Math.round(Number(s.offsetY) || 0), -80, 80);
    const anchorY = s.valign === 'center' ? 0.5 : s.anchorY === 0.5 ? 0.5 : 0;
    const valign: MultiDigitVAlign = s.valign === 'center' || anchorY === 0.5 ? 'center' : 'bottom';
    return {
        fontSize,
        lineHeight,
        boxH,
        offsetX,
        offsetY,
        anchorY: valign === 'center' ? 0.5 : 0,
        valign,
    };
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}
