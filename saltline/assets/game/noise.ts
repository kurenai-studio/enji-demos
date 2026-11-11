/** Value noise. Integer lattice, smoothstep. Periods make a tile when both are > 0. */

function hash2(ix: number, iy: number): number {
    let n = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function hash3(ix: number, iy: number, iz: number): number {
    let n = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(iz | 0, 1440671);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
    return t * t * (3 - 2 * t);
}

function lattice(ix: number, iy: number, periodX: number, periodY: number): number {
    if (periodX > 0) ix = ((ix % periodX) + periodX) % periodX;
    if (periodY > 0) iy = ((iy % periodY) + periodY) % periodY;
    return hash2(ix, iy);
}

/** 2D value noise in [0, 1]. `periodX/Y` tile the lattice; 0 means infinite. */
export function noise2(x: number, y: number, periodX = 0, periodY = 0): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = lattice(x0, y0, periodX, periodY);
    const b = lattice(x0 + 1, y0, periodX, periodY);
    const c = lattice(x0, y0 + 1, periodX, periodY);
    const d = lattice(x0 + 1, y0 + 1, periodX, periodY);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function fbm2(x: number, y: number, periodX = 0, periodY = 0): number {
    return noise2(x, y, periodX, periodY) * 0.5
        + noise2(x * 2, y * 2, periodX * 2, periodY * 2) * 0.3
        + noise2(x * 4, y * 4, periodX * 4, periodY * 4) * 0.2;
}

export function noise3(x: number, y: number, z: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const z0 = Math.floor(z);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const fz = fade(z - z0);
    let acc = 0;
    for (let dz = 0; dz <= 1; dz++) {
        for (let dy = 0; dy <= 1; dy++) {
            for (let dx = 0; dx <= 1; dx++) {
                const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
                acc += w * hash3(x0 + dx, y0 + dy, z0 + dz);
            }
        }
    }
    return acc;
}

export function fbm3(x: number, y: number, z: number): number {
    return noise3(x, y, z) * 0.55 + noise3(x * 2, y * 2, z * 2) * 0.3 + noise3(x * 4, y * 4, z * 4) * 0.15;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1)));
    return t * t * (3 - 2 * t);
}

export function clamp01(v: number): number {
    return Math.min(1, Math.max(0, v));
}

export function byte(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

export function mix(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}
