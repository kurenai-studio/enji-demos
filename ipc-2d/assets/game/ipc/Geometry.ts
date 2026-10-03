/**
 * 2D contact geometry for IPC: point-edge squared distance with its gradient
 * and Hessian, the log barrier, additive CCD and a PSD projection for small
 * symmetric matrices. Degrees of freedom are ordered [px, py, ax, ay, bx, by].
 */

/** Which feature of edge ab is closest to point p. */
export const PE_A = 0;
export const PE_B = 1;
export const PE_LINE = 2;

export function peType(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const ex = bx - ax;
    const ey = by - ay;
    const t = (px - ax) * ex + (py - ay) * ey;
    if (t <= 0) return PE_A;
    if (t >= ex * ex + ey * ey) return PE_B;
    return PE_LINE;
}

/** Squared distance from p to segment ab. */
export function peDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const ex = bx - ax;
    const ey = by - ay;
    const rx = px - ax;
    const ry = py - ay;
    const t = rx * ex + ry * ey;
    if (t <= 0) return rx * rx + ry * ry;
    const len2 = ex * ex + ey * ey;
    if (t >= len2) {
        const qx = px - bx;
        const qy = py - by;
        return qx * qx + qy * qy;
    }
    const c = rx * ey - ry * ex;
    return (c * c) / len2;
}

/** Closest-point parameter on ab, clamped to [0, 1]. */
export function peParam(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    if (len2 <= 0) return 0;
    const t = ((px - ax) * ex + (py - ay) * ey) / len2;
    return t < 0 ? 0 : t > 1 ? 1 : t;
}

// Constant second derivatives of c = (p - a) × (b - a) and L = |b - a|².
const HC = new Float64Array(36);
const HL = new Float64Array(36);
{
    const setSym = (m: Float64Array, i: number, j: number, v: number) => {
        m[i * 6 + j] = v;
        m[j * 6 + i] = v;
    };
    setSym(HC, 0, 5, 1);
    setSym(HC, 0, 3, -1);
    setSym(HC, 2, 5, -1);
    setSym(HC, 1, 4, -1);
    setSym(HC, 1, 2, 1);
    setSym(HC, 3, 4, 1);
    for (let i = 2; i < 6; i++) HL[i * 6 + i] = 2;
    setSym(HL, 2, 4, -2);
    setSym(HL, 3, 5, -2);
}
const gc = new Float64Array(6);
const gl = new Float64Array(6);

/**
 * Squared distance s, its gradient (6) and Hessian (36, row major) for the
 * closest feature. Returns s.
 */
export function peDistance2Derivatives(
    px: number, py: number, ax: number, ay: number, bx: number, by: number,
    grad: Float64Array, hess: Float64Array,
): number {
    const type = peType(px, py, ax, ay, bx, by);
    grad.fill(0);
    hess.fill(0);
    if (type !== PE_LINE) {
        // Point-point between p (slot 0) and a (slot 1) or b (slot 2).
        const q = type === PE_A ? 1 : 2;
        const dx = px - (type === PE_A ? ax : bx);
        const dy = py - (type === PE_A ? ay : by);
        grad[0] = 2 * dx;
        grad[1] = 2 * dy;
        grad[q * 2] = -2 * dx;
        grad[q * 2 + 1] = -2 * dy;
        for (let k = 0; k < 2; k++) {
            hess[k * 6 + k] = 2;
            hess[(q * 2 + k) * 6 + q * 2 + k] = 2;
            hess[k * 6 + q * 2 + k] = -2;
            hess[(q * 2 + k) * 6 + k] = -2;
        }
        return dx * dx + dy * dy;
    }
    const ex = bx - ax;
    const ey = by - ay;
    const rx = px - ax;
    const ry = py - ay;
    const c = rx * ey - ry * ex;
    const L = ex * ex + ey * ey;
    gc[0] = ey;
    gc[1] = -ex;
    gc[4] = -ry;
    gc[5] = rx;
    gc[2] = -gc[0] - gc[4];
    gc[3] = -gc[1] - gc[5];
    gl[0] = 0;
    gl[1] = 0;
    gl[2] = -2 * ex;
    gl[3] = -2 * ey;
    gl[4] = 2 * ex;
    gl[5] = 2 * ey;
    const iL = 1 / L;
    const s = c * c * iL;
    const k1 = 2 * c * iL;
    const k2 = c * c * iL * iL;
    for (let i = 0; i < 6; i++) grad[i] = k1 * gc[i] - k2 * gl[i];
    const a1 = 2 * iL;
    const a3 = 2 * c * iL * iL;
    const a5 = 2 * c * c * iL * iL * iL;
    for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
            const ij = i * 6 + j;
            hess[ij] = a1 * gc[i] * gc[j] + k1 * HC[ij] - a3 * (gc[i] * gl[j] + gl[i] * gc[j]) - k2 * HL[ij] + a5 * gl[i] * gl[j];
        }
    }
    return s;
}

/** IPC log barrier on squared distance: b(s) = -(s - ŝ)² ln(s / ŝ) for s < ŝ. */
export function barrier(s: number, sHat: number): number {
    if (s >= sHat) return 0;
    const d = s - sHat;
    return -d * d * Math.log(s / sHat);
}

export function barrierGrad(s: number, sHat: number): number {
    if (s >= sHat) return 0;
    const d = s - sHat;
    return -(2 * d * Math.log(s / sHat) + (d * d) / s);
}

export function barrierHess(s: number, sHat: number): number {
    if (s >= sHat) return 0;
    const d = s - sHat;
    return -(2 * Math.log(s / sHat) + (4 * d) / s - (d * d) / (s * s));
}

/**
 * Additive CCD (Li, Kaufman, Jiang 2021) for point p moving by dp against
 * edge ab moving by da, db. Returns a step in [0, tMax] after which the
 * distance minus the thickness ξ has not shrunk below `gap` times its start
 * value; 0 if the pair is already within ξ.
 */
export function accdPointEdge(
    px: number, py: number, ax: number, ay: number, bx: number, by: number,
    dpx: number, dpy: number, dax: number, day: number, dbx: number, dby: number,
    tMax: number, xi = 0, gap = 0.1,
): number {
    // Relative to the mean motion, which does not change the distance.
    const mx = (dpx + dax + dbx) / 3;
    const my = (dpy + day + dby) / 3;
    dpx -= mx; dpy -= my; dax -= mx; day -= my; dbx -= mx; dby -= my;
    const lp = Math.hypot(dpx, dpy) + Math.max(Math.hypot(dax, day), Math.hypot(dbx, dby));
    if (lp === 0) return tMax;
    let d = Math.sqrt(peDistance2(px, py, ax, ay, bx, by)) - xi;
    if (d <= 0) return 0;
    const g = gap * d;
    let t = 0;
    let tl = ((1 - gap) * d) / lp;
    for (let iter = 0; iter < 1000; iter++) {
        px += tl * dpx; py += tl * dpy;
        ax += tl * dax; ay += tl * day;
        bx += tl * dbx; by += tl * dby;
        d = Math.sqrt(peDistance2(px, py, ax, ay, bx, by)) - xi;
        if (t > 0 && d < g) break;
        t += tl;
        if (t > tMax) return tMax;
        tl = (0.9 * d) / lp;
    }
    return t;
}

/** Smallest α in (0, tMax] at which the triangle's signed area reaches zero, scaled by 0.9; else tMax. */
export function inversionStep(
    e1x: number, e1y: number, e2x: number, e2y: number,
    d1x: number, d1y: number, d2x: number, d2y: number,
    tMax: number,
): number {
    // det(e1 + α d1, e2 + α d2) = a α² + b α + c
    const a = d1x * d2y - d1y * d2x;
    const b = e1x * d2y + d1x * e2y - e1y * d2x - d1y * e2x;
    const c = e1x * e2y - e1y * e2x;
    let root = Infinity;
    if (Math.abs(a) < 1e-14 * (Math.abs(b) + Math.abs(c))) {
        if (b < 0) root = -c / b;
    } else {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) {
            const sq = Math.sqrt(disc);
            // Numerically stable pair of roots.
            const q = -0.5 * (b + (b >= 0 ? sq : -sq));
            const r1 = q / a;
            const r2 = q !== 0 ? c / q : Infinity;
            if (r1 > 0) root = Math.min(root, r1);
            if (r2 > 0) root = Math.min(root, r2);
        }
    }
    return Math.min(tMax, 0.9 * root);
}

const eigVec = new Float64Array(36);
const eigTmp = new Float64Array(36);
const eigVal = new Float64Array(6);

/**
 * Replaces the symmetric n×n matrix m (n ≤ 6, row major) by its projection
 * onto the positive semidefinite cone, via cyclic Jacobi rotations.
 */
export function projectPsd(m: Float64Array, n: number, offset = 0): void {
    const a = eigTmp;
    const v = eigVec;
    let minDiag = Infinity;
    for (let i = 0; i < n * n; i++) a[i] = m[offset + i];
    // Cheap exit: diagonally dominant with a positive diagonal is already PSD.
    let dominant = true;
    for (let i = 0; i < n && dominant; i++) {
        let off = 0;
        for (let j = 0; j < n; j++) if (j !== i) off += Math.abs(a[i * n + j]);
        if (a[i * n + i] < off) dominant = false;
        minDiag = Math.min(minDiag, a[i * n + i]);
    }
    if (dominant && minDiag >= 0) return;
    v.fill(0, 0, n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    for (let sweep = 0; sweep < 12; sweep++) {
        let off = 0;
        let diag = 0;
        for (let i = 0; i < n; i++) {
            diag += a[i * n + i] * a[i * n + i];
            for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
        }
        if (off <= 1e-24 * diag || off === 0) break;
        for (let p = 0; p < n - 1; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q];
                if (apq === 0) continue;
                const app = a[p * n + p];
                const aqq = a[q * n + q];
                const theta = (aqq - app) / (2 * apq);
                const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k * n + p];
                    const akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p * n + k];
                    const aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k * n + p];
                    const vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let negative = false;
    for (let i = 0; i < n; i++) {
        eigVal[i] = a[i * n + i];
        if (eigVal[i] < 0) negative = true;
    }
    if (!negative) return;
    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
            let sum = 0;
            for (let k = 0; k < n; k++) if (eigVal[k] > 0) sum += v[i * n + k] * eigVal[k] * v[j * n + k];
            m[offset + i * n + j] = sum;
            m[offset + j * n + i] = sum;
        }
    }
}

/**
 * dP/dF of 2D Neo-Hookean Ψ = μ/2 (|F|² − 2) − μ ln J + λ/2 ln² J, projected
 * to PSD in closed form (Smith et al. 2019, analytic eigensystems): with
 * F = U diag(σ1, σ2) Vᵀ the eigenmatrices are U X Vᵀ for a twist, a flip and
 * two scalings, so only the scaling pair needs a 2×2 eigen solve. Writes a
 * row-major 4×4 over F = [f00 f01 f10 f11] into `out`. Requires det F > 0.
 */
export function neoHookeanHessian(f00: number, f01: number, f10: number, f11: number, mu: number, lam: number, out: Float64Array): void {
    // 2×2 SVD with rotations: F = R(φ) diag(σ1, σ2) R(θ).
    const e = (f00 + f11) / 2, f = (f00 - f11) / 2, g = (f10 + f01) / 2, h = (f10 - f01) / 2;
    const q = Math.hypot(e, h), r = Math.hypot(f, g);
    const s1 = q + r, s2 = q - r;
    const a1 = Math.atan2(g, f), a2 = Math.atan2(h, e);
    const theta = (a2 - a1) / 2, phi = (a2 + a1) / 2;
    const cu = Math.cos(phi), su = Math.sin(phi), cv = Math.cos(theta), sv = Math.sin(theta);
    const J = s1 * s2;
    const c = mu - lam * Math.log(J);
    const twist = mu - c / J;
    const flip = mu + c / J;
    const h11 = mu + (c + lam) / (s1 * s1);
    const h22 = mu + (c + lam) / (s2 * s2);
    const h12 = lam / J;
    // Eigenpairs of the symmetric scaling block [[h11, h12], [h12, h22]].
    const mean = (h11 + h22) / 2, diff = (h11 - h22) / 2;
    const rad = Math.hypot(diff, h12);
    const l1 = mean + rad, l2 = mean - rad;
    const ang = Math.atan2(h12, diff) / 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    out.fill(0);
    const k = Math.SQRT1_2;
    addMode(out, twist, cu, su, cv, sv, 0, -k, k, 0);
    addMode(out, flip, cu, su, cv, sv, 0, k, k, 0);
    addMode(out, l1, cu, su, cv, sv, ca, 0, 0, sa);
    addMode(out, l2, cu, su, cv, sv, -sa, 0, 0, ca);
}

const modeVec = new Float64Array(4);

/** out += λ vec(M) vec(M)ᵀ for M = R(φ) X R(θ), skipped when λ ≤ 0. */
function addMode(
    out: Float64Array, lambda: number, cu: number, su: number, cv: number, sv: number,
    x00: number, x01: number, x10: number, x11: number,
): void {
    if (lambda <= 0) return;
    const m00 = cu * x00 - su * x10, m01 = cu * x01 - su * x11;
    const m10 = su * x00 + cu * x10, m11 = su * x01 + cu * x11;
    const v = modeVec;
    v[0] = m00 * cv + m01 * sv;
    v[1] = -m00 * sv + m01 * cv;
    v[2] = m10 * cv + m11 * sv;
    v[3] = -m10 * sv + m11 * cv;
    for (let i = 0; i < 4; i++) {
        const a = lambda * v[i];
        for (let j = 0; j < 4; j++) out[4 * i + j] += a * v[j];
    }
}
