/**
 * Optimal Reciprocal Collision Avoidance (van den Berg, Guy, Lin & Manocha
 * 2011), after the RVO2 library. Each neighbour turns into a half-plane of
 * velocities that cannot collide with it within the time horizon, each side
 * taking half the avoidance; the new velocity is the one closest to the
 * preferred velocity inside all half-planes and the speed limit (a 2D linear
 * program). When no velocity satisfies them all, the one that violates them
 * least is taken (linearProgram3).
 */

const EPS = 1e-5;

/** Half-plane: velocities on the left of `direction` through `point` are allowed. */
export interface Line {
    px: number;
    py: number;
    dx: number;
    dy: number;
}

export function makeLines(n: number): Line[] {
    return Array.from({ length: n }, () => ({ px: 0, py: 0, dx: 0, dy: 0 }));
}

const det = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

const result = { x: 0, y: 0 };

function linearProgram1(lines: Line[], lineNo: number, radius: number, optX: number, optY: number, directionOpt: boolean): boolean {
    const L = lines[lineNo];
    const dot = L.px * L.dx + L.py * L.dy;
    const disc = dot * dot + radius * radius - (L.px * L.px + L.py * L.py);
    if (disc < 0) return false;
    const s = Math.sqrt(disc);
    let tLeft = -dot - s, tRight = -dot + s;
    for (let i = 0; i < lineNo; i++) {
        const M = lines[i];
        const den = det(L.dx, L.dy, M.dx, M.dy);
        const num = det(M.dx, M.dy, L.px - M.px, L.py - M.py);
        if (Math.abs(den) <= EPS) {
            if (num < 0) return false;
            continue;
        }
        const t = num / den;
        if (den >= 0) tRight = Math.min(tRight, t);
        else tLeft = Math.max(tLeft, t);
        if (tLeft > tRight) return false;
    }
    let t: number;
    if (directionOpt) t = optX * L.dx + optY * L.dy > 0 ? tRight : tLeft;
    else t = Math.min(tRight, Math.max(tLeft, L.dx * (optX - L.px) + L.dy * (optY - L.py)));
    result.x = L.px + t * L.dx;
    result.y = L.py + t * L.dy;
    return true;
}

/** Returns lines.length on success, else the index of the first line that could not be met. */
function linearProgram2(lines: Line[], count: number, radius: number, optX: number, optY: number, directionOpt: boolean): number {
    if (directionOpt) {
        result.x = optX * radius; result.y = optY * radius;
    } else if (optX * optX + optY * optY > radius * radius) {
        const l = Math.hypot(optX, optY);
        result.x = (optX / l) * radius; result.y = (optY / l) * radius;
    } else {
        result.x = optX; result.y = optY;
    }
    for (let i = 0; i < count; i++) {
        const L = lines[i];
        if (det(L.dx, L.dy, L.px - result.x, L.py - result.y) > 0) {
            const tx = result.x, ty = result.y;
            if (!linearProgram1(lines, i, radius, optX, optY, directionOpt)) {
                result.x = tx; result.y = ty;
                return i;
            }
        }
    }
    return count;
}

const projLines = makeLines(64);

function linearProgram3(lines: Line[], count: number, numObst: number, begin: number, radius: number): void {
    let distance = 0;
    for (let i = begin; i < count; i++) {
        const L = lines[i];
        if (det(L.dx, L.dy, L.px - result.x, L.py - result.y) <= distance) continue;
        let n = 0;
        for (let k = 0; k < numObst; k++) Object.assign(projLines[n++], lines[k]);
        for (let j = numObst; j < i; j++) {
            const M = lines[j];
            const P = projLines[n];
            const d = det(L.dx, L.dy, M.dx, M.dy);
            if (Math.abs(d) <= EPS) {
                if (L.dx * M.dx + L.dy * M.dy > 0) continue;
                P.px = 0.5 * (L.px + M.px); P.py = 0.5 * (L.py + M.py);
            } else {
                const t = det(M.dx, M.dy, L.px - M.px, L.py - M.py) / d;
                P.px = L.px + t * L.dx; P.py = L.py + t * L.dy;
            }
            const ddx = M.dx - L.dx, ddy = M.dy - L.dy;
            const l = Math.hypot(ddx, ddy) || 1;
            P.dx = ddx / l; P.dy = ddy / l;
            n++;
        }
        const tx = result.x, ty = result.y;
        if (linearProgram2(projLines, n, radius, -L.dy, L.dx, true) < n) {
            result.x = tx; result.y = ty;
        }
        distance = det(L.dx, L.dy, L.px - result.x, L.py - result.y);
    }
}

/**
 * Solves for the new velocity: `lines[0..numObst)` are hard (walls), the rest
 * from neighbours. Writes into `out`.
 */
export function solveVelocity(lines: Line[], count: number, numObst: number, maxSpeed: number, prefX: number, prefY: number, out: { x: number; y: number }): void {
    const fail = linearProgram2(lines, count, maxSpeed, prefX, prefY, false);
    if (fail < count) linearProgram3(lines, count, numObst, fail, maxSpeed);
    out.x = result.x;
    out.y = result.y;
}

/**
 * The ORCA half-plane for agent A against neighbour B (RVO2's agent case):
 * relative position / velocity, combined radius, time horizon and the time
 * step (used once they already overlap).
 */
export function agentLine(
    L: Line, vx: number, vy: number, relPx: number, relPy: number, relVx: number, relVy: number,
    combinedRadius: number, timeHorizon: number, timeStep: number,
): void {
    const distSq = relPx * relPx + relPy * relPy;
    const rSq = combinedRadius * combinedRadius;
    const invT = 1 / timeHorizon;
    let ux: number, uy: number;
    if (distSq > rSq) {
        const wx = relVx - invT * relPx, wy = relVy - invT * relPy;
        const wLenSq = wx * wx + wy * wy;
        const dot1 = wx * relPx + wy * relPy;
        if (dot1 < 0 && dot1 * dot1 > rSq * wLenSq) {
            // Project on the cut-off circle.
            const wLen = Math.sqrt(wLenSq);
            const nx = wx / wLen, ny = wy / wLen;
            L.dx = ny; L.dy = -nx;
            const s = combinedRadius * invT - wLen;
            ux = s * nx; uy = s * ny;
        } else {
            // Project on a leg of the velocity-obstacle cone.
            const leg = Math.sqrt(distSq - rSq);
            if (det(relPx, relPy, wx, wy) > 0) {
                L.dx = (relPx * leg - relPy * combinedRadius) / distSq;
                L.dy = (relPx * combinedRadius + relPy * leg) / distSq;
            } else {
                L.dx = -(relPx * leg + relPy * combinedRadius) / distSq;
                L.dy = -(-relPx * combinedRadius + relPy * leg) / distSq;
            }
            const dot2 = relVx * L.dx + relVy * L.dy;
            ux = dot2 * L.dx - relVx; uy = dot2 * L.dy - relVy;
        }
    } else {
        // Already overlapping: resolve within one time step.
        const invS = 1 / timeStep;
        const wx = relVx - invS * relPx, wy = relVy - invS * relPy;
        const wLen = Math.hypot(wx, wy) || 1e-9;
        const nx = wx / wLen, ny = wy / wLen;
        L.dx = ny; L.dy = -nx;
        const s = combinedRadius * invS - wLen;
        ux = s * nx; uy = s * ny;
    }
    L.px = vx + 0.5 * ux;
    L.py = vy + 0.5 * uy;
}

/**
 * A static point (a wall corner or the closest point of a wall cell) at
 * offset (qx, qy) from the agent: velocity towards it is limited so the
 * agent's disc cannot reach it within `timeHorizon`, v·n ≤ (d − r) / τ.
 * A conservative, linear stand-in for RVO2's obstacle segments.
 */
export function wallLine(L: Line, qx: number, qy: number, radius: number, timeHorizon: number): void {
    const d = Math.hypot(qx, qy) || 1e-9;
    const nx = qx / d, ny = qy / d;
    const c = (d - radius) / timeHorizon;
    L.px = nx * c; L.py = ny * c;
    L.dx = -ny; L.dy = nx;
}
