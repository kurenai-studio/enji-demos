/**
 * Lighting, fog and display constants shared by every path. They are
 * #defines in lod-common.chunk; the tests check the two agree.
 */
export const SUN_DIR = [0.45, 0.72, 0.53];
export const SUN_COLOR = [2.2, 2.0, 1.7];
export const SKY_COLOR = [0.34, 0.42, 0.55];
export const GROUND_COLOR = [0.12, 0.11, 0.08];
/** Linear; the camera clears to its display-encoded value. */
export const FOG_COLOR = [0.5, 0.58, 0.68];
export const FOG_DENSITY = 0.0045;
/** Per-level debug tints. */
export const LOD_TINTS = [[0.9, 0.25, 0.2], [0.95, 0.75, 0.2], [0.25, 0.75, 0.35], [0.3, 0.5, 0.95]];

/** Linear to display: x^(1/2.2). */
export function toDisplay(c: number): number {
    return Math.pow(Math.max(0, Math.min(1, c)), 1 / 2.2);
}

/** Visibility exp(-(d ρ)²) after distance d. */
export function fogVisibility(d: number): number {
    return Math.exp(-((d * FOG_DENSITY) ** 2));
}
