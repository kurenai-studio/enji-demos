import { BORDER, type SnowParams } from './SnowSim';

/**
 * The demo scene: a 1.2 × 0.78 m tray of snow, 25 cm deep, and a gauntlet 2.2×
 * a human hand. The hand has to be several grid cells across, or the quadratic
 * B-spline stencil (3 cells wide) smears it out and the trench fills back in;
 * scaling the scene up is much cheaper than a finer grid in 3D.
 */
export const SCENE = {
    dx: 0.03,
    perCell: 1.5,
    trayW: 1.2,
    trayL: 0.78,
    trayH: 0.6,
    bed: 'drift' as const,
    handScale: 2.2,
    /** Wrist heights above the tray floor: digging (fingertips a few cm off the floor) and lifted out. */
    digY: 0.33,
    liftY: 0.75,
    settleFrames: 40,
    /**
     * Snow strength has to carry its own weight: trench walls need roughly
     * E·θ > ρ g h. E = 4e4 holds a 20 cm wall and is stable at 6 substeps.
     */
    params: { young: 4e4 } as Partial<SnowParams>,
};

export function simSize(): { nx: number; ny: number; nz: number } {
    return {
        nx: Math.round(SCENE.trayW / SCENE.dx) + 2 * BORDER,
        ny: Math.round(SCENE.trayH / SCENE.dx) + 2 * BORDER,
        nz: Math.round(SCENE.trayL / SCENE.dx) + 2 * BORDER,
    };
}
