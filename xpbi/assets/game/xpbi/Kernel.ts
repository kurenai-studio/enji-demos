/**
 * Wendland C2 kernel in 2D, compact support `h` (q = r/h < 1), and the
 * Bonet–Lok kernel-gradient correction used by XPBI (Yu et al. 2024).
 */
import { pinv2 } from './Svd2';

/** 2D Wendland C2: α (1−q)⁴ (4q+1), α = 7/(π h²). */
export function wendland(r: number, h: number): number {
    const q = r / h;
    if (q >= 1) return 0;
    const t = 1 - q;
    return (7 / (Math.PI * h * h)) * t * t * t * t * (4 * q + 1);
}

/** ∇W, written to out[0], out[1]. Zero at r = 0. */
export function wendlandGrad(dx: number, dy: number, h: number, out: number[]): void {
    const r = Math.hypot(dx, dy);
    if (r < 1e-12 || r >= h) { out[0] = 0; out[1] = 0; return; }
    const q = r / h;
    const t = 1 - q;
    // dW/dq = α (1−q)³ (−20 q), ∇W = (dW/dq)(1/h) (x/r)
    const dWdq = (7 / (Math.PI * h * h)) * t * t * t * (-20 * q);
    const s = dWdq / (h * r);
    out[0] = s * dx;
    out[1] = s * dy;
}

const inv = new Float64Array(4);
const g = [0, 0];

/**
 * Correction L_p = (Σ_b V_b ∇W ⊗ (x_b − x_p))⁺. Writes 4 row-major entries.
 * Interior particles of a regular lattice then reproduce linear fields.
 */
export function correctionL(
    px: number, py: number,
    neighbors: ArrayLike<number>, count: number, first: number,
    ox: ArrayLike<number>, oy: ArrayLike<number>, vol: ArrayLike<number>,
    h: number, out: Float64Array, offset: number,
): void {
    let a00 = 0, a01 = 0, a10 = 0, a11 = 0;
    for (let k = 0; k < count; k++) {
        const b = neighbors[first + k];
        const dx = ox[b] - px, dy = oy[b] - py;
        wendlandGrad(dx, dy, h, g);
        const v = vol[b];
        a00 += v * g[0] * dx;
        a01 += v * g[0] * dy;
        a10 += v * g[1] * dx;
        a11 += v * g[1] * dy;
    }
    pinv2(a00, a01, a10, a11, inv);
    out[offset] = inv[0]; out[offset + 1] = inv[1];
    out[offset + 2] = inv[2]; out[offset + 3] = inv[3];
}

/** Corrected kernel gradient L ∇W. */
export function correctedGrad(
    l00: number, l01: number, l10: number, l11: number,
    dx: number, dy: number, h: number, out: number[],
): void {
    wendlandGrad(dx, dy, h, g);
    out[0] = l00 * g[0] + l01 * g[1];
    out[1] = l10 * g[0] + l11 * g[1];
}
