import {
    assetManager, Camera, Color, EffectAsset, gfx, Layers, Material, Mat4, MeshRenderer, Node, PointLight, primitives, Quat, utils, Vec3, Vec4,
} from 'cc';
import { loadEffect, loadModel } from '../enji/helpers';
import type { Enemies } from './enemies';
import type { Surface } from './surface';
import type { Walker } from './walk';

const STANDARD = 'c8f66d17-351a-48da-a12c-0212d28575c4';
export const VIEW_LAYER = 1 << 19;

/** Hip pose from the live PAC-9. Position in metres, rotation in radians, YXZ. */
const HIP = { x: 0.118, y: -0.122, z: -0.275, rx: 0.034, ry: 0.085, rz: -0.03 };
/** Sight window on the bore: local sight height 0.069, pulled back to the eye. */
const ADS = { x: 0, y: -0.069, z: -0.135 };
/** Whole-gun dip while the support hand works the magazine. Radians, YXZ. */
const RELOAD = { x: -0.03, y: 0.1, z: -0.02, rx: 0.46, ry: 0.22, rz: -0.8 };
const MAG = 30;
const RESERVE = 150;
const FOV_HIP = 74;
const FOV_ADS = 52;
const RELOAD_TAC = 2.1;
const RELOAD_EMPTY = 2.72;
const MUZZLE = new Vec3(0, 0.02, -0.531);
const EJECT = new Vec3(0.023, 0.008, -0.03);
const RPM = 720;
const DEG = 180 / Math.PI;

const WHITE = new Color(255, 255, 255, 255);
const BRASS = new Color(176, 138, 60, 255);
const RAIN_PARTS = ['pac9_anodised', 'pac9_phosphate', 'pac9_polymer', 'pac9_polymer_tan'];

const PARTS: Record<string, { color: Color; rough: number; metal: number }> = {
    pac9_anodised: { color: WHITE, rough: 0.4, metal: 0.45 },
    pac9_phosphate: { color: WHITE, rough: 0.5, metal: 0.7 },
    pac9_polymer: { color: WHITE, rough: 0.62, metal: 0 },
    pac9_matte: { color: WHITE, rough: 0.92, metal: 0 },
    pac9_polymer_tan: { color: WHITE, rough: 0.62, metal: 0 },
    brass: { color: WHITE, rough: 0.45, metal: 1 },
    pac9_pin: { color: WHITE, rough: 0.4, metal: 0.6 },
    glove_fabric: { color: WHITE, rough: 0.9, metal: 0 },
};

const gunInv = new Mat4();
const shotDir = new Vec3();
const shotLocal = new Vec3();
const muzzlePos = new Vec3();
const ejectPos = new Vec3();
const tmp = new Vec3();
const right = new Vec3();
const up = new Vec3();
const forward = new Vec3();
const normal = new Vec3();
const reflectDir = new Vec3();
const aim = new Vec3();
const decalUp = new Vec3();
const rollQ = new Quat();

/** Palm point the support-hand poses are aimed at, in hand-local space. */
const PALM = new Vec3(0, -0.015, -0.055);
const BOLT_PALM = new Vec3(0, -0.024, -0.118);
/** Magazine group origin. The baked mag and the top round sit in gun space around this. */
const MAG_POS = new Vec3(0, -0.02, -0.0665);
const MAG_OUT = 0.47;
const MAG_IN = 1.345;

interface HandKey {
    t: number;
    p: Vec3;
    q: Quat;
}

function eulerXYZ(x: number, y: number, z: number): Quat {
    const c1 = Math.cos(x * 0.5);
    const c2 = Math.cos(y * 0.5);
    const c3 = Math.cos(z * 0.5);
    const s1 = Math.sin(x * 0.5);
    const s2 = Math.sin(y * 0.5);
    const s3 = Math.sin(z * 0.5);
    return new Quat(
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    );
}

function quatBasis(xx: number, xy: number, xz: number, yx: number, yy: number, yz: number, zx: number, zy: number, zz: number): Quat {
    const m11 = xx;
    const m12 = yx;
    const m13 = zx;
    const m21 = xy;
    const m22 = yy;
    const m23 = zy;
    const m31 = xz;
    const m32 = yz;
    const m33 = zz;
    const q = new Quat();
    const trace = m11 + m22 + m33;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        q.w = 0.25 / s;
        q.x = (m32 - m23) * s;
        q.y = (m13 - m31) * s;
        q.z = (m21 - m12) * s;
    } else if (m11 > m22 && m11 > m33) {
        const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        q.w = (m32 - m23) / s;
        q.x = 0.25 * s;
        q.y = (m12 + m21) / s;
        q.z = (m13 + m31) / s;
    } else if (m22 > m33) {
        const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        q.w = (m13 - m31) / s;
        q.x = (m12 + m21) / s;
        q.y = 0.25 * s;
        q.z = (m23 + m32) / s;
    } else {
        const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        q.w = (m21 - m12) / s;
        q.x = (m13 + m31) / s;
        q.y = (m23 + m32) / s;
        q.z = 0.25 * s;
    }
    Quat.normalize(q, q);
    return q;
}

function supportPose(q: Quat, x: number, y: number, z: number, palm: Vec3): HandKey {
    const rotated = new Vec3();
    Vec3.transformQuat(rotated, palm, q);
    return { t: 0, p: new Vec3(x - rotated.x, y - rotated.y, z - rotated.z), q: new Quat(q.x, q.y, q.z, q.w) };
}

function poseDelta(base: HandKey, x: number, y: number, z: number, q?: Quat): HandKey {
    const rot = q ?? base.q;
    return { t: 0, p: new Vec3(base.p.x + x, base.p.y + y, base.p.z + z), q: new Quat(rot.x, rot.y, rot.z, rot.w) };
}

function handKey(t: number, pose: HandKey): HandKey {
    return { t, p: pose.p, q: pose.q };
}

const roll90 = eulerXYZ(0, 0, Math.PI / 2);
const handQ = new Quat();
const gripQ = new Quat();
Quat.multiply(handQ, roll90, eulerXYZ(0.06, 0, 0));
Quat.multiply(gripQ, roll90, eulerXYZ(0.12, 0, 0));
const restPose = supportPose(handQ, -0.015, -0.062, -0.236, PALM);
const grabPose = supportPose(gripQ, -0.0135, -0.15, -0.0745, PALM);
const reachPose = poseDelta(grabPose, -0.035, -0.02, 0.01);
const dropQ = new Quat();
Quat.multiply(dropQ, gripQ, eulerXYZ(-0.5, 0, 0.25));
const dropPose = poseDelta(grabPose, -0.06, -0.3, 0.13, dropQ);
const seatPose = poseDelta(grabPose, 0, -0.035, 0.004);
const tapPose = poseDelta(grabPose, -0.004, -0.06, 0);
const pressPose = poseDelta(grabPose, 0, -0.012, 0);
const boltQ = new Quat();
Quat.multiply(boltQ, eulerXYZ(-0.6, 0, 0), quatBasis(0, 0, 1, -1, 0, 0, 0, -1, 0));
const boltPose = supportPose(boltQ, -0.03, 0.007, -0.078, BOLT_PALM);
const rackPose = poseDelta(boltPose, 0, 0, 0.062);
const INV_HAND = new Quat();
const INV_GRIP = new Quat();
Quat.invert(INV_HAND, handQ);
Quat.invert(INV_GRIP, gripQ);

/** Tactical reload. The hand leaves the handguard, pulls the mag, and seats it. */
const TAC_KEYS: HandKey[] = [
    handKey(0, restPose), handKey(0.1, restPose), handKey(0.36, reachPose), handKey(0.44, grabPose), handKey(0.5, grabPose),
    handKey(0.8, dropPose), handKey(0.98, dropPose), handKey(1.28, seatPose), handKey(1.35, grabPose),
    handKey(1.45, tapPose), handKey(1.52, pressPose), handKey(1.62, grabPose), handKey(1.7, reachPose), handKey(2.02, restPose), handKey(9, restPose),
];
/** Empty reload continues into a charging-handle pull after the mag is seated. */
const EMPTY_KEYS: HandKey[] = [
    ...TAC_KEYS.slice(0, 12),
    handKey(1.7, reachPose), handKey(1.96, boltPose), handKey(2.02, boltPose), handKey(2.14, rackPose), handKey(2.19, rackPose),
    handKey(2.26, boltPose), handKey(2.36, boltPose), handKey(2.66, restPose), handKey(9, restPose),
];

const rigP = new Vec3();
const rigQ = new Quat();
const rigD = new Vec3();
const rigSpin = new Vec3();
const rigPos = new Vec3();
const rigRot = new Quat();
const heldPos = new Vec3();
const heldRot = new Quat();

function sampleHand(keys: HandKey[], t: number, outP: Vec3, outQ: Quat): void {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1].t) i += 1;
    const a = keys[i];
    const b = keys[i + 1];
    const u = smoother((t - a.t) / Math.max(1e-4, b.t - a.t));
    Vec3.lerp(outP, a.p, b.p, u);
    Quat.slerp(outQ, a.q, b.q, u);
}

/**
 * PAC-9 viewmodel. Right mouse aims, R reloads, left mouse fires while
 * the cursor is locked. The magazine holds 30, with 150 in reserve.
 * Reload pulls that magazine out with the support hand and seats it again.
 */
export class Viewmodel {
    private readonly root: Node;
    private readonly camera: Node;
    private readonly gunMats: Material[] = [];
    private readonly gunCol0 = new Vec4(1, 0, 0, 0);
    private readonly gunCol1 = new Vec4(0, 1, 0, 0);
    private readonly gunCol2 = new Vec4(0, 0, 1, 0);
    private readonly gunCol3 = new Vec4(0, 0, 0, 1);
    private readonly kZ = new Spring(520, 30);
    private readonly kP = new Spring(380, 26);
    private readonly kY = new Spring(300, 22);
    private readonly kR = new Spring(300, 20);
    private readonly swY = new Spring(110, 15);
    private readonly swP = new Spring(110, 15);
    private time = 0;
    private idle = 0;
    private inspect = -1;
    private cooldown = 0;
    private bloom = 0;
    private heat = 0;
    private flash = 0;
    private flashDur = 0.05;
    private flashRoll = 0;
    private flashScale = 1;
    private flashStretch = 1;
    private flashJet = 1;
    private flashSeed = 0;
    private lastShot = -10;
    private smoke = 0;
    private smokeTick = 0;
    private bobPhase = 0;
    private bobAmt = 0;
    private adsLin = 0;
    private adsE = 0;
    private ammo = MAG;
    private reserve = RESERVE;
    private dry = false;
    private autoReload = -1;
    private reload: { t: number; T: number; empty: boolean; filled: boolean; pulled: boolean; racked: boolean } | null = null;
    private reloadW = 0;
    private rackW = 0;
    private lens: Camera | null = null;
    private lensTried = false;
    private muzzle: Node | null = null;
    private eject: Node | null = null;
    private flashRoot: Node | null = null;
    private readonly flashMats: Material[] = [];
    private readonly flashVecs: Vec4[] = [];
    private readonly seedVec = new Vec4();
    private light: PointLight | null = null;
    private bound: Walker | null = null;
    private readonly tracers: Tracer[] = [];
    private readonly bursts: Burst[] = [];
    private readonly shells: Shell[] = [];
    private readonly puffs: Puff[] = [];
    private readonly decals: Node[] = [];
    private decalCursor = 0;
    private decalRoot: Node | null = null;
    private metalDecal: Material | null = null;
    private concreteDecal: Material | null = null;
    private surface: Surface | null = null;
    private enemies: Enemies | null = null;
    private hitMark = 0;
    private hitWeak = false;
    private magNode: Node | null = null;
    private roundNode: Node | null = null;
    private support: Node | null = null;
    private roundShown = true;
    private readonly magRestP = new Vec3();
    private readonly magRestQ = new Quat();
    private readonly roundRestP = new Vec3();
    private readonly roundRestQ = new Quat();
    private readonly supportRestP = new Vec3();
    private readonly supportRestQ = new Quat();

    private constructor(root: Node, camera: Node) {
        this.root = root;
        this.camera = camera;
    }

    /** Harbor triangles and enemy boxes. Shot picks the closest face. */
    bindCombat(surface: Surface | null, enemies: Enemies | null): void {
        this.surface = surface;
        this.enemies = enemies;
    }

    static async mount(camera: Node): Promise<Viewmodel | null> {
        const [model, effect, wet, additive, muzzleFx, soft, decalFx, sightFx] = await Promise.all([
            loadModel('viewmodel/pac9').catch((err) => {
                console.warn('[saltline-enji] rifle model skipped', err);
                return null;
            }),
            loadStandard(),
            loadEffect('effects/wet-standard').catch((err) => {
                console.warn('[saltline-enji] rifle rain skipped', err);
                return null;
            }),
            loadEffect('effects/fx-add').catch((err) => {
                console.warn('[saltline-enji] shot fx skipped', err);
                return null;
            }),
            loadEffect('effects/muzzle').catch((err) => {
                console.warn('[saltline-enji] muzzle flash skipped', err);
                return null;
            }),
            loadEffect('effects/fx-soft').catch((err) => {
                console.warn('[saltline-enji] smoke skipped', err);
                return null;
            }),
            loadEffect('effects/decal').catch((err) => {
                console.warn('[saltline-enji] decals skipped', err);
                return null;
            }),
            loadEffect('effects/sight').catch((err) => {
                console.warn('[saltline-enji] reflex sight skipped', err);
                return null;
            }),
        ]);
        if (!model || !effect) {
            model?.destroy();
            return null;
        }
        const root = new Node('Viewmodel');
        camera.addChild(root);
        root.layer = VIEW_LAYER;
        root.setPosition(HIP.x, HIP.y, HIP.z);
        root.setRotationFromEuler(HIP.rx * DEG, HIP.ry * DEG, HIP.rz * DEG);
        root.addChild(model);
        const view = new Viewmodel(root, camera);
        let parts = 0;
        for (const mesh of model.getComponentsInChildren(MeshRenderer)) {
            const node = mesh.node;
            node.layer = VIEW_LAYER;
            mesh.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            mesh.receiveShadow = false;
            mesh.visibility = VIEW_LAYER;
            const part = partFor(node.name);
            if (!part) continue;
            const rainy = wet != null && RAIN_PARTS.indexOf(part.key) >= 0;
            const mat = new Material();
            mat.initialize({
                effectAsset: rainy && wet ? wet : effect,
                defines: { USE_VERTEX_COLOR: true },
            });
            mat.setProperty('mainColor', part.color);
            mat.setProperty('roughness', part.rough);
            mat.setProperty('metallic', part.metal);
            if (rainy) {
                const finish = part.key === 'pac9_phosphate' ? 1 : part.key.indexOf('polymer') >= 0 ? 2 : 0;
                mat.setProperty('surfaceKind', new Vec4(3, finish, 0, 0));
                view.gunMats.push(mat);
            }
            mesh.setSharedMaterial(mat, 0);
            parts += 1;
            if (part.key === 'pac9_polymer_tan') view.rememberRig(node, 'mag');
            else if (part.key === 'brass') view.rememberRig(node, 'round');
            else if (part.key === 'glove_fabric') {
                try {
                    view.splitSupportHand(mesh);
                } catch (err) {
                    console.warn('[saltline-enji] support hand split skipped', err);
                }
            }
        }
        view.buildFx(additive, muzzleFx, soft, effect, decalFx, sightFx);
        console.log('[saltline-enji] rifle parts', parts);
        return view;
    }

    step(dt: number, walker?: Walker | null): void {
        const step = Math.min(Math.max(dt, 0), 0.05);
        this.bound = walker ?? null;
        this.time += step;
        const firing = walker?.firing ?? false;
        const moving = walker?.moving ?? false;
        const speed = walker?.speed ?? (moving ? 4.2 : 0);
        const look = walker?.takeLook() ?? { yaw: 0, pitch: 0 };
        if (walker?.takeInspect()) this.inspect = 0;

        if (walker?.takeReload()) this.beginReload();
        if (this.autoReload >= 0) {
            this.autoReload -= step;
            if (this.autoReload < 0) this.beginReload();
        }
        this.advanceReload(step);
        const sprinting = speed > 7;
        const wantAds = !!walker?.aiming && !this.reload && !sprinting;
        this.adsLin = clamp(this.adsLin + (wantAds ? step : -step) / 0.18, 0, 1);
        this.adsE = smoother(this.adsLin);
        if (walker) walker.lookScale = 1 - this.adsE * 0.4;

        const busy = firing || moving || wantAds || !!this.reload || Math.abs(look.yaw) + Math.abs(look.pitch) > 0.25;
        if (busy) {
            this.idle = 0;
            if (this.inspect >= 0) this.inspect = Math.max(this.inspect, 2.9);
        } else {
            this.idle += step;
            if (this.inspect < 0 && this.idle > 14) this.inspect = 0;
        }
        let tilt = 0;
        let show = 0;
        let weight = 0;
        if (this.inspect >= 0) {
            this.inspect += step;
            const t = this.inspect;
            tilt = smoother(t / 0.5) * (1 - smoother((t - 1.4) / 0.5));
            show = smoother((t - 1.5) / 0.5) * (1 - smoother((t - 2.8) / 0.5));
            weight = smoother(t / 0.5) * (1 - smoother((t - 2.9) / 0.5));
            if (t > 3.5) {
                this.inspect = -1;
                this.idle = 0;
            }
        }

        this.cooldown -= step;
        if (firing && !this.reload && this.cooldown <= 0 && walker) {
            if (this.ammo > 0) {
                this.shot(walker);
                this.ammo -= 1;
                if (this.ammo <= 0) this.showRound(false);
                this.cooldown += 60 / RPM;
            } else if (!this.dry) {
                this.dry = true;
                if (this.reserve > 0) this.autoReload = 0.32;
            }
        }
        // Idle frames used to drive this negative without a floor, so the next
        // trigger emptied the magazine one round per frame.
        if (this.cooldown < 0) this.cooldown = Math.max(this.cooldown, -0.001);
        if (!firing) this.dry = false;
        this.bloom = Math.max(0, this.bloom - step * 1.5);
        if (this.time - this.lastShot > 0.11 && this.time - this.lastShot < 0.11 + step * 1.5 && this.heat > 0.4) {
            this.smoke = Math.min(1.6, this.heat * 1.3);
        }
        if (this.smoke > 0) {
            this.smoke = Math.max(0, this.smoke - step);
            this.smokeTick -= step;
            if (this.smokeTick <= 0) {
                this.smokeTick = 0.085;
                this.spawnSmoke();
            }
        }
        this.heat = Math.max(0, this.heat - step * 0.2);
        this.flash = Math.max(0, this.flash - step);

        const sway = 1 - this.adsE * 0.6;
        const lookYaw = clamp(look.yaw * Math.PI / 180, -0.2, 0.2);
        const lookPitch = clamp(look.pitch * Math.PI / 180, -0.2, 0.2);
        this.swY.kick(lookYaw * 3.2 * sway);
        this.swP.kick(lookPitch * 2.6 * sway);
        this.swY.step(step);
        this.swP.step(step);
        this.swY.x = clamp(this.swY.x, -0.09, 0.09);
        this.swP.x = clamp(this.swP.x, -0.07, 0.07);
        this.kZ.step(step);
        this.kP.step(step);
        this.kY.step(step);
        this.kR.step(step);

        const idle = 1 - this.adsE * 0.7;
        this.bobAmt = damp(this.bobAmt, speed > 0.3 ? speed / 3.6 : 0, 8, step);
        this.bobPhase += step * (speed > 0.3 ? 5.2 + speed * 1.55 : 0);
        const yr = this.bobAmt * (1 - this.adsE * 0.88);
        const lu = Math.sin(this.bobPhase) * 0.006 * yr;
        const foot = 0.5 + 0.5 * Math.cos(this.bobPhase * 2 + 0.6);
        const de = (Math.sin(this.bobPhase * 2) * 0.0042 - foot * foot * foot * foot * 0.0048) * yr;
        const hipW = 1 - this.adsE;
        const rw = this.reloadW;
        const rack = this.rackW;
        const x = HIP.x * hipW + ADS.x * this.adsE + RELOAD.x * rw + lu + Math.sin(this.time * 0.85 + 1) * 0.0012 * idle - this.swY.x * 0.06 * sway - 0.035 * weight;
        const y = HIP.y * hipW + ADS.y * this.adsE + RELOAD.y * rw + de + Math.sin(this.time * 1.7) * 0.0016 * idle + this.swP.x * 0.05 * sway + 0.045 * weight;
        const z = HIP.z * hipW + ADS.z * this.adsE + RELOAD.z * rw + this.kZ.x * 0.55;
        const rx = HIP.rx * hipW + RELOAD.rx * rw - 0.16 * rack + Math.sin(this.time * 1.7 + 0.8) * 0.0035 * idle + Math.sin(this.bobPhase * 2 + 0.5) * 0.008 * yr + this.swP.x * sway + this.kP.x + 0.3 * weight;
        const ry = HIP.ry * hipW + RELOAD.ry * rw + Math.sin(this.time * 0.6) * 0.002 * idle + Math.sin(this.bobPhase) * 0.01 * yr + this.swY.x * sway + this.kY.x + 0.18 * weight + 0.25 * show;
        const rz = HIP.rz * hipW + RELOAD.rz * rw + 0.62 * rack + Math.sin(this.bobPhase) * 0.014 * yr + this.swY.x * 0.7 * sway + this.kR.x - 0.75 * tilt + 0.55 * show + Math.sin(this.time * 0.5) * 0.004 * idle;
        this.root.setPosition(x, y, z);
        this.root.setRotationFromEuler(rx * DEG, ry * DEG, rz * DEG);
        this.root.updateWorldTransform();
        this.uploadGun();
        this.poseFx(step);
        this.applyFov();
        this.paintAmmo();
        this.paintCross(speed);
    }

    private beginReload(): void {
        if (this.reload || this.ammo >= MAG || this.reserve <= 0) return;
        const empty = this.ammo <= 0;
        this.reload = { t: 0, T: empty ? RELOAD_EMPTY : RELOAD_TAC, empty, filled: false, pulled: false, racked: false };
        this.autoReload = -1;
        if (empty) this.showRound(false);
        if (this.inspect >= 0) this.inspect = Math.max(this.inspect, 2.9);
    }

    private advanceReload(step: number): void {
        const job = this.reload;
        if (!job) {
            this.reloadW = 0;
            this.rackW = 0;
            this.poseRig(null);
            return;
        }
        job.t += step;
        const t = job.t;
        if (!job.pulled && t >= MAG_OUT) {
            job.pulled = true;
            this.kP.kick(-0.35);
        }
        if (!job.filled && t >= MAG_IN) {
            job.filled = true;
            const take = Math.min(MAG - this.ammo, this.reserve);
            this.ammo += take;
            this.reserve -= take;
            this.kP.kick(0.55);
        }
        if (job.empty && !job.racked && t >= 2.19) {
            job.racked = true;
            this.kZ.kick(-0.5);
            this.kP.kick(0.3);
        }
        const rise = smoother(Math.min(1, t / 0.3));
        const fallT = (t - (job.T - 0.46)) / 0.4;
        const fall = fallT <= 0 ? 1 : 1 - smoother(Math.min(1, fallT));
        this.reloadW = Math.min(rise, fall);
        this.rackW = job.empty ? smoother(clamp((t - 1.62) / 0.3, 0, 1)) * fall : 0;
        if (t >= job.T) {
            this.reload = null;
            this.reloadW = 0;
            this.rackW = 0;
            this.poseRig(null);
            return;
        }
        this.poseRig(job);
    }

    private poseRig(job: { t: number; empty: boolean } | null): void {
        if (!job) {
            this.restoreNode(this.support, this.supportRestP, this.supportRestQ);
            this.restoreMag();
            return;
        }
        sampleHand(job.empty ? EMPTY_KEYS : TAC_KEYS, job.t, rigP, rigQ);
        Quat.multiply(rigRot, rigQ, INV_HAND);
        Vec3.transformQuat(rigSpin, restPose.p, rigRot);
        Vec3.subtract(rigD, rigP, rigSpin);
        this.applyDelta(this.support, this.supportRestP, this.supportRestQ, rigD, rigRot);
        if (job.t >= MAG_OUT && job.t < MAG_IN) {
            Quat.multiply(rigRot, rigQ, INV_GRIP);
            Vec3.subtract(rigSpin, MAG_POS, grabPose.p);
            Vec3.transformQuat(rigPos, rigSpin, rigRot);
            Vec3.add(rigPos, rigPos, rigP);
            Vec3.transformQuat(rigSpin, MAG_POS, rigRot);
            Vec3.subtract(rigD, rigPos, rigSpin);
            this.applyDelta(this.magNode, this.magRestP, this.magRestQ, rigD, rigRot);
            this.applyDelta(this.roundNode, this.roundRestP, this.roundRestQ, rigD, rigRot);
        } else {
            this.restoreMag();
        }
        if (job.t > 0.86) this.showRound(true);
    }

    private applyDelta(node: Node | null, restP: Vec3, restQ: Quat, dP: Vec3, dQ: Quat): void {
        if (!node) return;
        Quat.multiply(heldRot, restQ, dQ);
        Vec3.transformQuat(heldPos, dP, restQ);
        node.setPosition(heldPos.x + restP.x, heldPos.y + restP.y, heldPos.z + restP.z);
        node.setRotation(heldRot.x, heldRot.y, heldRot.z, heldRot.w);
    }

    private restoreMag(): void {
        this.restoreNode(this.magNode, this.magRestP, this.magRestQ);
        this.restoreNode(this.roundNode, this.roundRestP, this.roundRestQ);
    }

    private restoreNode(node: Node | null, p: Vec3, q: Quat): void {
        if (!node) return;
        node.setPosition(p.x, p.y, p.z);
        node.setRotation(q.x, q.y, q.z, q.w);
    }

    private showRound(on: boolean): void {
        this.roundShown = on;
        if (this.roundNode) this.roundNode.active = on;
    }

    private rememberRig(node: Node, kind: 'mag' | 'round'): void {
        const p = kind === 'mag' ? this.magRestP : this.roundRestP;
        const q = kind === 'mag' ? this.magRestQ : this.roundRestQ;
        p.set(node.position.x, node.position.y, node.position.z);
        q.set(node.rotation.x, node.rotation.y, node.rotation.z, node.rotation.w);
        if (kind === 'mag') this.magNode = node;
        else this.roundNode = node;
    }

    /** The glove mesh holds both hands. The support hand has to move on its own during a reload. */
    private splitSupportHand(renderer: MeshRenderer): void {
        const data = renderer.mesh;
        const parent = renderer.node.parent;
        if (!data || !parent) return;
        const positions = data.readAttribute(0, gfx.AttributeName.ATTR_POSITION);
        const normals = data.readAttribute(0, gfx.AttributeName.ATTR_NORMAL);
        const uvs = data.readAttribute(0, gfx.AttributeName.ATTR_TEX_COORD);
        const colors = data.readAttribute(0, gfx.AttributeName.ATTR_COLOR);
        const indices = data.readIndices(0);
        if (!positions) return;
        const vertCount = Math.floor(positions.length / 3);
        if (vertCount < 3) return;
        const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(vertCount / 3);
        const link = new Array<number>(vertCount);
        for (let i = 0; i < vertCount; i++) link[i] = i;
        const find = (a: number): number => {
            let p = a;
            while (link[p] !== p) p = link[p];
            while (link[a] !== p) {
                const next = link[a];
                link[a] = p;
                a = next;
            }
            return p;
        };
        const union = (a: number, b: number): void => {
            const pa = find(a);
            const pb = find(b);
            if (pa !== pb) link[pa] = pb;
        };
        const weld = new Map<string, number>();
        for (let i = 0; i < vertCount; i++) {
            const key = `${Math.round(positions[i * 3] * 1000)},${Math.round(positions[i * 3 + 1] * 1000)},${Math.round(positions[i * 3 + 2] * 1000)}`;
            const prev = weld.get(key);
            if (prev === undefined) weld.set(key, i);
            else union(prev, i);
        }
        for (let t = 0; t < triCount; t++) {
            const a = indices ? indices[t * 3] : t * 3;
            const b = indices ? indices[t * 3 + 1] : t * 3 + 1;
            const c = indices ? indices[t * 3 + 2] : t * 3 + 2;
            union(a, b);
            union(b, c);
        }
        const sumX = new Array<number>(vertCount).fill(0);
        const sumZ = new Array<number>(vertCount).fill(0);
        const sumN = new Array<number>(vertCount).fill(0);
        for (let i = 0; i < vertCount; i++) {
            const root = find(i);
            sumX[root] += positions[i * 3];
            sumZ[root] += positions[i * 3 + 2];
            sumN[root] += 1;
        }
        const supportRoot = new Array<number>(vertCount).fill(0);
        for (let i = 0; i < vertCount; i++) {
            if (sumN[i] === 0) continue;
            const cx = sumX[i] / sumN[i];
            const cz = sumZ[i] / sumN[i];
            if (cz < -0.1 || cx < -0.05) supportRoot[i] = 1;
        }
        const colorStride = colors && vertCount > 0 ? Math.round(colors.length / vertCount) : 0;
        let colorScale = 1;
        if (colors && colors.length > 0) {
            let peak = 0;
            const n = Math.min(colors.length, 64);
            for (let i = 0; i < n; i++) peak = Math.max(peak, colors[i]);
            if (peak > 2) colorScale = 1 / 255;
        }
        const left = emptyStreams();
        const right = emptyStreams();
        let leftTris = 0;
        let rightTris = 0;
        for (let t = 0; t < triCount; t++) {
            const ids = [
                indices ? indices[t * 3] : t * 3,
                indices ? indices[t * 3 + 1] : t * 3 + 1,
                indices ? indices[t * 3 + 2] : t * 3 + 2,
            ];
            const dest = supportRoot[find(ids[0])] ? left : right;
            if (dest === left) leftTris += 1;
            else rightTris += 1;
            for (const id of ids) pushVert(dest, positions, normals, uvs, colors, colorStride, colorScale, id);
        }
        if (leftTris < 10 || rightTris < 10) return;
        const leftMesh = buildStreams(left);
        const rightMesh = buildStreams(right);
        if (!leftMesh || !rightMesh) return;
        renderer.mesh = rightMesh;
        const node = new Node('SupportHand');
        parent.addChild(node);
        node.layer = VIEW_LAYER;
        const glove = renderer.node;
        node.setScale(glove.scale.x, glove.scale.y, glove.scale.z);
        this.supportRestP.set(glove.position.x, glove.position.y, glove.position.z);
        this.supportRestQ.set(glove.rotation.x, glove.rotation.y, glove.rotation.z, glove.rotation.w);
        node.setPosition(this.supportRestP.x, this.supportRestP.y, this.supportRestP.z);
        node.setRotation(this.supportRestQ.x, this.supportRestQ.y, this.supportRestQ.z, this.supportRestQ.w);
        const hand = node.addComponent(MeshRenderer);
        hand.mesh = leftMesh;
        const mat = renderer.getSharedMaterial(0);
        if (mat) hand.setSharedMaterial(mat, 0);
        hand.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        hand.receiveShadow = false;
        hand.visibility = VIEW_LAYER;
        this.support = node;
        console.log('[saltline-enji] reload hand', leftTris, 'grip', rightTris);
    }

    private applyFov(): void {
        if (!this.lensTried) {
            this.lensTried = true;
            this.lens = this.camera.getComponent(Camera);
            if (!this.lens) {
                for (const component of this.camera.components) {
                    if (component.constructor.name === 'Camera') this.lens = component as Camera;
                }
            }
        }
        if (this.lens) this.lens.fov = FOV_HIP + (FOV_ADS - FOV_HIP) * this.adsE;
    }

    private paintAmmo(): void {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc) return;
        let el = doc.getElementById('saltline-ammo');
        if (!el) {
            el = doc.createElement('div');
            el.id = 'saltline-ammo';
            el.style.cssText = 'position:fixed;right:28px;bottom:22px;z-index:30;pointer-events:none;text-align:right;font-family:ui-sans-serif,system-ui,sans-serif;text-shadow:0 1px 2px rgba(0,0,0,.55)';
            doc.body.appendChild(el);
        }
        const low = this.ammo <= 8;
        const count = low ? '#ff5a3c' : '#f4efe6';
        el.innerHTML = `<div style="font:700 64px/0.8 ui-sans-serif,system-ui;color:${count};font-variant-numeric:tabular-nums">${this.ammo}</div><div style="font:500 15px/1 ui-monospace,monospace;color:#d9d0c4;margin-top:4px">/ ${this.reserve}</div>`;
    }

    /** Bone cross from the original HUD. The gap is the live cone on screen. */
    private paintCross(speed: number): void {
        const doc = (globalThis as { document?: Document }).document;
        if (!doc) return;
        let root = doc.getElementById('saltline-cross');
        if (!root) {
            root = doc.createElement('div');
            root.id = 'saltline-cross';
            root.innerHTML = '<i class="c-t"></i><i class="c-b"></i><i class="c-l"></i><i class="c-r"></i><i class="c-dot"></i><b class="c-hit"></b><b class="c-hit"></b><b class="c-hit"></b><b class="c-hit"></b>';
            root.style.cssText = 'position:fixed;left:50%;top:50%;width:0;height:0;z-index:28;pointer-events:none;';
            const css = doc.createElement('style');
            css.textContent = '#saltline-cross i{position:absolute;left:0;top:0;background:#e8e4da;box-shadow:0 0 0 1px rgba(0,0,0,.4)}'
                + '#saltline-cross .c-t,#saltline-cross .c-b{width:2px;height:9px}'
                + '#saltline-cross .c-l,#saltline-cross .c-r{width:9px;height:2px}'
                + '#saltline-cross .c-dot{width:2px;height:2px;margin:-1px 0 0 -1px;opacity:.85}'
                + '#saltline-cross .c-hit{position:absolute;width:2px;height:11px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.35);opacity:0}'
                + '#saltline-cross .c-hit:nth-of-type(1){left:-12px;top:-16px;transform:rotate(-45deg)}'
                + '#saltline-cross .c-hit:nth-of-type(2){left:10px;top:-16px;transform:rotate(45deg)}'
                + '#saltline-cross .c-hit:nth-of-type(3){left:-12px;top:6px;transform:rotate(45deg)}'
                + '#saltline-cross .c-hit:nth-of-type(4){left:10px;top:6px;transform:rotate(-45deg)}';
            doc.head.appendChild(css);
            doc.body.appendChild(root);
        }
        const show = this.adsE <= 0.6 && !this.reload;
        root.style.opacity = show ? '1' : '0';
        const spread = (0.0125 - 0.0113 * this.adsE) + this.bloom * (0.0065 - 0.0043 * this.adsE);
        const fov = ((this.lens?.fov ?? FOV_HIP) * Math.PI) / 360;
        const height = doc.documentElement?.clientHeight || 640;
        let gap = Math.tan(spread) / Math.tan(fov) * (height * 0.5) + 4 + (speed > 7 ? 10 : 0);
        gap = Math.round(Math.max(4, Math.min(70, gap)) * 2) / 2;
        const arms = root.querySelectorAll('i');
        if (arms.length >= 4) {
            (arms[0] as HTMLElement).style.transform = `translate3d(-50%, ${-gap}px, 0) translateY(-100%)`;
            (arms[1] as HTMLElement).style.transform = `translate3d(-50%, ${gap}px, 0)`;
            (arms[2] as HTMLElement).style.transform = `translate3d(${-gap}px, -50%, 0) translateX(-100%)`;
            (arms[3] as HTMLElement).style.transform = `translate3d(${gap}px, -50%, 0)`;
        }
        if (this.hitMark > 0) {
            this.hitMark = Math.max(0, this.hitMark - 0.05);
            const marks = root.querySelectorAll('b');
            const color = this.hitWeak ? '#ff5a3c' : '#fff';
            for (let i = 0; i < marks.length; i++) {
                const mark = marks[i] as HTMLElement;
                mark.style.opacity = String(Math.min(1, this.hitMark * 4));
                mark.style.background = color;
            }
        }
    }

    private markHit(weak: boolean): void {
        this.hitMark = 1;
        this.hitWeak = weak;
    }

    private shot(walker: Walker): void {
        const spread = (0.0125 - 0.0113 * this.adsE) + this.bloom * (0.0065 - 0.0043 * this.adsE);
        const ang = Math.random() * Math.PI * 2;
        const radius = Math.tan(spread) * Math.sqrt(Math.random());
        shotLocal.set(Math.cos(ang) * radius, Math.sin(ang) * radius, -1);
        shotLocal.normalize();
        Vec3.transformQuat(shotDir, shotLocal, this.camera.worldRotation);
        const eye = this.camera.worldPosition;
        let hit = walker.trace(eye.x, eye.y, eye.z, shotDir.x, shotDir.y, shotDir.z, 90);
        const reach = hit.hit ? Math.min(90, hit.dist + 0.75) : 90;
        const skin = this.surface?.raycast(eye.x, eye.y, eye.z, shotDir.x, shotDir.y, shotDir.z, reach) ?? null;
        if (skin) {
            const closer = !hit.hit || skin.dist < hit.dist - 0.02;
            const sameFace = hit.hit && skin.dist < hit.dist + 0.75
                && skin.nx * hit.nx + skin.ny * hit.ny + skin.nz * hit.nz > 0.35;
            if (closer || sameFace) {
                hit = {
                    x: skin.x, y: skin.y, z: skin.z,
                    nx: skin.nx, ny: skin.ny, nz: skin.nz,
                    dist: skin.dist, hit: true,
                };
            }
        }
        const foe = this.enemies?.raycast(
            eye.x, eye.y, eye.z, shotDir.x, shotDir.y, shotDir.z, hit.hit ? hit.dist : 90,
        ) ?? null;
        const body = (walker.crouched ? 0.85 : 1) * (1 - this.adsE * 0.45);
        const climb = 0.39 * body * (0.85 + Math.random() * 0.3);
        const side = (Math.random() - 0.5) * 0.28 * body;
        walker.addRecoil(climb, side);
        walker.addShake(0.12 * body);
        this.kZ.kick(1.5 * (1 - this.adsE * 0.4));
        this.kP.kick(1.5 * body);
        this.kY.kick((Math.random() - 0.5) * body);
        this.kR.kick((Math.random() - 0.5) * 1.8 * body);
        this.bloom = Math.min(1, this.bloom + 0.17);
        this.heat = Math.min(1.3, this.heat + 0.05);
        this.flashDur = 0.036 + Math.random() * 0.02;
        this.flash = this.flashDur;
        this.flashRoll = (Math.random() - 0.5) * 0.4 * DEG;
        this.flashScale = 0.8 + Math.random() * 0.5;
        this.flashStretch = 0.8 + Math.random() * 0.5;
        this.flashJet = 0.6 + Math.random() * 0.6;
        this.flashSeed = Math.random() * 100;
        this.lastShot = this.time;
        this.muzzle?.getWorldPosition(muzzlePos);
        this.spawnShell();
        if (foe) {
            this.enemies?.hurt(foe.id, foe.part === 'weak' ? 42 : 26);
            this.markHit(foe.part === 'weak');
            normal.set(foe.nx, foe.ny, foe.nz);
            this.spawnTracer({ x: foe.x, y: foe.y, z: foe.z, hit: true });
            this.spawnImpact(foe.x, foe.y, foe.z, foe.node, foe.size, false);
        } else {
            this.spawnTracer(hit);
            if (hit.hit) {
                normal.set(hit.nx, hit.ny, hit.nz);
                if (normal.lengthSqr() < 1e-6) {
                    normal.set(-shotDir.x, 0, -shotDir.z);
                    if (normal.lengthSqr() < 1e-6) normal.set(0, 1, 0);
                    else normal.normalize();
                }
                const ground = walker.groundAt(hit.x, hit.z);
                const concrete = normal.y > 0.72 && ground != null && Math.abs(hit.y - ground) < 0.35;
                this.spawnImpact(hit.x, hit.y, hit.z, null, concrete ? 0.26 : 0.18, concrete);
            }
        }
        if (this.light) {
            this.light.node.setWorldPosition(muzzlePos);
            this.light.node.active = true;
        }
    }

    private spawnTracer(hit: { x: number; y: number; z: number; hit: boolean }): void {
        const slot = this.tracers.find((tracer) => !tracer.alive) ?? this.tracers[0];
        if (!slot) return;
        const dx = hit.x - muzzlePos.x;
        const dy = hit.y - muzzlePos.y;
        const dz = hit.z - muzzlePos.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 0.2) return;
        slot.ox = muzzlePos.x;
        slot.oy = muzzlePos.y;
        slot.oz = muzzlePos.z;
        slot.dx = dx / dist;
        slot.dy = dy / dist;
        slot.dz = dz / dist;
        slot.dist = dist;
        slot.speed = 260;
        slot.trav = 0;
        slot.len = Math.min(Math.max(slot.speed * 0.022, 2), 7);
        slot.frames = 0;
        slot.alive = true;
        slot.node.active = true;
        slot.head.active = true;
    }

    /** World hit from an enemy round or a body hitting the ground. */
    strike(
        x: number, y: number, z: number,
        nx: number, ny: number, nz: number,
        dx: number, dy: number, dz: number,
        concrete: boolean,
    ): void {
        normal.set(nx, ny, nz);
        if (normal.lengthSqr() < 1e-6) normal.set(-dx, -dy, -dz);
        if (normal.lengthSqr() < 1e-6) normal.set(0, 1, 0);
        else normal.normalize();
        shotDir.set(dx, dy, dz);
        if (shotDir.lengthSqr() < 1e-6) shotDir.set(-normal.x, -normal.y, -normal.z);
        this.spawnImpact(x, y, z, null, concrete ? 0.22 : 0.14, concrete);
    }

    private spawnImpact(x: number, y: number, z: number, stick: Node | null, size: number, concrete: boolean): void {
        const slot = this.bursts.find((burst) => !burst.alive) ?? this.bursts[0];
        if (!slot) return;
        const floorHit = concrete;
        if (normal.lengthSqr() < 1e-6) normal.set(0, 1, 0);
        const nd = shotDir.x * normal.x + shotDir.y * normal.y + shotDir.z * normal.z;
        reflectDir.set(shotDir.x - 2 * nd * normal.x, shotDir.y - 2 * nd * normal.y, shotDir.z - 2 * nd * normal.z);
        if (reflectDir.lengthSqr() < 1e-6) reflectDir.set(normal);
        else reflectDir.normalize();
        const count = floorHit ? 4 : 8;
        const speedLo = floorHit ? 3 : 8;
        const speedHi = floorHit ? 8 : 22;
        for (let i = 0; i < slot.sparks.length; i++) {
            const spark = slot.sparks[i];
            if (i >= count) {
                spark.life = 0;
                spark.node.active = false;
                continue;
            }
            const spread = floorHit ? 0.7 : 0.45;
            tmp.set(
                reflectDir.x + (Math.random() - 0.5) * spread,
                reflectDir.y + (Math.random() - 0.2) * spread,
                reflectDir.z + (Math.random() - 0.5) * spread,
            );
            if (tmp.lengthSqr() < 1e-6) tmp.set(normal);
            else tmp.normalize();
            const speed = speedLo + Math.random() * (speedHi - speedLo);
            spark.vel.set(tmp.x * speed, tmp.y * speed, tmp.z * speed);
            spark.node.setWorldPosition(x + normal.x * 0.03, y + normal.y * 0.03, z + normal.z * 0.03);
            spark.max = floorHit ? 0.18 + Math.random() * 0.16 : 0.08 + Math.random() * 0.12;
            spark.life = spark.max;
            spark.node.active = true;
            const renderer = spark.node.getComponent(MeshRenderer);
            if (renderer) renderer.setSharedMaterial(floorHit ? slot.chipMat : slot.sparkMat, 0);
        }
        if (slot.dust) {
            slot.dust.setWorldPosition(x + normal.x * 0.04, y + normal.y * 0.04, z + normal.z * 0.04);
            slot.dust.setWorldRotation(this.camera.worldRotation);
            slot.dust.setScale(0.06, 0.06, 0.06);
            slot.dust.active = true;
            slot.dustMax = floorHit ? 0.45 : 0.22;
            slot.dustLife = slot.dustMax;
        }
        if (slot.pop) {
            slot.pop.active = !floorHit;
            slot.popLife = floorHit ? 0 : 0.045;
            if (!floorHit) {
                slot.pop.setWorldPosition(x + normal.x * 0.05, y + normal.y * 0.05, z + normal.z * 0.05);
                slot.pop.setWorldRotation(this.camera.worldRotation);
                slot.pop.setScale(0.12, 0.12, 0.12);
            }
        }
        this.placeDecal(x, y, z, concrete, stick, size);
        slot.alive = true;
    }

    private placeDecal(x: number, y: number, z: number, concrete: boolean, stick: Node | null, size: number): void {
        const mat = concrete ? this.concreteDecal : this.metalDecal;
        if (!mat || this.decals.length === 0) return;
        const node = this.decals[this.decalCursor % this.decals.length];
        this.decalCursor += 1;
        const home = stick ?? this.decalRoot;
        if (home && node.parent !== home) node.setParent(home, false);
        const lift = stick ? 0.004 : 0.008;
        tmp.set(x + normal.x * lift, y + normal.y * lift, z + normal.z * lift);
        node.setWorldPosition(tmp);
        aim.set(tmp.x - normal.x, tmp.y - normal.y, tmp.z - normal.z);
        if (Math.abs(normal.y) > 0.85) decalUp.set(0, 0, 1);
        else decalUp.set(0, 1, 0);
        node.lookAt(aim, decalUp);
        Quat.fromEuler(rollQ, 0, 0, Math.random() * 360);
        node.rotate(rollQ);
        node.setScale(size, size, 1);
        const renderer = node.getComponent(MeshRenderer);
        if (renderer) renderer.setSharedMaterial(mat, 0);
        node.active = true;
    }

    private spawnShell(): void {
        const slot = this.shells.find((shell) => shell.life <= 0) ?? this.shells[0];
        if (!slot) return;
        this.eject?.getWorldPosition(ejectPos);
        Vec3.transformQuat(right, Vec3.RIGHT, this.camera.worldRotation);
        Vec3.transformQuat(up, Vec3.UP, this.camera.worldRotation);
        Vec3.transformQuat(forward, shotLocal.set(0, 0, -1), this.camera.worldRotation);
        const side = 2 + Math.random() * 1.2;
        const lift = 1.2 + Math.random() * 0.8;
        const along = 0.5 - Math.random() * 0.6;
        slot.vel.set(
            right.x * side + up.x * lift + forward.x * along,
            right.y * side + up.y * lift + forward.y * along,
            right.z * side + up.z * lift + forward.z * along,
        );
        slot.node.setWorldPosition(ejectPos);
        slot.node.active = true;
        slot.life = 6;
        slot.spin = Math.random() * 6;
        slot.rate = (Math.random() - 0.5) * 50;
        slot.bounces = 0;
        slot.rest = false;
    }

    private spawnSmoke(): void {
        const slot = this.puffs.find((puff) => puff.life <= 0);
        if (!slot || !this.muzzle) return;
        this.muzzle.getWorldPosition(muzzlePos);
        slot.node.setWorldPosition(muzzlePos);
        slot.vel.set((Math.random() - 0.5) * 0.25, 0.45 + Math.random() * 0.25, (Math.random() - 0.5) * 0.25);
        slot.max = 1.3;
        slot.life = slot.max;
        slot.size = 0.1 + this.smoke * 0.06;
        slot.node.active = true;
    }

    private poseFx(dt: number): void {
        const inten = this.flash > 0 && this.flashDur > 0 ? 9.5 * Math.sqrt(this.flash / this.flashDur) : 0;
        const heat = smoother(clamp((this.heat - 0.45) / 0.8, 0, 1)) * 2.2;
        const show = inten > 0.02 || heat > 0.02;
        if (this.flashRoot) {
            this.flashRoot.active = show;
            if (inten > 0.02) {
                this.flashRoot.setRotationFromEuler(0, 0, this.flashRoll);
                const s = this.flashScale * (1 - this.adsE * 0.38);
                this.flashRoot.setScale(s, s, s * this.flashStretch);
            }
        }
        this.seedVec.x = this.flashSeed;
        for (let i = 0; i < this.flashMats.length; i++) {
            const vec = this.flashVecs[i];
            vec.y = inten;
            vec.z = heat;
            vec.w = this.flashJet;
            this.flashMats[i].setProperty('flash', vec);
            this.flashMats[i].setProperty('seed', this.seedVec);
        }
        if (this.light) {
            if (inten > 0.2 && this.muzzle) {
                this.muzzle.getWorldPosition(muzzlePos);
                this.light.node.setWorldPosition(muzzlePos);
                this.light.node.active = true;
            } else {
                this.light.node.active = false;
            }
        }
        for (const tracer of this.tracers) this.stepTracer(tracer, dt);
        for (const burst of this.bursts) this.stepBurst(burst, dt);
        for (const puff of this.puffs) this.stepPuff(puff, dt);
        for (const shell of this.shells) this.stepShell(shell, dt);
    }

    private stepTracer(tracer: Tracer, dt: number): void {
        if (!tracer.alive) return;
        const dist = tracer.dist;
        const len = tracer.len;
        if (tracer.frames === 0) tracer.trav = Math.min(dist, tracer.speed * Math.max(dt, 0.008) * (0.35 + Math.random() * 0.4));
        else tracer.trav += tracer.speed * dt;
        let tip = Math.min(tracer.trav, dist);
        let tail = Math.max(0, tracer.trav - len);
        if (tail >= dist) {
            if (tracer.frames >= 2) {
                tracer.alive = false;
                tracer.node.active = false;
                tracer.head.active = false;
                return;
            }
            tail = Math.max(0, dist - len * 0.5);
            tip = dist;
        }
        tracer.frames = Math.min(250, tracer.frames + 1);
        const ax = tracer.ox + tracer.dx * tail;
        const ay = tracer.oy + tracer.dy * tail;
        const az = tracer.oz + tracer.dz * tail;
        const bx = tracer.ox + tracer.dx * tip;
        const by = tracer.oy + tracer.dy * tip;
        const bz = tracer.oz + tracer.dz * tip;
        const cx = (ax + bx) * 0.5;
        const cy = (ay + by) * 0.5;
        const cz = (az + bz) * 0.5;
        const seg = Math.max(Math.hypot(bx - ax, by - ay, bz - az), 0.05);
        const cam = this.camera.worldPosition;
        const near = Math.max(0.35, Math.hypot(cam.x - ax, cam.y - ay, cam.z - az));
        const width = Math.min(0.014, Math.max(0.005, near * 0.006));
        tracer.node.setWorldPosition(cx, cy, cz);
        tmp.set(bx, by, bz);
        tracer.node.lookAt(tmp);
        tracer.node.setScale(width, width, seg);
        const head = Math.min(0.05, Math.max(0.016, near * 0.012));
        tracer.head.setWorldPosition(bx, by, bz);
        tracer.head.setWorldRotation(this.camera.worldRotation);
        tracer.head.setScale(head, head, head);
    }

    private stepBurst(burst: Burst, dt: number): void {
        if (!burst.alive) return;
        let live = 0;
        for (const spark of burst.sparks) {
            if (spark.life <= 0) continue;
            spark.life -= dt;
            if (spark.life <= 0) {
                spark.node.active = false;
                continue;
            }
            live += 1;
            spark.vel.y -= 8 * dt;
            spark.node.getWorldPosition(tmp);
            tmp.x += spark.vel.x * dt;
            tmp.y += spark.vel.y * dt;
            tmp.z += spark.vel.z * dt;
            spark.node.setWorldPosition(tmp);
            const speed = Math.hypot(spark.vel.x, spark.vel.y, spark.vel.z);
            forward.set(tmp.x + spark.vel.x, tmp.y + spark.vel.y, tmp.z + spark.vel.z);
            spark.node.lookAt(forward);
            const stretch = Math.min(0.18, 0.015 + speed * 0.008) * (spark.life / spark.max);
            spark.node.setScale(0.008, 0.008, Math.max(stretch, 0.02));
        }
        if (burst.dust && burst.dustLife > 0) {
            burst.dustLife -= dt;
            const u = 1 - burst.dustLife / burst.dustMax;
            const size = 0.05 + u * 0.16;
            burst.dust.setScale(size, size, size);
            burst.dust.setWorldRotation(this.camera.worldRotation);
            if (burst.dustMat) {
                const fade = burst.dustLife / burst.dustMax;
                burst.dustTint.set(0.42, 0.4, 0.37, 0.4 * fade);
                burst.dustMat.setProperty('tint', burst.dustTint);
            }
            if (burst.dustLife <= 0) burst.dust.active = false;
            else live += 1;
        }
        if (burst.pop && burst.popLife > 0) {
            burst.popLife -= dt;
            burst.pop.setWorldRotation(this.camera.worldRotation);
            const u = Math.max(burst.popLife, 0) / 0.045;
            const size = 0.16 * u;
            burst.pop.setScale(size, size, size);
            if (burst.popLife <= 0) burst.pop.active = false;
            else live += 1;
        }
        burst.alive = live > 0;
    }

    private stepPuff(puff: Puff, dt: number): void {
        if (puff.life <= 0) return;
        puff.life -= dt;
        if (puff.life <= 0) {
            puff.node.active = false;
            return;
        }
        puff.node.getWorldPosition(tmp);
        tmp.x += puff.vel.x * dt;
        tmp.y += puff.vel.y * dt;
        tmp.z += puff.vel.z * dt;
        puff.node.setWorldPosition(tmp);
        puff.node.setWorldRotation(this.camera.worldRotation);
        const u = 1 - puff.life / puff.max;
        const size = puff.size * (1 + u * 2.2);
        puff.node.setScale(size, size, size);
        puff.tint.set(0.55, 0.53, 0.5, 0.22 * (puff.life / puff.max));
        puff.mat.setProperty('tint', puff.tint);
    }

    private stepShell(shell: Shell, dt: number): void {
        if (shell.life <= 0) return;
        shell.life -= dt;
        if (shell.life <= 0) {
            shell.node.active = false;
            return;
        }
        if (!shell.rest) {
            shell.vel.y -= 9.81 * dt;
            shell.node.getWorldPosition(tmp);
            tmp.x += shell.vel.x * dt;
            tmp.y += shell.vel.y * dt;
            tmp.z += shell.vel.z * dt;
            const ground = this.bound?.groundAt(tmp.x, tmp.z);
            if (ground != null && tmp.y <= ground + 0.008 && shell.vel.y < 0) {
                tmp.y = ground + 0.008;
                shell.bounces += 1;
                if (shell.vel.y > -0.9 || shell.bounces >= 4) {
                    shell.rest = true;
                    shell.vel.set(0, 0, 0);
                    shell.node.setRotationFromEuler(90, shell.spin * 57, 0);
                } else {
                    shell.vel.y = -shell.vel.y * (0.32 + Math.random() * 0.16);
                    shell.vel.x = shell.vel.x * 0.6 + (Math.random() - 0.5) * 0.6;
                    shell.vel.z = shell.vel.z * 0.6 + (Math.random() - 0.5) * 0.6;
                    shell.rate *= 0.5;
                }
            }
            shell.node.setWorldPosition(tmp);
            if (!shell.rest) {
                shell.spin += shell.rate * dt;
                shell.node.setRotationFromEuler(shell.spin * 40, shell.spin * 15, shell.spin * 25);
            }
        }
    }

    private uploadGun(): void {
        if (this.gunMats.length === 0) return;
        Mat4.invert(gunInv, this.root.worldMatrix);
        this.gunCol0.set(gunInv.m00, gunInv.m01, gunInv.m02, gunInv.m03);
        this.gunCol1.set(gunInv.m04, gunInv.m05, gunInv.m06, gunInv.m07);
        this.gunCol2.set(gunInv.m08, gunInv.m09, gunInv.m10, gunInv.m11);
        this.gunCol3.set(gunInv.m12, gunInv.m13, gunInv.m14, gunInv.m15);
        for (const mat of this.gunMats) {
            mat.setProperty('gunCol0', this.gunCol0);
            mat.setProperty('gunCol1', this.gunCol1);
            mat.setProperty('gunCol2', this.gunCol2);
            mat.setProperty('gunCol3', this.gunCol3);
        }
    }

    private buildFx(
        additive: EffectAsset | null,
        muzzleFx: EffectAsset | null,
        soft: EffectAsset | null,
        solid: EffectAsset,
        decalFx: EffectAsset | null,
        sightFx: EffectAsset | null,
    ): void {
        const scene = this.camera.scene ?? this.camera.parent;
        if (!scene) return;
        this.muzzle = new Node('Muzzle');
        this.root.addChild(this.muzzle);
        this.muzzle.setPosition(MUZZLE);
        this.muzzle.layer = VIEW_LAYER;
        this.eject = new Node('Eject');
        this.root.addChild(this.eject);
        this.eject.setPosition(EJECT);

        if (muzzleFx) this.buildFlash(muzzleFx);

        const lightNode = new Node('MuzzleLight');
        scene.addChild(lightNode);
        lightNode.active = false;
        this.light = lightNode.addComponent(PointLight);
        this.light.color = new Color(255, 184, 96, 255);
        this.light.range = 6;
        this.light.luminance = 4000;
        this.light.visibility = Layers.Enum.DEFAULT | VIEW_LAYER;

        const fx = new Node('ShotFx');
        scene.addChild(fx);
        if (additive) {
            const beam = new Material();
            beam.initialize({ effectAsset: additive });
            beam.setProperty('tint', new Vec4(1, 0.78, 0.42, 0.9));
            beam.setProperty('shape', new Vec4(0, 0, 0, 0));
            const halo = new Material();
            halo.initialize({ effectAsset: additive });
            halo.setProperty('tint', new Vec4(1, 0.7, 0.35, 0.08));
            halo.setProperty('shape', new Vec4(0, 0, 0, 0));
            const head = new Material();
            head.initialize({ effectAsset: additive });
            head.setProperty('tint', new Vec4(1, 0.86, 0.5, 1.1));
            head.setProperty('shape', new Vec4(1, 0, 0, 0));
            const beamMesh = utils.MeshUtils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
            const quad = utils.MeshUtils.createMesh(primitives.quad());
            for (let i = 0; i < 6; i++) {
                const node = this.pooled(fx, 'Tracer', beamMesh, beam);
                const glow = new Node('Halo');
                node.addChild(glow);
                glow.layer = Layers.Enum.DEFAULT;
                glow.setScale(2.4, 2.4, 1.02);
                const glowMesh = glow.addComponent(MeshRenderer);
                glowMesh.mesh = beamMesh;
                glowMesh.setSharedMaterial(halo, 0);
                glowMesh.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
                glowMesh.visibility = Layers.Enum.DEFAULT;
                const tip = this.pooled(fx, 'Tip', quad, head);
                this.tracers.push({
                    node, head: tip, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1,
                    dist: 0, speed: 260, trav: 0, len: 2, frames: 0, alive: false,
                });
            }
            const metal = new Material();
            metal.initialize({ effectAsset: additive });
            metal.setProperty('tint', new Vec4(1, 0.72, 0.32, 2.6));
            metal.setProperty('shape', new Vec4(0, 0, 0, 0));
            const chip = new Material();
            chip.initialize({ effectAsset: additive });
            chip.setProperty('tint', new Vec4(0.85, 0.78, 0.62, 1.4));
            chip.setProperty('shape', new Vec4(0, 0, 0, 0));
            const popMat = new Material();
            popMat.initialize({ effectAsset: additive });
            popMat.setProperty('tint', new Vec4(1, 0.78, 0.4, 2.4));
            popMat.setProperty('shape', new Vec4(1, 0, 0, 0));
            const sparkMesh = utils.MeshUtils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
            for (let i = 0; i < 4; i++) {
                const sparks: Spark[] = [];
                for (let s = 0; s < 8; s++) {
                    sparks.push({ node: this.pooled(fx, 'Spark', sparkMesh, metal), vel: new Vec3(), life: 0, max: 0.1 });
                }
                let dust: Node | null = null;
                let dustMat: Material | null = null;
                const dustTint = new Vec4(0.42, 0.4, 0.37, 0.4);
                if (soft) {
                    dustMat = new Material();
                    dustMat.initialize({ effectAsset: soft });
                    dustMat.setProperty('tint', dustTint);
                    dust = this.pooled(fx, 'Dust', quad, dustMat);
                }
                const pop = this.pooled(fx, 'Pop', quad, popMat);
                this.bursts.push({
                    sparks, sparkMat: metal, chipMat: chip, dust, dustMat, dustTint,
                    dustLife: 0, dustMax: 0.3, pop, popLife: 0, alive: false,
                });
            }
        }
        if (soft) {
            const puffParent = scene.getChildByName('ShotFx') ?? scene;
            const puffMesh = utils.MeshUtils.createMesh(primitives.quad());
            for (let i = 0; i < 8; i++) {
                const mat = new Material();
                mat.initialize({ effectAsset: soft });
                const tint = new Vec4(0.55, 0.53, 0.5, 0);
                mat.setProperty('tint', tint);
                this.puffs.push({
                    node: this.pooled(puffParent, 'Smoke', puffMesh, mat),
                    mat, tint, vel: new Vec3(), life: 0, max: 1.3, size: 0.12,
                });
            }
        }

        const brass = new Material();
        brass.initialize({ effectAsset: solid });
        brass.setProperty('mainColor', BRASS);
        brass.setProperty('roughness', 0.3);
        brass.setProperty('metallic', 1);
        const body = utils.MeshUtils.createMesh(primitives.cylinder(0.0055, 0.0055, 0.046, { radialSegments: 8 }));
        const rim = utils.MeshUtils.createMesh(primitives.cylinder(0.0064, 0.0064, 0.004, { radialSegments: 8 }));
        const shellParent = scene.getChildByName('ShotFx') ?? scene;
        for (let i = 0; i < 24; i++) {
            const node = new Node('Shell');
            shellParent.addChild(node);
            node.active = false;
            this.shellPart(node, body, brass, 0);
            this.shellPart(node, rim, brass, -0.021);
            this.shells.push({ node, vel: new Vec3(), life: 0, spin: 0, rate: 0, bounces: 0, rest: false });
        }
        if (decalFx) this.buildDecals(decalFx, shellParent);
        if (sightFx) this.buildSight(sightFx);
    }

    private buildDecals(decalFx: EffectAsset, parent: Node): void {
        const metal = new Material();
        metal.initialize({ effectAsset: decalFx });
        metal.setProperty('mark', new Vec4(0, 0, 0, 0));
        const concrete = new Material();
        concrete.initialize({ effectAsset: decalFx });
        concrete.setProperty('mark', new Vec4(1, 0, 0, 0));
        this.metalDecal = metal;
        this.concreteDecal = concrete;
        this.decalRoot = parent;
        const mesh = quadMesh([[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]]);
        for (let i = 0; i < 40; i++) this.decals.push(this.pooled(parent, 'Decal', mesh, metal));
    }

    private buildSight(sightFx: EffectAsset): void {
        const node = new Node('Sight');
        this.root.addChild(node);
        node.layer = VIEW_LAYER;
        node.setPosition(0, 0, -0.0055);
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = quadMesh([[-0.013, 0.058, 0], [0.013, 0.058, 0], [0.013, 0.080, 0], [-0.013, 0.080, 0]]);
        const mat = new Material();
        mat.initialize({ effectAsset: sightFx });
        renderer.setSharedMaterial(mat, 0);
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        renderer.receiveShadow = false;
        renderer.visibility = VIEW_LAYER;
    }

    private buildFlash(muzzleFx: EffectAsset): void {
        this.flashRoot = new Node('Flash');
        this.muzzle?.addChild(this.flashRoot);
        this.flashRoot.layer = VIEW_LAYER;
        this.flashRoot.active = false;
        const parts: { kind: number; corners: number[][] }[] = [
            { kind: 0, corners: [[-0.13, -0.13, -0.03], [0.13, -0.13, -0.03], [0.13, 0.13, -0.03], [-0.13, 0.13, -0.03]] },
            { kind: 0, corners: [[-0.091, -0.091, -0.09], [0.091, -0.091, -0.09], [0.091, 0.091, -0.09], [-0.091, 0.091, -0.09]] },
            { kind: 1, corners: [[-0.065, 0, 0.01], [0.065, 0, 0.01], [0.065, 0, -0.34], [-0.065, 0, -0.34]] },
            { kind: 1, corners: [[0, -0.065, 0.01], [0, 0.065, 0.01], [0, 0.065, -0.34], [0, -0.065, -0.34]] },
            { kind: 2, corners: [[-0.17, -0.05, 0.035], [0.17, -0.05, 0.035], [0.17, 0.05, 0.035], [-0.17, 0.05, 0.035]] },
            { kind: 2, corners: [[-0.17, 0, 0.085], [0.17, 0, 0.085], [0.17, 0, -0.015], [-0.17, 0, -0.015]] },
            { kind: 3, corners: [[-0.05, -0.05, -0.01], [0.05, -0.05, -0.01], [0.05, 0.05, -0.01], [-0.05, 0.05, -0.01]] },
            { kind: 4, corners: [[-0.03, -0.03, 0.02], [0.03, -0.03, 0.02], [0.03, 0.03, 0.02], [-0.03, 0.03, 0.02]] },
        ];
        for (const part of parts) {
            const mat = new Material();
            mat.initialize({ effectAsset: muzzleFx });
            const flash = new Vec4(part.kind, 0, 0, 1);
            mat.setProperty('flash', flash);
            mat.setProperty('seed', this.seedVec);
            this.flashMats.push(mat);
            this.flashVecs.push(flash);
            const node = new Node('Part');
            this.flashRoot.addChild(node);
            node.layer = VIEW_LAYER;
            const renderer = node.addComponent(MeshRenderer);
            renderer.mesh = quadMesh(part.corners);
            renderer.setSharedMaterial(mat, 0);
            renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            renderer.receiveShadow = false;
            renderer.visibility = VIEW_LAYER;
        }
    }

    private shellPart(parent: Node, mesh: ReturnType<typeof utils.MeshUtils.createMesh>, mat: Material, y: number): void {
        const node = new Node('Brass');
        parent.addChild(node);
        node.setPosition(0, y, 0);
        node.layer = Layers.Enum.DEFAULT;
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = mesh;
        renderer.setSharedMaterial(mat, 0);
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        renderer.receiveShadow = true;
        renderer.visibility = Layers.Enum.DEFAULT;
    }

    private pooled(parent: Node, name: string, mesh: ReturnType<typeof utils.MeshUtils.createMesh>, mat: Material): Node {
        const node = new Node(name);
        parent.addChild(node);
        node.active = false;
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = mesh;
        renderer.setSharedMaterial(mat, 0);
        renderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
        renderer.receiveShadow = false;
        renderer.visibility = Layers.Enum.DEFAULT;
        return node;
    }
}

class Spring {
    x = 0;
    v = 0;

    constructor(private readonly k: number, private readonly c: number) {}

    kick(amount: number): void {
        this.v += amount;
    }

    step(dt: number): void {
        let remain = dt;
        while (remain > 1e-5) {
            const s = Math.min(0.008, remain);
            this.v += ((-this.x) * this.k - this.v * this.c) * s;
            this.x += this.v * s;
            remain -= s;
        }
    }
}

interface Tracer {
    node: Node;
    head: Node;
    ox: number;
    oy: number;
    oz: number;
    dx: number;
    dy: number;
    dz: number;
    dist: number;
    speed: number;
    trav: number;
    len: number;
    frames: number;
    alive: boolean;
}

interface Spark {
    node: Node;
    vel: Vec3;
    life: number;
    max: number;
}

interface Burst {
    sparks: Spark[];
    sparkMat: Material;
    chipMat: Material;
    dust: Node | null;
    dustMat: Material | null;
    dustTint: Vec4;
    dustLife: number;
    dustMax: number;
    pop: Node | null;
    popLife: number;
    alive: boolean;
}

interface Puff {
    node: Node;
    mat: Material;
    tint: Vec4;
    vel: Vec3;
    life: number;
    max: number;
    size: number;
}

interface Shell {
    node: Node;
    vel: Vec3;
    life: number;
    spin: number;
    rate: number;
    bounces: number;
    rest: boolean;
}

interface Streams {
    p: number[];
    n: number[];
    u: number[];
    c: number[];
    min: Vec3;
    max: Vec3;
}

function emptyStreams(): Streams {
    return {
        p: [],
        n: [],
        u: [],
        c: [],
        min: new Vec3(Infinity, Infinity, Infinity),
        max: new Vec3(-Infinity, -Infinity, -Infinity),
    };
}

function pushVert(
    dst: Streams,
    positions: ArrayLike<number>,
    normals: ArrayLike<number> | null,
    uvs: ArrayLike<number> | null,
    colors: ArrayLike<number> | null,
    colorStride: number,
    colorScale: number,
    id: number,
): void {
    const o = id * 3;
    const x = positions[o];
    const y = positions[o + 1];
    const z = positions[o + 2];
    dst.p.push(x, y, z);
    dst.min.x = Math.min(dst.min.x, x);
    dst.min.y = Math.min(dst.min.y, y);
    dst.min.z = Math.min(dst.min.z, z);
    dst.max.x = Math.max(dst.max.x, x);
    dst.max.y = Math.max(dst.max.y, y);
    dst.max.z = Math.max(dst.max.z, z);
    if (normals) dst.n.push(normals[o], normals[o + 1], normals[o + 2]);
    if (uvs) dst.u.push(uvs[id * 2], uvs[id * 2 + 1]);
    if (colors && colorStride >= 3) {
        const c = id * colorStride;
        dst.c.push(colors[c] * colorScale, colors[c + 1] * colorScale, colors[c + 2] * colorScale, colorStride > 3 ? colors[c + 3] * colorScale : 1);
    } else dst.c.push(1, 1, 1, 1);
}

function buildStreams(src: Streams): ReturnType<typeof utils.MeshUtils.createMesh> | null {
    const count = src.p.length / 3;
    if (count < 3 || count > 65000) return null;
    const indices: number[] = [];
    for (let i = 0; i < count; i++) indices.push(i);
    return utils.MeshUtils.createMesh({
        positions: src.p,
        normals: src.n.length > 0 ? src.n : undefined,
        uvs: src.u.length > 0 ? src.u : undefined,
        colors: src.c,
        indices,
        minPos: src.min,
        maxPos: src.max,
    });
}

function quadMesh(corners: number[][]): ReturnType<typeof utils.MeshUtils.createMesh> {
    const positions: number[] = [];
    const min = new Vec3(Infinity, Infinity, Infinity);
    const max = new Vec3(-Infinity, -Infinity, -Infinity);
    for (const corner of corners) {
        positions.push(corner[0], corner[1], corner[2]);
        min.x = Math.min(min.x, corner[0]);
        min.y = Math.min(min.y, corner[1]);
        min.z = Math.min(min.z, corner[2]);
        max.x = Math.max(max.x, corner[0]);
        max.y = Math.max(max.y, corner[1]);
        max.z = Math.max(max.z, corner[2]);
    }
    return utils.MeshUtils.createMesh({
        positions,
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
        indices: [0, 1, 2, 0, 2, 3],
        minPos: min,
        maxPos: max,
    });
}

function smoother(t: number): number {
    const x = t < 0 ? 0 : t > 1 ? 1 : t;
    return x * x * x * (x * (x * 6 - 15) + 10);
}

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

function damp(current: number, target: number, rate: number, dt: number): number {
    return target + (current - target) * Math.exp(-rate * dt);
}

function partFor(name: string): { key: string; color: Color; rough: number; metal: number } | null {
    let best: string | null = null;
    for (const key of Object.keys(PARTS)) {
        if (name !== key && !name.startsWith(key)) continue;
        if (!best || key.length > best.length) best = key;
    }
    if (!best) return null;
    return { key: best, color: PARTS[best].color, rough: PARTS[best].rough, metal: PARTS[best].metal };
}

function loadStandard(): Promise<EffectAsset | null> {
    return new Promise((resolve) => {
        assetManager.loadAny({ uuid: STANDARD }, (err: Error | null, asset: EffectAsset) => {
            if (err || !asset) {
                console.warn('[saltline-enji] viewmodel material skipped', err);
                resolve(null);
                return;
            }
            resolve(asset);
        });
    });
}
