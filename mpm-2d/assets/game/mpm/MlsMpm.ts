import { GUARDIAN, LIQUID, type MpmWorld, SAND, wallKeep } from './MpmWorld';
import { plasticity, recompose, svd2 } from './Svd2';

const svd = new Float64Array(6);
const m4 = new Float64Array(4);

/**
 * One explicit MLS-MPM substep (Hu et al. 2018, APIC transfers, quadratic
 * B-splines): stress is scattered as a momentum change together with the
 * affine velocity (P2G), the grid integrates gravity and walls, and particles
 * gather the new velocity and its gradient (G2P). Explicit stress means dt
 * must stay below roughly one cell over the material's wave speed; above that
 * it blows up, which `world.blewUp` reports.
 */
export function mlsStep(world: MpmWorld, dt: number): void {
    const g = world.gridA;
    g.fill(0);
    p2g(world, g, dt);
    gridUpdate(world, g, dt);
    g2p(world, g, dt);
}

function p2g(world: MpmWorld, g: Float64Array, dt: number): void {
    const prm = world.params;
    const W = world.width;
    const n = world.count;
    const { px, py, vx, vy, f00, f01, f10, f11, c00, c01, c10, c11, jac, mass, volume, material } = world;
    const row = W * 4;
    const E = prm.youngModulus;
    const nu = prm.poisson;
    const mu = E / (2 * (1 + nu));
    const lambda = (E * nu) / ((1 + nu) * (1 - 2 * nu));
    const bulk = prm.bulkModulus;

    for (let p = 0; p < n; p++) {
        const x = px[p];
        const y = py[p];
        const cx = x | 0;
        const cy = y | 0;
        const fx = x - cx;
        const fy = y - cy;
        const qx = fx - 0.5;
        const qy = fy - 0.5;
        const wx0 = 0.5 * (0.5 - qx) * (0.5 - qx);
        const wx1 = 0.75 - qx * qx;
        const wx2 = 0.5 * (0.5 + qx) * (0.5 + qx);
        const wy0 = 0.5 * (0.5 - qy) * (0.5 - qy);
        const wy1 = 0.75 - qy * qy;
        const wy2 = 0.5 * (0.5 + qy) * (0.5 + qy);
        const ox0 = -0.5 - fx;
        const ox1 = 0.5 - fx;
        const ox2 = 1.5 - fx;
        const oy0 = -0.5 - fy;
        const oy1 = 0.5 - fy;
        const oy2 = 1.5 - fy;
        const base = ((cy - 1) * W + (cx - 1)) * 4;
        const mat = material[p];
        const m = mass[p];

        // Kirchhoff stress τ.
        let t00: number;
        let t01: number;
        let t10: number;
        let t11: number;
        if (mat === LIQUID) {
            t00 = bulk * (jac[p] - 1);
            t01 = 0;
            t10 = 0;
            t11 = t00;
        } else if (mat === SAND) {
            // Hencky (log strain) elasticity: τ = U (2μ ln Σ + λ tr(ln Σ)) Uᵀ.
            svd2(f00[p], f01[p], f10[p], f11[p], svd);
            const l0 = Math.log(Math.max(Math.abs(svd[2]), 1e-6));
            const l1 = Math.log(Math.max(Math.abs(svd[3]), 1e-6));
            const s0 = 2 * mu * l0 + lambda * (l0 + l1);
            const s1 = 2 * mu * l1 + lambda * (l0 + l1);
            const c = svd[0];
            const s = svd[1];
            t00 = c * c * s0 + s * s * s1;
            t01 = c * s * (s0 - s1);
            t10 = t01;
            t11 = s * s * s0 + c * c * s1;
        } else {
            // Fixed corotated: τ = 2μ (F − R) Fᵀ + λ (J − 1) J I.
            const a00 = f00[p];
            const a01 = f01[p];
            const a10 = f10[p];
            const a11 = f11[p];
            const e = (a00 + a11) * 0.5;
            const h = (a10 - a01) * 0.5;
            const q = Math.sqrt(e * e + h * h);
            const c = q > 1e-12 ? e / q : 1;
            const s = q > 1e-12 ? h / q : 0;
            const g00 = a00 - c;
            const g01 = a01 + s;
            const g10 = a10 - s;
            const g11 = a11 - c;
            const J = a00 * a11 - a01 * a10;
            const vol = lambda * (J - 1) * J;
            t00 = 2 * mu * (g00 * a00 + g01 * a01) + vol;
            t01 = 2 * mu * (g00 * a10 + g01 * a11);
            t10 = 2 * mu * (g10 * a00 + g11 * a01);
            t11 = 2 * mu * (g10 * a10 + g11 * a11) + vol;
        }
        // Affine momentum A = −dt V 4 τ + m C, scattered as m w v + w A (xᵢ − xₚ).
        const k = -dt * volume[p] * 4;
        const A00 = k * t00 + m * c00[p];
        const A01 = k * t01 + m * c01[p];
        const A10 = k * t10 + m * c10[p];
        const A11 = k * t11 + m * c11[p];
        const mvx = m * vx[p];
        const mvy = m * vy[p];
        for (let j = 0, q = base; j < 3; j++, q += row) {
            const wj = j === 0 ? wy0 : j === 1 ? wy1 : wy2;
            const oj = j === 0 ? oy0 : j === 1 ? oy1 : oy2;
            const ax = mvx + A01 * oj;
            const ay = mvy + A11 * oj;
            const mj = wj * m;
            let w = wx0 * wj;
            g[q] += w * (ax + A00 * ox0);
            g[q + 1] += w * (ay + A10 * ox0);
            g[q + 2] += wx0 * mj;
            w = wx1 * wj;
            g[q + 4] += w * (ax + A00 * ox1);
            g[q + 5] += w * (ay + A10 * ox1);
            g[q + 6] += wx1 * mj;
            w = wx2 * wj;
            g[q + 8] += w * (ax + A00 * ox2);
            g[q + 9] += w * (ay + A10 * ox2);
            g[q + 10] += wx2 * mj;
        }
    }
}

function g2p(world: MpmWorld, g: Float64Array, dt: number): void {
    const prm = world.params;
    const W = world.width;
    const n = world.count;
    const { px, py, vx, vy, f00, f01, f10, f11, c00, c01, c10, c11, jac, logJp, material } = world;
    const row = W * 4;
    const lo = GUARDIAN;
    const hiX = W - GUARDIAN - 1;
    const hiY = world.height - GUARDIAN - 1;
    const pointer = world.pointer;
    const pointerR2 = pointer.radius * pointer.radius;
    const pushSpeed = (500 * W) / 128;
    const maxSpeed = 1 / dt;

    for (let p = 0; p < n; p++) {
        const x = px[p];
        const y = py[p];
        const cx = x | 0;
        const cy = y | 0;
        const fx = x - cx;
        const fy = y - cy;
        const qx = fx - 0.5;
        const qy = fy - 0.5;
        const wx0 = 0.5 * (0.5 - qx) * (0.5 - qx);
        const wx1 = 0.75 - qx * qx;
        const wx2 = 0.5 * (0.5 + qx) * (0.5 + qx);
        const wy0 = 0.5 * (0.5 - qy) * (0.5 - qy);
        const wy1 = 0.75 - qy * qy;
        const wy2 = 0.5 * (0.5 + qy) * (0.5 + qy);
        const u0 = wx0 * (-0.5 - fx);
        const u1 = wx1 * (0.5 - fx);
        const u2 = wx2 * (1.5 - fx);
        const base = ((cy - 1) * W + (cx - 1)) * 4;
        let sx = 0;
        let sy = 0;
        let b00 = 0;
        let b01 = 0;
        let b10 = 0;
        let b11 = 0;
        for (let j = 0, k = base; j < 3; j++, k += row) {
            const wj = j === 0 ? wy0 : j === 1 ? wy1 : wy2;
            const oj = j - 0.5 - fy;
            const ax0 = g[k];
            const ay0 = g[k + 1];
            const ax1 = g[k + 4];
            const ay1 = g[k + 5];
            const ax2 = g[k + 8];
            const ay2 = g[k + 9];
            const rx = wj * (wx0 * ax0 + wx1 * ax1 + wx2 * ax2);
            const ry = wj * (wx0 * ay0 + wx1 * ay1 + wx2 * ay2);
            sx += rx;
            sy += ry;
            b00 += wj * (u0 * ax0 + u1 * ax1 + u2 * ax2);
            b10 += wj * (u0 * ay0 + u1 * ay1 + u2 * ay2);
            b01 += rx * oj;
            b11 += ry * oj;
        }
        const d00 = b00 * 4;
        const d01 = b01 * 4;
        const d10 = b10 * 4;
        const d11 = b11 * 4;
        c00[p] = d00;
        c01[p] = d01;
        c10[p] = d10;
        c11[p] = d11;

        const mat = material[p];
        if (mat === LIQUID) {
            jac[p] = Math.min(Math.max(jac[p] * (1 + dt * (d00 + d11)), 0.05), 20);
        } else {
            const a00 = f00[p];
            const a01 = f01[p];
            const a10 = f10[p];
            const a11 = f11[p];
            const e00 = 1 + dt * d00;
            const e01 = dt * d01;
            const e10 = dt * d10;
            const e11 = 1 + dt * d11;
            svd2(e00 * a00 + e01 * a10, e00 * a01 + e01 * a11, e10 * a00 + e11 * a10, e10 * a01 + e11 * a11, svd);
            svd[2] = Math.min(Math.max(svd[2], 0.1), 1e4);
            svd[3] = Math.min(Math.max(svd[3], 0.1), 1e4);
            logJp[p] = plasticity(mat, svd, logJp[p], prm.frictionAngle, prm.elasticityRatio, prm.plasticity);
            recompose(svd, svd[2], svd[3], m4);
            f00[p] = m4[0];
            f01[p] = m4[1];
            f10[p] = m4[2];
            f11[p] = m4[3];
        }

        let nx = x + sx * dt;
        let ny = y + sy * dt;
        if (pointer.active) {
            const ex = nx - pointer.x;
            const ey = ny - pointer.y;
            const e2 = ex * ex + ey * ey;
            if (e2 < pointerR2) {
                if (pointer.mode === 'grab') {
                    sx = pointer.vx;
                    sy = pointer.vy;
                } else {
                    const len = Math.max(Math.sqrt(e2), 1e-4);
                    sx += (ex / len) * pushSpeed;
                    sy += (ey / len) * pushSpeed;
                }
            }
        }
        // Past one cell per step the stencil no longer covers the motion: the step has blown up.
        const v2 = sx * sx + sy * sy;
        if (!(v2 <= maxSpeed * maxSpeed)) {
            const s = v2 > 0 && Number.isFinite(v2) ? maxSpeed / Math.sqrt(v2) : 0;
            sx *= s;
            sy *= s;
            world.blewUp = true;
            if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
                nx = x;
                ny = y;
            }
        }
        vx[p] = sx;
        vy[p] = sy;
        px[p] = nx < lo ? lo : nx > hiX ? hiX : nx;
        py[p] = ny < lo ? lo : ny > hiY ? hiY : ny;
    }
}

function gridUpdate(world: MpmWorld, g: Float64Array, dt: number): void {
    const W = world.width;
    const H = world.height;
    const lo = GUARDIAN + 1;
    const hiX = W - GUARDIAN - 2;
    const hiY = H - GUARDIAN - 2;
    const keep = wallKeep(world.params.borderFriction, dt);
    const gdt = H * world.params.gravity * dt;
    for (let j = 0, k = 0; j < H; j++) {
        for (let i = 0; i < W; i++, k += 4) {
            const m = g[k + 2];
            if (m < 1e-5) {
                g[k] = 0;
                g[k + 1] = 0;
                continue;
            }
            let vx = g[k] / m;
            let vy = g[k + 1] / m - gdt;
            // Separating walls: stop motion into the wall band only, with friction while in contact.
            if ((i < lo && vx < 0) || (i > hiX && vx > 0)) {
                vx = 0;
                vy *= keep;
            }
            if ((j < lo && vy < 0) || (j > hiY && vy > 0)) {
                vy = 0;
                vx *= keep;
            }
            g[k] = vx;
            g[k + 1] = vy;
        }
    }
}
