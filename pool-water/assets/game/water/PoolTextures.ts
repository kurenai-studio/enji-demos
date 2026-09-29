import { Texture2D, TextureCube, Vec3 } from 'cc';

/**
 * Procedural textures, generated as raw pixels (no DOM canvas, so it also runs
 * on native): pool tiles, deck pavers and the sky cube map the water reflects.
 */

type RGB = [number, number, number];

/** 12x12 ceramic pool tiles; one repeat covers 2 world units, so a tile is the rim height (1/6) tall. */
export function createTileTexture(): Texture2D {
    const size = 1024;
    const n = 12;
    const img = new Image8(size);
    const rand = lcg(7);

    img.fillRect(0, 0, size, size, hex('#8f9ea6'));
    const t = size / n;
    const gap = 3;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const x = i * t + gap;
            const y = j * t + gap;
            const w = t - gap * 2;
            const l = 86 + rand() * 8;
            img.fillDiagonalGradient(x, y, w, hsl(195, 28, l + 3), hsl(200, 26, l - 4));
            img.fillRect(x, y, w, 2, [255, 255, 255], 0.18);
            img.fillRect(x, y, 2, w, [255, 255, 255], 0.18);
            img.fillRect(x, y + w - 2, w, 2, [0, 0, 0], 0.08);
            img.fillRect(x + w - 2, y, 2, w, [0, 0, 0], 0.08);
        }
    }
    const px = img.data;
    for (let k = 0; k < px.length; k += 4) {
        const v = (rand() - 0.5) * 6;
        px[k] += v;
        px[k + 1] += v;
        px[k + 2] += v;
    }
    return createMipmappedTexture(img);
}

/** Warm sandstone pavers, 4x4 per repeat. */
export function createDeckTexture(): Texture2D {
    const size = 1024;
    const n = 4;
    const img = new Image8(size);
    const rand = lcg(42);

    img.fillRect(0, 0, size, size, hex('#9a8f80'));
    const t = size / n;
    const gap = 3;
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const h = 32 + rand() * 8;
            const s = 22 + rand() * 10;
            const l = 68 + rand() * 10;
            img.fillRect(i * t + gap, j * t + gap, t - gap * 2, t - gap * 2, hsl(h, s, l));
        }
    }
    const px = img.data;
    for (let k = 0; k < px.length; k += 4) {
        const v = (rand() - 0.5) * 22;
        px[k] += v;
        px[k + 1] += v * 0.95;
        px[k + 2] += v * 0.85;
    }
    for (let k = 0; k < 900; k++) {
        const color: RGB = rand() < 0.5 ? [60, 50, 40] : [255, 250, 240];
        const alpha = 0.05 + rand() * 0.12;
        const radius = 1 + rand() * 5;
        img.fillCircle(rand() * size, rand() * size, radius, color, alpha);
    }
    return createMipmappedTexture(img);
}

/**
 * Bakes the sky of `pool-sky.effect` into a float cube map (values above 1 near
 * the sun are kept). Faces follow the GL cube map layout: +X, -X, +Y, -Y, +Z, -Z,
 * row 0 first, so `texture(skyTex, worldDirection)` returns the sky colour.
 */
export function createSkyCubemap(light: Readonly<Vec3>, size = 256): TextureCube {
    const cube = new TextureCube();
    cube.reset({ width: size, height: size, format: Texture2D.PixelFormat.RGBA32F, mipmapLevel: 1 });
    cube.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
    cube.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);

    const sun = Vec3.normalize(new Vec3(), light);
    const dir = new Vec3();
    const color: RGB = [0, 0, 0];
    const face = new Float32Array(size * size * 4);
    for (let f = 0; f < 6; f++) {
        for (let j = 0; j < size; j++) {
            const tc = ((j + 0.5) / size) * 2 - 1;
            for (let i = 0; i < size; i++) {
                const sc = ((i + 0.5) / size) * 2 - 1;
                cubeFaceDirection(f, sc, tc, dir);
                skyColor(dir.normalize(), sun, color);
                const k = (j * size + i) * 4;
                face[k] = color[0];
                face[k + 1] = color[1];
                face[k + 2] = color[2];
                face[k + 3] = 1;
            }
        }
        cube.uploadData(face, 0, f);
    }
    return cube;
}

// ---------------------------------------------------------------------------
// Sky formula (keep in sync with pool-sky.effect)
// ---------------------------------------------------------------------------

function cubeFaceDirection(face: number, sc: number, tc: number, out: Vec3): Vec3 {
    switch (face) {
        case 0: return out.set(1, -tc, -sc);
        case 1: return out.set(-1, -tc, sc);
        case 2: return out.set(sc, 1, tc);
        case 3: return out.set(sc, -1, -tc);
        case 4: return out.set(sc, -tc, 1);
        default: return out.set(-sc, -tc, -1);
    }
}

function skyColor(d: Readonly<Vec3>, sun: Readonly<Vec3>, out: RGB): void {
    const sunDot = Math.max(Vec3.dot(d, sun), 0);

    let r: number, g: number, b: number;
    if (d.y >= 0) {
        const k = Math.pow(d.y, 0.45);
        r = mix(0.72, 0.10, k); g = mix(0.84, 0.32, k); b = mix(0.95, 0.75, k);
    } else {
        const k = smoothstep(0, 0.2, -d.y);
        r = mix(0.72, 0.46, k); g = mix(0.84, 0.48, k); b = mix(0.95, 0.50, k);
    }

    const glow = Math.pow(sunDot, 10) * 0.25;
    r += glow; g += 0.85 * glow; b += 0.6 * glow;
    const halo = Math.pow(sunDot, 180) * 0.6;
    r += halo; g += 0.92 * halo; b += 0.8 * halo;

    if (d.y > 0) {
        const s = 1.3 / (d.y + 0.1);
        let c = fbm(d.x * s * 1.4 + 3, d.z * s * 1.4 + 3);
        c = smoothstep(0.52, 0.85, c) * smoothstep(0, 0.18, d.y) * 0.9;
        const k = Math.pow(sunDot, 3);
        r = mix(r, mix(0.82, 1.0, k), c);
        g = mix(g, mix(0.86, 0.98, k), c);
        b = mix(b, mix(0.92, 0.94, k), c);
    }

    const disc = smoothstep(0.9994, 0.9998, sunDot);
    out[0] = r + disc * 3.0;
    out[1] = g + disc * 2.7;
    out[2] = b + disc * 2.2;
}

function hash(x: number, y: number): number {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
}

function noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return mix(
        mix(hash(ix, iy), hash(ix + 1, iy), ux),
        mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux),
        uy,
    );
}

function fbm(x: number, y: number): number {
    let v = 0;
    let a = 0.5;
    for (let i = 0; i < 6; i++) {
        v += a * noise(x, y);
        x = x * 2.03 + 1.7;
        y = y * 2.03 + 9.2;
        a *= 0.5;
    }
    return v;
}

function mix(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Tiny 8-bit raster (the subset of canvas 2D the textures need)
// ---------------------------------------------------------------------------

class Image8 {
    readonly data: Uint8ClampedArray;

    constructor(readonly size: number) {
        this.data = new Uint8ClampedArray(size * size * 4);
    }

    /** Rectangles may have fractional edges (1024 / 12 px tiles); they snap to the nearest pixel edge. */
    fillRect(x: number, y: number, w: number, h: number, color: RGB, alpha = 1): void {
        const x0 = Math.round(x);
        const x1 = Math.round(x + w);
        for (let py = Math.round(y), y1 = Math.round(y + h); py < y1; py++) {
            for (let px = x0; px < x1; px++) this.blend(px, py, color, alpha);
        }
    }

    /** Linear gradient from the top-left corner to the bottom-right corner of a w x w square. */
    fillDiagonalGradient(x: number, y: number, w: number, from: RGB, to: RGB): void {
        const color: RGB = [0, 0, 0];
        const x0 = Math.round(x);
        const x1 = Math.round(x + w);
        for (let py = Math.round(y), y1 = Math.round(y + w); py < y1; py++) {
            for (let px = x0; px < x1; px++) {
                const t = (px + 0.5 - x + py + 0.5 - y) / (2 * w);
                color[0] = mix(from[0], to[0], t);
                color[1] = mix(from[1], to[1], t);
                color[2] = mix(from[2], to[2], t);
                this.blend(px, py, color, 1);
            }
        }
    }

    /** Anti-aliased disc, blended source-over. */
    fillCircle(cx: number, cy: number, radius: number, color: RGB, alpha: number): void {
        const x0 = Math.max(0, Math.floor(cx - radius - 1));
        const x1 = Math.min(this.size - 1, Math.ceil(cx + radius + 1));
        const y0 = Math.max(0, Math.floor(cy - radius - 1));
        const y1 = Math.min(this.size - 1, Math.ceil(cy + radius + 1));
        for (let py = y0; py <= y1; py++) {
            for (let px = x0; px <= x1; px++) {
                const coverage = Math.min(Math.max(radius - Math.hypot(px + 0.5 - cx, py + 0.5 - cy) + 0.5, 0), 1);
                if (coverage > 0) this.blend(px, py, color, alpha * coverage);
            }
        }
    }

    private blend(px: number, py: number, color: RGB, alpha: number): void {
        const k = (py * this.size + px) * 4;
        const d = this.data;
        d[k] = d[k] + (color[0] - d[k]) * alpha;
        d[k + 1] = d[k + 1] + (color[1] - d[k + 1]) * alpha;
        d[k + 2] = d[k + 2] + (color[2] - d[k + 2]) * alpha;
        d[k + 3] = 255;
    }
}

/**
 * Uploads `img` with a box-filtered mip chain, repeat wrapping and anisotropic
 * filtering. Rows are flipped so image row 0 lands at v = 1, like a three.js
 * CanvasTexture (flipY), which the tile-lookup coordinates were written for.
 */
function createMipmappedTexture(img: Image8): Texture2D {
    const levels = Math.log2(img.size) + 1;
    const texture = new Texture2D();
    texture.reset({ width: img.size, height: img.size, format: Texture2D.PixelFormat.RGBA8888, mipmapLevel: levels });

    let size = img.size;
    let level = flipRows(img.data, size);
    for (let mip = 0; mip < levels; mip++) {
        texture.uploadData(level, mip);
        if (size > 1) {
            level = downsample(level, size);
            size >>= 1;
        }
    }
    texture.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
    texture.setMipFilter(Texture2D.Filter.LINEAR);
    texture.setWrapMode(Texture2D.WrapMode.REPEAT, Texture2D.WrapMode.REPEAT);
    texture.setAnisotropy(16);
    return texture;
}

function flipRows(src: Uint8ClampedArray, size: number): Uint8Array {
    const out = new Uint8Array(src.length);
    const stride = size * 4;
    for (let y = 0; y < size; y++) {
        out.set(src.subarray(y * stride, (y + 1) * stride), (size - 1 - y) * stride);
    }
    return out;
}

function downsample(src: Uint8Array, size: number): Uint8Array {
    const half = size >> 1;
    const out = new Uint8Array(half * half * 4);
    for (let y = 0; y < half; y++) {
        for (let x = 0; x < half; x++) {
            const a = ((y * 2) * size + x * 2) * 4;
            const b = a + size * 4;
            const o = (y * half + x) * 4;
            for (let c = 0; c < 4; c++) {
                out[o + c] = (src[a + c] + src[a + 4 + c] + src[b + c] + src[b + 4 + c] + 2) >> 2;
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

/** Same sequence as the three.js demo's seeded generator. */
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

function hex(value: string): RGB {
    const v = parseInt(value.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** CSS hsl(h, s%, l%) as 0-255 RGB. */
function hsl(h: number, s: number, l: number): RGB {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const channel = (n: number) => {
        const k = (n + h / 30) % 12;
        return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
    };
    return [channel(0), channel(8), channel(4)];
}
