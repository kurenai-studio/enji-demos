/**
 * Vanilla XPBD sand (Macklin et al. 2014): colliding spheres with friction.
 * No deformation gradient, no continuum yield — the comparison XPBI improves on.
 */
import { PAD, type World } from './World';
import { neighbors } from './Xpbi';

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
    const mu = Math.tan((w.params.frictionDeg * Math.PI) / 180);
    for (let i = 0; i < w.count; i++) {
        let x = w.x0[i] + dt * w.vx[i];
        let y = w.y0[i] + dt * w.vy[i];
        if (x < xmin) { w.vx[i] = (xmin - w.x0[i]) / dt; w.vy[i] *= 0.4; x = xmin; }
        if (x > xmax) { w.vx[i] = (xmax - w.x0[i]) / dt; w.vy[i] *= 0.4; }
        if (y < ymin) {
            w.vy[i] = (ymin - w.y0[i]) / dt;
            w.vx[i] -= Math.sign(w.vx[i]) * Math.min(Math.abs(w.vx[i]), mu * 0.5);
        }
        if (y > ymax) w.vy[i] = (ymax - w.y0[i]) / dt;
        void y;
    }
}

export function vanillaStep(w: World, dt: number): void {
    const n = w.count;
    w.x0.set(w.px.subarray(0, n));
    w.y0.set(w.py.subarray(0, n));
    neighbors.build(w);
    for (let p = 0; p < n; p++) w.vy[p] -= w.params.gravity * dt;
    applyPointer(w, dt);
    const rest = w.radius;
    const mu = Math.tan((w.params.frictionDeg * Math.PI) / 180);
    for (let it = 0; it < w.params.iterations; it++) {
        for (let p = 0; p < n; p++) {
            const start = neighbors.rowStart[p], end = neighbors.rowStart[p + 1];
            for (let e = start; e < end; e++) {
                const q = neighbors.cols[e];
                if (q <= p) continue;
                const ax = w.x0[p] + dt * w.vx[p], ay = w.y0[p] + dt * w.vy[p];
                const bx = w.x0[q] + dt * w.vx[q], by = w.y0[q] + dt * w.vy[q];
                const dx = ax - bx, dy = ay - by;
                const dist = Math.hypot(dx, dy);
                if (dist >= rest || dist < 1e-12) continue;
                const nx = dx / dist, ny = dy / dist;
                const C = dist - rest;
                const wsum = 1 / w.mass[p] + 1 / w.mass[q];
                const dlam = -C / wsum;
                const s = dlam / dt;
                w.vx[p] += nx * s / w.mass[p];
                w.vy[p] += ny * s / w.mass[p];
                w.vx[q] -= nx * s / w.mass[q];
                w.vy[q] -= ny * s / w.mass[q];
                const rvx = w.vx[p] - w.vx[q], rvy = w.vy[p] - w.vy[q];
                const vn = rvx * nx + rvy * ny;
                let tx = rvx - vn * nx, ty = rvy - vn * ny;
                const tlen = Math.hypot(tx, ty);
                if (tlen > 1e-8) {
                    const ft = Math.min(1, (mu * Math.abs(s) * wsum) / tlen);
                    tx *= ft; ty *= ft;
                    w.vx[p] -= tx / 2; w.vy[p] -= ty / 2;
                    w.vx[q] += tx / 2; w.vy[q] += ty / 2;
                }
            }
        }
        walls(w, dt);
    }
    walls(w, dt);
    for (let p = 0; p < n; p++) {
        w.px[p] = Math.min(w.width - PAD, Math.max(PAD, w.x0[p] + dt * w.vx[p]));
        w.py[p] = Math.min(w.height - PAD, Math.max(PAD, w.y0[p] + dt * w.vy[p]));
    }
}
