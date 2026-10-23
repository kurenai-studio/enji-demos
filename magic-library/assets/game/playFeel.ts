import { sys } from 'cc';

/** Mouse look and stature. Eye height follows the chosen body height. */
const LOOK = [
    { sens: 0.06, name: '很慢' },
    { sens: 0.09, name: '慢' },
    { sens: 0.12, name: '标准' },
    { sens: 0.18, name: '灵敏' },
    { sens: 0.26, name: '很快' },
    { sens: 0.36, name: '飞快' },
] as const;

const HEIGHTS = [140, 150, 160, 170, 180, 190, 200, 210];
const STORE = 'enji.library.feel';
/** 170 cm lines up with the original 1.55 m eye height. */
const EYE_PER_CM = 1.55 / 170;

let lookIndex = 2;
let heightIndex = 3;

load();

export function lookSens(): number {
    return LOOK[lookIndex].sens;
}

export function lookName(): string {
    return LOOK[lookIndex].name;
}

export function heightCm(): number {
    return HEIGHTS[heightIndex];
}

export function eyeHeight(): number {
    return HEIGHTS[heightIndex] * EYE_PER_CM;
}

export function nudgeLook(dir: number): void {
    lookIndex = clamp(lookIndex + dir, 0, LOOK.length - 1);
    save();
}

export function nudgeHeight(dir: number): void {
    heightIndex = clamp(heightIndex + dir, 0, HEIGHTS.length - 1);
    save();
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function load(): void {
    try {
        const raw = sys.localStorage.getItem(STORE);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { look?: number; height?: number };
        if (Number.isInteger(parsed.look)) lookIndex = clamp(parsed.look as number, 0, LOOK.length - 1);
        if (Number.isInteger(parsed.height)) heightIndex = clamp(parsed.height as number, 0, HEIGHTS.length - 1);
    } catch {
        // Keep the defaults.
    }
}

function save(): void {
    try {
        sys.localStorage.setItem(STORE, JSON.stringify({ look: lookIndex, height: heightIndex }));
    } catch {
        // Private mode can reject storage; the session still keeps the choice.
    }
}
