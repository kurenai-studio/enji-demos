/**
 * Real spherical harmonics up to band 2 (9 coefficients, RGB), used for the
 * irradiance probes. Coefficients are stored as 27 floats: coefficient k of
 * colour channel c at [k * 3 + c].
 *
 * Irradiance from radiance (Ramamoorthi & Hanrahan 2001): E(n) = Σ Â_l L_lm Y_lm(n)
 * with Â_0 = π, Â_1 = 2π/3, Â_2 = π/4. `convolve()` folds Â_l / π into the
 * coefficients, so evaluating them gives E/π and a diffuse surface of albedo ρ
 * shades as ρ · eval(n).
 */

export const SH_COEFFS = 9;

/** Writes the 9 basis values for unit direction (x, y, z) into out. */
export function shBasis(x: number, y: number, z: number, out: Float64Array | Float32Array): void {
    out[0] = 0.282095;
    out[1] = 0.488603 * y;
    out[2] = 0.488603 * z;
    out[3] = 0.488603 * x;
    out[4] = 1.092548 * x * y;
    out[5] = 1.092548 * y * z;
    out[6] = 0.315392 * (3 * z * z - 1);
    out[7] = 1.092548 * x * z;
    out[8] = 0.546274 * (x * x - y * y);
}

/** Band of each coefficient. */
export const SH_BAND = [0, 1, 1, 1, 2, 2, 2, 2, 2];
const A_OVER_PI = [1, 2 / 3, 1 / 4];

/** Radiance coefficients → coefficients whose evaluation is irradiance / π. In place. */
export function convolve(sh: Float64Array | Float32Array): void {
    for (let k = 0; k < SH_COEFFS; k++) {
        const a = A_OVER_PI[SH_BAND[k]];
        sh[k * 3] *= a;
        sh[k * 3 + 1] *= a;
        sh[k * 3 + 2] *= a;
    }
}

const basis = new Float64Array(SH_COEFFS);

/** Evaluates RGB coefficients in direction (x, y, z). */
export function shEval(sh: ArrayLike<number>, x: number, y: number, z: number, out: [number, number, number]): void {
    shBasis(x, y, z, basis);
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < SH_COEFFS; k++) {
        r += sh[k * 3] * basis[k];
        g += sh[k * 3 + 1] * basis[k];
        b += sh[k * 3 + 2] * basis[k];
    }
    out[0] = Math.max(0, r);
    out[1] = Math.max(0, g);
    out[2] = Math.max(0, b);
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
