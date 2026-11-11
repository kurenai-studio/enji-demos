import { EventKeyboard, EventMouse, EventTouch, gfx, Input, input, KeyCode, Mat4, MeshRenderer, Node, Vec3 } from 'cc';

const EYE = 1.62;
const CROUCH = 1.02;
const RADIUS = 0.34;
const WALK = 4.2;
const SPRINT = 7.6;
const CROUCH_SPEED = 2.1;
const CELL = 0.8;
const ORIGIN_X = -46;
const ORIGIN_Z = -34;
const COLS = 114;
const ROWS = 88;

const wa = new Vec3();
const wb = new Vec3();
const wc = new Vec3();

/**
 * First-person walk. The harbor meshes are merged into hundred-thousand-triangle
 * chunks, so movement tests a grid baked once from those triangles: floor height
 * in each cell, and a blocked bit where a wall crosses chest height.
 */
export class Walker {
    yaw = 0;
    pitch = 0;
    private readonly pos = new Vec3();
    private readonly keys = new Set<number>();
    private readonly ground = new Float32Array(COLS * ROWS);
    private readonly blocked = new Uint8Array(COLS * ROWS);
    private readonly meshWorld = new Mat4();
    private velocityY = 0;
    private eye = EYE;
    private grounded = true;
    private dragging = false;
    private captured = false;
    private baked = false;
    private mouseLeft = false;
    private recoilP = 0;
    private recoilY = 0;
    private recoilHold = 0;
    private kickP = 0;
    private kickY = 0;
    private shake = 0;
    private shakeT = 0;
    moving = false;
    speed = 0;
    crouched = false;
    /** Hold to fire from the preview without pointer lock. */
    forceFire = false;
    /** Hold to aim from the preview without the right mouse button. */
    forceAim = false;
    /** 1 at the hip, 0.6 while the sight is up. The viewmodel writes this. */
    lookScale = 1;
    requestInspect = false;
    private requestReload = false;
    private mouseRight = false;
    lookYaw = 0;
    lookPitch = 0;

    constructor(private readonly node: Node) {
        this.ground.fill(-1e8);
    }

    capture(): void {
        this.node.getWorldPosition(this.pos);
        const euler = this.node.eulerAngles;
        this.yaw = euler.y;
        this.pitch = euler.x;
        this.captured = true;
    }

    bindInput(): void {
        input.on(Input.EventType.KEY_DOWN, (event: EventKeyboard) => {
            this.keys.add(event.keyCode);
            if (event.keyCode === KeyCode.KEY_F) this.requestInspect = true;
            if (event.keyCode === KeyCode.KEY_R) this.requestReload = true;
        });
        input.on(Input.EventType.KEY_UP, (event: EventKeyboard) => {
            this.keys.delete(event.keyCode);
        });
        const canvas = (globalThis as { document?: Document }).document?.querySelector('canvas');
        canvas?.addEventListener('contextmenu', (event) => event.preventDefault());
        input.on(Input.EventType.MOUSE_DOWN, (event: EventMouse) => {
            if (event.getButton() === EventMouse.BUTTON_RIGHT) {
                this.mouseRight = true;
                return;
            }
            if (event.getButton() !== EventMouse.BUTTON_LEFT) return;
            this.mouseLeft = true;
            this.dragging = true;
            canvas?.requestPointerLock?.();
        });
        input.on(Input.EventType.MOUSE_UP, (event: EventMouse) => {
            if (event.getButton() === EventMouse.BUTTON_RIGHT) {
                this.mouseRight = false;
                return;
            }
            if (event.getButton() !== EventMouse.BUTTON_LEFT) return;
            this.mouseLeft = false;
            this.dragging = false;
        });
        input.on(Input.EventType.MOUSE_MOVE, (event: EventMouse) => {
            const locked = (globalThis as { document?: Document }).document?.pointerLockElement != null;
            if (!this.dragging && !locked) return;
            const yaw = -event.getDeltaX() * 0.1 * this.lookScale;
            const pitch = event.getDeltaY() * 0.08 * this.lookScale;
            this.yaw += yaw;
            this.pitch = clamp(this.pitch + pitch, -85, 85);
            this.lookYaw += yaw;
            this.lookPitch += pitch;
        });
        input.on(Input.EventType.TOUCH_MOVE, (event: EventTouch) => {
            const delta = event.getDelta();
            this.yaw -= delta.x * 0.12;
            this.pitch = clamp(this.pitch + delta.y * 0.1, -85, 85);
        });
    }

    build(root: Node): void {
        const started = performance.now();
        let tris = 0;
        let skipped = 0;
        for (const mesh of root.getComponentsInChildren(MeshRenderer)) {
            const baked = this.bakeMesh(mesh);
            if (baked < 0) skipped += 1;
            else tris += baked;
        }
        this.keepLongWalls();
        this.baked = true;
        console.log('[saltline-enji] walk grid', tris, 'tris', skipped, 'unreadable', (performance.now() - started).toFixed(0), 'ms');
    }

    step(dt: number): void {
        const step = Math.min(dt, 0.05);
        if (!this.captured) this.capture();
        this.eye = this.held(KeyCode.KEY_C) ? CROUCH : EYE;
        this.crouched = this.eye < EYE - 0.1;
        this.recoilHold -= step;
        if (this.recoilHold <= 0) {
            this.recoilP = damp(this.recoilP, 0, 6.5, step);
            this.recoilY = damp(this.recoilY, 0, 6.5, step);
        }
        this.kickP = damp(this.kickP, this.recoilP, 34, step);
        this.kickY = damp(this.kickY, this.recoilY, 34, step);
        this.shake = Math.max(0, this.shake - 1.7 * step);
        this.shakeT += step;
        const shakeP = Math.sin(this.shakeT * 47) * this.shake * 1.4;
        const shakeY = Math.sin(this.shakeT * 36 + 1.3) * this.shake * 1.1;
        this.node.setRotationFromEuler(this.pitch + this.kickP + shakeP, this.yaw + this.kickY + shakeY, 0);

        const forward = this.node.forward;
        const right = this.node.right;
        let wishX = 0;
        let wishZ = 0;
        const fl = Math.hypot(forward.x, forward.z) || 1;
        const rl = Math.hypot(right.x, right.z) || 1;
        if (this.held(KeyCode.KEY_W)) {
            wishX += forward.x / fl;
            wishZ += forward.z / fl;
        }
        if (this.held(KeyCode.KEY_S)) {
            wishX -= forward.x / fl;
            wishZ -= forward.z / fl;
        }
        if (this.held(KeyCode.KEY_D)) {
            wishX += right.x / rl;
            wishZ += right.z / rl;
        }
        if (this.held(KeyCode.KEY_A)) {
            wishX -= right.x / rl;
            wishZ -= right.z / rl;
        }
        const wishLen = Math.hypot(wishX, wishZ);
        let speed = WALK;
        if (this.eye < EYE - 0.1) speed = CROUCH_SPEED;
        else if (this.held(KeyCode.SHIFT_LEFT) || this.held(KeyCode.SHIFT_RIGHT)) speed = SPRINT;
        this.moving = wishLen > 0.1;
        this.speed = this.moving ? speed : 0;
        if (wishLen > 1) {
            wishX /= wishLen;
            wishZ /= wishLen;
        }
        this.move(wishX * speed * step, wishZ * speed * step);

        const ground = this.baked ? this.heightAt(this.pos.x, this.pos.z) : null;
        if (this.grounded && this.held(KeyCode.SPACE) && ground !== null) this.velocityY = 5.2;
        this.velocityY -= 16 * step;
        this.pos.y += this.velocityY * step;
        const feet = this.pos.y - this.eye;
        if (ground !== null && this.velocityY <= 0 && feet <= ground + 0.12) {
            this.pos.y = ground + this.eye;
            this.velocityY = 0;
            this.grounded = true;
        } else {
            this.grounded = false;
        }
        if (this.pos.y < -12) {
            this.pos.set(-30, EYE, 5.8);
            this.velocityY = 0;
            this.grounded = true;
        }
        this.node.setPosition(this.pos);
    }

    /** Left mouse fires once the cursor is locked. The first click captures the mouse. */
    get firing(): boolean {
        const locked = (globalThis as { document?: Document }).document?.pointerLockElement != null;
        return this.forceFire || (this.mouseLeft && locked);
    }

    /** Right mouse holds the sight up. It does not need the cursor lock. */
    get aiming(): boolean {
        return this.forceAim || this.mouseRight;
    }

    takeReload(): boolean {
        const requested = this.requestReload;
        this.requestReload = false;
        return requested;
    }

    takeInspect(): boolean {
        const requested = this.requestInspect;
        this.requestInspect = false;
        return requested;
    }

    takeLook(): { yaw: number; pitch: number } {
        const look = { yaw: this.lookYaw, pitch: this.lookPitch };
        this.lookYaw = 0;
        this.lookPitch = 0;
        return look;
    }

    /** Pitch and yaw kicks are degrees. A fraction stays; the rest settles back. */
    addRecoil(pitch: number, yaw: number): void {
        const keep = 0.35;
        this.pitch = clamp(this.pitch + pitch * keep, -85, 85);
        this.yaw += yaw * keep;
        this.recoilP = clamp(this.recoilP + pitch * (1 - keep), -12, 12);
        this.recoilY = clamp(this.recoilY + yaw * (1 - keep), -8, 8);
        this.recoilHold = 0.09;
    }

    addShake(amount: number): void {
        this.shake = Math.min(1, this.shake + amount);
    }

    get eyeX(): number {
        return this.pos.x;
    }

    get eyeY(): number {
        return this.pos.y;
    }

    get eyeZ(): number {
        return this.pos.z;
    }

    groundAt(x: number, z: number): number | null {
        return this.heightAt(x, z);
    }

    /** Open apron: there is a floor and no wall cell underfoot. */
    footRoom(x: number, z: number): boolean {
        return this.heightAt(x, z) !== null && !this.solid(x, z);
    }

    /**
     * March a shot through the walk grid. The hit sits on the floor plane or
     * on the face of the wall cell, with that face's normal.
     */
    trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit {
        const len = Math.hypot(dx, dy, dz) || 1;
        const ix = dx / len;
        const iy = dy / len;
        const iz = dz / len;
        const step = 0.3;
        for (let t = 0.45; t <= maxDist; t += step) {
            const x = ox + ix * t;
            const y = oy + iy * t;
            const z = oz + iz * t;
            const ground = this.heightAt(x, z);
            if (ground !== null && y <= ground + 0.04) {
                let lo = Math.max(0.05, t - step);
                let hi = t;
                for (let k = 0; k < 6; k++) {
                    const mid = (lo + hi) * 0.5;
                    const g = this.heightAt(ox + ix * mid, oz + iz * mid);
                    if (g !== null && oy + iy * mid <= g + 0.04) hi = mid;
                    else lo = mid;
                }
                const hx = ox + ix * hi;
                const hz = oz + iz * hi;
                const g = this.heightAt(hx, hz) ?? ground;
                return { x: hx, y: g + 0.012, z: hz, nx: 0, ny: 1, nz: 0, dist: hi, hit: true };
            }
            if (ground !== null && this.solid(x, z) && y > ground + 0.2 && y < ground + 3.3) {
                const face = enterCell(ox, oy, oz, ix, iy, iz, x, z, ground);
                if (face) return face;
                const back = Math.max(0.2, t - step);
                return {
                    x: ox + ix * back, y: oy + iy * back, z: oz + iz * back,
                    nx: -ix, ny: 0, nz: -iz, dist: back, hit: true,
                };
            }
        }
        return {
            x: ox + ix * maxDist, y: oy + iy * maxDist, z: oz + iz * maxDist,
            nx: -ix, ny: -iy, nz: -iz, dist: maxDist, hit: false,
        };
    }

    private held(code: KeyCode): boolean {
        return this.keys.has(code);
    }

    /** Push the eye out of a body standing at (x, z). Walls still win. */
    avoid(x: number, z: number, radius: number): void {
        const dx = this.pos.x - x;
        const dz = this.pos.z - z;
        const dist = Math.hypot(dx, dz);
        const need = radius + RADIUS;
        if (dist >= need || dist < 1e-4) return;
        const scale = (need - dist) / dist;
        const nx = this.pos.x + dx * scale;
        const nz = this.pos.z + dz * scale;
        if (this.accept(nx, nz)) {
            this.pos.x = nx;
            this.pos.z = nz;
        } else if (this.accept(nx, this.pos.z)) this.pos.x = nx;
        else if (this.accept(this.pos.x, nz)) this.pos.z = nz;
    }

    private move(dx: number, dz: number): void {
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-5) return;
        const steps = Math.max(1, Math.ceil(dist / 0.08));
        const sx = dx / steps;
        const sz = dz / steps;
        for (let i = 0; i < steps; i++) {
            if (this.accept(this.pos.x + sx, this.pos.z + sz)) {
                this.pos.x += sx;
                this.pos.z += sz;
                continue;
            }
            if (this.accept(this.pos.x + sx, this.pos.z)) this.pos.x += sx;
            else if (this.accept(this.pos.x, this.pos.z + sz)) this.pos.z += sz;
            else break;
        }
    }

    private accept(x: number, z: number): boolean {
        if (this.hitsWall(x, z)) return false;
        if (!this.baked) return true;
        const next = this.heightAt(x, z);
        const here = this.heightAt(this.pos.x, this.pos.z);
        if (next === null || here === null) return false;
        return next - here <= 0.42;
    }

    private hitsWall(x: number, z: number): boolean {
        const diag = RADIUS * 0.72;
        return this.solid(x, z)
            || this.solid(x + RADIUS, z)
            || this.solid(x - RADIUS, z)
            || this.solid(x, z + RADIUS)
            || this.solid(x, z - RADIUS)
            || this.solid(x + diag, z + diag)
            || this.solid(x + diag, z - diag)
            || this.solid(x - diag, z + diag)
            || this.solid(x - diag, z - diag);
    }

    private solid(x: number, z: number): boolean {
        const i = (x - ORIGIN_X) / CELL;
        const j = (z - ORIGIN_Z) / CELL;
        const ix = Math.floor(i);
        const iz = Math.floor(j);
        if (ix < 0 || iz < 0 || ix >= COLS || iz >= ROWS) return false;
        return this.blocked[iz * COLS + ix] === 1;
    }

    private heightAt(x: number, z: number): number | null {
        const ix = Math.floor((x - ORIGIN_X) / CELL);
        const iz = Math.floor((z - ORIGIN_Z) / CELL);
        if (ix < 0 || iz < 0 || ix >= COLS || iz >= ROWS) return null;
        const h = this.ground[iz * COLS + ix];
        return h > -1e7 ? h : null;
    }

    private bakeMesh(mesh: MeshRenderer): number {
        const data = mesh.mesh;
        const node = mesh.node;
        if (!data) return -1;
        const matName = mesh.getSharedMaterial(0)?.name ?? '';
        if (/chainlink|decal|glass|label|rope|emissive/.test(matName)) return 0;
        this.meshWorld.set(node.worldMatrix);
        const world = this.meshWorld;
        const primitives = data.struct.primitives.length;
        let count = 0;
        for (let p = 0; p < primitives; p++) {
            const positions = data.readAttribute(p, gfx.AttributeName.ATTR_POSITION);
            const indices = data.readIndices(p);
            if (!positions || !indices) return -1;
            const triCount = Math.floor(indices.length / 3);
            for (let t = 0; t < triCount; t++) {
                this.place(positions, indices[t * 3], world, wa);
                this.place(positions, indices[t * 3 + 1], world, wb);
                this.place(positions, indices[t * 3 + 2], world, wc);
                this.stampTriangle();
            }
            count += triCount;
        }
        return count;
    }

    private place(positions: ArrayLike<number>, index: number, world: Mat4, out: Vec3): void {
        const o = index * 3;
        waScratch.x = positions[o];
        waScratch.y = positions[o + 1];
        waScratch.z = positions[o + 2];
        Vec3.transformMat4(out, waScratch, world);
    }

    private stampTriangle(): void {
        const abx = wb.x - wa.x;
        const aby = wb.y - wa.y;
        const abz = wb.z - wa.z;
        const acx = wc.x - wa.x;
        const acy = wc.y - wa.y;
        const acz = wc.z - wa.z;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-6) return;
        const up = ny / len;
        const minY = Math.min(wa.y, wb.y, wc.y);
        const maxY = Math.max(wa.y, wb.y, wc.y);
        // Roofs and container tops are also upward faces. Keeping the highest
        // one turned the shed interior into a 7 m step, so the walk stops at
        // the door. Only surfaces a person can stand on count as ground.
        if (up > 0.62 && minY > -0.45 && maxY < 2.6) this.stampFloor();
        const e1 = Math.hypot(wb.x - wa.x, wb.z - wa.z);
        const e2 = Math.hypot(wc.x - wb.x, wc.z - wb.z);
        const e3 = Math.hypot(wa.x - wc.x, wa.z - wc.z);
        const longest = Math.max(e1, e2, e3);
        const span = maxY - minY;
        // Steep faces that cross the body. Short props get stamped here too;
        // keepLongWalls drops anything that is not a run of wall.
        if (Math.abs(up) < 0.42 && span > 0.08 && minY < 1.25 && maxY > 0.7 && longest > 0.05) {
            this.stampSegment(wa.x, wa.z, wb.x, wb.z);
            this.stampSegment(wb.x, wb.z, wc.x, wc.z);
            this.stampSegment(wc.x, wc.z, wa.x, wa.z);
        }
    }

    private stampFloor(): void {
        const minX = Math.min(wa.x, wb.x, wc.x);
        const maxX = Math.max(wa.x, wb.x, wc.x);
        const minZ = Math.min(wa.z, wb.z, wc.z);
        const maxZ = Math.max(wa.z, wb.z, wc.z);
        const i0 = clampIndex(Math.floor((minX - ORIGIN_X) / CELL), COLS);
        const i1 = clampIndex(Math.floor((maxX - ORIGIN_X) / CELL), COLS);
        const j0 = clampIndex(Math.floor((minZ - ORIGIN_Z) / CELL), ROWS);
        const j1 = clampIndex(Math.floor((maxZ - ORIGIN_Z) / CELL), ROWS);
        if ((i1 - i0 + 1) * (j1 - j0 + 1) > 90000) return;
        for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
                const x = ORIGIN_X + (i + 0.5) * CELL;
                const z = ORIGIN_Z + (j + 0.5) * CELL;
                const y = baryY(x, z);
                if (y === null || y > 2.6) continue;
                const cell = j * COLS + i;
                const prev = this.ground[cell];
                if (prev < -1e7 || y < prev) this.ground[cell] = y;
            }
        }
    }

    // A barrel or a bollard stamps a small blob. A container wall stamps a
    // straight run. Drop every blocked cell that is not part of one.
    private keepLongWalls(): void {
        const keep = new Uint8Array(this.blocked.length);
        const dirs = [
            [1, 0],
            [0, 1],
            [1, 1],
            [1, -1],
        ];
        for (let iz = 0; iz < ROWS; iz++) {
            for (let ix = 0; ix < COLS; ix++) {
                if (this.blocked[iz * COLS + ix] !== 1) continue;
                let wall = false;
                for (let d = 0; d < dirs.length; d++) {
                    const dx = dirs[d][0];
                    const dz = dirs[d][1];
                    let run = 1;
                    for (let s = 1; s < 8; s++) {
                        const x = ix + dx * s;
                        const z = iz + dz * s;
                        if (x < 0 || z < 0 || x >= COLS || z >= ROWS || this.blocked[z * COLS + x] !== 1) break;
                        run += 1;
                    }
                    for (let s = 1; s < 8; s++) {
                        const x = ix - dx * s;
                        const z = iz - dz * s;
                        if (x < 0 || z < 0 || x >= COLS || z >= ROWS || this.blocked[z * COLS + x] !== 1) break;
                        run += 1;
                    }
                    if (run >= 4) {
                        wall = true;
                        break;
                    }
                }
                if (wall) keep[iz * COLS + ix] = 1;
            }
        }
        this.blocked.set(keep);
    }

    private stampSegment(ax: number, az: number, bx: number, bz: number): void {
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-4) return;
        const pieces = Math.max(1, Math.ceil(len / 6));
        const reach = 0.46;
        const reach2 = reach * reach;
        for (let p = 0; p < pieces; p++) {
            const t0 = p / pieces;
            const t1 = (p + 1) / pieces;
            const x0 = ax + (bx - ax) * t0;
            const z0 = az + (bz - az) * t0;
            const x1 = ax + (bx - ax) * t1;
            const z1 = az + (bz - az) * t1;
            const seg = Math.hypot(x1 - x0, z1 - z0);
            const steps = Math.max(1, Math.ceil(seg / (CELL * 0.45)));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const x = x0 + (x1 - x0) * t;
                const z = z0 + (z1 - z0) * t;
                const i0 = Math.floor((x - reach - ORIGIN_X) / CELL);
                const i1 = Math.floor((x + reach - ORIGIN_X) / CELL);
                const j0 = Math.floor((z - reach - ORIGIN_Z) / CELL);
                const j1 = Math.floor((z + reach - ORIGIN_Z) / CELL);
                for (let j = j0; j <= j1; j++) {
                    if (j < 0 || j >= ROWS) continue;
                    for (let i = i0; i <= i1; i++) {
                        if (i < 0 || i >= COLS) continue;
                        const cx = ORIGIN_X + (i + 0.5) * CELL;
                        const cz = ORIGIN_Z + (j + 0.5) * CELL;
                        const dx = cx - x;
                        const dz = cz - z;
                        if (dx * dx + dz * dz <= reach2) this.blocked[j * COLS + i] = 1;
                    }
                }
            }
        }
    }
}

const waScratch = new Vec3();

function baryY(x: number, z: number): number | null {
    const den = (wb.z - wc.z) * (wa.x - wc.x) + (wc.x - wb.x) * (wa.z - wc.z);
    if (Math.abs(den) < 1e-8) return null;
    const a = ((wb.z - wc.z) * (x - wc.x) + (wc.x - wb.x) * (z - wc.z)) / den;
    const b = ((wc.z - wa.z) * (x - wc.x) + (wa.x - wc.x) * (z - wc.z)) / den;
    const c = 1 - a - b;
    if (a < -0.02 || b < -0.02 || c < -0.02) return null;
    return a * wa.y + b * wb.y + c * wc.y;
}

function clampIndex(v: number, size: number): number {
    if (v < 0) return 0;
    if (v >= size) return size - 1;
    return v;
}

function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
}

function damp(current: number, target: number, rate: number, dt: number): number {
    return target + (current - target) * Math.exp(-rate * dt);
}

export interface RayHit {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    dist: number;
    hit: boolean;
}

/** First contact with the solid walk-cell box, on the face the ray enters. */
function enterCell(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, x: number, z: number, ground: number): RayHit | null {
    const ix = Math.floor((x - ORIGIN_X) / CELL);
    const iz = Math.floor((z - ORIGIN_Z) / CELL);
    const minX = ORIGIN_X + ix * CELL;
    const maxX = minX + CELL;
    const minZ = ORIGIN_Z + iz * CELL;
    const maxZ = minZ + CELL;
    const minY = ground;
    const maxY = ground + 3.2;
    let tEnter = 0;
    let tExit = 1e9;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    const slap = (o: number, d: number, min: number, max: number, axis: number): boolean => {
        if (Math.abs(d) < 1e-8) return o >= min && o <= max;
        let t1 = (min - o) / d;
        let t2 = (max - o) / d;
        let sign = -1;
        if (t1 > t2) {
            const swap = t1;
            t1 = t2;
            t2 = swap;
            sign = 1;
        }
        if (t1 > tEnter) {
            tEnter = t1;
            nx = axis === 0 ? sign : 0;
            ny = axis === 1 ? sign : 0;
            nz = axis === 2 ? sign : 0;
        }
        if (t2 < tExit) tExit = t2;
        return tEnter <= tExit;
    };
    if (!slap(ox, dx, minX, maxX, 0) || !slap(oy, dy, minY, maxY, 1) || !slap(oz, dz, minZ, maxZ, 2)) return null;
    if (tEnter < 0.05 || tEnter > 300) return null;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    return {
        x: ox + dx * tEnter + nx * 0.02,
        y: oy + dy * tEnter + ny * 0.02,
        z: oz + dz * tEnter + nz * 0.02,
        nx: nx / nlen,
        ny: ny / nlen,
        nz: nz / nlen,
        dist: tEnter,
        hit: true,
    };
}
