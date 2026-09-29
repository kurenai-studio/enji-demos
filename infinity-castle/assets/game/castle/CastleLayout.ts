import { Quat, Vec3 } from 'cc';
import { Rng } from './Rng';

/** Per-block data exported by tools/export_blocks.py (Cocos axes, block-local). */
export interface BlockInfo {
    lanterns: number[][];
    min: number[];
    max: number[];
    verts: number;
    faces: number;
}

export interface Placement {
    name: string;
    pos: Vec3;
    rot: Quat;
}

/** Height of one generated chunk of shaft: four 7 m storeys, like Z_LEVELS in the Blender script. */
export const CHUNK_HEIGHT = 28;
/** Half width of the shaft: the facade walls stand at x, z = ±SHAFT_W. */
export const SHAFT_W = 16;
/** Nothing may come closer than this to the shaft axis (the camera falls within 3 m of it). */
export const CLEAR_RADIUS = 4.5;

const FACADES = ['B_facade_0', 'B_facade_1', 'B_facade_2', 'B_facade_3'];
const WALL_KINDS = ['B_room_a', 'B_room_c', 'B_corr_a', 'B_corr_b', 'B_stair_a'];
const BRIDGE_KINDS = ['B_corr_a', 'B_corr_b', 'B_corr_c'];
const FLOAT_KINDS = ['B_room_b', 'B_stair_a', 'B_room_a', 'B_room_c'];
const YAWS = [0, 90, 180, 270];

const UP = new Vec3(0, 1, 0);
const AXIS_X = new Vec3(1, 0, 0);
const UPS = [UP, UP, UP, UP, new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

interface Wall {
    point: Vec3;
    rot: Quat;
    inward: Vec3;
    along: Vec3;
}

/** The four walls of facades, each facing into the shaft (facades face local +Z). */
const WALLS: Wall[] = [
    [new Vec3(0, 0, -SHAFT_W), 0],
    [new Vec3(0, 0, SHAFT_W), 180],
    [new Vec3(SHAFT_W, 0, 0), -90],
    [new Vec3(-SHAFT_W, 0, 0), 90],
].map(([point, yaw]) => {
    const rot = Quat.fromEuler(new Quat(), 0, yaw as number, 0);
    return {
        point: point as Vec3,
        rot,
        inward: Vec3.transformQuat(new Vec3(), new Vec3(0, 0, 1), rot),
        along: Vec3.transformQuat(new Vec3(), new Vec3(1, 0, 0), rot),
    };
});

function axisAngle(axis: Vec3, deg: number): Quat {
    return Quat.fromAxisAngle(new Quat(), axis, (deg * Math.PI) / 180);
}

/** Rotation taking local +Y to `up`, then spinning `yaw` degrees about it (`_up_frame`). */
function upFrame(up: Vec3, yaw: number): Quat {
    const align = new Quat();
    if (up.y < -0.999) Quat.fromAxisAngle(align, AXIS_X, Math.PI);
    else Quat.rotationTo(align, UP, up);
    return Quat.multiply(new Quat(), axisAngle(up, yaw), align);
}

export class CastleLayout {
    /** Column shift per wall bay, constant down the whole shaft so storeys line up. */
    private readonly colShift: number[][];

    constructor(private readonly seed: number, private readonly blocks: Record<string, BlockInfo>) {
        const rng = new Rng(seed);
        this.colShift = WALLS.map(() => [0, 1, 2, 3].map(() => rng.pick([0, 0, 1.75, 3.5, -1.75])));
    }

    /** Everything placed in chunk k (shaft y in [-(k+1) * H, -k * H]); same k -> same result. */
    chunk(k: number): Placement[] {
        const rng = Rng.forChunk(this.seed, k);
        const top = -k * CHUNK_HEIGHT;
        const out: Placement[] = [];
        const place = (name: string, pos: Vec3, rot: Quat) => {
            if (this.free(name, pos, rot)) out.push({ name, pos, rot });
        };

        // 1) walls of stacked facades; some bays sideways / upside down, some missing
        WALLS.forEach((wall, w) => {
            for (let level = 0; level < CHUNK_HEIGHT / 7; level++) {
                const y = top - 7 * (level + 1);
                const inset = rng.pick([0, 0, 0, 1.2, 2.4]);
                for (let i = 0; i < 4; i++) {
                    const pos = new Vec3(wall.point);
                    Vec3.scaleAndAdd(pos, pos, wall.along, -12 + 8 * i);
                    Vec3.scaleAndAdd(pos, pos, wall.inward, inset + rng.pick([0, 0, 0.8, -0.8]));
                    pos.y = y + this.colShift[w][i];
                    const spin = rng.next();
                    const name = rng.pick(FACADES);
                    let rot = wall.rot;
                    if (spin < 0.26) {
                        if (spin >= 0.2) continue;
                        const spinRot = axisAngle(wall.inward, spin < 0.12 ? rng.pick([90, -90]) : 180);
                        const offset = Vec3.transformQuat(new Vec3(), new Vec3(0, -3.5, 0), spinRot);
                        pos.y += 3.5;
                        pos.add(offset);
                        rot = Quat.multiply(new Quat(), spinRot, wall.rot);
                    }
                    out.push({ name, pos, rot });
                }
            }
        });

        // 2) rooms, corridors and stairs growing sideways out of the walls
        for (const wall of WALLS) {
            const count = 2 + (rng.next() < 0.5 ? 1 : 0);
            for (let n = 0; n < count; n++) {
                const pos = new Vec3(wall.point);
                Vec3.scaleAndAdd(pos, pos, wall.along, rng.uniform(-10, 10));
                Vec3.scaleAndAdd(pos, pos, wall.inward, 3.2);
                pos.y = rng.uniform(top - CHUNK_HEIGHT, top);
                const rot = upFrame(wall.inward, rng.pick(YAWS));
                place(rng.pick(WALL_KINDS), pos, rot);
            }
        }

        // 3) bridges spanning the shaft, always off-axis, some rolled sideways / upside down
        const bridges = rng.next() < 0.6 ? 2 : 1;
        for (let b = 0; b < bridges; b++) {
            const y = rng.uniform(top - CHUNK_HEIGHT, top);
            const alongX = rng.next() < 0.5;
            const c = (rng.next() < 0.5 ? -1 : 1) * rng.uniform(8.5, 11);
            const roll = rng.pick([0, 0, 0, 90, 180]);
            const name = rng.pick(BRIDGE_KINDS);
            const rolled = axisAngle(AXIS_X, roll);
            const rot = alongX ? rolled : Quat.multiply(new Quat(), axisAngle(UP, 90), rolled);
            const segs = [0, 1, 2, 3].map((i) => {
                const t = -12 + 8 * i;
                return alongX ? new Vec3(t, y, c) : new Vec3(c, y, t);
            });
            if (segs.every((p) => this.free(name, p, rot))) {
                for (const p of segs) out.push({ name, pos: p, rot });
            }
        }

        // 4) rooms and stairs floating in the void, any of the six gravity directions
        const floating = 2 + (rng.next() < 0.5 ? 1 : 0);
        for (let f = 0; f < floating; f++) {
            const a = rng.uniform(0, Math.PI * 2);
            const r = rng.uniform(10, 12.5);
            const pos = new Vec3(r * Math.cos(a), rng.uniform(top - CHUNK_HEIGHT, top), r * Math.sin(a));
            place(rng.pick(FLOAT_KINDS), pos, upFrame(rng.pick(UPS), rng.pick(YAWS)));
        }
        return out;
    }

    /**
     * Keeps the camera's cylinder around the shaft axis empty: a 3x3x3 grid of
     * points over the block's bounds (legs included) must stay outside it.
     */
    private free(name: string, pos: Vec3, rot: Quat): boolean {
        const info = this.blocks[name];
        const p = new Vec3();
        const local = new Vec3();
        for (let i = 0; i < 27; i++) {
            const u = [i % 3, Math.floor(i / 3) % 3, Math.floor(i / 9)];
            local.set(
                info.min[0] + ((info.max[0] - info.min[0]) * u[0]) / 2,
                info.min[1] + ((info.max[1] - info.min[1]) * u[1]) / 2,
                info.min[2] + ((info.max[2] - info.min[2]) * u[2]) / 2,
            );
            Vec3.transformQuat(p, local, rot).add(pos);
            if (Math.hypot(p.x, p.z) < CLEAR_RADIUS) return false;
        }
        return true;
    }
}
