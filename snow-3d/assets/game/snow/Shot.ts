import { PARTS, type HandPose } from './Hand';
import type { Bed } from './Scenes';
import { BORDER, type SnowParams } from './SnowSim';

/**
 * The Lich King shot: a thin layer of fresh snow on a sheet of ice, one slow
 * wipe of the gauntlet across it, and the words frozen in the ice below.
 * Sizes are in the same scaled-up units as the sandbox (gauntlet 2.2× a hand).
 */
export const SHOT = {
    dx: 0.025,
    perCell: 1.5,
    trayW: 1.8,
    trayL: 1.0,
    trayH: 0.3,
    bed: { depth: 0.07, drift: 0.006, bank: 0 } as Bed,
    handScale: 2.2,
    /** Thin snow needs far less strength than the 25 cm sandbox bed; a softer E also allows a 2.5 cm grid at 6 substeps. */
    params: { young: 1.5e4, floorFriction: 0.2 } as Partial<SnowParams>,
    /**
     * Under its own weight a 7 cm layer compresses by at most ρgh/E ≈ 2 % (about 0.6 mm), so the
     * fresh bed goes straight to sleep instead of settling.
     */
    settleFrames: 0,
    /**
     * The wipe leaves a dusting of one or two particle layers on the ice. The surface
     * leaves out snow this close to the ice, so the dusting reads as translucent.
     */
    dusting: 0.012,
    /** The text band on the ice, in tray coordinates from the tray centre (metres). */
    text: { w: 0.9, h: 0.15 },
    /** Lowest point of the gauntlet above the ice while wiping. */
    clearance: 0.0,
    /** Fingers trailing the wrist, as in a wipe (tools/shot-tune.mts compares poses). */
    lean: -0.55,
    yaw: 0,
};

export function shotSize(): { nx: number; ny: number; nz: number } {
    return {
        nx: Math.round(SHOT.trayW / SHOT.dx) + 2 * BORDER,
        ny: Math.round(SHOT.trayH / SHOT.dx) + 2 * BORDER,
        nz: Math.round(SHOT.trayL / SHOT.dx) + 2 * BORDER,
    };
}

/** Wrist height above the ice that puts the lowest capsule `clearance` above it at the given lean. */
export function wristHeight(lean: number, scale: number, clearance: number): number {
    const cl = Math.cos(lean), sl = Math.sin(lean);
    let low = Infinity;
    for (const part of PARTS) {
        for (const p of [part.a, part.b]) low = Math.min(low, (p[1] * cl + p[2] * sl) * scale - part.r * scale);
    }
    return clearance - low;
}

export const TIMELINE = {
    enter: 1.0,
    down: 1.5,
    wipeEnd: 3.6,
    exit: 4.5,
    end: 9,
};

/**
 * Hand pose at time t (s) of the shot. `cx, cz` is the tray centre and `floor`
 * the ice height; before `enter` the hand waits above and left of the frame.
 */
export function shotPose(t: number, cx: number, cz: number, floor: number): HandPose {
    const T = TIMELINE;
    const k = SHOT.handScale;
    const low = floor + wristHeight(SHOT.lean, k, SHOT.clearance);
    const half = SHOT.text.w / 2 + 0.1;
    // Start a little behind the text band and finish past it, so the wipe covers the whole line.
    const start = { x: cx - half, y: low, z: cz + 0.01 };
    const end = { x: cx + half, y: low, z: cz - 0.01 };
    const smooth = (u: number) => { const c = Math.min(Math.max(u, 0), 1); return c * c * (3 - 2 * c); };
    const pose: HandPose = { x: start.x - 0.25, y: floor + 0.75, z: start.z + 0.05, yaw: SHOT.yaw, lean: SHOT.lean };
    if (t < T.enter) return pose;
    if (t < T.down) {
        const u = smooth((t - T.enter) / (T.down - T.enter));
        pose.x += (start.x - pose.x) * u;
        pose.y += (start.y - pose.y) * u;
        pose.z += (start.z - pose.z) * u;
        return pose;
    }
    if (t < T.wipeEnd) {
        const u = smooth((t - T.down) / (T.wipeEnd - T.down));
        pose.x = start.x + (end.x - start.x) * u;
        pose.y = low;
        pose.z = start.z + (end.z - start.z) * u + 0.02 * Math.sin(Math.PI * u);
        return pose;
    }
    const u = smooth((t - T.wipeEnd) / (T.exit - T.wipeEnd));
    pose.x = end.x + 0.25 * u;
    pose.y = low + (0.8 - (low - floor)) * u;
    pose.z = end.z - 0.15 * u;
    return pose;
}
