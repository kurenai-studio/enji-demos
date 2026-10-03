import { smoothstep, vAdd, vCross, vDot, vec, vLen, vMad, vNorm, vSub, type Vec } from './Math3';
import type { Skeleton } from './Skeleton';

/** A skinned mesh in the bind pose: up to four joint influences per vertex. */
export interface SkinnedMesh {
    positions: number[];
    normals: number[];
    /** rgba; alpha 1 marks the shirt, which takes each character's tint. */
    colors: number[];
    joints: number[];
    weights: number[];
    indices: number[];
}

const SHIRT = [0.2, 0.55, 0.62, 1];
const PANTS = [0.2, 0.24, 0.38, 0];
const SKIN = [0.88, 0.66, 0.52, 0];
const SHOE = [0.16, 0.14, 0.13, 0];
const SIDES = 14;
const STEP = 0.022;

export interface ProfileKey {
    /** Fraction of the chain length. */
    at: number;
    /** Radii along the two cross-section axes. */
    r1: number;
    r2: number;
}

export interface Chain {
    points: Vec[];
    /** Joint driving each segment (points.length − 1 entries). */
    joints: number[];
    profile: ProfileKey[];
    /** Half-width of the weight blend around each interior joint (m). */
    blend: number;
    color: (segment: number, along: number) => number[];
    capStart: boolean;
    capEnd: boolean;
}

export function emptyMesh(): SkinnedMesh {
    return { positions: [], normals: [], colors: [], joints: [], weights: [], indices: [] };
}

function pushVertex(m: SkinnedMesh, p: Vec, n: Vec, color: number[], j0: number, j1: number, w1: number): number {
    const index = m.positions.length / 3;
    m.positions.push(p.x, p.y, p.z);
    m.normals.push(n.x, n.y, n.z);
    m.colors.push(color[0], color[1], color[2], color[3]);
    m.joints.push(j0, j1, 0, 0);
    m.weights.push(1 - w1, w1, 0, 0);
    return index;
}

function radiusAt(profile: ProfileKey[], f: number): [number, number] {
    if (f <= profile[0].at) return [profile[0].r1, profile[0].r2];
    for (let k = 1; k < profile.length; k++) {
        const a = profile[k - 1], b = profile[k];
        if (f <= b.at) {
            const t = (f - a.at) / (b.at - a.at);
            return [a.r1 + (b.r1 - a.r1) * t, a.r2 + (b.r2 - a.r2) * t];
        }
    }
    const last = profile[profile.length - 1];
    return [last.r1, last.r2];
}

/**
 * A tube along a polyline of joints with elliptical cross-sections. Near an
 * interior joint the two segment joints share the weight over ±blend, which
 * is the usual smooth-skinned elbow or knee (and where linear blending
 * collapses when the joint bends or twists far).
 */
export function addChain(m: SkinnedMesh, c: Chain): void {
    const lengths = [0];
    for (let i = 1; i < c.points.length; i++) lengths.push(lengths[i - 1] + vLen(vSub(vec(), c.points[i], c.points[i - 1])));
    const total = lengths[lengths.length - 1];
    // Stations every STEP, plus exactly at every point.
    const stations = new Set<number>();
    for (let s = 0; s < total; s += STEP) stations.add(s);
    for (const l of lengths) stations.add(l);
    const sorted = [...stations].sort((a, b) => a - b).filter((s, i, arr) => i === 0 || s - arr[i - 1] > 1e-6);
    const rings: number[] = [];
    const tangents: Vec[] = [];
    const centres: Vec[] = [];
    const ringJoints: [number, number, number][] = [];
    for (const s of sorted) {
        let seg = 0;
        while (seg < c.points.length - 2 && s > lengths[seg + 1]) seg++;
        const a = c.points[seg], b = c.points[seg + 1];
        const f = (s - lengths[seg]) / Math.max(1e-9, lengths[seg + 1] - lengths[seg]);
        const p = vMad(vec(), a, vSub(vec(), b, a), f);
        const t = vNorm(vec(), vSub(vec(), b, a));
        // At a point shared by two segments, use the mean direction.
        const atJoint = lengths.findIndex((l) => Math.abs(l - s) < 1e-6);
        if (atJoint > 0 && atJoint < c.points.length - 1) {
            const prev = vNorm(vec(), vSub(vec(), c.points[atJoint], c.points[atJoint - 1]));
            const next = vNorm(vec(), vSub(vec(), c.points[atJoint + 1], c.points[atJoint]));
            vNorm(t, vAdd(t, prev, next));
        }
        // Weight between the segment joints around the nearest interior point.
        let j0 = c.joints[seg], j1 = c.joints[seg], w1 = 0;
        for (let k = 1; k < c.points.length - 1; k++) {
            const d = s - lengths[k];
            if (Math.abs(d) < c.blend && c.joints[k - 1] !== c.joints[k]) {
                j0 = c.joints[k - 1];
                j1 = c.joints[k];
                w1 = smoothstep(-c.blend, c.blend, d);
            }
        }
        ringJoints.push([j0, j1, w1]);
        centres.push(p);
        tangents.push(t);
        const ref = Math.abs(t.y) > 0.7 ? vec(1, 0, 0) : vec(0, 1, 0);
        const e1 = vNorm(vec(), vMad(vec(), ref, t, -vDot(ref, t)));
        const e2 = vCross(vec(), t, e1);
        const [r1, r2] = radiusAt(c.profile, s / total);
        const color = c.color(seg, f);
        rings.push(m.positions.length / 3);
        for (let k = 0; k < SIDES; k++) {
            const th = (2 * Math.PI * k) / SIDES;
            const cs = Math.cos(th), sn = Math.sin(th);
            const q = vMad(vec(), vMad(vec(), p, e1, r1 * cs), e2, r2 * sn);
            const n = vNorm(vec(), vMad(vec(), vMad(vec(), vec(), e1, cs / r1), e2, sn / r2));
            pushVertex(m, q, n, color, j0, j1, w1);
        }
    }
    for (let r = 0; r + 1 < rings.length; r++) {
        for (let k = 0; k < SIDES; k++) {
            const a = rings[r] + k, b = rings[r] + ((k + 1) % SIDES);
            const d = rings[r + 1] + k, e = rings[r + 1] + ((k + 1) % SIDES);
            m.indices.push(a, b, e, a, e, d);
        }
    }
    const cap = (r: number, outward: number) => {
        const t = vec(tangents[r].x * outward, tangents[r].y * outward, tangents[r].z * outward);
        const [j0, j1, w1] = ringJoints[r];
        const centreColor = m.colors.slice(rings[r] * 4, rings[r] * 4 + 4);
        const centre = pushVertex(m, centres[r], t, centreColor, j0, j1, w1);
        for (let k = 0; k < SIDES; k++) {
            const a = rings[r] + k, b = rings[r] + ((k + 1) % SIDES);
            if (outward > 0) m.indices.push(a, b, centre);
            else m.indices.push(b, a, centre);
        }
    };
    if (c.capStart) cap(0, -1);
    if (c.capEnd) cap(rings.length - 1, 1);
}

/** Ellipsoid weighted fully to one joint. */
function addEllipsoid(m: SkinnedMesh, centre: Vec, rx: number, ry: number, rz: number, joint: number, color: number[]): void {
    const stacks = 10, slices = 16;
    const first = m.positions.length / 3;
    for (let i = 0; i <= stacks; i++) {
        const v = (Math.PI * i) / stacks;
        for (let k = 0; k <= slices; k++) {
            const u = (2 * Math.PI * k) / slices;
            const nx = Math.sin(v) * Math.cos(u), ny = Math.cos(v), nz = Math.sin(v) * Math.sin(u);
            const p = vec(centre.x + rx * nx, centre.y + ry * ny, centre.z + rz * nz);
            const n = vNorm(vec(), vec(nx / rx, ny / ry, nz / rz));
            pushVertex(m, p, n, color, joint, joint, 0);
        }
    }
    for (let i = 0; i < stacks; i++) {
        for (let k = 0; k < slices; k++) {
            const a = first + i * (slices + 1) + k;
            const b = a + slices + 1;
            m.indices.push(a, a + 1, b + 1, a, b + 1, b);
        }
    }
}

/** The character: torso, neck and head, two arms with hands, two legs with feet. About 3k vertices. */
export function buildBody(skel: Skeleton): SkinnedMesh {
    const m = emptyMesh();
    const j = (n: string) => skel.index(n);
    const at = (n: string, dx = 0, dy = 0, dz = 0) => {
        const b = skel.bind[j(n)];
        return vec(b.x + dx, b.y + dy, b.z + dz);
    };
    addChain(m, {
        points: [at('pelvis', 0, -0.13), at('pelvis'), at('spine'), at('chest'), at('neck', 0, -0.03)],
        joints: [j('pelvis'), j('pelvis'), j('spine'), j('chest')],
        profile: [
            { at: 0, r1: 0.12, r2: 0.085 }, { at: 0.2, r1: 0.16, r2: 0.1 }, { at: 0.4, r1: 0.145, r2: 0.092 },
            { at: 0.75, r1: 0.175, r2: 0.11 }, { at: 0.9, r1: 0.16, r2: 0.095 }, { at: 1, r1: 0.07, r2: 0.06 },
        ],
        blend: 0.07,
        color: (seg, f) => (seg === 0 || (seg === 1 && f < 0.3) ? PANTS : SHIRT),
        capStart: true,
        capEnd: true,
    });
    addChain(m, {
        points: [at('neck', 0, -0.06), at('neck'), at('head', 0, 0.02)],
        joints: [j('chest'), j('neck')],
        profile: [{ at: 0, r1: 0.055, r2: 0.05 }, { at: 1, r1: 0.05, r2: 0.048 }],
        blend: 0.03,
        color: () => SKIN,
        capStart: false,
        capEnd: false,
    });
    addEllipsoid(m, at('head', 0, 0.09, 0.01), 0.095, 0.115, 0.105, j('head'), SKIN);
    for (const s of ['L', 'R']) {
        const sign = s === 'L' ? 1 : -1;
        addChain(m, {
            points: [at(`upperArm.${s}`, -sign * 0.05, 0.01), at(`upperArm.${s}`), at(`forearm.${s}`), at(`hand.${s}`), at(`hand.${s}`, 0, -0.16)],
            joints: [j('chest'), j(`upperArm.${s}`), j(`forearm.${s}`), j(`hand.${s}`)],
            profile: [
                { at: 0, r1: 0.04, r2: 0.045 }, { at: 0.1, r1: 0.055, r2: 0.056 }, { at: 0.3, r1: 0.05, r2: 0.052 },
                { at: 0.49, r1: 0.041, r2: 0.043 }, { at: 0.6, r1: 0.044, r2: 0.046 }, { at: 0.8, r1: 0.03, r2: 0.034 },
                { at: 0.9, r1: 0.022, r2: 0.042 }, { at: 1, r1: 0.014, r2: 0.03 },
            ],
            blend: 0.05,
            color: (seg, f) => (seg <= 1 && !(seg === 1 && f > 0.6) ? SHIRT : SKIN),
            capStart: true,
            capEnd: true,
        });
        addChain(m, {
            points: [at(`thigh.${s}`, 0, 0.09), at(`thigh.${s}`), at(`shin.${s}`), at(`foot.${s}`, 0, 0.01)],
            joints: [j('pelvis'), j(`thigh.${s}`), j(`shin.${s}`)],
            profile: [
                { at: 0, r1: 0.085, r2: 0.085 }, { at: 0.15, r1: 0.088, r2: 0.088 }, { at: 0.35, r1: 0.075, r2: 0.078 },
                { at: 0.55, r1: 0.054, r2: 0.056 }, { at: 0.7, r1: 0.06, r2: 0.062 }, { at: 1, r1: 0.04, r2: 0.042 },
            ],
            blend: 0.06,
            color: () => PANTS,
            capStart: false,
            capEnd: true,
        });
        const ankle = at(`foot.${s}`);
        const ball = at(`toe.${s}`);
        addChain(m, {
            points: [vec(ankle.x, 0.045, -0.065), vec(ankle.x, 0.042, 0.02), vec(ball.x, 0.034, ball.z), vec(ball.x, 0.028, ball.z + 0.085)],
            joints: [j(`foot.${s}`), j(`foot.${s}`), j(`toe.${s}`)],
            // Horizontal tube: the first axis is up, the second sideways.
            profile: [
                { at: 0, r1: 0.04, r2: 0.04 }, { at: 0.3, r1: 0.05, r2: 0.047 }, { at: 0.68, r1: 0.033, r2: 0.048 }, { at: 1, r1: 0.02, r2: 0.035 },
            ],
            blend: 0.03,
            color: () => SHOE,
            capStart: true,
            capEnd: true,
        });
    }
    return m;
}

/** One octahedron per joint pointing at its first child (leaves get a short stub), weighted fully to the joint. */
export function buildBones(skel: Skeleton): SkinnedMesh {
    const m = emptyMesh();
    const color = [1, 0.85, 0.35, 0];
    const stub: Record<string, Vec> = { head: vec(0, 0.2, 0), 'hand.L': vec(0, -0.12, 0), 'hand.R': vec(0, -0.12, 0), 'toe.L': vec(0, 0, 0.08), 'toe.R': vec(0, 0, 0.08) };
    skel.joints.forEach((joint, i) => {
        const from = skel.bind[i];
        const child = skel.joints.findIndex((c) => c.parent === i);
        const to = child >= 0 ? skel.bind[child] : vAdd(vec(), from, stub[joint.name] ?? vec(0, 0.05, 0));
        const axis = vSub(vec(), to, from);
        const len = vLen(axis);
        const t = vNorm(vec(), axis);
        const ref = Math.abs(t.y) > 0.7 ? vec(1, 0, 0) : vec(0, 1, 0);
        const e1 = vNorm(vec(), vMad(vec(), ref, t, -vDot(ref, t)));
        const e2 = vCross(vec(), t, e1);
        const w = Math.min(0.03, Math.max(0.012, 0.12 * len));
        const mid = vMad(vec(), from, t, 0.18 * len);
        const ring = [0, 1, 2, 3].map((k) => {
            const a = (Math.PI / 2) * k;
            return vMad(vec(), vMad(vec(), mid, e1, w * Math.cos(a)), e2, w * Math.sin(a));
        });
        for (let k = 0; k < 4; k++) {
            const r0 = ring[k], r1 = ring[(k + 1) % 4];
            for (const [p, q, r] of [[from, r1, r0], [r0, r1, to]]) {
                const n = vNorm(vec(), vCross(vec(), vSub(vec(), q, p), vSub(vec(), r, p)));
                const base = m.positions.length / 3;
                for (const v of [p, q, r]) pushVertex(m, v, n, color, i, i, 0);
                m.indices.push(base, base + 1, base + 2);
            }
        }
    });
    return m;
}
