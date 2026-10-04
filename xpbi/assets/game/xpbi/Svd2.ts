/**
 * 2×2 SVD M = U Σ Vᵀ with U and Vᵀ pure rotations (Pedro Gimeno's closed form).
 * `out` is [cos φ, sin φ, σ0, σ1, cos θ, sin θ]; Σ[1] may be negative.
 */
export function svd2(m00: number, m01: number, m10: number, m11: number, out: Float64Array): void {
    const e = (m00 + m11) * 0.5;
    const f = (m00 - m11) * 0.5;
    const g = (m10 + m01) * 0.5;
    const h = (m10 - m01) * 0.5;
    const q = Math.sqrt(e * e + h * h);
    const r = Math.sqrt(f * f + g * g);
    const a1 = Math.atan2(g, f);
    const a2 = Math.atan2(h, e);
    const theta = (a2 - a1) * 0.5;
    const phi = (a2 + a1) * 0.5;
    out[0] = Math.cos(phi);
    out[1] = Math.sin(phi);
    out[2] = q + r;
    out[3] = q - r;
    out[4] = Math.cos(theta);
    out[5] = Math.sin(theta);
}

/** Writes U diag(s0, s1) Vᵀ (row major) into out[0..3]. */
export function recompose(svd: Float64Array, s0: number, s1: number, out: Float64Array): void {
    const cp = svd[0], sp = svd[1], ct = svd[4], st = svd[5];
    out[0] = cp * s0 * ct - sp * s1 * st;
    out[1] = -cp * s0 * st - sp * s1 * ct;
    out[2] = sp * s0 * ct + cp * s1 * st;
    out[3] = -sp * s0 * st + cp * s1 * ct;
}

/** SVD pseudo-inverse of a 2×2, singular values below `eps` dropped. */
export function pinv2(a00: number, a01: number, a10: number, a11: number, out: Float64Array, eps = 1e-8): void {
    const det = a00 * a11 - a01 * a10;
    if (Math.abs(det) > eps) {
        const i = 1 / det;
        out[0] = a11 * i; out[1] = -a01 * i; out[2] = -a10 * i; out[3] = a00 * i;
        return;
    }
    svd2(a00, a01, a10, a11, pinvSvd);
    const s0 = Math.abs(pinvSvd[2]) > eps ? 1 / pinvSvd[2] : 0;
    const s1 = Math.abs(pinvSvd[3]) > eps ? 1 / pinvSvd[3] : 0;
    const cp = pinvSvd[0], sp = pinvSvd[1], ct = pinvSvd[4], st = pinvSvd[5];
    // V Σ⁺ Uᵀ
    out[0] = ct * s0 * cp + st * s1 * (-sp);
    out[1] = ct * s0 * sp + st * s1 * cp;
    out[2] = -st * s0 * cp + ct * s1 * (-sp);
    out[3] = -st * s0 * sp + ct * s1 * cp;
}

const pinvSvd = new Float64Array(6);
const tmpF = new Float64Array(4);

export const JELLY = 0;
export const SAND = 1;
export const SNOW = 2;
export const CLAY = 3;
export const MATERIAL_NAMES = ['Jelly', 'Sand', 'Snow', 'Clay'];

/**
 * Return mapping Z(F) in place on row-major F[4]. Returns the updated logJp
 * (sand) or Jp (snow); unused for jelly and clay.
 *
 * Sand: Drucker–Prager on Hencky strain (Klár et al. 2016).
 * Snow: clamp Σ to [1 − θc, 1 + θs] (Stomakhin et al. 2013).
 * Clay: von Mises on Hencky strain, volume preserved.
 */
export function returnMap(
    f: Float64Array,
    material: number,
    logJp: number,
    frictionDeg: number,
    cohesion: number,
    snowC: number,
    snowS: number,
    yieldStress: number,
    mu: number,
): number {
    if (material === JELLY) return logJp;
    svd2(f[0], f[1], f[2], f[3], pinvSvd);
    if (material === SAND) {
        const sinPhi = Math.sin((frictionDeg / 180) * Math.PI);
        const alpha = Math.sqrt(2 / 3) * 2 * sinPhi / (3 - sinPhi);
        const e0 = Math.log(Math.max(Math.abs(pinvSvd[2]), 1e-6));
        const e1 = Math.log(Math.max(Math.abs(pinvSvd[3]), 1e-6));
        const trace = e0 + e1 + logJp;
        if (trace >= cohesion) {
            recompose(pinvSvd, 1, 1, f);
            return 0.5 * trace;
        }
        const h0 = e0 - trace * 0.5, h1 = e1 - trace * 0.5;
        const frob = Math.sqrt(h0 * h0 + h1 * h1);
        const dg = frob + (1 + 1) * trace * alpha;
        if (dg > 0 && frob > 1e-9) {
            recompose(
                pinvSvd,
                Math.exp(e0 - (dg / frob) * h0),
                Math.exp(e1 - (dg / frob) * h1),
                f,
            );
        }
        return 0;
    }
    if (material === SNOW) {
        const s0 = pinvSvd[2], s1 = pinvSvd[3];
        const c0 = Math.min(Math.max(s0, 1 - snowC), 1 + snowS);
        const c1 = Math.min(Math.max(s1, 1 - snowC), 1 + snowS);
        recompose(pinvSvd, c0, c1, f);
        return Math.min(Math.max((logJp * s0 * s1) / (c0 * c1), 0.2), 5);
    }
    // Von Mises: shrink the Hencky deviator if ||s|| > σ_Y.
    const e0 = Math.log(Math.max(Math.abs(pinvSvd[2]), 1e-6));
    const e1 = Math.log(Math.max(Math.abs(pinvSvd[3]), 1e-6));
    const m = (e0 + e1) * 0.5;
    const d0 = e0 - m, d1 = e1 - m;
    const n = Math.hypot(d0, d1);
    const tau = yieldStress / Math.max(2 * mu, 1e-8);
    if (n > tau && n > 1e-12) {
        const s = tau / n;
        recompose(pinvSvd, Math.exp(m + d0 * s), Math.exp(m + d1 * s), f);
    } else {
        tmpF[0] = f[0]; tmpF[1] = f[1]; tmpF[2] = f[2]; tmpF[3] = f[3];
    }
    return logJp;
}

export function snowHardening(jp: number, xi: number): number {
    return Math.min(Math.exp(xi * (1 - jp)), 6);
}

/** StVK Hencky energy density Ψ and first Piola P = ∂Ψ/∂F. */
export function stvk(f00: number, f01: number, f10: number, f11: number, mu: number, lambda: number, P: Float64Array): number {
    svd2(f00, f01, f10, f11, pinvSvd);
    const e0 = Math.log(Math.max(Math.abs(pinvSvd[2]), 1e-6));
    const e1 = Math.log(Math.max(Math.abs(pinvSvd[3]), 1e-6));
    const tr = e0 + e1;
    const psi = mu * (e0 * e0 + e1 * e1) + 0.5 * lambda * tr * tr;
    const t0 = 2 * mu * e0 + lambda * tr;
    const t1 = 2 * mu * e1 + lambda * tr;
    const cp = pinvSvd[0], sp = pinvSvd[1], ct = pinvSvd[4], st = pinvSvd[5];
    const tau00 = cp * cp * t0 + sp * sp * t1;
    const tau01 = cp * sp * (t0 - t1);
    const tau11 = sp * sp * t0 + cp * cp * t1;
    const is0 = 1 / Math.max(Math.abs(pinvSvd[2]), 1e-6);
    const is1 = 1 / Math.max(Math.abs(pinvSvd[3]), 1e-6);
    // F^{-T} = U Σ^{-1} Vᵀ
    const ft00 = cp * is0 * ct - sp * is1 * st;
    const ft01 = -cp * is0 * st - sp * is1 * ct;
    const ft10 = sp * is0 * ct + cp * is1 * st;
    const ft11 = -sp * is0 * st + cp * is1 * ct;
    P[0] = tau00 * ft00 + tau01 * ft10;
    P[1] = tau00 * ft01 + tau01 * ft11;
    P[2] = tau01 * ft00 + tau11 * ft10;
    P[3] = tau01 * ft01 + tau11 * ft11;
    return psi;
}
