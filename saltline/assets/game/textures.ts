import { Texture2D } from 'cc';
import { byte, fbm2, mix, smoothstep } from './noise';

export interface SurfaceMaps {
    albedo: Texture2D;
    normal: Texture2D;
    /** R occlusion, G roughness, B metallic, A specular. Sampled raw, not as sRGB. */
    pbr: Texture2D;
}

type Rgba = [number, number, number, number];

function fill(size: number, sample: (u: number, v: number) => Rgba): Uint8Array {
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) / size;
            const v = (y + 0.5) / size;
            const [r, g, b, a] = sample(u, v);
            const i = (y * size + x) * 4;
            data[i] = byte(r);
            data[i + 1] = byte(g);
            data[i + 2] = byte(b);
            data[i + 3] = byte(a);
        }
    }
    return data;
}

function texture(size: number, rgba: Uint8Array, repeat: boolean): Texture2D {
    const tex = new Texture2D();
    tex.reset({
        width: size,
        height: size,
        format: Texture2D.PixelFormat.RGBA8888,
        mipmapLevel: 1,
    });
    tex.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
    const wrap = repeat ? Texture2D.WrapMode.REPEAT : Texture2D.WrapMode.CLAMP_TO_EDGE;
    tex.setWrapMode(wrap, wrap);
    tex.uploadData(rgba);
    return tex;
}

function pack(size: number, albedo: (u: number, v: number) => Rgba, normal: (u: number, v: number) => Rgba, pbr: (u: number, v: number) => Rgba, repeat: boolean): SurfaceMaps {
    return {
        albedo: texture(size, fill(size, albedo), repeat),
        normal: texture(size, fill(size, normal), repeat),
        pbr: texture(size, fill(size, pbr), repeat),
    };
}

/** Tangent-space normal from a height field. +Z faces out of the surface. */
function normalFromHeight(heightAt: (u: number, v: number) => number, u: number, v: number, texel: number, slope: number): Rgba {
    const hL = heightAt(u - texel, v);
    const hR = heightAt(u + texel, v);
    const hD = heightAt(u, v - texel);
    const hU = heightAt(u, v + texel);
    let nx = (hL - hR) * slope;
    let ny = (hD - hU) * slope;
    let nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    return [nx * 127.5 + 127.5, ny * 127.5 + 127.5, nz * 127.5 + 127.5, 255];
}

const FLAT: Rgba = [127.5, 127.5, 255, 255];

/**
 * Container paint. One corrugation per tile; the mesh tiling repeats it along the length.
 * Rust starts where the macro noise crosses 0.68, and runs toward v = 1 (the bottom of the side).
 */
export function bakePaint(rgb: [number, number, number]): SurfaceMaps {
    const size = 128;
    const heightAt = (u: number, v: number) => Math.sin(u * Math.PI * 2) * 0.5 + 0.5;
    return pack(size, (u, v) => {
        const rib = heightAt(u, v);
        const grain = fbm2(u * 8, v * 8, 8, 8);
        const rust = smoothstep(0.68, 0.9, fbm2(u * 3.2, v * 2.4, 4, 3) * 0.85 + v * 0.22);
        const grit = 0.9 + grain * 0.12;
        const shade = 0.78 + rib * 0.22;
        const r = mix(rgb[0] * grit * shade, 112, rust);
        const g = mix(rgb[1] * grit * shade, 62, rust);
        const b = mix(rgb[2] * grit * shade, 40, rust);
        return [r, g, b, 255];
    }, (u, v) => normalFromHeight(heightAt, u, v, 1 / size, 2.4), (u, v) => {
        const rust = smoothstep(0.68, 0.9, fbm2(u * 3.2, v * 2.4, 4, 3) * 0.85 + v * 0.22);
        const rough = mix(0.4, 0.82, rust);
        return [mix(255, 170, rust), rough * 255, 18, mix(150, 80, rust)];
    }, true);
}

/** Apron. Joints every 1/6 of the map. Puddles are smooth and dark; dry asphalt stays rough. */
export function bakeAsphalt(): SurfaceMaps {
    const size = 512;
    const wetAt = (u: number, v: number) => smoothstep(0.5, 0.78, fbm2(u * 3.2 + 1.7, v * 2.6 + 0.4));
    const heightAt = (u: number, v: number) => {
        const wet = wetAt(u, v);
        const cells = 6;
        const du = Math.min((u * cells) % 1, 1 - (u * cells) % 1);
        const dv = Math.min((v * cells) % 1, 1 - (v * cells) % 1);
        const joint = smoothstep(0.018, 0.0, Math.min(du, dv));
        return fbm2(u * 22, v * 18) * (1 - wet) * (1 - joint);
    };
    return pack(size, (u, v) => {
        const wet = wetAt(u, v);
        const grit = fbm2(u * 28, v * 24);
        const cells = 6;
        const du = Math.min((u * cells) % 1, 1 - (u * cells) % 1);
        const dv = Math.min((v * cells) % 1, 1 - (v * cells) % 1);
        const joint = smoothstep(0.02, 0.0, Math.min(du, dv));
        const trackL = (v - 0.38) * 16;
        const trackR = (v - 0.62) * 16;
        const track = Math.exp(-(trackL * trackL)) * 0.55 + Math.exp(-(trackR * trackR)) * 0.55;
        let shade = 58 + grit * 18 - joint * 22 - track * 10;
        shade = mix(shade, 46 + grit * 8, wet);
        return [shade, shade + 1, shade + 2, 255];
    }, (u, v) => {
        if (wetAt(u, v) > 0.85) return FLAT;
        return normalFromHeight(heightAt, u, v, 1 / size, 3.2);
    }, (u, v) => {
        const wet = wetAt(u, v);
        const rough = mix(0.78, 0.16, wet);
        const ao = mix(210, 150, wet);
        const spec = mix(90, 255, wet);
        return [ao, rough * 255, 8, spec];
    }, false);
}

export function bakeWater(): SurfaceMaps {
    const size = 128;
    const heightAt = (u: number, v: number) =>
        Math.sin(u * Math.PI * 2 * 3) * 0.65 + Math.sin((v * 2 + u) * Math.PI * 2) * 0.35;
    return pack(size, (u, v) => {
        const glint = 0.5 + 0.5 * heightAt(u, v);
        return [28 + glint * 10, 58 + glint * 14, 66 + glint * 12, 255];
    }, (u, v) => normalFromHeight(heightAt, u, v, 1 / size, 0.55), () => [255, 48, 8, 210], true);
}

export function bakeMetal(): SurfaceMaps {
    const size = 128;
    const heightAt = (u: number, v: number) => fbm2(u * 10, v * 10, 10, 10);
    return pack(size, (u, v) => {
        const n = heightAt(u, v);
        const scratch = smoothstep(0.72, 0.78, fbm2(u * 40, v * 2, 20, 4));
        const g = 138 + n * 28 - scratch * 30;
        return [g, g + 1, g - 1, 255];
    }, (u, v) => normalFromHeight(heightAt, u, v, 1 / size, 1.1), (u, v) => {
        const scratch = smoothstep(0.72, 0.78, fbm2(u * 40, v * 2, 20, 4));
        return [220, mix(0.55, 0.72, scratch) * 255, mix(190, 140, scratch), 170];
    }, true);
}

export function bakeConcrete(): SurfaceMaps {
    const size = 128;
    const heightAt = (u: number, v: number) => fbm2(u * 6, v * 6, 6, 6);
    return pack(size, (u, v) => {
        const n = heightAt(u, v);
        const stain = smoothstep(0.62, 0.8, fbm2(u * 2.5 + 3, v * 2.5, 3, 3));
        const g = mix(128 + n * 16, 96, stain);
        return [g + 4, g + 1, g - 6, 255];
    }, (u, v) => normalFromHeight(heightAt, u, v, 1 / size, 1.4), () => [200, 220, 6, 70], true);
}

export function bakeWood(): SurfaceMaps {
    const size = 64;
    return pack(size, (u, v) => {
        const ring = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 7);
        const n = fbm2(u * 4, v * 12, 4, 8);
        return [96 + ring * 40 + n * 10, 64 + ring * 22, 36 + n * 8, 255];
    }, () => FLAT, () => [210, 200, 0, 40], true);
}

export function bakeCaution(): SurfaceMaps {
    const size = 64;
    return pack(size, (u) => {
        const stripe = Math.floor(u * 8) % 2 === 0;
        return stripe ? [214, 168, 28, 255] : [28, 28, 30, 255];
    }, () => FLAT, () => [230, 150, 8, 80], true);
}

export function bakeHull(): SurfaceMaps {
    const size = 64;
    const heightAt = (u: number, v: number) => fbm2(u * 5, v * 5, 5, 5);
    return pack(size, (u, v) => {
        const n = heightAt(u, v);
        const rust = smoothstep(0.7, 0.88, n);
        return [mix(42, 96, rust), mix(52, 58, rust), mix(60, 42, rust), 255];
    }, (u, v) => normalFromHeight(heightAt, u, v, 1 / size, 0.8), (u, v) => {
        const rust = smoothstep(0.7, 0.88, heightAt(u, v));
        return [200, mix(0.48, 0.75, rust) * 255, mix(40, 20, rust), 120];
    }, true);
}
