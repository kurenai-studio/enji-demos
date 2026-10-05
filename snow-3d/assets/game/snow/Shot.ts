import { PARTS, toWorld, type HandPose } from './Hand';
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
    /**
     * Palm down, fingertips tipped 0.2 rad toward the ice. The arm reaches in from across the
     * ice (from the far right), fingers toward the camera, and brushes outward with the
     * little-finger edge leading; the forearm rises away from the camera instead of into it.
     * Only the fingers reach the ice (within 3 cm); the palm and cuff skim the top of the 7 cm
     * layer, so the stroke clears a band about a hand wide (tools/shot-tune.mts compares poses).
     */
    lean: -Math.PI / 2 + 0.2,
    yaw: -Math.PI / 2 + 0.3,
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

/**
 * The beat of the cinematic: the palm comes down onto the snow left of the words,
 * rests there a moment, then brushes slowly across and lifts away.
 */
export const TIMELINE = {
    enter: 0.6,
    land: 1.6,
    brush: 2.3,
    wipeEnd: 4.9,
    exit: 5.9,
    end: 10.5,
};

/** Middle of the fingers and thumb in hand space: the part that brushes the snow. */
const BRUSH_CENTRE = [0.015, -0.155, 0.02];

const smooth = (u: number) => { const c = Math.min(Math.max(u, 0), 1); return c * c * (3 - 2 * c); };

/**
 * Hand pose at time t (s) of the shot. `cx, cz` is the tray centre and `floor`
 * the ice height; before `enter` the hand waits above and left of the frame.
 */
export function shotPose(t: number, cx: number, cz: number, floor: number): HandPose {
    const T = TIMELINE;
    const low = floor + wristHeight(SHOT.lean, SHOT.handScale, SHOT.clearance);
    // The wrist sits off the brushing fingers; place it so the fingers run along the text band.
    const off: number[] = [];
    toWorld({ x: 0, y: 0, z: 0, yaw: SHOT.yaw, lean: SHOT.lean }, BRUSH_CENTRE, off, 0, SHOT.handScale);
    const half = SHOT.text.w / 2 + 0.08;
    const start = { x: cx - half - off[0], z: cz - off[2] };
    const end = { x: cx + half - off[0], z: cz - off[2] - 0.01 };
    const pose: HandPose = { x: start.x - 0.2, y: floor + 0.7, z: start.z + 0.1, yaw: SHOT.yaw, lean: SHOT.lean };
    if (t < T.enter) return pose;
    if (t < T.land) {
        // Down onto the snow, slowing into the touch.
        const u = (t - T.enter) / (T.land - T.enter);
        const e = 1 - (1 - u) * (1 - u) * (1 - u);
        pose.x += (start.x - pose.x) * smooth(u);
        pose.y += (low - pose.y) * e;
        pose.z += (start.z - pose.z) * smooth(u);
        return pose;
    }
    if (t < T.brush) {
        // The pause: the hand settles a few millimetres as the weight comes onto it.
        const u = (t - T.land) / (T.brush - T.land);
        pose.x = start.x;
        pose.y = low + 0.004 * Math.sin(Math.PI * Math.min(1, u * 1.5));
        pose.z = start.z;
        return pose;
    }
    if (t < T.wipeEnd) {
        const u = smooth((t - T.brush) / (T.wipeEnd - T.brush));
        pose.x = start.x + (end.x - start.x) * u;
        pose.y = low;
        pose.z = start.z + (end.z - start.z) * u + 0.015 * Math.sin(Math.PI * u);
        return pose;
    }
    const u = smooth((t - T.wipeEnd) / (T.exit - T.wipeEnd));
    pose.x = end.x + 0.15 * u;
    pose.y = low + (0.75 - (low - floor)) * u;
    pose.z = end.z + 0.12 * u;
    // Fingers tip up as the hand leaves.
    pose.lean = SHOT.lean - 0.35 * u;
    return pose;
}
