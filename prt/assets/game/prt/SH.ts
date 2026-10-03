/**
 * Real spherical harmonics, bands 0–4 (25 coefficients), z as the polar axis
 * and no Condon–Shortley phase. Coefficient (l, m) sits at index l² + l + m.
 *
 * Zonal functions: a function symmetric about axis d with Legendre moments
 * k_l = 2π ∫ f(t) P_l(t) dt projects to f_lm = k_l Y_lm(d). Two are closed form:
 *   clamped cosine max(cos θ, 0): k_l = Â_l = π, 2π/3, π/4, 0, −π/24
 *   a cap of half-angle α:        k_0 = 2π(1 − cos α),
 *                                 k_l = 2π (P_{l−1}(cos α) − P_{l+1}(cos α)) / (2l + 1)
 */

export const BANDS = 5;
export const COEFFS = BANDS * BANDS;

/** Band of each coefficient. */
export const BAND_OF: readonly number[] = Array.from({ length: COEFFS }, (_, k) => Math.floor(Math.sqrt(k)));

/** Writes the 25 basis values for unit direction (x, y, z) into out. */
export function basis(x: number, y: number, z: number, out: Float64Array | Float32Array): void {
    const x2 = x * x, y2 = y * y, z2 = z * z;
    out[0] = 0.282094791773878;
    out[1] = 0.48860251190292 * y;
    out[2] = 0.48860251190292 * z;
    out[3] = 0.48860251190292 * x;
    out[4] = 1.092548430592079 * x * y;
    out[5] = 1.092548430592079 * y * z;
    out[6] = 0.31539156525252 * (3 * z2 - 1);
    out[7] = 1.092548430592079 * x * z;
    out[8] = 0.546274215296039 * (x2 - y2);
    out[9] = 0.590043589926644 * y * (3 * x2 - y2);
    out[10] = 2.890611442640554 * x * y * z;
    out[11] = 0.457045799464466 * y * (5 * z2 - 1);
    out[12] = 0.373176332590115 * z * (5 * z2 - 3);
    out[13] = 0.457045799464466 * x * (5 * z2 - 1);
    out[14] = 1.445305721320277 * z * (x2 - y2);
    out[15] = 0.590043589926644 * x * (x2 - 3 * y2);
    out[16] = 2.503342941796705 * x * y * (x2 - y2);
    out[17] = 1.770130769779931 * y * z * (3 * x2 - y2);
    out[18] = 0.94617469575756 * x * y * (7 * z2 - 1);
    out[19] = 0.669046543557289 * y * z * (7 * z2 - 3);
    out[20] = 0.105785546915204 * (35 * z2 * z2 - 30 * z2 + 3);
    out[21] = 0.669046543557289 * x * z * (7 * z2 - 3);
    out[22] = 0.47308734787878 * (x2 - y2) * (7 * z2 - 1);
    out[23] = 1.770130769779931 * x * z * (x2 - 3 * y2);
    out[24] = 0.625835735449176 * (x2 * x2 - 6 * x2 * y2 + y2 * y2);
}

/** Legendre polynomials P_0 … P_n at t. */
export function legendre(t: number, n: number): number[] {
    const p = [1, t];
    for (let l = 1; l < n; l++) p.push(((2 * l + 1) * t * p[l] - l * p[l - 1]) / (l + 1));
    return p.slice(0, n + 1);
}

/** Legendre moments of the clamped cosine, Â_l. */
export const COSINE_LOBE: readonly number[] = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4, 0, -Math.PI / 24];

/** Legendre moments of a unit-radiance cap of half-angle α. */
export function capMoments(alpha: number): number[] {
    const c = Math.cos(alpha);
    const p = legendre(c, BANDS);
    const k = [2 * Math.PI * (1 - c)];
    for (let l = 1; l < BANDS; l++) k.push((2 * Math.PI * (p[l - 1] - p[l + 1])) / (2 * l + 1));
    return k;
}

const scratch = new Float64Array(COEFFS);

/** Adds scale · Σ k_l Y_lm(d) to RGB coefficients out[k * 3 + c]. */
export function addZonal(out: Float64Array, moments: readonly number[], d: readonly number[], rgb: readonly number[]): void {
    basis(d[0], d[1], d[2], scratch);
    for (let k = 0; k < COEFFS; k++) {
        const w = moments[BAND_OF[k]] * scratch[k];
        out[k * 3] += w * rgb[0];
        out[k * 3 + 1] += w * rgb[1];
        out[k * 3 + 2] += w * rgb[2];
    }
}

/**
 * Per-band factors that taper the reconstruction of a light kept to `bands`
 * bands (Sloan, "Stupid SH tricks"): Hann σ_l = (1 + cos(π l / bands)) / 2.
 * Sharp lights ring (negative lobes) when cut off abruptly.
 */
export function hannWindow(bands: number): number[] {
    return Array.from({ length: BANDS }, (_, l) => (l < bands ? (1 + Math.cos((Math.PI * l) / bands)) / 2 : 0));
}

/** Keeps the first `bands` bands, each scaled by window[l]. In place on RGB coefficients. */
export function truncate(sh: Float64Array, bands: number, window: readonly number[] | null): void {
    for (let k = 0; k < COEFFS; k++) {
        const l = BAND_OF[k];
        const w = l >= bands ? 0 : window ? window[l] : 1;
        sh[k * 3] *= w;
        sh[k * 3 + 1] *= w;
        sh[k * 3 + 2] *= w;
    }
}

/** Evaluates RGB coefficients in direction d. */
export function evalRgb(sh: ArrayLike<number>, x: number, y: number, z: number, out: number[]): void {
    basis(x, y, z, scratch);
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < COEFFS; k++) {
        r += sh[k * 3] * scratch[k];
        g += sh[k * 3 + 1] * scratch[k];
        b += sh[k * 3 + 2] * scratch[k];
    }
    out[0] = r; out[1] = g; out[2] = b;
}

/** N directions spread evenly over the sphere (Fibonacci lattice), xyz interleaved. */
export function sphereDirections(n: number): Float64Array {
    const dirs = new Float64Array(n * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(1 - y * y);
        const phi = i * golden;
        dirs[i * 3] = Math.cos(phi) * r;
        dirs[i * 3 + 1] = y;
        dirs[i * 3 + 2] = Math.sin(phi) * r;
    }
    return dirs;
}

/**
 * N cosine-distributed directions about +z (Fibonacci points on the unit disc
 * lifted to the hemisphere, Malley's method), xyz interleaved. With pdf cos θ / π,
 * ∫ g(ω) cos θ dω ≈ (π / N) Σ g(ω_j).
 */
export function cosineDirections(n: number): Float64Array {
    const dirs = new Float64Array(n * 3);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt((i + 0.5) / n);
        const phi = i * golden;
        dirs[i * 3] = Math.cos(phi) * r;
        dirs[i * 3 + 1] = Math.sin(phi) * r;
        dirs[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - r * r));
    }
    return dirs;
}

/** Orthonormal tangent and bitangent for unit normal n (Duff et al. 2017). */
export function tangentFrame(nx: number, ny: number, nz: number, t: number[], b: number[]): void {
    const s = nz >= 0 ? 1 : -1;
    const a = -1 / (s + nz);
    const c = nx * ny * a;
    t[0] = 1 + s * nx * nx * a; t[1] = s * c; t[2] = -s * nx;
    b[0] = c; b[1] = s + ny * ny * a; b[2] = -ny;
}
