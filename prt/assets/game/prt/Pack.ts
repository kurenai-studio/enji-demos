/**
 * Layouts of the two RGBA32F textures the PRT vertex shader reads
 * (prt-common.chunk mirrors this file).
 *
 * Transfer texture: 21 texels per vertex, VERTS_PER_ROW vertices per row.
 *   Texel c · 7 + j of a vertex holds channel c's coefficients 4j … 4j + 3
 *   (the 28th slot is zero).
 * Light texture: one row of 21 texels, the same layout for the light's
 *   coefficients, so each channel is seven vec4 dot products.
 */
import { RGB_STRIDE } from './Bake';
import { COEFFS } from './SH';

export const GROUPS = Math.ceil(COEFFS / 4);
export const TEXELS_PER_VERTEX = GROUPS * 3;
export const VERTS_PER_ROW = 48;
export const TRANSFER_WIDTH = TEXELS_PER_VERTEX * VERTS_PER_ROW;

export function transferRows(vertices: number): number {
    return Math.max(1, Math.ceil(vertices / VERTS_PER_ROW));
}

/** RGB transfer (k · 3 + c per vertex) → texture data. */
export function packTransfer(rgb: Float32Array, vertices: number, out: Float32Array): void {
    for (let v = 0; v < vertices; v++) {
        const row = Math.floor(v / VERTS_PER_ROW), col = (v % VERTS_PER_ROW) * TEXELS_PER_VERTEX;
        const base = (row * TRANSFER_WIDTH + col) * 4, src = v * RGB_STRIDE;
        for (let c = 0; c < 3; c++) for (let k = 0; k < GROUPS * 4; k++) {
            out[base + (c * GROUPS + (k >> 2)) * 4 + (k & 3)] = k < COEFFS ? rgb[src + k * 3 + c] : 0;
        }
    }
}

/** RGB light coefficients (k · 3 + c) → the light texture's 21 texels. */
export function packLight(sh: ArrayLike<number>, out: Float32Array): void {
    for (let c = 0; c < 3; c++) for (let k = 0; k < GROUPS * 4; k++) {
        out[(c * GROUPS + (k >> 2)) * 4 + (k & 3)] = k < COEFFS ? sh[k * 3 + c] : 0;
    }
}

/** What the vertex shader computes for vertex v. */
export function shadeFromTextures(transfer: Float32Array, light: Float32Array, v: number, out: number[]): void {
    const row = Math.floor(v / VERTS_PER_ROW), col = (v - row * VERTS_PER_ROW) * TEXELS_PER_VERTEX;
    for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < GROUPS; j++) {
            const t = (row * TRANSFER_WIDTH + col + c * GROUPS + j) * 4, l = (c * GROUPS + j) * 4;
            for (let e = 0; e < 4; e++) sum += transfer[t + e] * light[l + e];
        }
        out[c] = sum;
    }
}
