/**
 * 2×2 SVD M = U Σ Vᵀ with U and Vᵀ pure rotations (Pedro Gimeno's robust
 * closed form, as in the PB-MPM reference). Σ[1] may be negative.
 * `out` receives [cos φ, sin φ, σ0, σ1, cos θ, sin θ] with U = R(φ), Vᵀ = R(θ).
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
    const cp = svd[0];
    const sp = svd[1];
    const ct = svd[4];
    const st = svd[5];
    out[0] = cp * s0 * ct - sp * s1 * st;
    out[1] = -cp * s0 * st - sp * s1 * ct;
    out[2] = sp * s0 * ct + cp * s1 * st;
    out[3] = -sp * s0 * st + cp * s1 * ct;
}

/**
 * Plasticity applied to Σ at the end of a step, shared by both solvers.
 * Sand: Drucker–Prager return mapping (Klár et al. 2016) with the PB-MPM
 * reference's volume memory in logJp. Visco: clamp Σ to a yield band, then
 * restore the volume. Returns the new logJp; Σ is written to svd[2..3].
 */
export function plasticity(material: number, svd: Float64Array, logJp: number, frictionAngle: number, elasticityRatio: number, yieldAmount: number): number {
    if (material === 2) {
        const sinPhi = Math.sin((frictionAngle / 180) * Math.PI);
        const alpha = Math.sqrt(2 / 3) * 2 * sinPhi / (3 - sinPhi);
        const e0 = Math.log(Math.max(Math.abs(svd[2]), 1e-6));
        const e1 = Math.log(Math.max(Math.abs(svd[3]), 1e-6));
        const trace = e0 + e1 + logJp;
        if (trace >= 0) {
            svd[2] = 1;
            svd[3] = 1;
            return 0.5 * trace;
        }
        const h0 = e0 - trace * 0.5;
        const h1 = e1 - trace * 0.5;
        const frob = Math.sqrt(h0 * h0 + h1 * h1);
        const dg = frob + (elasticityRatio + 1) * trace * alpha;
        if (dg > 0 && frob > 1e-9) {
            svd[2] = Math.exp(e0 - (dg / frob) * (e0 - trace * 0.5));
            svd[3] = Math.exp(e1 - (dg / frob) * (e1 - trace * 0.5));
        }
        return 0;
    }
    if (material === 3) {
        const yieldSurface = Math.exp(1 - yieldAmount);
        const j = svd[2] * svd[3];
        const s0 = Math.min(Math.max(svd[2], 1 / yieldSurface), yieldSurface);
        const s1 = Math.min(Math.max(svd[3], 1 / yieldSurface), yieldSurface);
        const k = Math.sqrt(Math.abs(j / (s0 * s1)));
        svd[2] = s0 * k;
        svd[3] = s1 * k;
    }
    return logJp;
}

/** Hardening never takes snow past this multiple of its base moduli, so a crushed clump cannot outrun the explicit step. */
const SNOW_MAX_HARDENING = 6;

/**
 * Snow plasticity (Stomakhin et al. 2013): the elastic singular values are
 * clamped to [1 − θc, 1 + θs]; whatever is cut off moves into the plastic
 * part, whose volume ratio Jp is returned (Jp · det F_E stays the total J).
 * Σ is written to svd[2..3].
 */
export function snowPlasticity(svd: Float64Array, jp: number, compression: number, stretch: number): number {
    const s0 = svd[2];
    const s1 = svd[3];
    const c0 = Math.min(Math.max(s0, 1 - compression), 1 + stretch);
    const c1 = Math.min(Math.max(s1, 1 - compression), 1 + stretch);
    svd[2] = c0;
    svd[3] = c1;
    return Math.min(Math.max((jp * s0 * s1) / (c0 * c1), 0.2), 5);
}

/** e^{ξ(1 − Jp)}: packed snow (Jp < 1) gets stiffer, torn snow (Jp > 1) softer. */
export function snowHardening(jp: number, xi: number): number {
    return Math.min(Math.exp(xi * (1 - jp)), SNOW_MAX_HARDENING);
}
