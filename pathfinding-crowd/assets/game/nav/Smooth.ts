import type { Grid } from './Grid';

/**
 * Turns a cell path into waypoints (cell centres, with the exact start and
 * goal) and pulls the string: from each kept waypoint, skip ahead while a
 * disc of `radius` still has a clear run to the next one. Returns a flat
 * [x0, y0, x1, y1, …] polyline.
 */
export function smoothPath(grid: Grid, cells: number[], start: [number, number], goal: [number, number], radius: number): number[] {
    const w = grid.w;
    const pts: number[] = [start[0], start[1]];
    for (let k = 1; k < cells.length - 1; k++) {
        const x = cells[k] % w;
        pts.push(x + 0.5, (cells[k] - x) / w + 0.5);
    }
    pts.push(goal[0], goal[1]);
    const n = pts.length / 2;
    const out = [pts[0], pts[1]];
    let anchor = 0;
    while (anchor < n - 1) {
        let next = anchor + 1;
        while (next + 1 < n && grid.capsuleClear(pts[2 * anchor], pts[2 * anchor + 1], pts[2 * next + 2], pts[2 * next + 3], radius)) next++;
        out.push(pts[2 * next], pts[2 * next + 1]);
        anchor = next;
    }
    return out;
}

export function polylineLength(pts: number[]): number {
    let l = 0;
    for (let k = 2; k < pts.length; k += 2) l += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
    return l;
}
