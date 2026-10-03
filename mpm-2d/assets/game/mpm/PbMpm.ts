//-----------------------------------------------------------------------------
// CPU port of Position Based MPM (Chris Lewin, EA SEED 2024), following the
// reference g2p2g.wgsl. Copyright (c) 2024 Electronic Arts. All rights reserved.
// BSD 3-Clause licence: https://github.com/electronicarts/pbmpm/blob/main/LICENSE.md
//-----------------------------------------------------------------------------
import { GUARDIAN, LIQUID, type MpmWorld, SAND, SNOW, wallKeep } from './MpmWorld';
import { plasticity, recompose, snowHardening, snowPlasticity, svd2 } from './Svd2';

const svd = new Float64Array(6);
/**
 * Weight of the volume-restoring part of the snow target when compressed. The
 * shape part alone only pushes back along the compressed axis, so a snowball
 * packs on impact without spreading; restoring volume pushes it sideways,
 * which is what stretches and tears it. Larger values tear more but let a
 * resting bank pack down further at low budgets.
 */
const SNOW_VOLUME_BLEND = 0.7;
const m4 = new Float64Array(4);

/**
 * One PB-MPM substep. The grid carries displacements, not velocities; each
 * iteration gathers them to the particles (G2P), moves every particle's
 * affine displacement D towards its material constraint, and scatters back
 * (P2G). Iteration 0 only scatters, the last one only gathers and integrates.
 * Stable for any dt: a large step costs accuracy (more damping), not blow-ups.
 */
export function pbStep(world: MpmWorld, dt: number): void {
    const iterations = Math.max(2, world.params.iterations);
    for (let it = 0; it < iterations; it++) {
        const last = it === iterations - 1;
        const src = world.gridA;
        const dst = world.gridB;
        if (it > 0) gridUpdate(world, src, dt);
        if (!last) dst.fill(0);
        pass(world, src, dst, it > 0, last, dt);
        if (!last) {
            world.gridA = dst;
            world.gridB = src;
        }
    }
}

/**
 * One fused G2P → constraint → P2G sweep. Quadratic B-spline weights are
 * separable, so each stencil row of three nodes is reduced with the x weights
 * first and then weighted by its y weight.
 */
function pass(world: MpmWorld, src: Float64Array, dst: Float64Array, gather: boolean, last: boolean, dt: number): void {
    const prm = world.params;
    const W = world.width;
    const n = world.count;
    const { px, py, vx, vy, f00, f01, f10, f11, c00, c01, c10, c11, jac, logJp, mass, volume, material } = world;
    const row = W * 4;
    const liquidRelax = prm.liquidRelaxation;
    const elasticRelax = prm.elasticRelaxation;
    const visc = prm.liquidViscosity;
    const ratio = prm.elasticityRatio;
    const useGridVolume = prm.useGridVolume;

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
        // Node minus particle position; nodes sit at cell centres.
        const ox0 = -0.5 - fx;
        const ox1 = 0.5 - fx;
        const ox2 = 1.5 - fx;
        const oy0 = -0.5 - fy;
        const oy1 = 0.5 - fy;
        const oy2 = 1.5 - fy;
        const base = ((cy - 1) * W + (cx - 1)) * 4;
        const mat = material[p];

        let dX = vx[p];
        let dY = vy[p];
        let d00 = c00[p];
        let d01 = c01[p];
        let d10 = c10[p];
        let d11 = c11[p];

        if (gather) {
            // G2P: displacement and its affine part (APIC), D = 4 Σ w d (xᵢ − xₚ)ᵀ.
            const u0 = wx0 * ox0;
            const u1 = wx1 * ox1;
            const u2 = wx2 * ox2;
            let sx = 0;
            let sy = 0;
            let b00 = 0;
            let b01 = 0;
            let b10 = 0;
            let b11 = 0;
            let gv = 0;
            for (let j = 0, k = base; j < 3; j++, k += row) {
                const wj = j === 0 ? wy0 : j === 1 ? wy1 : wy2;
                const oj = j === 0 ? oy0 : j === 1 ? oy1 : oy2;
                const ax0 = src[k];
                const ay0 = src[k + 1];
                const ax1 = src[k + 4];
                const ay1 = src[k + 5];
                const ax2 = src[k + 8];
                const ay2 = src[k + 9];
                const rx = wj * (wx0 * ax0 + wx1 * ax1 + wx2 * ax2);
                const ry = wj * (wx0 * ay0 + wx1 * ay1 + wx2 * ay2);
                sx += rx;
                sy += ry;
                b00 += wj * (u0 * ax0 + u1 * ax1 + u2 * ax2);
                b10 += wj * (u0 * ay0 + u1 * ay1 + u2 * ay2);
                b01 += rx * oj;
                b11 += ry * oj;
                gv += wj * (wx0 * src[k + 3] + wx1 * src[k + 7] + wx2 * src[k + 11]);
            }
            // Grid volume restores liquid volume lost to shearing, only when compressed.
            if (useGridVolume && mat === LIQUID && gv > 0) {
                const v = 1 / gv;
                if (v < 1) jac[p] += (v - jac[p]) * 0.1;
            }
            dX = sx;
            dY = sy;
            d00 = b00 * 4;
            d01 = b01 * 4;
            d10 = b10 * 4;
            d11 = b11 * 4;
            vx[p] = dX;
            vy[p] = dY;
            c00[p] = d00;
            c01[p] = d01;
            c10[p] = d10;
            c11[p] = d11;
            if (last) {
                integrate(world, p, dt);
                continue;
            }
        }

        // Constraint: move D towards what the material wants, for this scatter only.
        if (mat === LIQUID) {
            const s = d01 + d10;
            d00 -= visc * d00;
            d11 -= visc * d11;
            d01 -= visc * 0.5 * s;
            d10 -= visc * 0.5 * s;
            const alpha = 0.5 * (1 / jac[p] - (d00 + d11) - 1);
            d00 += liquidRelax * alpha;
            d11 += liquidRelax * alpha;
        } else {
            const a00 = f00[p];
            const a01 = f01[p];
            const a10 = f10[p];
            const a11 = f11[p];
            // Trial F = (I + D) F.
            const n00 = (1 + d00) * a00 + d01 * a10;
            const n01 = (1 + d00) * a01 + d01 * a11;
            const n10 = d10 * a00 + (1 + d11) * a10;
            const n11 = d10 * a01 + (1 + d11) * a11;
            const det = n00 * n11 - n01 * n10;
            let t00: number;
            let t01: number;
            let t10: number;
            let t11: number;
            if (mat === SAND) {
                svd2(n00, n01, n10, n11, svd);
                if (logJp[p] === 0) {
                    svd[2] = Math.min(Math.max(svd[2], 1), 1000);
                    svd[3] = Math.min(Math.max(svd[3], 1), 1000);
                }
                recompose(svd, svd[2], svd[3], m4);
                t00 = m4[0];
                t01 = m4[1];
                t10 = m4[2];
                t11 = m4[3];
            } else if (mat === SNOW) {
                // PB-MPM has no stress, so snow's bounded elastic stress becomes a
                // bounded correction: each singular value is pulled towards 1 by at
                // most θ times the hardening (θc compressed, θs stretched), and any
                // deformation past that is left to flow, to be absorbed into Jp.
                // When compressed, part of the target restores volume instead.
                svd2(n00, n01, n10, n11, svd);
                const hard = snowHardening(jac[p], prm.snowHardening);
                const maxStretch = prm.snowStretch * hard;
                const maxCompression = prm.snowCompression * hard;
                const e0 = svd[2] - 1;
                const e1 = svd[3] - 1;
                let s0 = svd[2] - Math.min(Math.max(e0, -maxCompression), maxStretch);
                let s1 = svd[3] - Math.min(Math.max(e1, -maxCompression), maxStretch);
                const J = svd[2] * svd[3];
                if (J < 1) {
                    const blend = SNOW_VOLUME_BLEND * Math.min(1, hard);
                    const vol = Math.sqrt(Math.max(J, 1e-6));
                    s0 = (1 - blend) * s0 + blend * (svd[2] / vol);
                    s1 = (1 - blend) * s1 + blend * (svd[3] / vol);
                }
                recompose(svd, s0, s1, m4);
                t00 = m4[0];
                t01 = m4[1];
                t10 = m4[2];
                t11 = m4[3];
            } else {
                // Rotation of the polar decomposition, in closed form.
                const e = (n00 + n11) * 0.5;
                const h = (n10 - n01) * 0.5;
                const q = Math.sqrt(e * e + h * h);
                const c = q > 1e-12 ? e / q : 1;
                const s = q > 1e-12 ? h / q : 0;
                t00 = c;
                t01 = -s;
                t10 = s;
                t11 = c;
            }
            if (ratio < 1) {
                // Closest det = 1 matrix along F, blended with the shape target.
                const cdf = Math.min(Math.max(Math.abs(det), 0.1), mat === SAND ? 1 : 1000);
                const qs = (1 - ratio) / ((det < 0 ? -1 : 1) * Math.sqrt(cdf));
                t00 = ratio * t00 + qs * n00;
                t01 = ratio * t01 + qs * n01;
                t10 = ratio * t10 + qs * n10;
                t11 = ratio * t11 + qs * n11;
            }
            // D += relaxation × (target F⁻¹ − I − D).
            const inv = 1 / (a00 * a11 - a01 * a10);
            const i00 = a11 * inv;
            const i01 = -a01 * inv;
            const i10 = -a10 * inv;
            const i11 = a00 * inv;
            d00 += elasticRelax * (t00 * i00 + t01 * i10 - 1 - d00);
            d01 += elasticRelax * (t00 * i01 + t01 * i11 - d01);
            d10 += elasticRelax * (t10 * i00 + t11 * i10 - d10);
            d11 += elasticRelax * (t10 * i01 + t11 * i11 - 1 - d11);
            if (mat === SAND) {
                const s = d01 + d10;
                d00 -= visc * d00;
                d11 -= visc * d11;
                d01 -= visc * 0.5 * s;
                d10 -= visc * 0.5 * s;
            }
        }

        // P2G: m w (d + D (xᵢ − xₚ)), plus mass and volume.
        const m = mass[p];
        const vol = volume[p];
        for (let j = 0, k = base; j < 3; j++, k += row) {
            const wj = j === 0 ? wy0 : j === 1 ? wy1 : wy2;
            const oj = j === 0 ? oy0 : j === 1 ? oy1 : oy2;
            const mj = wj * m;
            const vj = wj * vol;
            const ax = dX + d01 * oj;
            const ay = dY + d11 * oj;
            let w = wx0 * mj;
            dst[k] += w * (ax + d00 * ox0);
            dst[k + 1] += w * (ay + d10 * ox0);
            dst[k + 2] += w;
            dst[k + 3] += wx0 * vj;
            w = wx1 * mj;
            dst[k + 4] += w * (ax + d00 * ox1);
            dst[k + 5] += w * (ay + d10 * ox1);
            dst[k + 6] += w;
            dst[k + 7] += wx1 * vj;
            w = wx2 * mj;
            dst[k + 8] += w * (ax + d00 * ox2);
            dst[k + 9] += w * (ay + d10 * ox2);
            dst[k + 10] += w;
            dst[k + 11] += wx2 * vj;
        }
    }
}

/** End of substep for particle p: evolve volume / F with the gathered D, move, then add pointer and gravity to the next displacement. */
function integrate(world: MpmWorld, p: number, dt: number): void {
    const prm = world.params;
    const d00 = world.c00[p];
    const d01 = world.c01[p];
    const d10 = world.c10[p];
    const d11 = world.c11[p];
    const mat = world.material[p];
    if (mat === LIQUID) {
        world.jac[p] = Math.max(world.jac[p] * (d00 + d11 + 1), 0.05);
    } else {
        const a00 = world.f00[p];
        const a01 = world.f01[p];
        const a10 = world.f10[p];
        const a11 = world.f11[p];
        svd2(
            (1 + d00) * a00 + d01 * a10, (1 + d00) * a01 + d01 * a11,
            d10 * a00 + (1 + d11) * a10, d10 * a01 + (1 + d11) * a11, svd);
        // Lower bound keeps F invertible and stops crushed particles from exploding.
        svd[2] = Math.min(Math.max(svd[2], 0.1), 1e4);
        svd[3] = Math.min(Math.max(svd[3], 0.1), 1e4);
        if (mat === SNOW) {
            // Yield stress ∝ hardening in Stomakhin's model; with PB-MPM's fixed
            // stiffness that is a yield strain ∝ hardening, so packed snow keeps
            // a wider elastic window and stops packing once it can carry the load.
            const hard = snowHardening(world.jac[p], prm.snowHardening);
            world.jac[p] = snowPlasticity(svd, world.jac[p], prm.snowCompression * hard, prm.snowStretch * hard);
        }
        else world.logJp[p] = plasticity(mat, svd, world.logJp[p], prm.frictionAngle, prm.elasticityRatio, prm.plasticity);
        recompose(svd, svd[2], svd[3], m4);
        world.f00[p] = m4[0];
        world.f01[p] = m4[1];
        world.f10[p] = m4[2];
        world.f11[p] = m4[3];
    }
    let dX = world.vx[p];
    let dY = world.vy[p];
    const nx = world.px[p] + dX;
    const ny = world.py[p] + dY;
    const pointer = world.pointer;
    if (pointer.active) {
        const ex = nx - pointer.x;
        const ey = ny - pointer.y;
        const e2 = ex * ex + ey * ey;
        if (e2 < pointer.radius * pointer.radius) {
            if (pointer.mode === 'grab') {
                dX = pointer.vx * dt;
                dY = pointer.vy * dt;
            } else {
                const len = Math.max(Math.sqrt(e2), 1e-4);
                const push = (500 * dt * world.width) / 128;
                dX += (ex / len) * push;
                dY += (ey / len) * push;
            }
        }
    }
    world.vx[p] = dX;
    world.vy[p] = dY - world.height * prm.gravity * dt * dt;
    world.px[p] = Math.min(Math.max(nx, world.minX), world.maxX);
    world.py[p] = Math.min(Math.max(ny, world.minY), world.maxY);
}

/** Mass-weights the scattered displacements and stops nodes from moving particles into the guardian band. */
function gridUpdate(world: MpmWorld, g: Float64Array, dt: number): void {
    const W = world.width;
    const H = world.height;
    const lo = GUARDIAN + 1;
    const hiX = W - GUARDIAN - 2;
    const hiY = H - GUARDIAN - 2;
    // Friction compounds over the iterations; split it so a whole substep grips like MLS-MPM's.
    const keep = wallKeep(world.params.borderFriction, dt / Math.max(1, world.params.iterations - 1));
    for (let j = 0, k = 0; j < H; j++) {
        for (let i = 0; i < W; i++, k += 4) {
            const m = g[k + 2];
            if (m < 1e-5) {
                g[k] = 0;
                g[k + 1] = 0;
                continue;
            }
            let dx = g[k] / m;
            let dy = g[k + 1] / m;
            // Separating walls: stop motion into the wall band only, with friction while in contact.
            if ((i < lo && dx < 0) || (i > hiX && dx > 0)) {
                dx = 0;
                dy *= keep;
            }
            if ((j < lo && dy < 0) || (j > hiY && dy > 0)) {
                dy = 0;
                dx *= keep;
            }
            g[k] = dx;
            g[k + 1] = dy;
        }
    }
}
