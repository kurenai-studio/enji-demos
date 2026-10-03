/**
 * Q16.16 fixed point in plain JS numbers. Every value is an integer (raw =
 * real × 65536) and every operation ends in an integer, so two machines that
 * run the same steps get the same bits, whatever their FPU, compiler or
 * engine does with floating point (fused multiply-add, x87 extended
 * precision, a different Math.sin). Products stay below 2^53, so they are
 * exact in a double: keep |raw| under 2^26 (±1024 units), as the game does.
 */
export const ONE = 65536;

/** Real number to fixed point; only for constants, never inside the simulation. */
export function fx(x: number): number {
    return Math.round(x * ONE);
}

export function toFloat(a: number): number {
    return a / ONE;
}

/** a × b, rounded towards zero (so drag brings negative speeds to rest as well as positive ones). */
export function fmul(a: number, b: number): number {
    return Math.trunc((a * b) / ONE);
}

/** a / b, rounded towards zero; b ≠ 0. */
export function fdiv(a: number, b: number): number {
    return Math.trunc((a * ONE) / b);
}

/** ⌊√v⌋ for an integer v ≥ 0 (exact: the float estimate is corrected both ways). */
export function isqrt(v: number): number {
    if (v <= 0) return 0;
    let s = Math.floor(Math.sqrt(v));
    while (s * s > v) s--;
    while ((s + 1) * (s + 1) <= v) s++;
    return s;
}

/** Length of a fixed-point vector, in fixed point: √(x² + y²) of raw values is already Q16.16. */
export function flength(x: number, y: number): number {
    return isqrt(x * x + y * y);
}

export function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}
