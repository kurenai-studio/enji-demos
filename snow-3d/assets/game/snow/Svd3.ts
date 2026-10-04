const S = new Float64Array(9);
const V = new Float64Array(9);
const B = new Float64Array(9);

/**
 * 3×3 SVD F = U Σ Vᵀ with U and V rotations (row major in and out). Cyclic
 * Jacobi on FᵀF gives V; U comes from Gram–Schmidt on the columns of F V, with
 * u₃ = u₁ × u₂ so it stays a rotation and an inverted F shows up as σ₃ < 0.
 * σ₁ ≥ σ₂ ≥ |σ₃|.
 */
export function svd3(f: ArrayLike<number>, fo: number, u: Float64Array, sig: Float64Array, v: Float64Array): void {
    const f0 = f[fo], f1 = f[fo + 1], f2 = f[fo + 2];
    const f3 = f[fo + 3], f4 = f[fo + 4], f5 = f[fo + 5];
    const f6 = f[fo + 6], f7 = f[fo + 7], f8 = f[fo + 8];
    S[0] = f0 * f0 + f3 * f3 + f6 * f6;
    S[1] = f0 * f1 + f3 * f4 + f6 * f7;
    S[2] = f0 * f2 + f3 * f5 + f6 * f8;
    S[4] = f1 * f1 + f4 * f4 + f7 * f7;
    S[5] = f1 * f2 + f4 * f5 + f7 * f8;
    S[8] = f2 * f2 + f5 * f5 + f8 * f8;
    S[3] = S[1];
    S[6] = S[2];
    S[7] = S[5];
    V.fill(0);
    V[0] = V[4] = V[8] = 1;
    const scale = S[0] + S[4] + S[8];
    // Squared off-diagonal norm: stop at off-diagonals ~1e-12 of the trace (Jacobi converges quadratically).
    const tol = 1e-24 * scale * scale;
    for (let sweep = 0; sweep < 4; sweep++) {
        if (S[1] * S[1] + S[2] * S[2] + S[5] * S[5] <= tol) break;
        rotate(0, 1);
        rotate(0, 2);
        rotate(1, 2);
    }
    // Columns of V sorted by eigenvalue, largest first.
    let l0 = S[0], l1 = S[4], l2 = S[8];
    if (l0 < l1) { swapColumns(0, 1); const t = l0; l0 = l1; l1 = t; }
    if (l0 < l2) { swapColumns(0, 2); const t = l0; l0 = l2; l2 = t; }
    if (l1 < l2) { swapColumns(1, 2); }
    const det = V[0] * (V[4] * V[8] - V[5] * V[7]) - V[1] * (V[3] * V[8] - V[5] * V[6]) + V[2] * (V[3] * V[7] - V[4] * V[6]);
    if (det < 0) { V[2] = -V[2]; V[5] = -V[5]; V[8] = -V[8]; }

    // B = F V, column c is F v_c.
    for (let c = 0; c < 3; c++) {
        const a = V[c], b = V[3 + c], d = V[6 + c];
        B[c] = f0 * a + f1 * b + f2 * d;
        B[3 + c] = f3 * a + f4 * b + f5 * d;
        B[6 + c] = f6 * a + f7 * b + f8 * d;
    }
    let ux = B[0], uy = B[3], uz = B[6];
    let s0 = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (s0 > 1e-12) { ux /= s0; uy /= s0; uz /= s0; } else { ux = 1; uy = 0; uz = 0; s0 = 0; }
    let wx = B[1], wy = B[4], wz = B[7];
    const d1 = ux * wx + uy * wy + uz * wz;
    wx -= d1 * ux; wy -= d1 * uy; wz -= d1 * uz;
    let s1 = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (s1 > 1e-12) { wx /= s1; wy /= s1; wz /= s1; } else {
        // Any unit vector perpendicular to u₁.
        if (Math.abs(ux) < 0.9) { wx = 0; wy = -uz; wz = uy; } else { wx = uz; wy = 0; wz = -ux; }
        const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
        wx /= l; wy /= l; wz /= l;
        s1 = 0;
    }
    const zx = uy * wz - uz * wy;
    const zy = uz * wx - ux * wz;
    const zz = ux * wy - uy * wx;
    const s2 = zx * B[2] + zy * B[5] + zz * B[8];
    u[0] = ux; u[1] = wx; u[2] = zx;
    u[3] = uy; u[4] = wy; u[5] = zy;
    u[6] = uz; u[7] = wz; u[8] = zz;
    sig[0] = s0; sig[1] = s1; sig[2] = s2;
    for (let i = 0; i < 9; i++) v[i] = V[i];
}

function rotate(p: number, q: number): void {
    const apq = S[p * 3 + q];
    if (apq === 0) return;
    const app = S[p * 3 + p];
    const aqq = S[q * 3 + q];
    const theta = (aqq - app) / (2 * apq);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    const r = 3 - p - q;
    const arp = S[r * 3 + p];
    const arq = S[r * 3 + q];
    const nrp = c * arp - s * arq;
    const nrq = s * arp + c * arq;
    S[r * 3 + p] = S[p * 3 + r] = nrp;
    S[r * 3 + q] = S[q * 3 + r] = nrq;
    S[p * 3 + p] = app - t * apq;
    S[q * 3 + q] = aqq + t * apq;
    S[p * 3 + q] = S[q * 3 + p] = 0;
    for (let k = 0; k < 3; k++) {
        const vp = V[k * 3 + p];
        const vq = V[k * 3 + q];
        V[k * 3 + p] = c * vp - s * vq;
        V[k * 3 + q] = s * vp + c * vq;
    }
}

function swapColumns(a: number, b: number): void {
    for (let k = 0; k < 3; k++) {
        const t = V[k * 3 + a];
        V[k * 3 + a] = V[k * 3 + b];
        V[k * 3 + b] = t;
    }
    const t = S[a * 4];
    S[a * 4] = S[b * 4];
    S[b * 4] = t;
}
