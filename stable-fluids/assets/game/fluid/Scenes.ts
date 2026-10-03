import { type FluidGrid, Side } from './FluidGrid';

export const SCENES = ['tunnel', 'jets', 'plume'] as const;
export type SceneName = (typeof SCENES)[number];
export const SCENE_TITLES: Record<SceneName, string> = { tunnel: 'Wind tunnel', jets: 'Jets', plume: 'Smoke plume' };

/** Dye palette, linear RGB. */
const ORANGE = [1.0, 0.45, 0.12];
const CYAN = [0.15, 0.7, 1.0];
const PINK = [0.95, 0.25, 0.6];
const LIME = [0.55, 0.95, 0.25];

export interface Scene {
    name: SceneName;
    /** Drives emitters each step (after advection, before the projection). */
    drive(grid: FluidGrid): void;
}

/**
 * Sets up the grid for a scene. Everything scales with the grid height so the
 * lite grid shows the same flow.
 */
export function buildScene(name: SceneName, grid: FluidGrid): Scene {
    const { nx, ny } = grid;
    grid.clear();
    grid.obstacles.length = 0;
    const p = grid.params;
    if (name === 'tunnel') {
        // Flow past a cylinder, slightly off the centre line so shedding starts
        // within a few seconds instead of waiting on round-off.
        grid.sides.splice(0, 4, Side.Inflow, Side.Open, Side.Wall, Side.Wall);
        grid.inflow = 0.3 * ny;
        grid.obstacles.push({ x: 0.22 * nx, y: 0.5 * ny + 0.6, r: 0.1 * ny, vx: 0, vy: 0 });
        p.buoyancy = 0;
        p.dyeDecay = 0;
        for (let i = 0; i < grid.u.length; i++) grid.u[i] = grid.inflow;
        const stripe = Math.max(2, Math.round(ny / 20));
        return {
            name,
            drive(g) {
                for (let j = 0; j < ny; j++) {
                    const band = Math.floor(j / stripe);
                    const on = band % 2 === 0;
                    const c = band % 4 === 0 ? CYAN : PINK;
                    for (let i = 0; i < 2; i++) g.setDye(i, j, on ? c[0] : 0, on ? c[1] : 0, on ? c[2] : 0);
                }
            },
        };
    }
    if (name === 'jets') {
        // Two nozzles fire at each other slightly off axis in a closed box; the
        // collision sheds a vortex pair every time they sweep past each other.
        grid.sides.splice(0, 4, Side.Wall, Side.Wall, Side.Wall, Side.Wall);
        grid.inflow = 0;
        p.buoyancy = 0;
        p.dyeDecay = 0.25;
        const speed = 0.6 * ny;
        const radius = 0.045 * ny;
        return {
            name,
            drive(g) {
                const a = 0.35 * Math.sin(g.time * 0.9);
                g.nozzle(0.1 * nx, 0.5 * ny - 0.08 * ny, radius, speed * Math.cos(a), speed * Math.sin(a), ORANGE[0], ORANGE[1], ORANGE[2]);
                g.nozzle(0.9 * nx, 0.5 * ny + 0.08 * ny, radius, -speed * Math.cos(a), -speed * Math.sin(a), CYAN[0], CYAN[1], CYAN[2]);
            },
        };
    }
    // Plume: two warm sources on the floor, buoyant dye, open top.
    grid.sides.splice(0, 4, Side.Wall, Side.Wall, Side.Wall, Side.Open);
    grid.inflow = 0;
    p.buoyancy = 0.5 * ny;
    p.dyeDecay = 0.05;
    const radius = 0.06 * ny;
    const rise = 0.15 * ny;
    return {
        name,
        drive(g) {
            const wobble = 0.02 * ny * Math.sin(g.time * 1.7);
            g.nozzle(0.3 * nx + wobble, 0.1 * ny, radius, 0, rise, PINK[0], PINK[1], PINK[2]);
            g.nozzle(0.7 * nx - wobble, 0.1 * ny, radius, 0, rise, LIME[0], LIME[1], LIME[2]);
        },
    };
}
