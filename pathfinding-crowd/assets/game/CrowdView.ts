import { Material, Mesh, MeshRenderer, Node, primitives, utils } from 'cc';
import { updateDynamicMesh } from '../enji/helpers';
import type { Grid } from './nav/Grid';
import type { Swarm } from './nav/Swarm';

type RGB = readonly [number, number, number];

export const GROUP_COLORS: readonly RGB[] = [[1.0, 0.56, 0.2], [0.28, 0.72, 1.0]];
const FLOOR: RGB = [0.16, 0.18, 0.22];
const WALL_TOP: RGB = [0.5, 0.52, 0.58];
const WALL_HEIGHT = 1.1;
const AGENT_HEIGHT = 0.55;
const OVERLAY_Y = 0.03;

/** Vertices and indices written from scratch each update and drawn as one dynamic mesh. */
class DynamicBatch {
    readonly renderer: MeshRenderer;
    private readonly positions: Float32Array;
    private readonly colors: Float32Array;
    private readonly indices: Uint32Array;
    private nv = 0;
    private ni = 0;
    private readonly minPos: { x: number; y: number; z: number };
    private readonly maxPos: { x: number; y: number; z: number };

    constructor(parent: Node, name: string, material: Material, maxVertices: number, maxIndices: number, halfW: number, halfH: number) {
        this.positions = new Float32Array(3 * maxVertices);
        this.colors = new Float32Array(4 * maxVertices);
        this.indices = new Uint32Array(maxIndices);
        this.minPos = { x: -halfW - 1, y: -1, z: -halfH - 1 };
        this.maxPos = { x: halfW + 1, y: 3, z: halfH + 1 };
        const node = new Node(name);
        parent.addChild(node);
        this.renderer = node.addComponent(MeshRenderer);
        // The mesh only gets vertex streams for attributes that are non-empty at creation.
        this.nv = maxVertices;
        this.ni = maxIndices;
        this.renderer.mesh = utils.MeshUtils.createDynamicMesh(0, this.geometry(), undefined, {
            maxSubMeshes: 1, maxSubMeshVertices: maxVertices, maxSubMeshIndices: maxIndices,
        });
        this.nv = this.ni = 0;
        this.renderer.setSharedMaterial(material, 0);
        this.renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        this.renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
    }

    get capacityLeft(): number {
        return Math.min(this.positions.length / 3 - this.nv, (this.indices.length - this.ni) / 1.5);
    }

    begin(): void {
        this.nv = this.ni = 0;
    }

    vertex(x: number, y: number, z: number, c: RGB, k = 1): number {
        const v = this.nv++;
        this.positions[3 * v] = x; this.positions[3 * v + 1] = y; this.positions[3 * v + 2] = z;
        this.colors[4 * v] = Math.min(1, c[0] * k); this.colors[4 * v + 1] = Math.min(1, c[1] * k);
        this.colors[4 * v + 2] = Math.min(1, c[2] * k); this.colors[4 * v + 3] = 1;
        return v;
    }

    tri(a: number, b: number, c: number): void {
        this.indices[this.ni++] = a; this.indices[this.ni++] = b; this.indices[this.ni++] = c;
    }

    quad(a: number, b: number, c: number, d: number): void {
        this.tri(a, b, c);
        this.tri(a, c, d);
    }

    /** A flat quad on the ground plane: the segment (ax, az) → (bx, bz), `width` wide. */
    segment(ax: number, az: number, bx: number, bz: number, width: number, y: number, c: RGB): void {
        let nx = bz - az, nz = ax - bx;
        const l = Math.hypot(nx, nz) || 1;
        nx = (nx / l) * width * 0.5; nz = (nz / l) * width * 0.5;
        const v0 = this.vertex(ax - nx, y, az - nz, c), v1 = this.vertex(bx - nx, y, bz - nz, c);
        const v2 = this.vertex(bx + nx, y, bz + nz, c), v3 = this.vertex(ax + nx, y, az + nz, c);
        this.quad(v0, v1, v2, v3);
    }

    end(): void {
        updateDynamicMesh(this.renderer, this.geometry());
    }

    private geometry(): primitives.IDynamicGeometry {
        return {
            positions: this.positions.subarray(0, 3 * this.nv),
            colors: this.colors.subarray(0, 4 * this.nv),
            indices32: this.indices.subarray(0, this.ni),
            minPos: this.minPos,
            maxPos: this.maxPos,
        };
    }
}

/** Floor tiles and wall blocks for a grid, cell (x, y) at world x − w/2, z = y − h/2. */
export function mapMesh(grid: Grid): Mesh {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const ox = -grid.w / 2, oz = -grid.h / 2;
    const quad = (p: number[], c: RGB, k: number): void => {
        const base = positions.length / 3;
        positions.push(...p);
        for (let i = 0; i < 4; i++) colors.push(c[0] * k, c[1] * k, c[2] * k, 1);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let y = 0; y < grid.h; y++) {
        for (let x = 0; x < grid.w; x++) {
            const x0 = x + ox, x1 = x0 + 1, z0 = y + oz, z1 = z0 + 1;
            if (grid.free(x, y)) {
                quad([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1], FLOOR, (x + y) % 2 ? 1 : 1.12);
                continue;
            }
            const h = WALL_HEIGHT;
            quad([x0, h, z0, x1, h, z0, x1, h, z1, x0, h, z1], WALL_TOP, 1);
            if (grid.free(x + 1, y)) quad([x1, 0, z0, x1, 0, z1, x1, h, z1, x1, h, z0], WALL_TOP, 0.72);
            if (grid.free(x - 1, y)) quad([x0, 0, z1, x0, 0, z0, x0, h, z0, x0, h, z1], WALL_TOP, 0.58);
            if (grid.free(x, y + 1)) quad([x1, 0, z1, x0, 0, z1, x0, h, z1, x1, h, z1], WALL_TOP, 0.82);
            if (grid.free(x, y - 1)) quad([x0, 0, z0, x1, 0, z0, x1, h, z0, x0, h, z0], WALL_TOP, 0.48);
        }
    }
    return utils.MeshUtils.createMesh({ positions, colors, indices });
}

export type Overlay = 'none' | 'flow' | 'paths' | 'search';

export interface SearchView {
    astarCells: number[];
    jpsCells: number[];
    path: number[];
}

const HEX = Array.from({ length: 6 }, (_, k) => [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3)]);

/** Agents (hexagonal prisms with a nose showing the heading), target markers and the debug overlay. */
export class CrowdView {
    private readonly agents: DynamicBatch;
    private readonly overlay: DynamicBatch;
    private readonly ox: number;
    private readonly oz: number;
    private readonly heading: Float32Array;

    constructor(parent: Node, material: Material, grid: Grid, maxAgents: number) {
        this.ox = -grid.w / 2;
        this.oz = -grid.h / 2;
        this.agents = new DynamicBatch(parent, 'Agents', material, 21 * maxAgents + 200, 51 * maxAgents + 400, grid.w / 2, grid.h / 2);
        this.overlay = new DynamicBatch(parent, 'Overlay', material, 60000, 90000, grid.w / 2, grid.h / 2);
        this.heading = new Float32Array(2 * maxAgents);
    }

    updateAgents(swarm: Swarm): void {
        const b = this.agents;
        const crowd = swarm.crowd;
        const r = crowd.params.radius;
        b.begin();
        for (let i = 0; i < crowd.count; i++) {
            const x = crowd.px[i] + this.ox, z = crowd.py[i] + this.oz;
            // Heading eases towards the velocity so the nose does not flicker when an agent is pushed about.
            const vx = crowd.vx[i], vz = crowd.vy[i];
            if (vx * vx + vz * vz > 0.04) {
                const hx = this.heading[2 * i] * 0.8 + vx * 0.2, hz = this.heading[2 * i + 1] * 0.8 + vz * 0.2;
                const l = Math.hypot(hx, hz) || 1;
                this.heading[2 * i] = hx / l; this.heading[2 * i + 1] = hz / l;
            }
            const c = GROUP_COLORS[swarm.group[i]];
            const top: number[] = [];
            for (const [cx, cz] of HEX) top.push(b.vertex(x + cx * r, AGENT_HEIGHT, z + cz * r, c));
            b.tri(top[0], top[1], top[2]); b.tri(top[0], top[2], top[3]); b.tri(top[0], top[3], top[4]); b.tri(top[0], top[4], top[5]);
            for (let k = 0; k < 6; k++) {
                const [ax, az] = HEX[k], [bx, bz] = HEX[(k + 1) % 6];
                // Side faces lit from one direction.
                const shade = 0.5 + 0.25 * ((ax + bx) * 0.5 * 0.6 + (az + bz) * 0.5 * 0.8);
                const v0 = b.vertex(x + ax * r, 0, z + az * r, c, shade), v1 = b.vertex(x + bx * r, 0, z + bz * r, c, shade);
                const v2 = b.vertex(x + bx * r, AGENT_HEIGHT, z + bz * r, c, shade), v3 = b.vertex(x + ax * r, AGENT_HEIGHT, z + az * r, c, shade);
                b.quad(v0, v1, v2, v3);
            }
            const hx = this.heading[2 * i], hz = this.heading[2 * i + 1];
            const y = AGENT_HEIGHT + 0.01;
            const white: RGB = [1, 1, 1];
            b.tri(b.vertex(x + hx * r * 0.95, y, z + hz * r * 0.95, white),
                b.vertex(x - hz * r * 0.45, y, z + hx * r * 0.45, white, 0.8),
                b.vertex(x + hz * r * 0.45, y, z - hx * r * 0.45, white, 0.8));
        }
        // Target markers: a ring of posts around each target.
        for (let t = 0; t < 2; t++) {
            const [tx, ty] = swarm.targets[t];
            const c = GROUP_COLORS[1 - t];
            for (let k = 0; k < 8; k++) {
                const a = (k * Math.PI) / 4;
                const x = tx + this.ox + Math.cos(a) * 2.5, z = ty + this.oz + Math.sin(a) * 2.5;
                const s = 0.12, h = 1.6;
                const v = [b.vertex(x - s, 0, z - s, c, 0.7), b.vertex(x + s, 0, z + s, c, 0.7), b.vertex(x + s, h, z + s, c, 1.2), b.vertex(x - s, h, z - s, c, 1.2),
                    b.vertex(x - s, 0, z + s, c, 0.9), b.vertex(x + s, 0, z - s, c, 0.9), b.vertex(x + s, h, z - s, c, 1.2), b.vertex(x - s, h, z + s, c, 1.2)];
                b.quad(v[0], v[1], v[2], v[3]);
                b.quad(v[4], v[5], v[6], v[7]);
            }
        }
        b.end();
    }

    clearOverlay(): void {
        this.overlay.begin();
        this.overlay.end();
    }

    /**
     * Flow overlay: the field to `target`, cells tinted by congestion and an
     * arrow per cell (brighter where the cell sees the goal directly).
     */
    drawFlow(swarm: Swarm, target: number, density: Float32Array | null): void {
        const b = this.overlay;
        const grid = swarm.map.grid;
        const f = swarm.fields[target];
        const c = GROUP_COLORS[1 - target];
        b.begin();
        for (let y = 0; y < grid.h; y++) {
            for (let x = 0; x < grid.w; x++) {
                const i = y * grid.w + x;
                if (grid.blocked[i]) continue;
                const cx = x + 0.5 + this.ox, cz = y + 0.5 + this.oz;
                const d = density ? Math.min(1, density[i] / 4) : 0;
                if (d > 0.02) {
                    const red: RGB = [0.25 + 0.75 * d, 0.12, 0.16];
                    const v0 = b.vertex(cx - 0.48, OVERLAY_Y * 0.5, cz - 0.48, red), v1 = b.vertex(cx + 0.48, OVERLAY_Y * 0.5, cz - 0.48, red);
                    const v2 = b.vertex(cx + 0.48, OVERLAY_Y * 0.5, cz + 0.48, red), v3 = b.vertex(cx - 0.48, OVERLAY_Y * 0.5, cz + 0.48, red);
                    b.quad(v0, v1, v2, v3);
                }
                const dx = f.dir[2 * i], dz = f.dir[2 * i + 1];
                if (dx === 0 && dz === 0) continue;
                const k = f.sight[i] ? 1 : 0.6;
                b.tri(b.vertex(cx + dx * 0.42, OVERLAY_Y, cz + dz * 0.42, c, k),
                    b.vertex(cx - dx * 0.3 - dz * 0.16, OVERLAY_Y, cz - dz * 0.3 + dx * 0.16, c, k * 0.55),
                    b.vertex(cx - dx * 0.3 + dz * 0.16, OVERLAY_Y, cz - dz * 0.3 - dx * 0.16, c, k * 0.55));
            }
        }
        b.end();
    }

    /** Paths overlay: each agent's smoothed path from where it stands. */
    drawPaths(swarm: Swarm): void {
        const b = this.overlay;
        const crowd = swarm.crowd;
        b.begin();
        for (let i = 0; i < crowd.count && b.capacityLeft > 400; i++) {
            const p = swarm.paths[i];
            if (!p) continue;
            const c = GROUP_COLORS[swarm.group[i]];
            let ax = crowd.px[i], ay = crowd.py[i];
            for (let k = swarm.pathPos[i]; k < p.length / 2; k++) {
                b.segment(ax + this.ox, ay + this.oz, p[2 * k] + this.ox, p[2 * k + 1] + this.oz, 0.07, OVERLAY_Y, c);
                ax = p[2 * k]; ay = p[2 * k + 1];
            }
        }
        b.end();
    }

    /** Search overlay: cells A* expanded, JPS jump points, and the smoothed path between the targets. */
    drawSearch(grid: Grid, s: SearchView): void {
        const b = this.overlay;
        b.begin();
        const cell = (i: number, c: RGB, inset: number, y: number): void => {
            const x = (i % grid.w) + this.ox, z = Math.floor(i / grid.w) + this.oz;
            b.quad(b.vertex(x + inset, y, z + inset, c), b.vertex(x + 1 - inset, y, z + inset, c),
                b.vertex(x + 1 - inset, y, z + 1 - inset, c), b.vertex(x + inset, y, z + 1 - inset, c));
        };
        for (const i of s.astarCells) cell(i, [0.2, 0.32, 0.5], 0.06, OVERLAY_Y * 0.5);
        for (const i of s.jpsCells) cell(i, [1, 0.85, 0.3], 0.22, OVERLAY_Y);
        for (let k = 2; k < s.path.length; k += 2) {
            b.segment(s.path[k - 2] + this.ox, s.path[k - 1] + this.oz, s.path[k] + this.ox, s.path[k + 1] + this.oz, 0.18, OVERLAY_Y * 1.5, [0.4, 1, 0.55]);
        }
        b.end();
    }
}
