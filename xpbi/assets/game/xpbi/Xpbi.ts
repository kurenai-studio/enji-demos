/**
 * XPBI (Yu, Li, Lan, Yang & Jiang, SIGGRAPH Asia 2024): velocity-based XPBD
 * with Wendland kernels, Bonet–Lok gradient correction, updated-Lagrangian F,
 * and plasticity inside the Gauss–Seidel loop.
 */
import { correctedGrad, correctionL, wendland } from './Kernel';
import { CLAY, JELLY, returnMap, SAND, SNOW, snowHardening, stvk } from './Svd2';
import { PAD, type World } from './World';

const P = new Float64Array(4);
const F = new Float64Array(4);
const g = [0, 0];
const gx: number[] = [];
const gy: number[] = [];
const ids: number[] = [];

export class Neighbors {
    head: Int32Array;
    next: Int32Array;
    cols: Int32Array;
    rowStart: Int32Array;
    cellW: number;
    cellH: number;
    h: number;
    originX = 0;
    originY = 0;

    constructor() {
        this.head = new Int32Array(1);
        this.next = new Int32Array(1);
        this.cols = new Int32Array(1);
        this.rowStart = new Int32Array(1);
        this.cellW = 1;
        this.cellH = 1;
        this.h = 1;
    }

    build(w: World): void {
        const n = w.count, h = w.h;
        this.h = h;
        this.originX = -h;
        this.originY = -h;
        this.cellW = Math.max(1, Math.ceil((w.width + 2 * h) / h));
        this.cellH = Math.max(1, Math.ceil((w.height + 2 * h) / h));
        const cells = this.cellW * this.cellH;
        if (this.head.length < cells) this.head = new Int32Array(cells);
        if (this.next.length < n) this.next = new Int32Array(n);
        this.head.fill(-1);
        for (let i = 0; i < n; i++) {
            const c = this.cell(w.px[i], w.py[i]);
            this.next[i] = this.head[c];
            this.head[c] = i;
        }
        if (this.rowStart.length < n + 1) this.rowStart = new Int32Array(n + 1);
        let nnz = 0;
        this.rowStart[0] = 0;
        const estimate = n * 16;
        if (this.cols.length < estimate) this.cols = new Int32Array(estimate);
        for (let p = 0; p < n; p++) {
            const x = w.px[p], y = w.py[p];
            const cx = Math.floor((x - this.originX) / h);
            const cy = Math.floor((y - this.originY) / h);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const u = cx + dx, v = cy + dy;
                if (u < 0 || v < 0 || u >= this.cellW || v >= this.cellH) continue;
                for (let b = this.head[v * this.cellW + u]; b >= 0; b = this.next[b]) {
                    if (b === p) continue;
                    const rx = w.px[b] - x, ry = w.py[b] - y;
                    if (rx * rx + ry * ry >= h * h) continue;
                    if (nnz >= this.cols.length) {
                        const next = new Int32Array(this.cols.length * 2);
                        next.set(this.cols);
                        this.cols = next;
                    }
                    this.cols[nnz++] = b;
                }
            }
            this.rowStart[p + 1] = nnz;
        }
    }

    private cell(x: number, y: number): number {
        const cx = Math.min(this.cellW - 1, Math.max(0, Math.floor((x - this.originX) / this.h)));
        const cy = Math.min(this.cellH - 1, Math.max(0, Math.floor((y - this.originY) / this.h)));
        return cy * this.cellW + cx;
    }
}

export const neighbors = new Neighbors();

function lame(w: World, p: number): { mu: number; lambda: number } {
    let E = w.params.young;
    const m = w.material[p];
    if (m === JELLY) E *= 24;
    else if (m === SNOW) E *= 10;
    else if (m === CLAY) E *= 8;
    E *= harden(w, p);
    const nu = w.params.poisson;
    return { mu: E / (2 * (1 + nu)), lambda: (E * nu) / ((1 + nu) * (1 - 2 * nu)) };
}

function harden(w: World, p: number): number {
    return w.material[p] === SNOW ? snowHardening(w.logJp[p], w.params.snowHardening) : 1;
}

function volume(w: World, p: number): number {
    const j = w.f00[p] * w.f11[p] - w.f01[p] * w.f10[p];
    return w.vol0[p] * Math.max(j, 0.05);
}

function applyPointer(w: World, dt: number): void {
    const ptr = w.pointer;
    if (!ptr.active) return;
    const r2 = ptr.radius * ptr.radius;
    for (let i = 0; i < w.count; i++) {
        const dx = w.px[i] - ptr.x, dy = w.py[i] - ptr.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = 1 - Math.sqrt(d2) / ptr.radius;
        if (ptr.mode === 'grab') {
            w.vx[i] += (ptr.vx - w.vx[i]) * 0.4 * t;
            w.vy[i] += (ptr.vy - w.vy[i]) * 0.4 * t;
        } else {
            const d = Math.sqrt(d2) + 1e-8;
            w.vx[i] += (dx / d) * 8 * t * dt;
            w.vy[i] += (dy / d) * 8 * t * dt;
        }
    }
}

function walls(w: World, dt: number): void {
    const xmin = PAD, xmax = w.width - PAD, ymin = PAD, ymax = w.height - PAD;
    const mu = 0.4;
    for (let i = 0; i < w.count; i++) {
        let x = w.x0[i] + dt * w.vx[i];
        let y = w.y0[i] + dt * w.vy[i];
        if (x < xmin) {
            const vn = w.vx[i];
            w.vx[i] = (xmin - w.x0[i]) / dt;
            w.vy[i] -= Math.sign(w.vy[i]) * Math.min(Math.abs(w.vy[i]), mu * Math.abs(vn - w.vx[i]));
            x = xmin;
        } else if (x > xmax) {
            const vn = w.vx[i];
            w.vx[i] = (xmax - w.x0[i]) / dt;
            w.vy[i] -= Math.sign(w.vy[i]) * Math.min(Math.abs(w.vy[i]), mu * Math.abs(vn - w.vx[i]));
        }
        if (y < ymin) {
            const vn = w.vy[i];
            w.vy[i] = (ymin - w.y0[i]) / dt;
            w.vx[i] -= Math.sign(w.vx[i]) * Math.min(Math.abs(w.vx[i]), mu * Math.abs(vn - w.vy[i]));
        } else if (y > ymax) {
            w.vy[i] = (ymax - w.y0[i]) / dt;
        }
    }
}

function velocityGradient(w: World, p: number, g00: { v: number }, g01: { v: number }, g10: { v: number }, g11: { v: number }): void {
    const start = neighbors.rowStart[p], end = neighbors.rowStart[p + 1];
    const l = p * 4;
    let a = 0, b = 0, c = 0, d = 0;
    for (let e = start; e < end; e++) {
        const q = neighbors.cols[e];
        correctedGrad(w.L[l], w.L[l + 1], w.L[l + 2], w.L[l + 3], w.x0[q] - w.x0[p], w.y0[q] - w.y0[p], w.h, g);
        const v = w.vol[q];
        a += v * (w.vx[q] - w.vx[p]) * g[0];
        b += v * (w.vx[q] - w.vx[p]) * g[1];
        c += v * (w.vy[q] - w.vy[p]) * g[0];
        d += v * (w.vy[q] - w.vy[p]) * g[1];
    }
    g00.v = a; g01.v = b; g10.v = c; g11.v = d;
}

const G00 = { v: 0 }, G01 = { v: 0 }, G10 = { v: 0 }, G11 = { v: 0 };

function solveParticle(w: World, p: number, dt: number, implicit: boolean): void {
    velocityGradient(w, p, G00, G01, G10, G11);
    const fn00 = w.fn00[p], fn01 = w.fn01[p], fn10 = w.fn10[p], fn11 = w.fn11[p];
    F[0] = (1 + dt * G00.v) * fn00 + dt * G01.v * fn10;
    F[1] = (1 + dt * G00.v) * fn01 + dt * G01.v * fn11;
    F[2] = dt * G10.v * fn00 + (1 + dt * G11.v) * fn10;
    F[3] = dt * G10.v * fn01 + (1 + dt * G11.v) * fn11;
    const prm = w.params;
    const mat = w.material[p];
    if (implicit) {
        w.logJp[p] = returnMap(F, mat, w.logJp[p], prm.frictionDeg, prm.cohesion, prm.snowCompression, prm.snowStretch, prm.yieldStress, lame(w, p).mu);
    }
    const { mu, lambda } = lame(w, p);
    const psi = stvk(F[0], F[1], F[2], F[3], mu, lambda, P);
    const C = Math.sqrt(Math.max(2 * psi, 0));
    if (C < 1e-8) return;
    const dCdF00 = P[0] / C, dCdF01 = P[1] / C, dCdF10 = P[2] / C, dCdF11 = P[3] / C;
    // M = (∂C/∂F) F^{n T}
    const m00 = dCdF00 * fn00 + dCdF01 * fn01;
    const m01 = dCdF00 * fn10 + dCdF01 * fn11;
    const m10 = dCdF10 * fn00 + dCdF11 * fn01;
    const m11 = dCdF10 * fn10 + dCdF11 * fn11;
    const start = neighbors.rowStart[p], end = neighbors.rowStart[p + 1];
    const nnb = end - start;
    while (gx.length < nnb + 1) { gx.push(0); gy.push(0); ids.push(0); }
    const lp = p * 4;
    let denom = 0;
    let gpx = 0, gpy = 0;
    for (let k = 0; k < nnb; k++) {
        const q = neighbors.cols[start + k];
        correctedGrad(w.L[lp], w.L[lp + 1], w.L[lp + 2], w.L[lp + 3], w.x0[q] - w.x0[p], w.y0[q] - w.y0[p], w.h, g);
        const s = w.vol[q];
        const bx = s * (m00 * g[0] + m01 * g[1]);
        const by = s * (m10 * g[0] + m11 * g[1]);
        gx[k] = bx; gy[k] = by; ids[k] = q;
        denom += (bx * bx + by * by) / w.mass[q];
        gpx -= bx; gpy -= by;
    }
    gx[nnb] = gpx; gy[nnb] = gpy; ids[nnb] = p;
    denom += (gpx * gpx + gpy * gpy) / w.mass[p];
    const alphaTilde = (1 / w.vol0[p]) / (dt * dt);
    denom += alphaTilde;
    if (denom < 1e-18) return;
    const dlam = (-C - alphaTilde * w.lambda[p]) / denom;
    w.lambda[p] += dlam;
    const k = dlam / dt;
    for (let i = 0; i <= nnb; i++) {
        const q = ids[i];
        const invM = 1 / w.mass[q];
        w.vx[q] += invM * gx[i] * k;
        w.vy[q] += invM * gy[i] * k;
    }
}

function positionCorrection(w: World, dt: number): void {
    const rest = 0.75 * w.radius;
    const n = w.count;
    for (let p = 0; p < n; p++) {
        const start = neighbors.rowStart[p], end = neighbors.rowStart[p + 1];
        for (let e = start; e < end; e++) {
            const q = neighbors.cols[e];
            if (q <= p) continue;
            const ax = w.x0[p] + dt * w.vx[p], ay = w.y0[p] + dt * w.vy[p];
            const bx = w.x0[q] + dt * w.vx[q], by = w.y0[q] + dt * w.vy[q];
            const dx = ax - bx, dy = ay - by;
            const dist = Math.hypot(dx, dy);
            const C = dist - rest;
            if (C >= 0 || dist < 1e-12) continue;
            const nx = dx / dist, ny = dy / dist;
            const wsum = 1 / w.mass[p] + 1 / w.mass[q];
            const dlam = -C / wsum;
            const s = dlam / dt;
            w.vx[p] += (nx * s) / w.mass[p];
            w.vy[p] += (ny * s) / w.mass[p];
            w.vx[q] -= (nx * s) / w.mass[q];
            w.vy[q] -= (ny * s) / w.mass[q];
        }
    }
}

function xsph(w: World): void {
    const c = w.params.xsph;
    if (c === 0) return;
    const n = w.count;
    const dvx = new Float64Array(n), dvy = new Float64Array(n);
    for (let p = 0; p < n; p++) {
        const start = neighbors.rowStart[p], end = neighbors.rowStart[p + 1];
        let ax = 0, ay = 0;
        for (let e = start; e < end; e++) {
            const q = neighbors.cols[e];
            const W = wendland(Math.hypot(w.x0[q] - w.x0[p], w.y0[q] - w.y0[p]), w.h);
            ax += w.vol[q] * (w.vx[q] - w.vx[p]) * W;
            ay += w.vol[q] * (w.vy[q] - w.vy[p]) * W;
        }
        dvx[p] = c * ax; dvy[p] = c * ay;
    }
    for (let p = 0; p < n; p++) { w.vx[p] += dvx[p]; w.vy[p] += dvy[p]; }
}

function commitF(w: World, dt: number, implicit: boolean): void {
    const prm = w.params;
    for (let p = 0; p < w.count; p++) {
        velocityGradient(w, p, G00, G01, G10, G11);
        const fn00 = w.fn00[p], fn01 = w.fn01[p], fn10 = w.fn10[p], fn11 = w.fn11[p];
        F[0] = (1 + dt * G00.v) * fn00 + dt * G01.v * fn10;
        F[1] = (1 + dt * G00.v) * fn01 + dt * G01.v * fn11;
        F[2] = dt * G10.v * fn00 + (1 + dt * G11.v) * fn10;
        F[3] = dt * G10.v * fn01 + (1 + dt * G11.v) * fn11;
        w.logJp[p] = returnMap(F, w.material[p], w.logJp[p], prm.frictionDeg, prm.cohesion, prm.snowCompression, prm.snowStretch, prm.yieldStress, lame(w, p).mu);
        w.f00[p] = F[0]; w.f01[p] = F[1]; w.f10[p] = F[2]; w.f11[p] = F[3];
        void implicit;
    }
}

/** One XPBI substep of size dt. `implicit` runs Z inside the XPBD loop. */
export function xpbiStep(w: World, dt: number, implicit: boolean): void {
    const n = w.count;
    w.x0.set(w.px.subarray(0, n));
    w.y0.set(w.py.subarray(0, n));
    w.fn00.set(w.f00.subarray(0, n));
    w.fn01.set(w.f01.subarray(0, n));
    w.fn10.set(w.f10.subarray(0, n));
    w.fn11.set(w.f11.subarray(0, n));
    for (let p = 0; p < n; p++) w.vol[p] = volume(w, p);
    neighbors.build(w);
    for (let p = 0; p < n; p++) {
        const start = neighbors.rowStart[p];
        correctionL(w.x0[p], w.y0[p], neighbors.cols, neighbors.rowStart[p + 1] - start, start, w.x0, w.y0, w.vol, w.h, w.L, p * 4);
        w.lambda[p] = 0;
        w.vy[p] -= w.params.gravity * dt;
    }
    applyPointer(w, dt);
    const iters = w.params.iterations;
    for (let it = 0; it < iters; it++) {
        for (let p = 0; p < n; p++) solveParticle(w, p, dt, implicit);
        positionCorrection(w, dt);
        walls(w, dt);
    }
    xsph(w);
    commitF(w, dt, implicit);
    walls(w, dt);
    for (let p = 0; p < n; p++) {
        w.px[p] = Math.min(w.width - PAD, Math.max(PAD, w.x0[p] + dt * w.vx[p]));
        w.py[p] = Math.min(w.height - PAD, Math.max(PAD, w.y0[p] + dt * w.vy[p]));
    }
}

void JELLY; void SAND; void CLAY;
