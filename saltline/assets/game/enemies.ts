import { assetManager, Color, EffectAsset, instantiate, Layers, Material, Mat4, MeshRenderer, Node, Prefab, primitives, Quat, utils, Vec3, Vec4 } from 'cc';
import { preloadModel } from '../enji/helpers';
import type { Walker } from './walk';

const STANDARD = 'c8f66d17-351a-48da-a12c-0212d28575c4';

const SIGHT = 45;
const LOSE = 4;
const SEARCH = 8;
const TOKENS = 2;
const TOKEN_GAP = 1.25;
const CONE = Math.cos(100 * Math.PI / 180);

const HOUND = {
    hp: 140, shot: 5, burst: 4, gap: 0.11, tele: 0.5, cool: [1.8, 3],
    run: 4.5, stalk: 2, patrol: 1.5, accel: 7, turn: 2.5,
    near: 8, far: 18, lunge: 3, lungeHit: 15, lungeCd: 3.5, lungeSpeed: 9.5,
    spreadFar: 0.12, spreadNear: 0.045,
};
const GULL = {
    hp: 45, bolt: 7, boltSpeed: 70, burst: 3, gap: 0.12, tele: 0.55,
    cool: [1.9, 3.3], near: 12, far: 25, altMin: 4, altMax: 8,
    max: 8, patrol: 3, accel: 11, spreadFar: 0.065, spreadNear: 0.018, fire: 42,
};

const STAND = 0.72;
const HIP_X = 0.165;
const HIP_Y = -0.01;
const HIP_Z = 0.4;
const L0 = 0.075;
const L1 = 0.4;
const L2 = 0.42;
const FOOT_X = 0.275;
const FOOT_Z = [0.37, 0.37, -0.42, -0.42];
const SIDE = [1, -1, 1, -1];
const FORE = [1, 1, -1, -1];
const FOOT_R = 0.046;
const LEGS = ['FL', 'FR', 'RL', 'RR'];
const PAIRS = [[0, 3], [1, 2]];

const BONES = new Set([
    'root', 'body', 'neck', 'head', 'turret', 'gun', 'antenna', 'beacon',
    'abdFL', 'thighFL', 'shinFL', 'abdFR', 'thighFR', 'shinFR',
    'abdRL', 'thighRL', 'shinRL', 'abdRR', 'thighRR', 'shinRR',
    'rotor0', 'rotor1', 'rotor2', 'rotor3', 'gimbalYaw', 'ball', 'lamp',
    'strobeG', 'strobeR', 'strobeW',
]);

const LENS_IDLE = new Color(186, 150, 42, 255);
const LENS_HOT = new Color(255, 46, 24, 255);
const LENS_DEAD = new Color(28, 8, 6, 255);
const GLOW_ORANGE = new Color(255, 120, 36, 255);
const GLOW_RED = new Color(255, 42, 22, 255);
const GLOW_GREEN = new Color(70, 220, 90, 255);
const GLOW_WHITE = new Color(230, 220, 190, 255);

export interface FoeHit {
    id: number;
    part: 'body' | 'weak';
    node: Node;
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
    dist: number;
    size: number;
}

interface Volume {
    node: Node;
    hx: number;
    hy: number;
    hz: number;
    part: 'body' | 'weak';
}

interface Bolt {
    node: Node;
    x: number;
    y: number;
    z: number;
    dx: number;
    dy: number;
    dz: number;
    life: number;
    on: boolean;
    ray: boolean;
}

interface Foot {
    x: number;
    y: number;
    z: number;
    fx: number;
    fy: number;
    fz: number;
    tx: number;
    ty: number;
    tz: number;
    sx: number;
    sz: number;
}

interface Spring {
    x: number;
    v: number;
}

interface Foe {
    kind: 'hound' | 'gull';
    root: Node;
    bones: Map<string, Node>;
    lenses: Material[];
    parts: Volume[];
    face: number;
    prevFace: number;
    yawRate: number;
    turn: number;
    speed: number;
    wish: number;
    prevSpeed: number;
    hp: number;
    maxHp: number;
    alive: boolean;
    active: boolean;
    die: number;
    diePitch: number;
    dieRoll: number;
    slammed: boolean;
    mode: 'patrol' | 'investigate' | 'search' | 'engage';
    modeT: number;
    es: 'move' | 'aim' | 'cool' | 'tele' | 'burst' | 'wind' | 'lunge' | 'recover';
    esT: number;
    atk: 'idle' | 'tele' | 'burst';
    atkT: number;
    shots: number;
    cool: number;
    lungeCd: number;
    seeT: number;
    noSeeT: number;
    senseT: number;
    exposure: number;
    los: boolean;
    token: boolean;
    homeX: number;
    homeZ: number;
    goalX: number;
    goalZ: number;
    hasGoal: boolean;
    waitT: number;
    moveT: number;
    lastX: number;
    lastY: number;
    lastZ: number;
    orbitA: number;
    orbitDir: number;
    orbitR: number;
    alt: number;
    vx: number;
    vy: number;
    vz: number;
    phase: number;
    flare: number;
    feet: Foot[];
    sw: number;
    swT: number;
    swDur: number;
    lift: number;
    lastPair: number;
    idleT: number;
    pushX: number;
    pushZ: number;
    crouch: number;
    scan: number;
    tyaw: number;
    tpitch: number;
    hyaw: number;
    hpitch: number;
    sY: Spring;
    sP: Spring;
    sR: Spring;
    sL: Spring;
    sA: Spring;
    sA2: Spring;
    gy: number;
    gp: number;
    thr: number;
    spin: number[];
    sweep: number;
}

const inv = new Mat4();
const muzzle = new Vec3();
const aim = new Vec3();
const spinQ = new Quat();

/**
 * Harbor machines taken from the original rig, with that game's gait,
 * sight and fire loop. Hits land on the real shell pieces.
 */
export class Enemies {
    private readonly pool: Foe[] = [];
    private readonly bolts: Bolt[] = [];
    readonly coats: Material[] = [];
    private readonly hold = new Node('SpentMarks');
    private time = 0;
    private navYaw = 0;
    private sent = 0;
    private tokens = 0;
    private tokenT = -9;
    private hp = 100;
    private down = 0;
    private flash = 0;
    private hpEl: HTMLElement | null = null;
    private flashEl: HTMLElement | null = null;
    /** Spark, dust and decal at a bullet strike. Wired to the viewmodel. */
    onStrike: ((
        x: number, y: number, z: number,
        nx: number, ny: number, nz: number,
        dx: number, dy: number, dz: number,
        concrete: boolean,
    ) => void) | null = null;

    private constructor(private readonly walker: Walker) {}

    static async mount(parent: Node, walker: Walker, wet: EffectAsset | null = null): Promise<Enemies | null> {
        const effect = await loadStandard();
        if (!effect) return null;
        const [hound, gull] = await Promise.all([
            preloadModel('enemies/hound'),
            preloadModel('enemies/gull'),
        ]);
        const enemies = new Enemies(walker);
        const painted = wet ?? effect;
        const shell = solid(painted, new Color(255, 255, 255, 255), 0.46, 0.08, true, wet != null);
        const metal = solid(painted, new Color(255, 255, 255, 255), 0.36, 0.74, true, wet != null);
        const root = new Node('Enemies');
        parent.addChild(root);
        root.addChild(enemies.hold);
        for (let i = 0; i < 3; i++) enemies.pool.push(assemble(root, hound, 'hound', shell, metal, effect, enemies.coats));
        for (let i = 0; i < 2; i++) enemies.pool.push(assemble(root, gull, 'gull', shell, metal, effect, enemies.coats));
        const streak = lamp(effect, new Color(255, 150, 70, 255));
        const mesh = utils.MeshUtils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
        for (let i = 0; i < 8; i++) {
            const node = part(root, 'Bolt', mesh, streak, 0, 0, 0);
            node.active = false;
            enemies.bolts.push({ node, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, life: 0, on: false, ray: false });
        }
        const houndBones = enemies.pool[0].bones.size;
        const gullBones = enemies.pool[3].bones.size;
        console.log('[saltline-enji] enemies', enemies.pool.length, 'bones', houndBones, gullBones);
        return enemies;
    }

    step(dt: number): void {
        const step = Math.min(Math.max(dt, 0), 0.05);
        this.time += step;
        if (this.down > 0) {
            this.down -= step;
            if (this.down <= 0) this.hp = 100;
        }
        this.flash = Math.max(0, this.flash - step * 1.6);
        if (this.time > 1.1 && this.sent < 1 && this.bring('gull', 10, 0)) this.sent += 1;
        if (this.time > 1.6 && this.sent < 2 && this.bring('hound', 14, 2.2)) this.sent += 1;
        if (this.time > 5.4 && this.sent < 3 && this.bring('hound', 18, -2.2)) this.sent += 1;
        let hounds = 0;
        let gulls = 0;
        for (const foe of this.pool) {
            if (!foe.active || !foe.alive) continue;
            if (foe.kind === 'hound') hounds += 1;
            else gulls += 1;
        }
        if (this.time > 14 && hounds < 2) this.bring('hound', 22, hounds === 0 ? 2 : -3);
        if (this.time > 14 && gulls < 1) this.bring('gull', 11, 0);
        for (const foe of this.pool) {
            if (!foe.active) continue;
            if (!foe.alive) {
                this.wreck(foe, step);
                continue;
            }
            this.think(foe, step);
            if (foe.kind === 'hound') this.runHound(foe, step);
            else this.flyGull(foe, step);
            this.paintLens(foe);
        }
        this.flyBolts(step);
        this.paintPlayer();
    }

    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): FoeHit | null {
        let best: FoeHit | null = null;
        for (let id = 0; id < this.pool.length; id++) {
            const foe = this.pool[id];
            if (!foe.alive) continue;
            for (const volume of foe.parts) {
                volume.node.updateWorldTransform();
                const hit = rayObb(ox, oy, oz, dx, dy, dz, volume, maxDist);
                if (!hit || hit.dist > maxDist) continue;
                if (best && hit.dist >= best.dist) continue;
                best = { id, part: volume.part, node: volume.node, ...hit };
                maxDist = hit.dist;
            }
        }
        return best;
    }

    hurt(id: number, amount: number): void {
        const foe = this.pool[id];
        if (!foe || !foe.alive) return;
        foe.hp -= amount;
        foe.flare = 1;
        if (foe.mode !== 'engage') {
            foe.mode = 'investigate';
            foe.modeT = 10;
            foe.seeT = 1;
            foe.lastX = this.walker.eyeX;
            foe.lastY = this.walker.eyeY - 1.62;
            foe.lastZ = this.walker.eyeZ;
        }
        this.rally(foe);
        if (foe.hp <= 0) this.kill(foe);
    }

    private think(foe: Foe, dt: number): void {
        const eyeX = this.walker.eyeX;
        const eyeY = this.walker.eyeY;
        const eyeZ = this.walker.eyeZ;
        const sensor = this.sensor(foe);
        foe.senseT -= dt;
        if (foe.senseT <= 0) {
            foe.senseT = 0.11 + Math.random() * 0.08;
            const dx = eyeX - sensor.x;
            const dy = eyeY - sensor.y;
            const dz = eyeZ - sensor.z;
            const dist = Math.hypot(dx, dy, dz);
            let los = false;
            if (dist < SIGHT && this.down <= 0) {
                const horiz = Math.hypot(dx, dz) || 1;
                const fx = Math.sin(foe.face);
                const fz = Math.cos(foe.face);
                const facing = (dx * fx + dz * fz) / horiz;
                if (foe.mode === 'engage' || facing > CONE || dist < 3.5) los = this.clear(sensor.x, sensor.y, sensor.z, eyeX, eyeY, eyeZ);
            }
            foe.los = los;
        }
        if (foe.los) {
            foe.seeT += dt;
            foe.noSeeT = 0;
            foe.lastX = eyeX;
            foe.lastY = eyeY - 1.62;
            foe.lastZ = eyeZ;
            foe.exposure = Math.min(1, foe.exposure + dt * 0.1);
        } else {
            foe.noSeeT += dt;
            foe.seeT = Math.max(0, foe.seeT - dt * 0.6);
            foe.exposure = Math.max(0, foe.exposure - dt * 0.45);
        }
        const need = foe.kind === 'hound' ? 0.55 : 0.4;
        if (foe.mode === 'engage') {
            if (foe.noSeeT > LOSE || this.down > 0) {
                foe.mode = 'search';
                foe.modeT = SEARCH + Math.random() * 3;
                this.release(foe);
            }
        } else if (foe.los && foe.seeT > (foe.mode === 'patrol' ? need : need * 0.45)) {
            foe.mode = 'engage';
            foe.noSeeT = 0;
            this.rally(foe);
            if (foe.kind === 'hound') this.pickFire(foe);
        } else if (foe.mode !== 'patrol') {
            foe.modeT -= dt;
            if (foe.modeT <= 0) {
                foe.mode = 'patrol';
                foe.homeX = foe.root.position.x;
                foe.homeZ = foe.root.position.z;
            }
        }
    }

    private runHound(foe: Foe, dt: number): void {
        const before = foe.face;
        foe.wish = 0;
        this.navYaw = foe.face;
        const px = this.walker.eyeX;
        const pz = this.walker.eyeZ;
        const dx = px - foe.root.position.x;
        const dz = pz - foe.root.position.z;
        const dist = Math.hypot(dx, dz) || 1;
        const toPlayer = Math.atan2(dx, dz);
        foe.cool -= dt;
        foe.lungeCd -= dt;
        let charging = false;
        if (foe.mode === 'patrol') {
            if (foe.hasGoal) {
                if (this.seek(foe, dt, HOUND.patrol)) foe.waitT = 1.5 + Math.random() * 3;
                foe.wish = foe.hasGoal ? foe.wish : 0;
            } else if ((foe.waitT -= dt) <= 0) {
                const spot = this.ring(foe.homeX, foe.homeZ, 3 + Math.random() * 5);
                if (spot) {
                    foe.goalX = spot.x;
                    foe.goalZ = spot.z;
                    foe.hasGoal = true;
                } else foe.waitT = 1;
            }
        } else if (foe.mode === 'investigate' || foe.mode === 'search') {
            const left = Math.hypot(foe.lastX - foe.root.position.x, foe.lastZ - foe.root.position.z);
            if (left > 1.6) {
                foe.goalX = foe.lastX;
                foe.goalZ = foe.lastZ;
                foe.hasGoal = true;
                this.seek(foe, dt, left < 7 ? HOUND.stalk : HOUND.run);
            } else {
                foe.hasGoal = false;
                foe.wish = 0;
                this.navYaw = foe.face + Math.sin(this.time * 0.7 + foe.phase) * 0.7;
            }
        } else {
            const close = (foe.es === 'move' || foe.es === 'aim' || foe.es === 'cool') && dist < HOUND.lunge && foe.lungeCd <= 0 && this.down <= 0;
            if (close) {
                foe.es = 'wind';
                foe.esT = 0.28;
                this.release(foe);
            }
            if (foe.es === 'move') {
                foe.moveT += dt;
                const there = this.seek(foe, dt, HOUND.run);
                const inBand = dist > HOUND.near - 1 && dist < HOUND.far + 2;
                if (there || (foe.moveT > 1.6 && foe.los && inBand)) {
                    foe.es = 'aim';
                    foe.esT = 0;
                    foe.hasGoal = false;
                    foe.wish = 0;
                }
            } else if (foe.es === 'aim' || foe.es === 'cool') {
                foe.esT += dt;
                const aligned = Math.abs(wrap(toPlayer - foe.face)) < 0.14 && Math.abs(wrap(toPlayer - foe.face - foe.tyaw)) < 0.2;
                if (foe.los && foe.cool <= 0 && this.down <= 0 && aligned && this.takeToken(foe)) {
                    foe.es = 'tele';
                    foe.esT = HOUND.tele;
                } else if (foe.noSeeT > 1.1 || foe.esT > 3) this.pickFire(foe);
            } else if (foe.es === 'tele') {
                foe.esT -= dt;
                foe.flare = Math.min(1, foe.flare + dt * 5);
                if (foe.esT <= 0) {
                    foe.es = 'burst';
                    foe.shots = HOUND.burst;
                    foe.esT = 0;
                }
            } else if (foe.es === 'burst') {
                foe.esT -= dt;
                foe.flare = 1;
                if (foe.esT <= 0) {
                    foe.esT = HOUND.gap;
                    foe.shots -= 1;
                    this.houndShot(foe);
                }
                if (foe.shots <= 0) {
                    this.release(foe);
                    foe.cool = HOUND.cool[0] + Math.random() * (HOUND.cool[1] - HOUND.cool[0]);
                    foe.es = 'cool';
                    foe.esT = 0;
                }
            } else if (foe.es === 'wind') {
                foe.esT -= dt;
                if (foe.esT <= 0) {
                    foe.es = 'lunge';
                    foe.esT = 0.36;
                    foe.speed = HOUND.lungeSpeed;
                    foe.face = toPlayer;
                }
            } else if (foe.es === 'lunge') {
                charging = true;
                foe.esT -= dt;
                foe.speed = HOUND.lungeSpeed;
                if (dist < 1.35 && this.down <= 0) {
                    this.hurtPlayer(HOUND.lungeHit);
                    foe.esT = 0;
                }
                if (foe.esT <= 0) {
                    foe.es = 'recover';
                    foe.esT = 0.55;
                    foe.lungeCd = HOUND.lungeCd;
                    foe.speed *= 0.3;
                }
            } else if (foe.es === 'recover') {
                foe.esT -= dt;
                if (foe.esT <= 0) this.pickFire(foe);
            }
        }
        if (foe.mode === 'engage' && foe.es !== 'move') this.navYaw = toPlayer;
        const turn = clamp(wrap(this.navYaw - foe.face) * 6, -HOUND.turn, HOUND.turn) * (charging ? 2 : 1);
        foe.yawRate += (turn - foe.yawRate) * (1 - Math.exp(-10 * dt));
        foe.face += foe.yawRate * dt;
        if (!charging) {
            const target = foe.wish;
            const accel = target > foe.speed ? HOUND.accel : -HOUND.accel * 1.4;
            foe.speed = clamp(foe.speed + accel * dt, 0, Math.max(target, 0));
            if (accel < 0 && foe.speed < target) foe.speed = target;
        }
        foe.turn = wrap(foe.face - before) / Math.max(dt, 1e-4);
        this.shove(foe, dt);
        const fx = Math.sin(foe.face);
        const fz = Math.cos(foe.face);
        this.slide(foe, (fx * foe.speed + foe.pushX) * dt, (fz * foe.speed + foe.pushZ) * dt);
        const ground = this.walker.groundAt(foe.root.position.x, foe.root.position.z);
        if (ground !== null) foe.root.setPosition(foe.root.position.x, ground, foe.root.position.z);
        this.poseHound(foe, dt);
        this.walker.avoid(foe.root.position.x, foe.root.position.z, 0.55);
        foe.flare = Math.max(0, foe.flare - dt * 2);
    }

    private flyGull(foe: Foe, dt: number): void {
        const px = this.walker.eyeX;
        const py = this.walker.eyeY - 1.62;
        const pz = this.walker.eyeZ;
        const engage = foe.mode === 'engage';
        let tx = foe.homeX;
        let tz = foe.homeZ;
        let ty = (this.walker.groundAt(foe.root.position.x, foe.root.position.z) ?? foe.root.position.y - foe.alt) + foe.alt;
        let speed = GULL.patrol;
        if (engage) {
            speed = GULL.max;
            foe.orbitR += (8 - foe.orbitR) * Math.min(1, dt * 0.6);
            foe.orbitA += foe.orbitDir * 2.4 / Math.max(6, foe.orbitR) * dt;
            tx = px + Math.cos(foe.orbitA) * foe.orbitR;
            tz = pz + Math.sin(foe.orbitA) * foe.orbitR;
            ty = py + 2.8;
        } else if (foe.mode === 'investigate' || foe.mode === 'search') {
            speed = 5.5;
            foe.orbitA += 0.5 * dt;
            tx = foe.lastX + Math.cos(foe.orbitA) * 4.5;
            tz = foe.lastZ + Math.sin(foe.orbitA) * 4.5;
            ty = foe.lastY + Math.min(foe.alt, 5.5);
        } else {
            foe.orbitA += 0.28 * dt * foe.orbitDir;
            tx = foe.homeX + Math.cos(foe.orbitA) * 6;
            tz = foe.homeZ + Math.sin(foe.orbitA) * 6;
            ty = (this.walker.groundAt(foe.homeX, foe.homeZ) ?? 0) + foe.alt;
        }
        const ax = (tx - foe.root.position.x) * 2.2 - foe.vx * 2.4;
        const ay = (ty - foe.root.position.y) * 5 - foe.vy * 3.6;
        const az = (tz - foe.root.position.z) * 2.2 - foe.vz * 2.4;
        const alen = Math.hypot(ax, ay, az) || 1;
        const cap = GULL.accel / alen;
        const scale = cap < 1 ? cap : 1;
        foe.vx += ax * scale * dt;
        foe.vy += ay * scale * dt;
        foe.vz += az * scale * dt;
        const vel = Math.hypot(foe.vx, foe.vy, foe.vz);
        if (vel > speed) {
            foe.vx *= speed / vel;
            foe.vy *= speed / vel;
            foe.vz *= speed / vel;
        }
        const nx = foe.root.position.x + foe.vx * dt;
        const nz = foe.root.position.z + foe.vz * dt;
        const x = this.bodyRoom(nx, nz) ? nx : foe.root.position.x;
        const z = this.bodyRoom(nx, nz) ? nz : foe.root.position.z;
        let y = foe.root.position.y + foe.vy * dt;
        const floor = (this.walker.groundAt(x, z) ?? y - 2) + 1.4;
        if (y < floor) {
            y = floor;
            if (foe.vy < 0) foe.vy = 0;
        }
        foe.root.setPosition(x, y, z);
        const lookX = engage && foe.noSeeT < 1.5 ? px : foe.lastX;
        const lookZ = engage && foe.noSeeT < 1.5 ? pz : foe.lastZ;
        const want = Math.atan2(lookX - x, lookZ - z);
        foe.face += clamp(wrap(want - foe.face), -3.2 * dt, 3.2 * dt);
        this.poseGull(foe, dt, want);
        foe.cool -= dt;
        const playerDist = Math.hypot(px - x, pz - z);
        if (foe.atk === 'idle') {
            if (engage && foe.los && foe.cool <= 0 && this.down <= 0 && playerDist < GULL.fire && Math.abs(wrap(want - foe.face)) < 0.35 && this.takeToken(foe)) {
                foe.atk = 'tele';
                foe.atkT = GULL.tele;
            }
        } else if (foe.atk === 'tele') {
            foe.atkT -= dt;
            foe.flare = Math.min(1, foe.flare + dt * 4.5);
            if (!engage) {
                foe.atk = 'idle';
                this.release(foe);
            } else if (foe.atkT <= 0) {
                foe.atk = 'burst';
                foe.shots = GULL.burst;
                foe.atkT = 0;
            }
        } else if (foe.atk === 'burst') {
            foe.atkT -= dt;
            foe.flare = 1;
            if (foe.atkT <= 0) {
                foe.atkT = GULL.gap;
                foe.shots -= 1;
                this.gullBolt(foe);
            }
            if (foe.shots <= 0) {
                foe.atk = 'idle';
                foe.cool = GULL.cool[0] + Math.random() * (GULL.cool[1] - GULL.cool[0]);
                this.release(foe);
            }
        }
        foe.flare = Math.max(0, foe.flare - dt * 1.5);
    }

    private seek(foe: Foe, dt: number, speed: number): boolean {
        void dt;
        if (!foe.hasGoal) {
            foe.wish = 0;
            return true;
        }
        const dx = foe.goalX - foe.root.position.x;
        const dz = foe.goalZ - foe.root.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.45) {
            foe.hasGoal = false;
            foe.wish = 0;
            return true;
        }
        this.navYaw = Math.atan2(dx, dz);
        const err = Math.abs(wrap(this.navYaw - foe.face));
        foe.wish = err > 1.1 ? 0 : Math.min(speed * (1 - err * 0.5), 0.4 + dist * 2.6);
        return false;
    }

    private poseHound(foe: Foe, dt: number): void {
        const root = foe.bones.get('root');
        const body = foe.bones.get('body');
        if (!root || !body) {
            foe.root.setRotationFromEuler(0, foe.face * 180 / Math.PI, 0);
            return;
        }
        this.stepFeet(foe, dt);
        const ee = Math.cos(foe.face);
        const bb = Math.sin(foe.face);
        const base = foe.root.position.y + STAND + foe.sY.x - foe.crouch;
        let turret = 0;
        let pitch = 0;
        let headYaw = Math.sin(this.time * 0.7 + foe.phase) * 0.5 + clamp(foe.turn * 0.25, -0.6, 0.6);
        let headPitch = 0.05;
        const tracking = foe.mode === 'engage' && foe.noSeeT < 1.5;
        if (tracking) {
            const ix = this.walker.eyeX - foe.root.position.x;
            const iz = this.walker.eyeZ - foe.root.position.z;
            const iy = this.walker.eyeY - 0.62 - (base + 0.25);
            turret = Math.atan2(ix * ee - iz * bb, ix * bb + iz * ee);
            pitch = clamp(Math.atan2(-iy, Math.hypot(ix, iz)), -0.9, 0.35);
        } else {
            foe.scan += dt * 0.5;
            turret = Math.sin(foe.scan * 0.9 + foe.phase) * 1.1;
        }
        if (tracking || foe.mode === 'investigate' || foe.mode === 'search') {
            const tx = tracking ? this.walker.eyeX : foe.lastX;
            const ty = tracking ? this.walker.eyeY - 1.62 : foe.lastY;
            const tz = tracking ? this.walker.eyeZ : foe.lastZ;
            const ix = tx - foe.root.position.x;
            const iz = tz - foe.root.position.z;
            const iy = ty + 1.2 - (base + 0.2);
            headYaw = clamp(Math.atan2(ix * ee - iz * bb, ix * bb + iz * ee), -1.2, 1.2);
            headPitch = clamp(Math.atan2(-iy, Math.hypot(ix, iz)), -0.6, 0.5);
        }
        const step = clamp(4.5 * dt, 0, 1);
        foe.tyaw += clamp(wrap(turret - foe.tyaw), -step, step);
        foe.tpitch += (pitch - foe.tpitch) * (1 - Math.exp(-10 * dt));
        const blend = 1 - Math.exp(-7 * dt);
        foe.hyaw += (headYaw - foe.hyaw) * blend;
        foe.hpitch += (headPitch - foe.hpitch) * blend;
        const front = (foe.feet[0].y + foe.feet[1].y) * 0.5;
        const back = (foe.feet[2].y + foe.feet[3].y) * 0.5;
        const left = (foe.feet[0].y + foe.feet[2].y) * 0.5;
        const right = (foe.feet[1].y + foe.feet[3].y) * 0.5;
        const accel = dt > 0 ? (foe.speed - foe.prevSpeed) / dt : 0;
        foe.prevSpeed = foe.speed;
        const bodyPitch = Math.atan2(back - front, 0.8) * 0.6 + clamp(accel * 0.006, -0.07, 0.07);
        const bodyRoll = Math.atan2(left - right, 0.55) * 0.6 + clamp(foe.turn * foe.speed * 0.02, -0.12, 0.12);
        const sink = (front + back) * 0.5 - foe.root.position.y;
        spring(foe.sY, sink * 0.45 - Math.min(0.05, foe.speed * 0.011), 160, 17, dt);
        spring(foe.sP, bodyPitch, 130, 15, dt);
        spring(foe.sR, bodyRoll, 130, 15, dt);
        spring(foe.sL, 0, 110, 13, dt);
        const bob = Math.sin(this.time * 1.7 + foe.phase) * 0.004;
        const stand = STAND + foe.sY.x - foe.crouch + bob;
        const bp = foe.sP.x;
        const br = foe.sR.x;
        setEuler(root, 0, foe.face, 0);
        body.setPosition(foe.sL.x, stand, 0);
        setEuler(body, bp, 0, br);
        const turretNode = foe.bones.get('turret');
        const gun = foe.bones.get('gun');
        const head = foe.bones.get('head');
        const antenna = foe.bones.get('antenna');
        if (turretNode) setEuler(turretNode, 0, foe.tyaw, 0);
        if (gun) setEuler(gun, foe.tpitch - bp * 0.5, 0, 0);
        if (head) setEuler(head, foe.hpitch, foe.hyaw, 0);
        spring(foe.sA, clamp(-accel * 0.03 - bp, -0.6, 0.6), 60, 5, dt);
        spring(foe.sA2, clamp(foe.turn * 0.12 - br, -0.6, 0.6), 60, 5, dt);
        if (antenna) setEuler(antenna, foe.sA.x, 0, foe.sA2.x);
        const beacon = foe.bones.get('beacon');
        if (beacon) {
            const blink = (this.time * (foe.mode === 'patrol' ? 0.8 : 2.2) + foe.phase) % 1;
            const on = blink < 0.12 || (blink > 0.22 && blink < 0.3) ? 1 : 0.001;
            beacon.setScale(on, on, on);
        }
        this.applyLegs(foe, stand, bp, br);
    }

    /** Plant the four feet under the current body. Shared by the gait and the collapse. */
    private applyLegs(foe: Foe, stand: number, pitch: number, roll: number): void {
        const ee = Math.cos(foe.face);
        const bb = Math.sin(foe.face);
        const cosP = Math.cos(pitch);
        const sinP = Math.sin(pitch);
        const cosR = Math.cos(roll);
        const sinR = Math.sin(roll);
        const px = foe.root.position.x;
        const py = foe.root.position.y;
        const pz = foe.root.position.z;
        for (let leg = 0; leg < 4; leg++) {
            const foot = foe.feet[leg];
            const jx = foot.x - px;
            const jy = foot.y + FOOT_R * 0.6 - py;
            const jz = foot.z - pz;
            const lateral = jx * ee - jz * bb - foe.sL.x;
            const up = jy - stand;
            const ahead = jx * bb + jz * ee;
            const pitched = up * cosP + ahead * sinP;
            const forward = -up * sinP + ahead * cosP;
            const side = lateral * cosR + pitched * sinR;
            const height = -lateral * sinR + pitched * cosR;
            const ik = solveLeg(side - SIDE[leg] * HIP_X, height - HIP_Y, forward - FORE[leg] * HIP_Z, SIDE[leg]);
            const abd = foe.bones.get('abd' + LEGS[leg]);
            const thigh = foe.bones.get('thigh' + LEGS[leg]);
            const shin = foe.bones.get('shin' + LEGS[leg]);
            if (abd) setEuler(abd, 0, 0, ik.abd);
            if (thigh) setEuler(thigh, ik.hip, 0, 0);
            if (shin) setEuler(shin, ik.knee, 0, 0);
        }
    }

    private stepFeet(foe: Foe, dt: number): void {
        const moving = foe.speed > 0.15 || Math.abs(foe.turn) > 0.25;
        if (foe.sw < 0) {
            foe.idleT = moving ? 0 : foe.idleT + dt;
            const pace = foe.speed + Math.abs(foe.turn) * 0.5;
            const dur = clamp(0.24 - pace * 0.01, 0.16, 0.24);
            const plant = (leg: number): { x: number; z: number } => {
                const yaw = foe.face;
                const tx = foe.root.position.x + Math.sin(yaw) * 0.12;
                const tz = foe.root.position.z + Math.cos(yaw) * 0.12;
                return this.keepInReach(leg, tx, tz, yaw);
            };
            let best = -1;
            let err = 0;
            for (let pair = 0; pair < 2; pair++) {
                let local = 0;
                for (const leg of PAIRS[pair]) {
                    const goal = plant(leg);
                    const foot = foe.feet[leg];
                    const miss = Math.hypot(goal.x - foot.x, goal.z - foot.z);
                    if (miss > local) local = miss;
                }
                if (pair !== foe.lastPair) local *= 1.25;
                if (local > err) {
                    err = local;
                    best = pair;
                }
            }
            const gate = moving ? 0.07 : foe.idleT > 0.25 ? 0.035 : 1e9;
            if (best >= 0 && err > gate) {
                foe.sw = best;
                foe.swT = 0;
                foe.swDur = dur;
                foe.lift = 0.045 + Math.min(0.06, pace * 0.01);
                for (const leg of PAIRS[best]) {
                    const foot = foe.feet[leg];
                    foot.fx = foot.x;
                    foot.fy = foot.y;
                    foot.fz = foot.z;
                    const to = plant(leg);
                    foot.tx = to.x;
                    foot.tz = to.z;
                    foot.ty = this.walker.groundAt(to.x, to.z) ?? foe.root.position.y;
                }
            }
        } else {
            foe.swT += dt / Math.max(0.05, foe.swDur);
            const t = foe.swT >= 1 ? 1 : foe.swT;
            const n = t * t * (3 - 2 * t);
            for (const leg of PAIRS[foe.sw]) {
                const foot = foe.feet[leg];
                foot.x = foot.fx + (foot.tx - foot.fx) * n;
                foot.z = foot.fz + (foot.tz - foot.fz) * n;
                foot.y = foot.fy + (foot.ty - foot.fy) * n + Math.sin(Math.PI * t) * foe.lift;
            }
            if (foe.swT >= 1) {
                foe.sY.v -= 0.12 + foe.speed * 0.03;
                foe.lastPair = foe.sw;
                foe.sw = -1;
            }
        }
    }

    /** Keep a plant inside the leg so the knee does not lock straight. */
    private keepInReach(leg: number, x: number, z: number, yaw: number): { x: number; z: number } {
        const at = plantAt(leg, x, z, yaw);
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const hx = x + SIDE[leg] * HIP_X * c + FORE[leg] * HIP_Z * s;
        const hz = z - SIDE[leg] * HIP_X * s + FORE[leg] * HIP_Z * c;
        const dx = at.x - hx;
        const dz = at.z - hz;
        const dist = Math.hypot(dx, dz);
        const cap = 0.3;
        if (dist <= cap || dist < 1e-4) return at;
        return { x: hx + (dx / dist) * cap, z: hz + (dz / dist) * cap };
    }

    private poseGull(foe: Foe, dt: number, want: number): void {
        const root = foe.bones.get('root');
        const body = foe.bones.get('body');
        if (!root || !body) {
            foe.root.setRotationFromEuler(0, foe.face * 180 / Math.PI, 0);
            return;
        }
        const speed = Math.hypot(foe.vx, foe.vz);
        const cosY = Math.cos(foe.face);
        const sinY = Math.sin(foe.face);
        const along = foe.vx * sinY + foe.vz * cosY;
        const across = foe.vx * cosY - foe.vz * sinY;
        let pitch = clamp(along * 0.04, -0.42, 0.42);
        let roll = clamp(-across * 0.04, -0.42, 0.42);
        if (!foe.alive) {
            pitch += Math.sin(this.time * 11 + foe.phase) * 0.1;
            roll += Math.cos(this.time * 8.7 + foe.phase * 2) * 0.13;
        }
        const blend = 1 - Math.exp(-7 * dt);
        foe.hpitch += (pitch - foe.hpitch) * blend;
        foe.hyaw += (roll - foe.hyaw) * blend;
        setEuler(root, foe.hpitch, foe.face, foe.hyaw);
        const bob = Math.sin(this.time * 2.1 + foe.phase) * 0.045 + Math.sin(this.time * 3.7 + foe.phase * 1.7) * 0.018;
        body.setPosition(0, bob, 0);
        foe.thr += (1 + clamp(foe.vy * 0.03, -0.25, 0.4) + speed * 0.02 - foe.thr) * blend;
        const spin = 41 * Math.max(0.2, foe.thr) * dt;
        const signs = [1, -1.03, -0.98, 1.01];
        for (let i = 0; i < 4; i++) {
            const rotor = foe.bones.get('rotor' + i);
            if (!rotor) continue;
            foe.spin[i] += spin * signs[i];
            setEuler(rotor, 0, foe.spin[i], 0);
        }
        const blink = (this.time * 0.9 + foe.phase * 0.1) % 1;
        const flash = blink < 0.05 || (blink > 0.13 && blink < 0.18) ? 1 : 0.001;
        const white = blink > 0.5 && blink < 0.56 ? 1 : 0.001;
        for (const name of ['strobeR', 'strobeG']) {
            const node = foe.bones.get(name);
            if (node) node.setScale(flash, flash, flash);
        }
        const strobeW = foe.bones.get('strobeW');
        if (strobeW) strobeW.setScale(white, white, white);
        const sensor = this.sensor(foe);
        let ax = foe.root.position.x;
        let ay = foe.root.position.y - 5;
        let az = foe.root.position.z;
        if (foe.mode === 'engage' && foe.noSeeT < 1.5) {
            ax = this.walker.eyeX;
            ay = this.walker.eyeY - 0.52;
            az = this.walker.eyeZ;
        } else if (foe.mode !== 'patrol') {
            foe.sweep += dt;
            ax = foe.lastX + Math.sin(foe.sweep * 0.9) * 3;
            ay = foe.lastY;
            az = foe.lastZ + Math.cos(foe.sweep * 0.7) * 3;
        } else {
            foe.sweep += dt;
            const ang = foe.face + Math.sin(foe.sweep * 0.5 + foe.phase) * 0.9;
            ax = foe.root.position.x + Math.sin(ang) * 5;
            ay = foe.root.position.y - 5;
            az = foe.root.position.z + Math.cos(ang) * 5;
        }
        const dx = ax - sensor.x;
        const dy = ay - sensor.y;
        const dz = az - sensor.z;
        const localX = dx * cosY - dz * sinY;
        const localZ = dx * sinY + dz * cosY;
        const gimbal = Math.atan2(localX, localZ);
        const tilt = clamp(Math.atan2(-dy, Math.hypot(localX, localZ)), -0.5, 1.5);
        const aimBlend = 1 - Math.exp(-9 * dt);
        foe.gy += wrap(gimbal - foe.gy) * aimBlend;
        foe.gp += (tilt - foe.gp) * aimBlend;
        const yawNode = foe.bones.get('gimbalYaw');
        const ball = foe.bones.get('ball');
        const gun = foe.bones.get('gun');
        if (yawNode) setEuler(yawNode, 0, foe.gy, 0);
        if (ball) setEuler(ball, foe.gp - foe.hpitch, 0, 0);
        if (gun) setEuler(gun, clamp(foe.gp, -0.2, 1.3) - foe.hpitch, 0, 0);
        void want;
    }

    private houndShot(foe: Foe): void {
        const gun = foe.bones.get('gun') ?? foe.bones.get('body');
        if (!gun) return;
        pointOn(gun, 0.43, muzzle);
        const spread = HOUND.spreadFar + (HOUND.spreadNear - HOUND.spreadFar) * foe.exposure;
        const dx = this.walker.eyeX - muzzle.x + (Math.random() - 0.5) * spread * 6;
        const dy = this.walker.eyeY - muzzle.y + (Math.random() - 0.5) * spread * 4;
        const dz = this.walker.eyeZ - muzzle.z + (Math.random() - 0.5) * spread * 6;
        const len = Math.hypot(dx, dy, dz) || 1;
        this.fireRay(muzzle.x, muzzle.y, muzzle.z, dx / len, dy / len, dz / len, HOUND.shot, 90);
    }

    private gullBolt(foe: Foe): void {
        const slot = this.bolts.find((bolt) => !bolt.on);
        if (!slot) return;
        const gun = foe.bones.get('gun') ?? foe.bones.get('body') ?? foe.root;
        pointOn(gun, 0.25, muzzle);
        const spread = GULL.spreadFar + (GULL.spreadNear - GULL.spreadFar) * foe.exposure;
        const dx = this.walker.eyeX - muzzle.x + (Math.random() - 0.5) * spread * 8;
        const dy = (this.walker.eyeY - 0.2) - muzzle.y + (Math.random() - 0.5) * spread * 4;
        const dz = this.walker.eyeZ - muzzle.z + (Math.random() - 0.5) * spread * 8;
        const len = Math.hypot(dx, dy, dz) || 1;
        slot.on = true;
        slot.ray = false;
        slot.life = 1.3;
        slot.x = muzzle.x;
        slot.y = muzzle.y;
        slot.z = muzzle.z;
        slot.dx = dx / len;
        slot.dy = dy / len;
        slot.dz = dz / len;
        slot.node.active = true;
        foe.vx -= slot.dx * 0.35;
        foe.vz -= slot.dz * 0.35;
    }

    private flyBolts(dt: number): void {
        for (const bolt of this.bolts) {
            if (!bolt.on) continue;
            if (bolt.ray) {
                bolt.life -= dt;
                if (bolt.life <= 0) {
                    bolt.on = false;
                    bolt.node.active = false;
                }
                continue;
            }
            const step = GULL.boltSpeed * dt;
            const wall = this.walker.trace(bolt.x, bolt.y, bolt.z, bolt.dx, bolt.dy, bolt.dz, step + 0.2);
            const player = this.playerAlong(bolt.x, bolt.y, bolt.z, bolt.dx, bolt.dy, bolt.dz, step + 0.2);
            if (player !== null && (!wall.hit || player < wall.dist)) {
                this.hurtPlayer(GULL.bolt);
                this.mark(bolt.x + bolt.dx * player, bolt.y + bolt.dy * player, bolt.z + bolt.dz * player, -bolt.dx, -bolt.dy, -bolt.dz, bolt.dx, bolt.dy, bolt.dz, false);
                bolt.on = false;
                bolt.node.active = false;
                continue;
            }
            if (wall.hit && wall.dist <= step + 0.05) {
                this.mark(wall.x, wall.y, wall.z, wall.nx, wall.ny, wall.nz, bolt.dx, bolt.dy, bolt.dz, wall.ny > 0.72);
                bolt.on = false;
                bolt.node.active = false;
                continue;
            }
            bolt.x += bolt.dx * step;
            bolt.y += bolt.dy * step;
            bolt.z += bolt.dz * step;
            bolt.life -= dt;
            if (bolt.life <= 0) {
                bolt.on = false;
                bolt.node.active = false;
                continue;
            }
            bolt.node.setWorldPosition(bolt.x, bolt.y, bolt.z);
            aim.set(bolt.x + bolt.dx, bolt.y + bolt.dy, bolt.z + bolt.dz);
            bolt.node.lookAt(aim);
            bolt.node.setScale(0.045, 0.045, 0.35);
        }
    }

    private fireRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, damage: number, range: number): void {
        const wall = this.walker.trace(ox, oy, oz, dx, dy, dz, range);
        const player = this.playerAlong(ox, oy, oz, dx, dy, dz, range);
        let end = range;
        if (player !== null && (!wall.hit || player < wall.dist)) {
            this.hurtPlayer(damage);
            end = player;
            this.mark(ox + dx * end, oy + dy * end, oz + dz * end, -dx, -dy, -dz, dx, dy, dz, false);
        } else if (wall.hit) {
            end = wall.dist;
            this.mark(wall.x, wall.y, wall.z, wall.nx, wall.ny, wall.nz, dx, dy, dz, wall.ny > 0.72);
        }
        const slot = this.bolts.find((bolt) => !bolt.on);
        if (!slot) return;
        slot.on = true;
        slot.ray = true;
        slot.life = 0.05;
        slot.x = ox + dx * end * 0.5;
        slot.y = oy + dy * end * 0.5;
        slot.z = oz + dz * end * 0.5;
        slot.dx = dx;
        slot.dy = dy;
        slot.dz = dz;
        slot.node.active = true;
        slot.node.setWorldPosition(slot.x, slot.y, slot.z);
        aim.set(ox + dx * end, oy + dy * end, oz + dz * end);
        slot.node.lookAt(aim);
        slot.node.setScale(0.02, 0.02, Math.max(0.3, end));
    }

    private playerAlong(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null {
        if (this.down > 0) return null;
        const px = this.walker.eyeX;
        const pz = this.walker.eyeZ;
        const y0 = this.walker.eyeY - 1.7;
        const y1 = this.walker.eyeY + 0.15;
        const radius = 0.36;
        const a = dx * dx + dz * dz;
        if (a < 1e-6) return null;
        const bx = ox - px;
        const bz = oz - pz;
        const b = 2 * (bx * dx + bz * dz);
        const c = bx * bx + bz * bz - radius * radius;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return null;
        const s = Math.sqrt(disc);
        let t = (-b - s) / (2 * a);
        if (t < 0) t = (-b + s) / (2 * a);
        if (t < 0.05 || t > maxDist) return null;
        const y = oy + dy * t;
        if (y < y0 || y > y1) return null;
        return t;
    }

    private hurtPlayer(amount: number): void {
        if (this.down > 0) return;
        this.hp = Math.max(0, this.hp - amount);
        this.flash = 1;
        this.walker.addShake(0.35);
        if (this.hp <= 0) this.down = 1.4;
    }

    private clear(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number): boolean {
        const dx = tx - ox;
        const dy = ty - oy;
        const dz = tz - oz;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.4) return true;
        const hit = this.walker.trace(ox, oy, oz, dx / dist, dy / dist, dz / dist, dist);
        return !hit.hit || hit.dist > dist - 0.35;
    }

    private sensor(foe: Foe): { x: number; y: number; z: number } {
        const node = foe.bones.get(foe.kind === 'hound' ? 'head' : 'ball') ?? foe.bones.get('root') ?? foe.root;
        node.updateWorldTransform();
        node.getWorldPosition(muzzle);
        return { x: muzzle.x, y: muzzle.y, z: muzzle.z };
    }

    private pickFire(foe: Foe): void {
        const px = this.walker.eyeX;
        const pz = this.walker.eyeZ;
        let best = 1e9;
        let fx = foe.root.position.x;
        let fz = foe.root.position.z;
        const base = Math.atan2(foe.root.position.z - pz, foe.root.position.x - px);
        for (let i = 0; i < 6; i++) {
            const ang = base + (Math.random() - 0.5) * 2.4;
            const dist = HOUND.near + 1 + Math.random() * (HOUND.far - HOUND.near - 2);
            const x = px + Math.cos(ang) * dist;
            const z = pz + Math.sin(ang) * dist;
            if (!this.walker.footRoom(x, z)) continue;
            const travel = Math.hypot(x - foe.root.position.x, z - foe.root.position.z);
            if (travel < best) {
                best = travel;
                fx = x;
                fz = z;
            }
        }
        foe.goalX = fx;
        foe.goalZ = fz;
        foe.hasGoal = true;
        foe.es = 'move';
        foe.esT = 0;
        foe.moveT = 0;
    }

    private ring(x: number, z: number, radius: number): { x: number; z: number } | null {
        for (let i = 0; i < 6; i++) {
            const ang = Math.random() * Math.PI * 2;
            const px = x + Math.cos(ang) * radius;
            const pz = z + Math.sin(ang) * radius;
            if (this.walker.footRoom(px, pz)) return { x: px, z: pz };
        }
        return null;
    }

    private takeToken(foe: Foe): boolean {
        if (foe.token) return true;
        const gap = this.time - this.tokenT;
        if (this.tokens >= TOKENS || gap < TOKEN_GAP) return false;
        foe.token = true;
        this.tokens += 1;
        this.tokenT = this.time;
        return true;
    }

    private release(foe: Foe): void {
        if (!foe.token) return;
        foe.token = false;
        this.tokens = Math.max(0, this.tokens - 1);
    }

    private rally(foe: Foe): void {
        for (const other of this.pool) {
            if (other === foe || !other.alive || other.mode === 'engage') continue;
            const dx = other.root.position.x - foe.root.position.x;
            const dz = other.root.position.z - foe.root.position.z;
            if (dx * dx + dz * dz > 18 * 18) continue;
            other.lastX = this.walker.eyeX;
            other.lastY = this.walker.eyeY - 1.62;
            other.lastZ = this.walker.eyeZ;
            other.mode = 'investigate';
            other.modeT = 9;
        }
    }

    private shove(foe: Foe, dt: number): void {
        for (const other of this.pool) {
            if (other === foe || other.kind !== 'hound' || !other.active) continue;
            const dx = foe.root.position.x - other.root.position.x;
            const dz = foe.root.position.z - other.root.position.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 1.7 && dist > 0.001) {
                const scale = (1.7 - dist) * 2.2 / dist;
                foe.pushX += dx * scale * dt * 6;
                foe.pushZ += dz * scale * dt * 6;
            }
        }
        const dx = foe.root.position.x - this.walker.eyeX;
        const dz = foe.root.position.z - this.walker.eyeZ;
        const dist = Math.hypot(dx, dz);
        const charging = foe.es === 'lunge' || foe.es === 'wind';
        if (!charging && dist < 1.25 && dist > 0.001) {
            const scale = (1.25 - dist) * 3 / dist;
            foe.pushX += dx * scale * dt * 6;
            foe.pushZ += dz * scale * dt * 6;
        }
        const decay = Math.exp(-5 * dt);
        foe.pushX *= decay;
        foe.pushZ *= decay;
    }

    private kill(foe: Foe): void {
        foe.alive = false;
        foe.die = 0;
        foe.slammed = false;
        this.release(foe);
        if (foe.kind === 'gull') {
            const lost = foe.bones.get('rotor' + Math.floor(Math.random() * 4));
            lost?.setScale(0.0001, 0.0001, 0.0001);
            return;
        }
        foe.vy = 0;
        foe.diePitch = (Math.random() - 0.5) * 0.5;
        foe.dieRoll = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.28);
        foe.sP.v += (Math.random() - 0.5) * 2.2;
        foe.sR.v += foe.dieRoll * 3;
        foe.sY.v -= 0.55;
        foe.speed *= 0.3;
        foe.sw = -1;
        foe.bones.get('beacon')?.setScale(0.001, 0.001, 0.001);
        const c = Math.cos(foe.face);
        const s = Math.sin(foe.face);
        for (let leg = 0; leg < 4; leg++) {
            const foot = foe.feet[leg];
            const side = SIDE[leg] * (0.16 + Math.random() * 0.18);
            const fore = FORE[leg] * (0.05 + Math.random() * 0.2) + (Math.random() - 0.5) * 0.08;
            foot.sx = side * c + fore * s;
            foot.sz = -side * s + fore * c;
        }
    }

    private wreck(foe: Foe, dt: number): void {
        foe.die += dt;
        if (foe.kind === 'hound') this.collapseHound(foe, dt);
        else {
            const root = foe.bones.get('root');
            const p = foe.root.position;
            const g = this.walker.groundAt(p.x, p.z) ?? p.y;
            foe.root.setPosition(p.x, Math.max(g + 0.2, p.y - dt * (3 + foe.die * 4)), p.z);
            if (root) setEuler(root, foe.die * 1.2, foe.face, foe.die * 2.1);
        }
        if (foe.die > 8) {
            foe.active = false;
            foe.root.active = false;
        }
    }

    /** Belly drops, feet splay, head and gun droop. The root stays upright so the legs can fold. */
    private collapseHound(foe: Foe, dt: number): void {
        if (foe.die < 2.5) {
            foe.vy -= 9.8 * dt * (foe.die < 0.12 ? 0.3 : 1);
            foe.sY.x += foe.vy * dt;
            const floor = 0.2 - STAND;
            if (foe.sY.x < floor) {
                foe.sY.x = floor;
                if (foe.vy < -1.2) {
                    if (!foe.slammed) {
                        foe.slammed = true;
                        const p = foe.root.position;
                        const gy = this.walker.groundAt(p.x, p.z) ?? p.y;
                        this.mark(p.x, gy + 0.02, p.z, 0, 1, 0, 0, -1, 0, true);
                    }
                    foe.vy = -foe.vy * 0.22;
                } else foe.vy = 0;
            }
            spring(foe.sP, foe.diePitch, 60, 9, dt);
            spring(foe.sR, foe.dieRoll, 60, 9, dt);
            spring(foe.sL, 0, 40, 8, dt);
            const keep = Math.exp(-3.2 * dt);
            for (const foot of foe.feet) {
                foot.x += foot.sx * (1 - keep);
                foot.z += foot.sz * (1 - keep);
                foot.sx *= keep;
                foot.sz *= keep;
                foot.y = this.walker.groundAt(foot.x, foot.z) ?? foe.root.position.y;
            }
            const px = foe.root.position.x + Math.sin(foe.face) * foe.speed * dt;
            const pz = foe.root.position.z + Math.cos(foe.face) * foe.speed * dt;
            const gy = this.walker.groundAt(px, pz) ?? foe.root.position.y;
            foe.root.setPosition(px, gy, pz);
            foe.speed *= Math.exp(-5 * dt);
            const blend = 1 - Math.exp(-5 * dt);
            foe.hpitch += (0.72 - foe.hpitch) * blend;
            foe.hyaw += (foe.dieRoll * 0.55 - foe.hyaw) * blend;
            foe.tpitch += (0.42 - foe.tpitch) * blend;
            foe.tyaw += (0 - foe.tyaw) * blend;
        }
        this.poseHoundDead(foe);
    }

    private poseHoundDead(foe: Foe): void {
        const root = foe.bones.get('root');
        const body = foe.bones.get('body');
        if (!root || !body) return;
        const stand = STAND + foe.sY.x;
        setEuler(root, 0, foe.face, 0);
        body.setPosition(foe.sL.x, stand, 0);
        setEuler(body, foe.sP.x, 0, foe.sR.x);
        const turret = foe.bones.get('turret');
        const gun = foe.bones.get('gun');
        const head = foe.bones.get('head');
        const antenna = foe.bones.get('antenna');
        if (turret) setEuler(turret, 0, foe.tyaw, 0);
        if (gun) setEuler(gun, foe.tpitch - foe.sP.x * 0.5, 0, 0);
        if (head) setEuler(head, foe.hpitch, foe.hyaw, 0);
        if (antenna) setEuler(antenna, -0.45, 0, foe.sR.x);
        foe.bones.get('beacon')?.setScale(0.001, 0.001, 0.001);
        this.applyLegs(foe, stand, foe.sP.x, foe.sR.x);
        const hot = foe.die < 1.2 && Math.sin(foe.die * 52) > 0.15;
        const color = hot ? LENS_HOT : LENS_DEAD;
        for (const mat of foe.lenses) {
            mat.setProperty('emissive', color);
            mat.setProperty('mainColor', color);
        }
    }

    private mark(
        x: number, y: number, z: number,
        nx: number, ny: number, nz: number,
        dx: number, dy: number, dz: number,
        concrete: boolean,
    ): void {
        this.onStrike?.(x, y, z, nx, ny, nz, dx, dy, dz, concrete);
    }

    private bring(kind: 'hound' | 'gull', ahead: number, side: number): boolean {
        const foe = this.pool.find((entry) => entry.kind === kind && !entry.active);
        if (!foe) return false;
        const spot = this.spot(ahead, side);
        if (!spot) return false;
        this.stripMarks(foe);
        foe.active = true;
        foe.alive = true;
        foe.hp = foe.maxHp;
        foe.die = 0;
        foe.face = Math.atan2(this.walker.eyeX - spot.x, this.walker.eyeZ - spot.z);
        foe.prevFace = foe.face;
        foe.yawRate = 0;
        foe.turn = 0;
        foe.speed = 0;
        foe.wish = 0;
        foe.prevSpeed = 0;
        foe.mode = 'investigate';
        foe.modeT = 12;
        foe.es = 'move';
        foe.esT = 0;
        foe.atk = 'idle';
        foe.atkT = 0;
        foe.shots = 0;
        foe.cool = 1 + Math.random();
        foe.lungeCd = 1.2;
        foe.seeT = 0;
        foe.noSeeT = 0;
        foe.senseT = Math.random() * 0.2;
        foe.exposure = 0;
        foe.los = false;
        foe.token = false;
        foe.homeX = spot.x;
        foe.homeZ = spot.z;
        foe.goalX = spot.x;
        foe.goalZ = spot.z;
        foe.hasGoal = false;
        foe.waitT = 0;
        foe.moveT = 0;
        foe.lastX = this.walker.eyeX;
        foe.lastY = this.walker.eyeY - 1.62;
        foe.lastZ = this.walker.eyeZ;
        foe.orbitA = Math.random() * Math.PI * 2;
        foe.orbitDir = Math.random() < 0.5 ? 1 : -1;
        foe.orbitR = kind === 'gull' ? 8 : 0;
        foe.alt = kind === 'gull' ? 2.8 : 0;
        foe.vx = foe.vy = foe.vz = 0;
        foe.diePitch = 0;
        foe.dieRoll = 0;
        foe.slammed = false;
        foe.phase = Math.random() * Math.PI * 2;
        foe.flare = 0;
        foe.sw = -1;
        foe.swT = 0;
        foe.swDur = 0.2;
        foe.lift = 0.07;
        foe.lastPair = -1;
        foe.idleT = 0;
        foe.pushX = 0;
        foe.pushZ = 0;
        foe.crouch = 0;
        foe.scan = Math.random() * 3;
        foe.tyaw = 0;
        foe.tpitch = 0;
        foe.hyaw = 0;
        foe.hpitch = 0;
        zero(foe.sY); zero(foe.sP); zero(foe.sR); zero(foe.sL); zero(foe.sA); zero(foe.sA2);
        foe.gy = 0;
        foe.gp = 0;
        foe.thr = 1;
        foe.spin = [0, 0, 0, 0];
        foe.sweep = 0;
        foe.root.active = true;
        foe.root.setRotationFromEuler(0, 0, 0);
        const y = kind === 'gull' ? spot.y + foe.alt : spot.y;
        foe.root.setPosition(spot.x, y, spot.z);
        for (const name of ['rotor0', 'rotor1', 'rotor2', 'rotor3', 'beacon', 'strobeR', 'strobeG', 'strobeW']) {
            foe.bones.get(name)?.setScale(1, 1, 1);
        }
        if (kind === 'hound') {
            this.plantFeet(foe);
            for (const foot of foe.feet) {
                foot.sx = 0;
                foot.sz = 0;
            }
        }
        console.log('[saltline-enji] enemy in', kind, spot.x.toFixed(1), spot.z.toFixed(1));
        return true;
    }

    private plantFeet(foe: Foe): void {
        for (let leg = 0; leg < 4; leg++) {
            const at = plantAt(leg, foe.root.position.x, foe.root.position.z, foe.face);
            const y = this.walker.groundAt(at.x, at.z) ?? foe.root.position.y;
            const foot = foe.feet[leg];
            foot.x = foot.fx = foot.tx = at.x;
            foot.z = foot.fz = foot.tz = at.z;
            foot.y = foot.fy = foot.ty = y;
        }
    }

    private spot(ahead: number, side: number): { x: number; y: number; z: number } | null {
        const yaw = this.walker.yaw * Math.PI / 180;
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const rx = -fz;
        const rz = fx;
        for (const dist of [ahead, ahead + 8, ahead - 5, 14, 30]) {
            for (const slide of [side, 0, -side, side * 0.5]) {
                const x = this.walker.eyeX + fx * dist + rx * slide;
                const z = this.walker.eyeZ + fz * dist + rz * slide;
                if (!this.walker.footRoom(x, z)) continue;
                const y = this.walker.groundAt(x, z);
                if (y === null) continue;
                return { x, y, z };
            }
        }
        return null;
    }

    private slide(foe: Foe, dx: number, dz: number): void {
        const x = foe.root.position.x;
        const z = foe.root.position.z;
        const y = foe.root.position.y;
        if (this.bodyRoom(x + dx, z + dz)) foe.root.setPosition(x + dx, y, z + dz);
        else if (this.bodyRoom(x + dx, z)) foe.root.setPosition(x + dx, y, z);
        else if (this.bodyRoom(x, z + dz)) foe.root.setPosition(x, y, z + dz);
    }

    private bodyRoom(x: number, z: number): boolean {
        return this.walker.footRoom(x, z)
            && this.walker.footRoom(x + 0.42, z)
            && this.walker.footRoom(x - 0.42, z)
            && this.walker.footRoom(x, z + 0.42)
            && this.walker.footRoom(x, z - 0.42);
    }

    private stripMarks(foe: Foe): void {
        const walk = (node: Node): void => {
            for (let i = node.children.length - 1; i >= 0; i--) {
                const child = node.children[i];
                if (child.name === 'Decal') {
                    child.active = false;
                    child.setParent(this.hold);
                    continue;
                }
                walk(child);
            }
        };
        walk(foe.root);
    }

    private paintLens(foe: Foe): void {
        const hot = foe.mode === 'engage' || foe.atk !== 'idle' || foe.es === 'tele' || foe.es === 'burst';
        const color = hot ? LENS_HOT : LENS_IDLE;
        for (const mat of foe.lenses) {
            mat.setProperty('emissive', color);
            mat.setProperty('mainColor', color);
        }
    }

    private paintPlayer(): void {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc) return;
        if (!this.hpEl) {
            const el = doc.createElement('div');
            el.id = 'saltline-hp';
            el.style.cssText = 'position:fixed;left:28px;bottom:26px;z-index:30;pointer-events:none;font:700 28px/1 ui-sans-serif,system-ui;color:#e8e4da;text-shadow:0 1px 2px rgba(0,0,0,.55)';
            doc.body.appendChild(el);
            this.hpEl = el;
            const veil = doc.createElement('div');
            veil.id = 'saltline-hurt';
            veil.style.cssText = 'position:fixed;inset:0;z-index:27;pointer-events:none;background:radial-gradient(circle at center, transparent 40%, rgba(180,24,16,.72) 100%);opacity:0';
            doc.body.appendChild(veil);
            this.flashEl = veil;
        }
        this.hpEl.textContent = String(this.hp);
        this.hpEl.style.color = this.hp <= 30 ? '#ff5a3c' : '#e8e4da';
        if (this.flashEl) this.flashEl.style.opacity = String(this.flash * 0.85);
    }
}

function assemble(parent: Node, prefab: Prefab, kind: 'hound' | 'gull', shell: Material, metal: Material, effect: EffectAsset, coats: Material[]): Foe {
    const root = instantiate(prefab);
    root.name = kind === 'hound' ? 'Hound' : 'Gull';
    parent.addChild(root);
    root.active = false;
    stamp(root);
    const bones = new Map<string, Node>();
    indexBones(root, bones);
    const lenses: Material[] = [];
    const parts = dress(root, kind, shell, metal, effect, lenses, coats);
    if (bones.size < 8) {
        const found: string[] = [];
        indexBones(root, bones);
        root.children.forEach((child) => found.push(child.name));
        console.warn('[saltline-enji] rig bones', kind, bones.size, found.join(','));
    }
    return makeFoe(root, kind, kind === 'hound' ? 140 : 45, bones, lenses, parts);
}

function dress(root: Node, kind: 'hound' | 'gull', shell: Material, metal: Material, effect: EffectAsset, lenses: Material[], coats: Material[]): Volume[] {
    const volumes: Volume[] = [];
    const renderers: MeshRenderer[] = [];
    collectRenderers(root, renderers);
    for (const renderer of renderers) {
        const node = renderer.node;
        node.layer = Layers.Enum.DEFAULT;
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.ON;
        renderer.receiveShadow = true;
        const slot = slotOf(node.name);
        const bone = boneOf(node);
        if (slot === 'lens') {
            const mat = lamp(effect, LENS_IDLE);
            renderer.setSharedMaterial(mat, 0);
            lenses.push(mat);
        } else if (slot === 'glow') {
            renderer.setSharedMaterial(lamp(effect, glowOf(bone, kind)), 0);
        } else {
            const src = slot === 'metal' ? metal : shell;
            const mat = solid(src.effectAsset!, new Color(255, 255, 255, 255), slot === 'metal' ? 0.36 : 0.46, slot === 'metal' ? 0.74 : 0.08, true, true);
            // Each panel is its own mesh in bone space, so a shared noise
            // field paints every panel the same. The seed stays on the panel.
            mat.setProperty('surfaceKind', new Vec4(4, Math.random(), Math.random(), 0));
            renderer.setSharedMaterial(mat, 0);
            coats.push(mat);
        }
        renderer.visibility = Layers.Enum.DEFAULT;
        const volume = hitBox(node, renderer, bone);
        if (volume) volumes.push(volume);
    }
    return volumes;
}

function hitBox(node: Node, renderer: MeshRenderer, bone: string): Volume | null {
    const bounds = renderer.mesh?.struct;
    const min = bounds?.minPosition;
    const max = bounds?.maxPosition;
    if (!min || !max) return null;
    const hx = Math.abs(max.x - min.x) * 0.5;
    const hy = Math.abs(max.y - min.y) * 0.5;
    const hz = Math.abs(max.z - min.z) * 0.5;
    if (hx < 0.012 && hy < 0.012 && hz < 0.012) return null;
    const hit = new Node('Hit');
    node.addChild(hit);
    hit.layer = Layers.Enum.DEFAULT;
    hit.setPosition((min.x + max.x) * 0.5, (min.y + max.y) * 0.5, (min.z + max.z) * 0.5);
    return {
        node: hit,
        hx, hy, hz,
        part: bone === 'head' || bone === 'ball' ? 'weak' : 'body',
    };
}

function collectRenderers(node: Node, out: MeshRenderer[]): void {
    for (const component of node.components) {
        if (component.constructor.name === 'MeshRenderer') out.push(component as MeshRenderer);
    }
    for (const child of node.children) collectRenderers(child, out);
}

function indexBones(node: Node, map: Map<string, Node>): void {
    if (BONES.has(node.name)) map.set(node.name, node);
    for (const child of node.children) indexBones(child, map);
}

function stamp(node: Node): void {
    node.layer = Layers.Enum.DEFAULT;
    for (const child of node.children) stamp(child);
}

function boneOf(node: Node): string {
    let current: Node | null = node;
    while (current) {
        if (BONES.has(current.name)) return current.name;
        current = current.parent;
    }
    return '';
}

function slotOf(name: string): string {
    if (name.indexOf('lens') === 0) return 'lens';
    if (name.indexOf('glow') === 0) return 'glow';
    if (name.indexOf('metal') === 0) return 'metal';
    return 'shell';
}

function glowOf(bone: string, kind: 'hound' | 'gull'): Color {
    if (bone === 'strobeG' || (bone === 'body' && kind === 'gull')) return GLOW_GREEN;
    if (bone === 'strobeW' || bone === 'lamp') return GLOW_WHITE;
    if (bone === 'beacon' || bone === 'body') return GLOW_ORANGE;
    return GLOW_RED;
}

function makeFoe(root: Node, kind: 'hound' | 'gull', hp: number, bones: Map<string, Node>, lenses: Material[], parts: Volume[]): Foe {
    return {
        kind, root, bones, lenses, parts,
        face: 0, prevFace: 0, yawRate: 0, turn: 0, speed: 0, wish: 0, prevSpeed: 0,
        hp, maxHp: hp, alive: false, active: false, die: 0, diePitch: 0, dieRoll: 0, slammed: false,
        mode: 'patrol', modeT: 0, es: 'move', esT: 0, atk: 'idle', atkT: 0, shots: 0,
        cool: 1, lungeCd: 1, seeT: 0, noSeeT: 0, senseT: 0, exposure: 0, los: false, token: false,
        homeX: 0, homeZ: 0, goalX: 0, goalZ: 0, hasGoal: false, waitT: 0, moveT: 0,
        lastX: 0, lastY: 0, lastZ: 0, orbitA: 0, orbitDir: 1, orbitR: 16, alt: 6,
        vx: 0, vy: 0, vz: 0, phase: 0, flare: 0,
        feet: [foot(), foot(), foot(), foot()],
        sw: -1, swT: 0, swDur: 0.2, lift: 0.07, lastPair: -1, idleT: 0,
        pushX: 0, pushZ: 0, crouch: 0, scan: 0,
        tyaw: 0, tpitch: 0, hyaw: 0, hpitch: 0,
        sY: { x: 0, v: 0 }, sP: { x: 0, v: 0 }, sR: { x: 0, v: 0 },
        sL: { x: 0, v: 0 }, sA: { x: 0, v: 0 }, sA2: { x: 0, v: 0 },
        gy: 0, gp: 0, thr: 1, spin: [0, 0, 0, 0], sweep: 0,
    };
}

function foot(): Foot {
    return { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, sx: 0, sz: 0 };
}

function zero(springValue: Spring): void {
    springValue.x = 0;
    springValue.v = 0;
}

function plantAt(leg: number, x: number, z: number, yaw: number): { x: number; z: number } {
    const reach = SIDE[leg] * FOOT_X;
    const along = FOOT_Z[leg];
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return { x: x + reach * c + along * s, z: z - reach * s + along * c };
}

function solveLeg(side: number, up: number, forward: number, sign: number): { abd: number; hip: number; knee: number } {
    const reach2 = side * side + up * up;
    const hipReach = Math.sqrt(Math.max(reach2 - L0 * L0, 1e-6));
    let abd = Math.atan2(up, side) - Math.atan2(-hipReach, sign * L0);
    if (abd > Math.PI) abd -= Math.PI * 2;
    else if (abd < -Math.PI) abd += Math.PI * 2;
    const shin = L2 - FOOT_R * 0.6;
    let dist = Math.hypot(hipReach, forward);
    const far = (L1 + shin) * 0.995;
    const near = Math.abs(L1 - shin) + 0.03;
    if (dist > far) dist = far;
    else if (dist < near) dist = near;
    const pitch = Math.atan2(forward, hipReach);
    const cosHip = clamp((L1 * L1 + dist * dist - shin * shin) / (2 * L1 * dist), -1, 1);
    const cosKnee = clamp((L1 * L1 + shin * shin - dist * dist) / (2 * L1 * shin), -1, 1);
    return { abd, hip: Math.acos(cosHip) - pitch, knee: -(Math.PI - Math.acos(cosKnee)) };
}

function spring(value: Spring, target: number, k: number, drag: number, dt: number): void {
    value.v += ((target - value.x) * k - value.v * drag) * dt;
    value.x += value.v * dt;
}

function setEuler(node: Node, x: number, y: number, z: number): void {
    const cx = Math.cos(x * 0.5);
    const sx = Math.sin(x * 0.5);
    const cy = Math.cos(y * 0.5);
    const sy = Math.sin(y * 0.5);
    const cz = Math.cos(z * 0.5);
    const sz = Math.sin(z * 0.5);
    Quat.set(
        spinQ,
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz + sx * sy * cz,
        cx * cy * cz - sx * sy * sz,
    );
    node.setRotation(spinQ);
}

function pointOn(node: Node, reach: number, out: Vec3): void {
    node.updateWorldTransform();
    node.getWorldPosition(out);
    const m = node.worldMatrix;
    const len = Math.hypot(m.m08, m.m09, m.m10) || 1;
    out.x += m.m08 / len * reach;
    out.y += m.m09 / len * reach;
    out.z += m.m10 / len * reach;
}

function part(parent: Node, name: string, mesh: ReturnType<typeof utils.MeshUtils.createMesh>, mat: Material, x: number, y: number, z: number): Node {
    const node = new Node(name);
    parent.addChild(node);
    node.setPosition(x, y, z);
    node.layer = Layers.Enum.DEFAULT;
    const renderer = node.addComponent(MeshRenderer);
    renderer.mesh = mesh;
    renderer.setSharedMaterial(mat, 0);
    renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
    renderer.receiveShadow = false;
    renderer.visibility = Layers.Enum.DEFAULT;
    return node;
}

function rayObb(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
    volume: Volume, maxDist: number,
): { x: number; y: number; z: number; nx: number; ny: number; nz: number; dist: number; size: number } | null {
    if (!Mat4.invert(inv, volume.node.worldMatrix)) return null;
    const o = mulPoint(inv, ox, oy, oz);
    const d = mulVector(inv, dx, dy, dz);
    let tEnter = 0;
    let tExit = maxDist;
    let axis = 0;
    let sign = 1;
    const slab = (origin: number, dir: number, half: number, ax: number): boolean => {
        if (Math.abs(dir) < 1e-8) return origin >= -half && origin <= half;
        let t1 = (-half - origin) / dir;
        let t2 = (half - origin) / dir;
        let face = -1;
        if (t1 > t2) {
            const swap = t1;
            t1 = t2;
            t2 = swap;
            face = 1;
        }
        if (t1 > tEnter) {
            tEnter = t1;
            axis = ax;
            sign = face;
        }
        if (t2 < tExit) tExit = t2;
        return tEnter <= tExit;
    };
    if (!slab(o.x, d.x, volume.hx, 0) || !slab(o.y, d.y, volume.hy, 1) || !slab(o.z, d.z, volume.hz, 2)) return null;
    if (tEnter < 0.02 || tEnter > maxDist) return null;
    const world = mulPoint(volume.node.worldMatrix, o.x + d.x * tEnter, o.y + d.y * tEnter, o.z + d.z * tEnter);
    const n = axisNormal(volume.node.worldMatrix, axis, sign);
    let span = volume.hy * 2;
    if (axis === 0) span = Math.min(volume.hy, volume.hz) * 2;
    else if (axis === 1) span = Math.min(volume.hx, volume.hz) * 2;
    else span = Math.min(volume.hx, volume.hy) * 2;
    return {
        x: world.x + n.x * 0.012,
        y: world.y + n.y * 0.012,
        z: world.z + n.z * 0.012,
        nx: n.x, ny: n.y, nz: n.z,
        dist: tEnter,
        size: Math.min(0.16, Math.max(0.045, span * 0.72)),
    };
}

function axisNormal(m: Mat4, axis: number, sign: number): { x: number; y: number; z: number } {
    const x = axis === 0 ? m.m00 : axis === 1 ? m.m04 : m.m08;
    const y = axis === 0 ? m.m01 : axis === 1 ? m.m05 : m.m09;
    const z = axis === 0 ? m.m02 : axis === 1 ? m.m06 : m.m10;
    const len = Math.hypot(x, y, z) || 1;
    return { x: (x / len) * sign, y: (y / len) * sign, z: (z / len) * sign };
}

function mulPoint(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number } {
    const w = m.m03 * x + m.m07 * y + m.m11 * z + m.m15 || 1;
    return {
        x: (m.m00 * x + m.m04 * y + m.m08 * z + m.m12) / w,
        y: (m.m01 * x + m.m05 * y + m.m09 * z + m.m13) / w,
        z: (m.m02 * x + m.m06 * y + m.m10 * z + m.m14) / w,
    };
}

function mulVector(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number } {
    return {
        x: m.m00 * x + m.m04 * y + m.m08 * z,
        y: m.m01 * x + m.m05 * y + m.m09 * z,
        z: m.m02 * x + m.m06 * y + m.m10 * z,
    };
}

function wrap(angle: number): number {
    let t = angle % (Math.PI * 2);
    if (t > Math.PI) t -= Math.PI * 2;
    else if (t < -Math.PI) t += Math.PI * 2;
    return t;
}

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

function solid(effect: EffectAsset, color: Color, roughness: number, metallic: number, vertex: boolean, wet = false): Material {
    const mat = new Material();
    mat.initialize({ effectAsset: effect, defines: vertex ? { USE_VERTEX_COLOR: true } : undefined });
    mat.setProperty('mainColor', color);
    mat.setProperty('roughness', roughness);
    mat.setProperty('metallic', metallic);
    mat.setProperty('specularIntensity', wet ? 0.46 : 0.5);
    if (wet) {
        mat.setProperty('wetParams', new Vec4(0, 0, 0, 0));
        mat.setProperty('wetMacro', new Vec4(0, 0, 0, 0));
        mat.setProperty('surfaceKind', new Vec4(4, 0, 0, 0));
    }
    return mat;
}

function lamp(effect: EffectAsset, color: Color): Material {
    const mat = new Material();
    mat.initialize({ effectAsset: effect });
    mat.setProperty('mainColor', color);
    mat.setProperty('emissive', color);
    mat.setProperty('emissiveScale', new Vec3(1.6, 1.25, 0.8));
    mat.setProperty('roughness', 0.35);
    mat.setProperty('metallic', 0);
    return mat;
}

function loadStandard(): Promise<EffectAsset | null> {
    return new Promise((resolve) => {
        assetManager.loadAny({ uuid: STANDARD }, (err: Error | null, asset: EffectAsset) => {
            if (err || !asset) {
                console.warn('[saltline-enji] enemy material skipped', err);
                resolve(null);
                return;
            }
            resolve(asset);
        });
    });
}
