import { Texture2D, TextureCube } from 'cc';
import { byte, noise2, smoothstep } from './noise';

/**
 * Saltline sky: low warm sun, dark blue zenith, cloud deck that opens
 * toward the sun. The directional light is the actual sun; this cube is
 * what the skybox and the ambient probe show.
 * Face order is +X, -X, +Y, -Y, +Z, -Z.
 */
const SUN = normalize(0.916, 0.225, 0.331);
const HOR: [number, number, number] = [0.95, 0.55, 0.28];
const AWAY: [number, number, number] = [0.16, 0.22, 0.3];
const SUN_COL: [number, number, number] = [1.0, 0.72, 0.42];

export function makeHarborSky(withDisc = true): TextureCube {
    const size = 96;
    const cube = new TextureCube();
    cube.reset({
        width: size,
        height: size,
        format: Texture2D.PixelFormat.RGBA8888,
        mipmapLevel: 1,
    });
    for (let face = 0; face < 6; face++) {
        const data = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            const t = 1 - ((y + 0.5) / size) * 2;
            for (let x = 0; x < size; x++) {
                const s = ((x + 0.5) / size) * 2 - 1;
                const dir = normalize(...faceVector(face, s, t));
                const color = skyColor(dir[0], dir[1], dir[2], withDisc);
                const i = (y * size + x) * 4;
                data[i] = byte(color[0] * 255);
                data[i + 1] = byte(color[1] * 255);
                data[i + 2] = byte(color[2] * 255);
                data[i + 3] = 255;
            }
        }
        cube.uploadData(data, 0, face);
    }
    return cube;
}

function faceVector(face: number, s: number, t: number): [number, number, number] {
    switch (face) {
        case 0: return [1, t, -s];
        case 1: return [-1, t, s];
        case 2: return [s, 1, -t];
        case 3: return [s, -1, t];
        case 4: return [s, t, 1];
        default: return [-s, t, -1];
    }
}

function normalize(x: number, y: number, z: number): [number, number, number] {
    const len = Math.hypot(x, y, z) || 1;
    return [x / len, y / len, z / len];
}

function rot(x: number, y: number): [number, number] {
    return [1.6 * x - 1.2 * y + 17.3, 1.2 * x + 1.6 * y + 17.3];
}

function fbm(x: number, y: number, octaves: number): number {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += amp * noise2(x, y);
        norm += amp;
        const next = rot(x, y);
        x = next[0];
        y = next[1];
        amp *= 0.5;
    }
    return sum / norm;
}

function skyToSun(x: number, z: number): number {
    const sl = Math.hypot(SUN[0], SUN[2]) || 1;
    const dl = Math.hypot(x, z) || 1;
    const dot = (x / dl) * (SUN[0] / sl) + (z / dl) * (SUN[2] / sl);
    return Math.min(1, Math.max(0, dot * 0.5 + 0.5));
}

function horizonColor(ts: number): [number, number, number] {
    const lift = smoothstep(0.2, 0.75, ts);
    let r = AWAY[0] * (1 - lift) + (AWAY[0] * 1.25 + 0.05) * lift;
    let g = AWAY[1] * (1 - lift) + (AWAY[1] * 1.25 + 0.03) * lift;
    let b = AWAY[2] * (1 - lift) + (AWAY[2] * 1.25 + 0.02) * lift;
    const fire = Math.pow(ts, 6);
    r = r * (1 - fire) + HOR[0] * 1.9 * fire;
    g = g * (1 - fire) + HOR[1] * 1.55 * fire;
    b = b * (1 - fire) + HOR[2] * 1.2 * fire;
    const core = Math.pow(ts, 34);
    r = r * (1 - core) + 1.0 * 3.4 * core;
    g = g * (1 - core) + 0.6 * 3.4 * core;
    b = b * (1 - core) + 0.24 * 3.4 * core;
    return [r, g, b];
}

function skyColor(x: number, y: number, z: number, withDisc = true): [number, number, number] {
    const h = Math.max(y, 0);
    const mu = x * SUN[0] + y * SUN[1] + z * SUN[2];
    const s = Math.max(mu, 0);
    const ts = skyToSun(x, z);
    const hc = horizonColor(ts);
    const midT = Math.pow(ts, 3);
    const midR = 0.15 * (1 - midT) + 0.72 * midT;
    const midG = 0.24 * (1 - midT) + 0.5 * midT;
    const midB = 0.36 * (1 - midT) + 0.34 * midT;
    const band = smoothstep(0, 0.17, h);
    let r = hc[0] * (1 - band) + midR * band;
    let g = hc[1] * (1 - band) + midG * band;
    let b = hc[2] * (1 - band) + midB * band;
    const zen = smoothstep(0.1, 0.5, h);
    r = r * (1 - zen) + 0.085 * zen;
    g = g * (1 - zen) + 0.145 * zen;
    b = b * (1 - zen) + 0.24 * zen;
    const glow = Math.pow(s, 8) * 0.14 + Math.pow(s, 64) * 0.55 + Math.pow(s, 400) * 1.4;
    r += SUN_COL[0] * 1.0 * glow;
    g += SUN_COL[1] * 0.86 * glow;
    b += SUN_COL[2] * 0.68 * glow;

    const denom = h + 0.1;
    let qx = (x / denom) * 0.62;
    let qy = (z / denom) * 0.95;
    const warp = fbm(qx * 0.45 + 7.1, qy * 0.45, 3);
    const wx = qx + (warp - 0.5) * 1.3;
    const wy = qy + (warp - 0.5) * 0.4;
    const dens = fbm(wx, wy, 4);
    const big = noise2(qx * 0.19 + 3.7, qy * 0.19);
    const body = dens * 0.74 + big * 0.36;
    let cov = smoothstep(0.31, 0.5, body);
    const edge = 0.03 + (0.285 - 0.03) * Math.pow(ts, 1.7);
    const rag = (noise2(qx * 0.9 + 11, qy * 0.9) - 0.5) * 0.16 + (dens - 0.5) * 0.1;
    const deck = smoothstep(edge - 0.035, edge + 0.11, h + rag * (0.35 + ts));
    cov *= deck;
    const hole = smoothstep(0.972, 0.9985, mu + (dens - 0.5) * 0.012);
    cov *= 1 - 0.93 * hole;

    const sdLen = Math.hypot(SUN[0], SUN[2]) || 1;
    const densS = fbm(wx + (SUN[0] / sdLen) * 0.22, wy + (SUN[2] / sdLen) * 0.22, 3);
    const relief = Math.min(1, Math.max(0, (dens - densS) * 4.5 + 0.5));
    const thick = smoothstep(0.4, 0.72, body);
    let cr = (0.155 * (1 - thick) + 0.03 * thick) * (0.55 + 0.9 * relief * relief);
    let cg = (0.195 * (1 - thick) + 0.042 * thick) * (0.55 + 0.9 * relief * relief);
    let cb = (0.255 * (1 - thick) + 0.064 * thick) * (0.55 + 0.9 * relief * relief);
    const thin = Math.pow(1 - thick, 3);
    cr += 0.07 * thin;
    cg += 0.1 * thin;
    cb += 0.15 * thin;
    const nearSun = Math.pow(ts, 5) * Math.exp(-Math.max(h - edge, 0) * 4.5) * 0.9 + Math.pow(s, 7) * 0.9;
    const warmK = nearSun * (0.05 + 2.2 * relief * relief * relief) * 1.15;
    cr += HOR[0] * 1.3 * warmK;
    cg += HOR[1] * 0.66 * warmK;
    cb += HOR[2] * 0.4 * warmK;
    const rim = cov * (1 - cov) * 4 * Math.pow(ts, 4) * (0.5 + 1.6 * Math.pow(s, 6)) * (1 - 0.85 * hole);
    cr += SUN_COL[0] * rim;
    cg += SUN_COL[1] * rim;
    cb += SUN_COL[2] * rim;
    const fade = Math.exp(-h * 11);
    cr = cr * (1 - fade) + (hc[0] * 0.55 + cr * 0.45) * fade;
    cg = cg * (1 - fade) + (hc[1] * 0.55 + cg * 0.45) * fade;
    cb = cb * (1 - fade) + (hc[2] * 0.55 + cb * 0.45) * fade;
    const cover = cov * 0.985;
    r = r * (1 - cover) + cr * cover;
    g = g * (1 - cover) + cg * cover;
    b = b * (1 - cover) + cb * cover;

    if (withDisc) {
        const disk = smoothstep(0.9984, 0.9994, mu) * (1 - cov * 0.92);
        r += disk * 6;
        g += disk * 4.6;
        b += disk * 2.6;
    }

    if (y < 0) {
        const t = Math.min(1, -y * 5);
        const lowR = AWAY[0] * 0.42;
        const lowG = AWAY[1] * 0.42;
        const lowB = AWAY[2] * 0.42;
        const belowR = hc[0] + SUN_COL[0] * Math.pow(s, 48) * 1.5;
        const belowG = hc[1] + SUN_COL[1] * Math.pow(s, 48) * 1.5;
        const belowB = hc[2] + SUN_COL[2] * Math.pow(s, 48) * 1.5;
        r = belowR * (1 - t) + lowR * t;
        g = belowG * (1 - t) + lowG * t;
        b = belowB * (1 - t) + lowB * t;
    }
    return [r, g, b];
}
