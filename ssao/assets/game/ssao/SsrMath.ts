/**
 * The screen-space reflection tracer in plain TypeScript, line for line what
 * ssr-trace.effect does, so tools/test.mts can run it on analytic G-buffers.
 * Keep the two in sync: the shader is the one that ships.
 */
import { bayer4, type GBuffer } from './AoMath';

export interface SsrSettings {
    /** Ray marching steps per pixel; the stride is chosen so they cover the ray's on-screen length. */
    steps: number;
    /** Bisection steps after the first crossing (0: take the crossing step as is). */
    refine: number;
    /** A surface is taken to be this thick (metres) behind its stored depth. */
    thickness: number;
    /** Longest reflection ray, metres. */
    maxDistance: number;
}

export interface SsrResult {
    /** Hit position in G-buffer texture coordinates (0..1), valid when confidence > 0. */
    u: number;
    v: number;
    /** 0 miss, 1 a solid hit; fades towards screen edges and the end of the ray. */
    confidence: number;
    /** Steps taken before the hit or the end. */
    steps: number;
}

/** Rays stop this far in front of the camera. */
export const NEAR = 0.1;
/** Hits within this fraction of the screen from an edge fade out. */
export const EDGE_FADE = 0.1;

/** Depth the G-buffer stores at texel (x, y); `far` and beyond is sky. */
function depthAt(g: GBuffer, x: number, y: number): number {
    return g.depth[Math.min(g.height - 1, Math.max(0, y)) * g.width + Math.min(g.width - 1, Math.max(0, x))];
}

function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
}

/**
 * Traces the mirror reflection of the view ray at texel (x, y), after
 * McGuire & Mara 2014 ("Efficient GPU screen-space ray tracing"): the ray is
 * projected to a 2D segment in texels, clipped to the screen, and walked
 * along its major axis; 1 / depth is linear in screen space, so the ray's
 * depth at each step comes from one add. A step hits when the ray passes
 * behind the stored surface by no more than `thickness`; bisection then
 * finds the crossing within a fraction of a step.
 */
export function traceReflection(g: GBuffer, x: number, y: number, s: SsrSettings, out: SsrResult): void {
    out.confidence = 0;
    out.steps = 0;
    const W = g.width, H = g.height;
    const k = y * W + x;
    const d = g.depth[k];
    if (d >= g.far * 0.999) return;
    const u = (x + 0.5) / W, v = (y + 0.5) / H;
    const px = (u * 2 - 1) * g.tanX * d, py = (v * 2 - 1) * g.tanY * d, pz = -d;
    const nx = g.nx[k], ny = g.ny[k], nz = g.nz[k];
    const il = 1 / Math.hypot(px, py, pz);
    const vx = px * il, vy = py * il, vz = pz * il;
    const vn = vx * nx + vy * ny + vz * nz;
    const rx = vx - 2 * vn * nx, ry = vy - 2 * vn * ny, rz = vz - 2 * vn * nz;

    // End point, clipped to the near plane.
    let len = s.maxDistance;
    if (pz + rz * len > -NEAR) len = (-NEAR - pz) / rz;
    const qx = px + rx * len, qy = py + ry * len, qz = pz + rz * len;

    // Both ends in texels; k = 1 / depth.
    const k0 = 1 / -pz;
    let k1 = 1 / -qz;
    const p0x = ((px * k0) / g.tanX * 0.5 + 0.5) * W, p0y = ((py * k0) / g.tanY * 0.5 + 0.5) * H;
    let p1x = ((qx * k1) / g.tanX * 0.5 + 0.5) * W, p1y = ((qy * k1) / g.tanY * 0.5 + 0.5) * H;

    // Clip the far end to the screen; k stays linear along the segment.
    let t = 1;
    const ex = p1x - p0x, ey = p1y - p0y;
    if (p1x < 0) t = Math.min(t, -p0x / ex);
    if (p1x > W) t = Math.min(t, (W - p0x) / ex);
    if (p1y < 0) t = Math.min(t, -p0y / ey);
    if (p1y > H) t = Math.min(t, (H - p0y) / ey);
    p1x = p0x + ex * t; p1y = p0y + ey * t;
    k1 = k0 + (k1 - k0) * t;

    // Walk the major axis: a (major), b (minor).
    const permute = Math.abs(p1y - p0y) > Math.abs(p1x - p0x);
    const a0 = permute ? p0y : p0x, b0 = permute ? p0x : p0y;
    const a1 = permute ? p1y : p1x, b1 = permute ? p1x : p1y;
    let da = a1 - a0;
    if (Math.abs(da) < 1e-4) da = 1e-4;
    const span = Math.abs(da);
    const stride = Math.max(1, span / s.steps);
    const dir = Math.sign(da);
    const invDa = 1 / Math.abs(da);
    const stepA = dir * stride;
    const stepB = (b1 - b0) * invDa * stride;
    const stepK = (k1 - k0) * invDa * stride;

    // Start a dithered fraction of a step out, so neighbours sample between each other's steps.
    const j = bayer4(x, y);
    let a = a0 + stepA * j, b = b0 + stepB * j, kk = k0 + stepK * j;
    const n = Math.min(s.steps, Math.ceil(span / stride));
    for (let i = 0; i < n; i++) {
        const pa = a, pb = b, pk = kk;
        a += stepA; b += stepB; kk += stepK;
        out.steps = i + 1;
        if (kk <= 0) return;
        const tx = Math.floor(permute ? b : a), ty = Math.floor(permute ? a : b);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;
        const sd = depthAt(g, tx, ty);
        if (sd >= g.far * 0.999) continue;
        const dPrev = 1 / pk, dCur = 1 / kk;
        const lo = Math.min(dPrev, dCur), hi = Math.max(dPrev, dCur);
        if (!(hi >= sd && lo <= sd + s.thickness)) continue;

        // Bisect between the last step in front and this one.
        let la = pa, lb = pb, lk = pk, ha = a, hb = b, hk = kk;
        for (let r = 0; r < s.refine; r++) {
            const ma = (la + ha) * 0.5, mb = (lb + hb) * 0.5, mk = (lk + hk) * 0.5;
            const mx = Math.floor(permute ? mb : ma), my = Math.floor(permute ? ma : mb);
            if (1 / mk >= depthAt(g, mx, my)) { ha = ma; hb = mb; hk = mk; } else { la = ma; lb = mb; lk = mk; }
        }
        const hx = permute ? hb : ha, hy = permute ? ha : hb;
        const hu = hx / W, hv = hy / H;
        // The step test spans a whole stride but reads one texel; at the
        // crossing the ray must really be inside the surface's slab, give or
        // take the depth it covers in one texel. Otherwise it passed over.
        const hd = 1 / hk;
        const slack = Math.abs(stepK / stride) * hd * hd;
        const hsd = depthAt(g, Math.floor(hx), Math.floor(hy));
        if (hd < hsd - slack || hd > hsd + s.thickness + slack) continue;
        // A surface facing away from the ray is its back: what is behind it is not on screen.
        const hk2 = Math.min(H - 1, Math.max(0, Math.floor(hy))) * W + Math.min(W - 1, Math.max(0, Math.floor(hx)));
        if (g.nx[hk2] * rx + g.ny[hk2] * ry + g.nz[hk2] * rz > 0) return;
        const edge = Math.min(hu, 1 - hu, hv, 1 - hv);
        const dist = Math.hypot((hu * 2 - 1) * g.tanX * hd - px, (hv * 2 - 1) * g.tanY * hd - py, -hd - pz);
        out.u = hu;
        out.v = hv;
        out.confidence = smoothstep(0, EDGE_FADE, edge) * (1 - smoothstep(0.8 * s.maxDistance, s.maxDistance, dist));
        return;
    }
}
