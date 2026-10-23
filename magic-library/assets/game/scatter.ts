import { Quat, Vec3 } from 'cc';

const BOOK_H = 0.24;
const BOOK_D = 0.16;
const BOOK_T = 0.04;
const HALF_U = BOOK_H * 0.5 + 0.003;
const HALF_V = BOOK_D * 0.5 + 0.003;
const HASH = 0.3;
const CLUSTERS = 40;
const CLUSTER_SHARE = 0.32;
const CLUSTER_SIGMA = 0.55;
const CANDIDATES = 2;

export type BookPose = { x: number; y: number; z: number; rot: Quat };

type Foot = {
    x: number; z: number; yaw: number; flip: number;
    ux: number; uz: number; vx: number; vz: number; top: number;
};
type Block = { min_xz: readonly [number, number]; max_xz: readonly [number, number] };

function lcg(seed: number) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return (a?: number, b?: number) => {
        s = (s * 16807) % 2147483647;
        const f = (s - 1) / 2147483646;
        if (a !== undefined && b !== undefined) return a + (b - a) * f;
        return f;
    };
}

function gauss(rnd: (a?: number, b?: number) => number) {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

const FORWARD = new Vec3(0, 0, 1);
const heightAxis = new Vec3();
const depthAxis = new Vec3();

/** This mesh is thickness X, height Y, depth Z. ±90° around Z lays the cover flat. */
function flatRot(yawDeg: number, flipDeg: number, out: Quat) {
    Quat.fromAxisAngle(yawQ, UP, yawDeg * Math.PI / 180);
    Quat.fromAxisAngle(flipQ, FORWARD, flipDeg * Math.PI / 180);
    Quat.multiply(out, yawQ, flipQ);
}

function rect(x: number, z: number, yaw: number, flip: number): Foot {
    flatRot(yaw, flip, rotQ);
    Vec3.transformQuat(heightAxis, new Vec3(0, 1, 0), rotQ);
    Vec3.transformQuat(depthAxis, new Vec3(0, 0, 1), rotQ);
    return {
        x, z, yaw, flip, top: 0,
        ux: heightAxis.x, uz: heightAxis.z,
        vx: depthAxis.x, vz: depthAxis.z,
    };
}

function project(r: Foot, ax: number, az: number) {
    return HALF_U * Math.abs(r.ux * ax + r.uz * az) + HALF_V * Math.abs(r.vx * ax + r.vz * az);
}

function overlaps(a: Foot, b: Foot) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const axes: [number, number][] = [[a.ux, a.uz], [a.vx, a.vz], [b.ux, b.uz], [b.vx, b.vz]];
    for (const [ax, az] of axes) {
        if (Math.abs(dx * ax + dz * az) > project(a, ax, az) + project(b, ax, az)) return false;
    }
    return true;
}

const UP = new Vec3(0, 1, 0);
const HALF = new Vec3(0, BOOK_H * 0.5, 0);
const yawQ = new Quat();
const flipQ = new Quat();
const rotQ = new Quat();
const offset = new Vec3();

function makePose(r: Foot, base: number, floorY: number): BookPose {
    flatRot(r.yaw, r.flip, rotQ);
    const rot = new Quat();
    Quat.copy(rot, rotQ);
    Vec3.transformQuat(offset, HALF, rot);
    const cy = floorY + base + BOOK_T * 0.5 + 0.0005;
    return { x: r.x - offset.x, y: cy - offset.y, z: r.z - offset.z, rot };
}

function generate(count: number, seed: number, zone: readonly number[], blockers: readonly Block[], floorY: number, clear?: { x: number; z: number; r: number }) {
    const rnd = lcg(seed);
    const x0 = zone[0] + 0.2;
    const x1 = zone[1] - 0.2;
    const z0 = zone[2] + 0.15;
    const z1 = zone[3] - 0.15;
    const blocked = (x: number, z: number) => {
        if (x < x0 || x > x1 || z < z0 || z > z1) return true;
        if (clear && (x - clear.x) ** 2 + (z - clear.z) ** 2 < clear.r * clear.r) return true;
        for (const b of blockers) {
            if (x > b.min_xz[0] - 0.15 && x < b.max_xz[0] + 0.15
                && z > b.min_xz[1] - 0.15 && z < b.max_xz[1] + 0.15) return true;
        }
        return false;
    };
    const centers: [number, number][] = [];
    for (let i = 0; i < 2000 && centers.length < CLUSTERS; i++) {
        const x = rnd(x0, x1);
        const z = rnd(z0, z1);
        if (!blocked(x, z)) centers.push([x, z]);
    }
    const spot = () => {
        for (let i = 0; i < 30; i++) {
            let x: number;
            let z: number;
            if (centers.length > 0 && rnd() < CLUSTER_SHARE) {
                const idx = Math.floor(rnd(1, centers.length + 0.999)) - 1;
                const c = centers[idx] ?? centers[0];
                x = c[0] + gauss(rnd) * CLUSTER_SIGMA;
                z = c[1] + gauss(rnd) * CLUSTER_SIGMA;
            } else {
                x = rnd(x0, x1);
                z = rnd(z0, z1);
            }
            if (!blocked(x, z)) return [x, z] as const;
        }
        return [(x0 + x1) * 0.5, (z0 + z1) * 0.5] as const;
    };
    const hash = new Map<string, Foot[]>();
    const baseFor = (r: Foot) => {
        const cx = Math.floor(r.x / HASH);
        const cz = Math.floor(r.z / HASH);
        let base = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const bucket = hash.get(`${cx + dx},${cz + dz}`);
                if (!bucket) continue;
                for (const other of bucket) {
                    if (other.top > base && overlaps(r, other)) base = other.top;
                }
            }
        }
        return base;
    };
    const poses: BookPose[] = [];
    for (let i = 0; i < count; i++) {
        let best: { r: Foot; base: number } | null = null;
        for (let c = 0; c < CANDIDATES; c++) {
            const [x, z] = spot();
            const flip = rnd() < 0.5 ? 90 : -90;
            const r = rect(x, z, rnd(0, 360), flip);
            const base = baseFor(r);
            if (!best || base < best.base) best = { r, base };
        }
        const chosen = best!;
        chosen.r.top = chosen.base + BOOK_T + 0.0005;
        const key = `${Math.floor(chosen.r.x / HASH)},${Math.floor(chosen.r.z / HASH)}`;
        let bucket = hash.get(key);
        if (!bucket) hash.set(key, bucket = []);
        bucket.push(chosen.r);
        poses.push(makePose(chosen.r, chosen.base, floorY));
    }
    return poses;
}

type ScatterFloor = {
    y: number;
    floor_zone_xz: readonly number[];
    blockers: readonly Block[];
    holes?: readonly { min_xz: readonly [number, number]; max_xz: readonly [number, number] }[];
};

/** Same split as Maker: alternate copies across floors, each floor its own seeded pile. */
export function scatterFloors(
    count: number,
    floors: readonly ScatterFloor[],
    spawn: readonly number[],
): BookPose[] {
    if (floors.length === 0) return [];
    const per = floors.map(() => 0);
    for (let i = 0; i < count; i++) per[i % floors.length] += 1;
    const piles = floors.map((f, fl) => {
        const blockers: Block[] = [
            ...f.blockers,
            ...(f.holes ?? []).map((h) => ({ min_xz: h.min_xz, max_xz: h.max_xz })),
        ];
        return generate(
            per[fl],
            20261011 + fl,
            f.floor_zone_xz as [number, number, number, number],
            blockers,
            f.y,
            fl === 0 ? { x: spawn[0], z: spawn[2], r: 0.9 } : undefined,
        );
    });
    const used = floors.map(() => 0);
    const out: BookPose[] = [];
    for (let i = 0; i < count; i++) {
        const fl = i % floors.length;
        out.push(piles[fl][used[fl]++]);
    }
    return out;
}
