import { Vec4, type EffectAsset, type Material, type Texture2D } from 'cc';
import type { Planes } from './Culling';
import type { Forest } from './Forest';
import type { LodSettings } from './Lod';
import type { SpeciesAssets } from './Species';

/** Material vec4 properties must be Vec4: a plain array leaves the uniform undefined. */
export function v4(x: number, y: number, z: number, w: number): Vec4 {
    return new Vec4(x, y, z, w);
}

export interface FrameInput {
    planes: Planes;
    eye: [number, number, number];
    /** 1 / tan(fov / 2). */
    projScale: number;
    dt: number;
    lod: LodSettings;
    tint: boolean;
    /** Fog distance scale (0 in the overhead view). */
    fog: number;
}

export interface Shared {
    forest: Forest;
    species: SpeciesAssets[];
    treeEffect: EffectAsset;
    impostorEffect: EffectAsset;
    atlas: Texture2D;
    makeMaterial(effect: EffectAsset, defines?: Record<string, boolean | number>): Material;
}

export interface RenderPath {
    /** Shows or hides everything the path draws. */
    setVisible(on: boolean): void;
    update(frame: FrameInput): void;
    /** One HUD line. */
    describe(): string;
    /** Milliseconds of script work in the last update. */
    readonly cpuMs: number;
    destroy(): void;
}
