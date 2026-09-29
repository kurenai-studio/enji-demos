import { Texture2D, Vec3 } from 'cc';
import { createDataTexture } from '../../enji/helpers';

/**
 * Heightfield wave simulation on the CPU, uploaded every frame into an RGBA32F
 * texture (r = height, g = vertical velocity, b/a = surface normal x/z).
 *
 * Cell (i, j) is texel (i, j): u = (i + 0.5) / size maps to world x = u * 2 - 1
 * and v to world z, so shaders sample it at `worldPos.xz * 0.5 + 0.5`.
 * The update rules match the GPU passes of Evan Wallace's WebGL Water.
 */
export class WaterSimulation {
    readonly size: number;
    readonly texture: Texture2D;
    damping = 0.995;

    private info: Float32Array;
    private next: Float32Array;

    constructor(size = 256) {
        this.size = size;
        this.info = new Float32Array(size * size * 4);
        this.next = new Float32Array(size * size * 4);
        this.texture = createDataTexture(size, size, { float: true });
        this.upload();
    }

    reset(): void {
        this.info.fill(0);
    }

    /** Adds a cosine-shaped bump at world (x, z); `radius` is in texture units (world / 2). */
    addDrop(x: number, z: number, radius: number, strength: number): void {
        const n = this.size;
        const info = this.info;
        const cu = x * 0.5 + 0.5;
        const cv = z * 0.5 + 0.5;
        const [i0, i1] = cellRange(cu, radius, n);
        const [j0, j1] = cellRange(cv, radius, n);
        for (let j = j0; j <= j1; j++) {
            const dv = cv - (j + 0.5) / n;
            for (let i = i0; i <= i1; i++) {
                const du = cu - (i + 0.5) / n;
                let drop = Math.max(0, 1 - Math.sqrt(du * du + dv * dv) / radius);
                drop = 0.5 - Math.cos(drop * Math.PI) * 0.5;
                info[(j * n + i) * 4] += drop * strength;
            }
        }
    }

    /** Displaces water by the volume the sphere left (old) and entered (new). */
    moveSphere(oldCenter: Readonly<Vec3>, newCenter: Readonly<Vec3>, radius: number): void {
        this.applySphereVolume(oldCenter, radius, 1);
        this.applySphereVolume(newCenter, radius, -1);
    }

    /** One wave propagation step: velocity follows the neighbour average, then damps. */
    step(): void {
        const n = this.size;
        const src = this.info;
        const dst = this.next;
        const last = n - 1;
        for (let j = 0; j < n; j++) {
            const up = (j === 0 ? 0 : j - 1) * n;
            const down = (j === last ? last : j + 1) * n;
            const row = j * n;
            for (let i = 0; i < n; i++) {
                const k = (row + i) * 4;
                const left = i === 0 ? 0 : i - 1;
                const right = i === last ? last : i + 1;
                const average = (
                    src[(row + left) * 4] + src[(up + i) * 4] +
                    src[(row + right) * 4] + src[(down + i) * 4]
                ) * 0.25;
                const height = src[k];
                const velocity = (src[k + 1] + (average - height) * 2) * this.damping;
                dst[k] = height + velocity;
                dst[k + 1] = velocity;
                dst[k + 2] = src[k + 2];
                dst[k + 3] = src[k + 3];
            }
        }
        this.info = dst;
        this.next = src;
    }

    /** Recomputes b/a = normalize(cross(dz, dx)).xz from forward differences. */
    updateNormals(): void {
        const n = this.size;
        const info = this.info;
        const delta = 1 / n;
        const deltaSq = delta * delta;
        const last = n - 1;
        for (let j = 0; j < n; j++) {
            const row = j * n;
            const down = (j === last ? last : j + 1) * n;
            for (let i = 0; i < n; i++) {
                const k = (row + i) * 4;
                const height = info[k];
                const hx = info[(row + (i === last ? last : i + 1)) * 4] - height;
                const hz = info[(down + i) * 4] - height;
                const inv = 1 / Math.sqrt(hx * hx + hz * hz + deltaSq);
                info[k + 2] = -hx * inv;
                info[k + 3] = -hz * inv;
            }
        }
    }

    upload(): void {
        this.texture.uploadData(this.info);
    }

    private applySphereVolume(center: Readonly<Vec3>, radius: number, sign: number): void {
        // exp(-(1.5 t)^6) is below 1e-20 past t = 1.3, so only cells near the sphere change.
        const n = this.size;
        const info = this.info;
        const reach = (radius * 1.3) / 2;
        const [i0, i1] = cellRange(center.x * 0.5 + 0.5, reach, n);
        const [j0, j1] = cellRange(center.z * 0.5 + 0.5, reach, n);
        for (let j = j0; j <= j1; j++) {
            const dz = ((j + 0.5) / n) * 2 - 1 - center.z;
            for (let i = i0; i <= i1; i++) {
                const dx = ((i + 0.5) / n) * 2 - 1 - center.x;
                const t = Math.sqrt(dx * dx + center.y * center.y + dz * dz) / radius;
                const s = (t * 1.5) * (t * 1.5);
                const dy = Math.exp(-s * s * s);
                const ymin = Math.min(0, center.y - dy);
                const ymax = Math.min(Math.max(0, center.y + dy), ymin + 2 * dy);
                info[(j * n + i) * 4] += sign * (ymax - ymin) * 0.1;
            }
        }
    }
}

/** Inclusive range of cells whose centres lie within `radius` of texture coordinate `c`. */
function cellRange(c: number, radius: number, n: number): [number, number] {
    const lo = Math.max(0, Math.floor((c - radius) * n - 0.5));
    const hi = Math.min(n - 1, Math.ceil((c + radius) * n - 0.5));
    return [lo, hi];
}
