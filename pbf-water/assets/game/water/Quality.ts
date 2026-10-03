import type { PBFSolver } from './PBFSolver';

/**
 * Quality levels scale the particle spacing; everything tied to it scales along:
 * the kernel radius (two spacings, so about 30 neighbours at every level), the
 * surface mesher grid, and the dropped block (same volume). The constraint
 * relaxation ε and the s_corr strength carry units of the kernel, so they are
 * rescaled to keep the same behaviour: Σ|∇C|² grows as 1/h², and the s_corr
 * displacement as k/h.
 */
export interface WaterQuality {
    name: string;
    spacing: number;
    kernel: number;
    meshCell: number;
    meshRadius: number;
    dropSide: number;
    relaxation: number;
    sCorrK: number;
}

const BASE_SPACING = 0.05;

function level(name: string, spacing: number): WaterQuality {
    const s = spacing / BASE_SPACING;
    return {
        name,
        spacing,
        kernel: 2 * spacing,
        meshCell: 0.9 * spacing,
        meshRadius: 1.8 * spacing,
        dropSide: Math.round(0.4 / spacing),
        relaxation: 20 / (s * s),
        sCorrK: 0.0008 * s * s,
    };
}

export const QUALITY: readonly WaterQuality[] = [level('High', 0.05), level('Medium', 0.0625), level('Low', 0.08)];

export function applyQuality(solver: PBFSolver, quality: WaterQuality): void {
    solver.relaxation = quality.relaxation;
    solver.sCorrK = quality.sCorrK;
}
