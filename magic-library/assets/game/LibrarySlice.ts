import {
    Camera, Color, Director, EventKeyboard, EventMouse, Input, KeyCode, Material, MeshRenderer, Node, primitives, Quat, utils, Vec3, director, input, instantiate,
} from 'cc';
import { loadBuiltinEffect, loadModel, preloadModel } from '../enji/helpers';
import { bookMeshIndex, buildBookMeshes } from './bookLooks';
import { BookSim, SimBook, SimRamp } from './BookSim';
import { bookLabel, bookTitle, subjectColor, subjectName, volumeName } from './catalog';
import { GameAudio } from './GameAudio';
import { Hud } from './Hud';
import { LevelDef } from './levels';
import { LOOSE_BOOKS } from './looseCatalog';
import { scatterFloors } from './scatter';
import { CandleRig, candlesEnabled, flickerCandles, lightCandles } from './candles';
import { eyeHeight, lookSens } from './playFeel';
import { newlyUnlocked, SkillBook, SkillId, SKILL_DEFS, skillLevel } from './skills';

function waitDrawnFrames(count: number): Promise<void> {
    return new Promise((resolve) => {
        let left = Math.max(1, count);
        const tick = () => {
            left -= 1;
            if (left <= 0) resolve();
            else director.once(Director.EVENT_AFTER_DRAW, tick);
        };
        director.once(Director.EVENT_AFTER_DRAW, tick);
    });
}

const WALK = 3.4;
const REACH = 2.8;
const SLOT_AIM = 0.16;
/** Open face of the shelf mesh is local +Z. Authored yaw points that face at the wall. */
const SHELF_FLIP = new Quat();
Quat.fromAxisAngle(SHELF_FLIP, new Vec3(0, 1, 0), Math.PI);
/**
 * Book in the hand: cover tilted toward the lens, long side across the view.
 * Flat to the screen reads as a sticker and makes the stack z-fight.
 */
const HOLD_TILT = 32 * Math.PI / 180;
const HOLD_CAM = new Quat();
const HOLD_FACE = new Vec3();
{
    const turnY = new Quat();
    const turnZ = new Quat();
    const flat = new Quat();
    const tilt = new Quat();
    Quat.fromAxisAngle(turnY, new Vec3(0, 1, 0), -Math.PI / 2);
    Quat.fromAxisAngle(turnZ, new Vec3(0, 0, 1), -Math.PI / 2);
    Quat.multiply(flat, turnZ, turnY);
    Quat.fromAxisAngle(tilt, new Vec3(1, 0, 0), -HOLD_TILT);
    Quat.multiply(HOLD_CAM, tilt, flat);
    Vec3.transformQuat(HOLD_FACE, new Vec3(1, 0, 0), HOLD_CAM);
}
const PICK_FLY = 0.32;
const PLACE_FLY = 0.32;
const STACK_FLY = 0.18;
const STACK_GAP = 0.05;
const LOCAL_RIGHT = new Vec3(1, 0, 0);
const TOSS_YAW = new Quat();
const TOSS_TILT = new Quat();
const TOSS_ROT = new Quat();
const BOOK_MID = new Vec3(0, 0.12, 0);
/** Local box of the book mesh, plus a few millimetres so the rim still counts. */
const HIT_MIN = [-0.024, -0.002, -0.084];
const HIT_MAX = [0.024, 0.242, 0.084];
/** Same first step as the original carry ladder. */
const CARRY_CAP = 3;
const BODY_R = 0.28;
const STEP = 0.45; // max height change per move (stairs), never floor-to-floor jump
const LOCAL_FORWARD = new Vec3(0, 0, -1);
type LooseBook = {
    node: Node;
    subject: number;
    emblem: number;
    volume: number;
    sim: SimBook;
};

type Slot = {
    local: Vec3;
    world: Vec3;
    subject: number;
    volume: number;
    bayQuat: Quat;
    bay: number;
    row: number;
    series: number;
    filled: LooseBook | null;
    /** Subject and volume both match. A mismatch still sits on the shelf. */
    matched: boolean;
};

type AimMark = { node: Node; fill: MeshRenderer; edges: MeshRenderer[] };

type Floor = LevelDef['layout']['floors'][number];
type Ramp = LevelDef['layout'] extends { ramps: infer R } ? R extends readonly (infer Item)[] ? Item : never : never;

function smoothstep(t: number): number {
    return t * t * (3 - 2 * t);
}

function inRect(x: number, z: number, x0: number, x1: number, z0: number, z1: number): boolean {
    return x >= x0 && x <= x1 && z >= z0 && z <= z1;
}

/** Entry distance of a local-space ray through the book box. */
function raySlab(o: Vec3, d: Vec3): number | null {
    let tmin = 0.25;
    let tmax = REACH;
    const origin = [o.x, o.y, o.z];
    const dir = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) {
        if (Math.abs(dir[i]) < 1e-7) {
            if (origin[i] < HIT_MIN[i] || origin[i] > HIT_MAX[i]) return null;
            continue;
        }
        let t1 = (HIT_MIN[i] - origin[i]) / dir[i];
        let t2 = (HIT_MAX[i] - origin[i]) / dir[i];
        if (t1 > t2) {
            const swap = t1;
            t1 = t2;
            t2 = swap;
        }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
    }
    return tmin;
}

/** Basic tidy loop: two-floor walk + stairs, pick, shelf. */
export class LibrarySlice {
    private world: Node;
    private cameraNode: Node;
    private readonly hud: Hud;
    private readonly audio: GameAudio;
    private readonly level: LevelDef;
    private readonly skills = new SkillBook();
    private stage: Node | null = null;
    private stepDist = 0;
    private stepStride = 1.05;
    private paused = false;

    private yaw = 0;
    private pitch = 0;
    private keys = new Set<KeyCode>();
    private looking = false;
    private lastMx = 0;
    private lastMy = 0;
    private feetY = 0;

    private loose: LooseBook[] = [];
    private slots: Slot[] = [];
    /** Bottom to top. The last one is the book that places next. */
    private held: LooseBook[] = [];
    private readonly glides = new Map<LooseBook, { fromP: Vec3; fromR: Quat; t: number; dur: number }>();
    /** Books that have left the hand and are still flying to a slot. */
    private readonly placeFlights: {
        book: LooseBook;
        fromP: Vec3;
        fromR: Quat;
        toP: Vec3;
        toR: Quat;
        t: number;
    }[] = [];
    private readonly restP = new Vec3();
    private readonly restR = new Quat();
    private carry: Node;

    private floors: readonly Floor[] = [];
    private ramps: readonly Ramp[] = [];
    private bookSim: BookSim | null = null;

    private readonly forward = new Vec3();
    private readonly right = new Vec3();
    private readonly eye = new Vec3();
    private readonly scratch = new Vec3();
    private readonly scratch2 = new Vec3();
    private readonly qTmp = new Quat();
    private aimBook: AimMark | null = null;
    private aimSlot: AimMark | null = null;
    private guideMark: AimMark | null = null;
    private readonly glowBooks: LooseBook[] = [];
    private readonly glowNodes: Node[] = [];
    private glowT = 0;
    private candleRig: CandleRig | null = null;
    private hallNode: Node | null = null;
    private readonly bayPos: Vec3[] = [];
    private readonly bayFace: Vec3[] = [];
    private readonly baySubject: number[] = [];
    private colsTotal = 1;
    private rowsTotal = 1;
    private matHoverFill: Material | null = null;
    private matHoverEdge: Material | null = null;
    private matGoodFill: Material | null = null;
    private matGoodEdge: Material | null = null;
    private matBadFill: Material | null = null;
    private matBadEdge: Material | null = null;

    constructor(level: LevelDef, world: Node, cameraNode: Node, _camera: Camera, hud: Hud, audio: GameAudio) {
        this.level = level;
        this.world = world;
        this.cameraNode = cameraNode;
        this.hud = hud;
        this.audio = audio;
        this.floors = level.layout.floors as readonly Floor[];
        this.ramps = ('ramps' in level.layout ? level.layout.ramps : []) as readonly Ramp[];
        hud.bind({
            onPrimary: () => this.primaryAction(),
            onDrop: () => this.dropTop(),
            onThrow: () => this.throwTop(),
            onCycle: () => this.cycleHeld(),
            onSkill: (index) => {
                const def = SKILL_DEFS[index];
                if (def) this.useSkill(def.id);
            },
            onMenu: () => {},
        });
        this.carry = new Node('Carry');
        this.cameraNode.addChild(this.carry);
        // Lower right, in front of the lens. The stack follows look.
        this.carry.setPosition(0.22, -0.24, -0.72);
    }

    /** Drop or raise the camera after a height change in settings. */
    applyEye(): void {
        const p = this.cameraNode.position;
        this.cameraNode.setPosition(p.x, this.feetY + eyeHeight(), p.z);
    }

    setPaused(on: boolean): void {
        this.paused = on;
        if (on) {
            this.keys.clear();
            this.looking = false;
        }
    }

    setMenu(onMenu: () => void): void {
        this.hud.bind({
            onPrimary: () => this.primaryAction(),
            onDrop: () => this.dropTop(),
            onThrow: () => this.throwTop(),
            onCycle: () => this.cycleHeld(),
            onSkill: (index) => {
                const def = SKILL_DEFS[index];
                if (def) this.useSkill(def.id);
            },
            onMenu,
        });
    }

    async start(onProgress?: (msg: string) => void): Promise<void> {
        const note = (msg: string) => onProgress?.(msg);
        note(`加载${this.level.title}…`);
        await Promise.all([
            preloadModel(this.level.hall),
            preloadModel(this.level.bay),
            preloadModel('models/Book_s0_e0_v1'),
        ]);

        this.stage = new Node('Stage');
        // Keep the stage off until everything is placed so an early curtain never
        // reveals an empty room.
        this.stage.active = false;
        this.world.addChild(this.stage);

        note('布置大厅…');
        const hall = await loadModel(this.level.hall);
        this.stage.addChild(hall);
        this.hallNode = hall;
        await this.applyCandles();
        this.bookSim = new BookSim(this.stage, this.floors, this.ramps as unknown as SimRamp[]);

        note('摆放书架…');
        const bayPrefab = await preloadModel(this.level.bay);
        const layout = this.level.layout;
        const baseSlots = layout.slots_bay_local;
        const expandRows = baseSlots.every((s) => (s.row ?? 0) === 0);
        layout.bays.forEach((bay, bayIndex) => {
            const bayNode = instantiate(bayPrefab);
            this.stage!.addChild(bayNode);
            bayNode.setPosition(bay.pos[0], bay.pos[1], bay.pos[2]);
            const br = bay.rot; // w,x,y,z
            const authored = new Quat(br[1], br[2], br[3], br[0]);
            const bayQuat = new Quat();
            if (this.level.shelfFlip) Quat.multiply(bayQuat, authored, SHELF_FLIP);
            else Quat.copy(bayQuat, authored);
            bayNode.setRotation(bayQuat);
            const face = new Vec3();
            // Gothic opens on local +Z; ArchiveBay opens on local -X (slots authored +X → flip sign).
            const openLocal = this.level.id === 'archive' ? new Vec3(-1, 0, 0) : new Vec3(0, 0, 1);
            Vec3.transformQuat(face, openLocal, bayQuat);
            this.bayPos.push(new Vec3(bay.pos[0], bay.pos[1], bay.pos[2]));
            this.bayFace.push(face);
            this.baySubject.push(bay.subject);

            const rowCount = expandRows ? 7 : 1;
            for (let row = 0; row < rowCount; row++) {
                for (const s of baseSlots) {
                    const local = new Vec3(
                        this.level.id === 'archive' ? -s.pos[0] : s.pos[0],
                        expandRows ? s.pos[1] + row * 0.28 : s.pos[1],
                        s.pos[2],
                    );
                Vec3.transformQuat(this.scratch, local, bayQuat);
                const world = new Vec3(
                    bay.pos[0] + this.scratch.x,
                    bay.pos[1] + this.scratch.y,
                    bay.pos[2] + this.scratch.z,
                );
                this.slots.push({
                    local,
                    world,
                    subject: bay.subject,
                    volume: s.volume,
                    bayQuat,
                        bay: bayIndex,
                        row: expandRows ? row : s.row,
                        series: s.series,
                    filled: null,
                        matched: false,
                });
            }
        }
        });
        this.colsTotal = new Set(this.slots.map((s) => `${s.bay}|${s.row}|${s.series}`)).size;
        this.rowsTotal = new Set(this.slots.map((s) => `${s.bay}|${s.row}`)).size;

        note('散落书本…');
        const bookPrefab = await preloadModel('models/Book_s0_e0_v1');
        const sample = instantiate(bookPrefab);
        const sampleRenderer = sample.getComponentInChildren(MeshRenderer);
        const meshes = buildBookMeshes(sampleRenderer!.mesh!);
        sample.destroy();
        const poses = scatterFloors(LOOSE_BOOKS.length, this.floors, layout.player_spawn.pos);
        for (let i = 0; i < LOOSE_BOOKS.length; i++) {
            const [subject, emblem, volume] = LOOSE_BOOKS[i];
            const pose = poses[i];
            const node = instantiate(bookPrefab);
            this.stage!.addChild(node);
            node.setPosition(pose.x, pose.y, pose.z);
            node.setRotation(pose.rot);
            const renderer = node.getComponentInChildren(MeshRenderer);
            if (renderer) renderer.mesh = meshes[bookMeshIndex(subject, emblem, volume)];
            this.loose.push({
                node, subject, emblem, volume,
                sim: this.bookSim.bindLoose(node),
            });
            if ((i + 1) % 400 === 0) {
                note(`散落书本… ${i + 1}/${LOOSE_BOOKS.length}`);
                await new Promise<void>((r) => setTimeout(r, 0));
            }
        }

        const spawn = layout.player_spawn;
        this.feetY = spawn.pos[1];
        this.cameraNode.setPosition(spawn.pos[0], this.feetY + eyeHeight(), spawn.pos[2]);
        const fx = spawn.facing[0];
        const fz = spawn.facing[2];
        this.yaw = Math.atan2(-fx, -fz) * 180 / Math.PI;
        this.pitch = 0;
        this.applyLook();

        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);

        note('校准准星…');
        await this.buildAim();

        // Reveal the stage only after everything is placed, then wait for real
        // draws so the curtain never opens onto an empty / half-uploaded room.
        note('点亮场景…');
        this.stage.active = true;
        await waitDrawnFrames(18);
        this.hint(`${this.level.title} · 对准书，E 或左键捡起`);
        note('场景就绪');
    }

    /** Corner brackets and a light tint, just outside the book. */
    private async buildAim(): Promise<void> {
        await loadBuiltinEffect('builtin-unlit');
        const make = (technique: number, r: number, g: number, b: number, a: number) => {
            const m = new Material();
            m.initialize({ effectName: 'builtin-unlit', technique });
            m.setProperty('mainColor', new Color(r, g, b, a));
            return m;
        };
        this.matHoverFill = make(1, 255, 214, 120, 70);
        this.matHoverEdge = make(0, 255, 230, 150, 255);
        this.matGoodFill = make(1, 120, 255, 176, 70);
        this.matGoodEdge = make(0, 160, 255, 196, 255);
        this.matBadFill = make(1, 255, 96, 88, 76);
        this.matBadEdge = make(0, 255, 128, 112, 255);
        const mesh = utils.MeshUtils.createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
        const gap = 0.014;
        const te = 0.018;
        const half = [0.02 + gap, 0.12 + gap, 0.08 + gap];
        const arm = [0.032, 0.08, 0.06];
        const addMesh = (parent: Node, name: string) => {
            const n = new Node(name);
            parent.addChild(n);
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            mr.receiveShadow = false;
            return { n, mr };
        };
        const makeMark = (name: string): AimMark => {
            const root = new Node(name);
            (this.stage ?? this.world).addChild(root);
            const fill = addMesh(root, 'Fill');
            fill.n.setScale((half[0]) * 2, half[1] * 2, half[2] * 2);
            const edges: MeshRenderer[] = [];
            const signs = [-1, 1];
            for (const sx of signs) {
                for (const sy of signs) {
                    for (const sz of signs) {
                        const cx = sx * half[0];
                        const cy = sy * half[1];
                        const cz = sz * half[2];
                        const stubs: Array<[number, number, number, number, number, number]> = [
                            [cx - sx * arm[0] * 0.5, cy, cz, arm[0], te, te],
                            [cx, cy - sy * arm[1] * 0.5, cz, te, arm[1], te],
                            [cx, cy, cz - sz * arm[2] * 0.5, te, te, arm[2]],
                        ];
                        for (const [px, py, pz, sxScale, syScale, szScale] of stubs) {
                            const edge = addMesh(root, 'Edge');
                            edge.n.setPosition(px, py, pz);
                            edge.n.setScale(sxScale, syScale, szScale);
                            edges.push(edge.mr);
                        }
                    }
                }
            }
            root.active = false;
            return { node: root, fill: fill.mr, edges };
        };
        this.aimBook = makeMark('AimBook');
        this.aimSlot = makeMark('AimSlot');
        this.guideMark = makeMark('Guide');
        const glowMesh = utils.MeshUtils.createMesh(primitives.box({ width: 0.09, height: 0.3, length: 0.22 }));
        const glowMat = make(1, 255, 214, 120, 80);
        for (let i = 0; i < 9; i++) {
            const node = new Node('Glow');
            (this.stage ?? this.world).addChild(node);
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = glowMesh;
            mr.setSharedMaterial(glowMat, 0);
            mr.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            node.active = false;
            this.glowNodes.push(node);
        }
    }

    /** Spawns flames only while the settings switch is on. Default is off. */
    async applyCandles(): Promise<void> {
        const hall = this.hallNode;
        if (!hall?.isValid) return;
        if (!candlesEnabled()) {
            this.extinguish(hall);
            return;
        }
        if (!this.candleRig) this.candleRig = await lightCandles(hall, this.level.id);
    }

    private extinguish(hall: Node): void {
        this.candleRig = null;
        for (const child of [...hall.children]) {
            if (child.name === 'Flame' || child.name === 'Wick') child.destroy();
        }
    }

    private hint(text: string): void {
        this.hud.setHint(text);
    }

    dispose(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
        for (const book of this.held) {
            if (book.node.isValid) book.node.destroy();
        }
        this.held.length = 0;
        this.loose.length = 0;
        this.slots.length = 0;
        this.placeFlights.length = 0;
        this.glides.clear();
        this.glowBooks.length = 0;
        this.bayPos.length = 0;
        this.bayFace.length = 0;
        this.baySubject.length = 0;
        this.bookSim = null;
        this.aimBook = null;
        this.aimSlot = null;
        this.guideMark = null;
        this.glowNodes.length = 0;
        this.candleRig = null;
        this.hallNode = null;
        if (this.stage?.isValid) this.stage.destroy();
        this.stage = null;
    }

    update(dt: number): void {
        if (this.paused) return;
        const ox = this.cameraNode.position.x;
        const oz = this.cameraNode.position.z;
        const moved = this.move(dt);
        const p = this.cameraNode.position;
        this.bookSim?.syncPlayer(p.x, this.feetY, p.z);
        if (moved) {
            const woken = this.bookSim?.wakeNearPlayer(p.x, this.feetY, p.z) ?? 0;
            if (woken > 0) this.audio.play('books_shove', 0.45 + Math.min(0.35, woken * 0.05), 0.14, 0.12);
            this.stepDist += Math.hypot(p.x - ox, p.z - oz);
            // About three steps a second at full walk, not a seven-hertz tick.
            if (this.stepDist >= this.stepStride) {
                this.stepDist = 0;
                const base = woken > 0 ? 1.15 : 1.05;
                this.stepStride = base * (0.92 + Math.random() * 0.16);
                this.audio.playStep(woken > 0 ? 0.14 : 0.36);
            }
        }
        this.bookSim?.update(dt);
        const ended = this.skills.update(dt);
        if (ended.indexOf('insight') >= 0) this.glowBooks.length = 0;
        this.poseHeld(dt);
        this.posePlaced(dt);
        this.updateGuide();
        this.updateAim();
        this.updateGlows(dt);
        if (this.candleRig) flickerCandles(this.candleRig, this.glowT);
        this.refreshHint();
        this.refreshHud();
        this.hud.update(dt);
    }

    private onKeyDown(e: EventKeyboard): void {
        if (this.paused) return;
        this.keys.add(e.keyCode);
        if (e.keyCode === KeyCode.KEY_E) this.tryInteract();
        else if (e.keyCode === KeyCode.KEY_Q) this.throwTop();
        else if (e.keyCode === KeyCode.KEY_R) this.cycleHeld();
        else if (e.keyCode >= KeyCode.DIGIT_1 && e.keyCode <= KeyCode.DIGIT_5) {
            const def = SKILL_DEFS[e.keyCode - KeyCode.DIGIT_1];
            if (def) this.useSkill(def.id);
        }
    }
    private onKeyUp(e: EventKeyboard): void { this.keys.delete(e.keyCode); }

    private onMouseDown(e: EventMouse): void {
        if (this.paused) return;
        if (e.getButton() === EventMouse.BUTTON_RIGHT) {
            this.looking = true;
            this.lastMx = e.getLocationX();
            this.lastMy = e.getLocationY();
        } else if (e.getButton() === EventMouse.BUTTON_LEFT) {
            const loc = e.getUILocation();
            if (this.hud.hit(loc.x, loc.y)) return;
            this.tryInteract();
        }
    }
    private onMouseUp(e: EventMouse): void {
        if (e.getButton() === EventMouse.BUTTON_RIGHT) this.looking = false;
    }
    private onMouseMove(e: EventMouse): void {
        if (this.paused || !this.looking) return;
        const x = e.getLocationX();
        const y = e.getLocationY();
        const sens = lookSens();
        this.yaw -= (x - this.lastMx) * sens;
        this.pitch = Math.max(-80, Math.min(80, this.pitch + (y - this.lastMy) * sens));
        this.lastMx = x;
        this.lastMy = y;
        this.applyLook();
    }

    private applyLook(): void {
        this.cameraNode.setRotationFromEuler(this.pitch, this.yaw, 0);
    }

    private cameraForward(out: Vec3): void {
        Vec3.transformQuat(out, LOCAL_FORWARD, this.cameraNode.worldRotation);
        out.normalize();
    }

    private floorBlocked(f: Floor, x: number, z: number): boolean {
        const wz = f.walk_zone_xz;
        if (!inRect(x, z, wz[0], wz[1], wz[2], wz[3])) return true;
        for (const h of f.holes) {
            if (inRect(x, z, h.min_xz[0], h.max_xz[0], h.min_xz[1], h.max_xz[1])) return true;
        }
        for (const b of f.blockers) {
            if (inRect(
                x, z,
                b.min_xz[0] - BODY_R, b.max_xz[0] + BODY_R,
                b.min_xz[1] - BODY_R, b.max_xz[1] + BODY_R,
            )) return true;
        }
        return false;
    }

    /** Feet height at (x,z) reachable from current feetY; null if blocked. */
    private surface(x: number, z: number): number | null {
        const from = this.feetY;
        for (const r of this.ramps) {
            if (!inRect(x, z, r.min_xz[0], r.max_xz[0], r.min_xz[1], r.max_xz[1])) continue;
            const wz = this.floors[0]?.walk_zone_xz;
            if (wz && !inRect(x, z, wz[0], wz[1], wz[2], wz[3])) return null;
            const v = r.axis === 'x' ? x : z;
            const t = Math.max(0, Math.min(1, (v - r.from) / (r.to - r.from)));
            const h = r.y0 + (r.y1 - r.y0) * t;
            return Math.abs(h - from) <= STEP ? h : null;
        }
        for (const f of this.floors) {
            if (Math.abs(f.y - from) <= STEP && !this.floorBlocked(f, x, z)) return f.y;
        }
        return null;
    }

    private tryStep(nx: number, nz: number): number | null {
        return this.surface(nx, nz);
    }

    private move(dt: number): boolean {
        let fwd = 0;
        let side = 0;
        if (this.keys.has(KeyCode.KEY_W) || this.keys.has(KeyCode.ARROW_UP)) fwd += 1;
        if (this.keys.has(KeyCode.KEY_S) || this.keys.has(KeyCode.ARROW_DOWN)) fwd -= 1;
        if (this.keys.has(KeyCode.KEY_D) || this.keys.has(KeyCode.ARROW_RIGHT)) side += 1;
        if (this.keys.has(KeyCode.KEY_A) || this.keys.has(KeyCode.ARROW_LEFT)) side -= 1;
        if (fwd === 0 && side === 0) return false;

        const rad = this.yaw * Math.PI / 180;
        this.forward.set(-Math.sin(rad), 0, -Math.cos(rad));
        this.right.set(Math.cos(rad), 0, -Math.sin(rad));
        const p = this.cameraNode.position;
        const ox = p.x;
        const oz = p.z;
        let nx = ox + this.forward.x * fwd * WALK * dt + this.right.x * side * WALK * dt;
        let nz = oz + this.forward.z * fwd * WALK * dt + this.right.z * side * WALK * dt;

        // Axis-separated slide so a wall does not cancel the free axis.
        let x = ox;
        let z = oz;
        let h = this.tryStep(nx, oz);
        if (h !== null) {
            x = nx;
            this.feetY = h;
        }
        h = this.tryStep(x, nz);
        if (h !== null) {
            z = nz;
            this.feetY = h;
        }

        this.cameraNode.setPosition(x, this.feetY + eyeHeight(), z);
        return x !== ox || z !== oz;
    }

    private topHeld(): LooseBook | null {
        return this.held.length > 0 ? this.held[this.held.length - 1] : null;
    }

    /** Rest pose in carry space. Older books sit deeper into the palm, along the cover normal. */
    private restHeld(index: number, outP: Vec3, outR: Quat): void {
        const fromTop = this.held.length - 1 - index;
        const jitter = ((index % 3) - 1) * 0.005;
        const pile = fromTop * STACK_GAP;
        Quat.copy(outR, HOLD_CAM);
        Vec3.transformQuat(this.scratch2, BOOK_MID, HOLD_CAM);
        outP.set(
            -this.scratch2.x - HOLD_FACE.x * pile + jitter,
            -this.scratch2.y - HOLD_FACE.y * pile - fromTop * 0.01,
            -this.scratch2.z - HOLD_FACE.z * pile,
        );
    }

    private beginGlide(book: LooseBook, dur: number, restart: boolean): void {
        if (this.glides.has(book) && !restart) return;
        const fromP = new Vec3();
        const fromR = new Quat();
        Vec3.copy(fromP, book.node.position);
        Quat.copy(fromR, book.node.rotation);
        this.glides.set(book, { fromP, fromR, t: 0, dur });
    }

    /** Ease every carried book toward its rest pose. A fresh pick flies in from the floor. */
    private poseHeld(dt: number): void {
        for (let i = 0; i < this.held.length; i++) {
            const book = this.held[i];
            this.restHeld(i, this.restP, this.restR);
            const glide = this.glides.get(book);
            if (!glide) {
                book.node.setPosition(this.restP);
                book.node.setRotation(this.restR);
                continue;
            }
            glide.t += dt;
            const k = smoothstep(Math.min(1, glide.t / glide.dur));
            Vec3.lerp(this.scratch, glide.fromP, this.restP, k);
            Quat.slerp(this.qTmp, glide.fromR, this.restR, k);
            book.node.setPosition(this.scratch);
            book.node.setRotation(this.qTmp);
            if (glide.t >= glide.dur) this.glides.delete(book);
        }
    }

    /** Ease a released book from the hand to the slot, then leave it standing. */
    private posePlaced(dt: number): void {
        for (let i = this.placeFlights.length - 1; i >= 0; i--) {
            const flight = this.placeFlights[i];
            flight.t += dt;
            if (flight.t < 0) continue;
            const k = smoothstep(Math.min(1, flight.t / PLACE_FLY));
            Vec3.lerp(this.scratch, flight.fromP, flight.toP, k);
            Quat.slerp(this.qTmp, flight.fromR, flight.toR, k);
            flight.book.node.setWorldPosition(this.scratch);
            flight.book.node.setWorldRotation(this.qTmp);
            if (flight.t >= PLACE_FLY) {
                this.audio.play('book_shelve', 0.75, 0.08, 0.03);
                this.placeFlights.splice(i, 1);
            }
        }
    }

    private cancelPlace(book: LooseBook): void {
        const i = this.placeFlights.findIndex((flight) => flight.book === book);
        if (i >= 0) this.placeFlights.splice(i, 1);
    }

    private pick(book: LooseBook, dur = PICK_FLY, quiet = false): boolean {
        if (this.held.length >= CARRY_CAP) {
            if (!quiet) this.hint(`手里已有 ${CARRY_CAP} 本，先放一本`);
            return false;
        }
        book.node.setParent(this.carry, true);
        this.held.push(book);
        this.bookSim?.freezeHeld(book.sim);
        this.beginGlide(book, dur, true);
        for (let i = 0; i < this.held.length - 1; i++) this.beginGlide(this.held[i], STACK_FLY, false);
        if (!quiet) {
            this.audio.play('book_pick', 0.8, 0.1, 0.03);
            this.hint(`拿起了书（${bookLabel(book)}）。手里 ${this.held.length}/${CARRY_CAP}`);
        }
        return true;
    }

    /** Pop one carried book and fly it onto a slot. The slot is claimed at once. */
    private flyToSlot(book: LooseBook, slot: Slot, delay: number): void {
        const index = this.held.indexOf(book);
        if (index < 0 || slot.filled) return;
        this.held.splice(index, 1);
        this.glides.delete(book);
        const fromP = new Vec3();
        const fromR = new Quat();
        book.node.getWorldPosition(fromP);
        book.node.getWorldRotation(fromR);
        book.node.setParent(this.world, true);
        const toR = new Quat();
        Quat.copy(toR, slot.bayQuat);
        slot.filled = book;
        slot.matched = book.subject === slot.subject && book.volume === slot.volume;
        this.bookSim?.freezeShelved(book.sim);
        this.loose = this.loose.filter((x) => x !== book);
        this.placeFlights.push({ book, fromP, fromR, toP: slot.world, toR, t: -delay });
        for (const other of this.held) this.beginGlide(other, STACK_FLY, false);
    }

    private placeTop(slot: Slot): void {
        const book = this.topHeld();
        if (!book) return;
        const beforeCols = this.tidyCols();
        const beforeRows = this.tidyRows();
        this.flyToSlot(book, slot, 0);
        this.noteProgress(beforeCols, beforeRows, book);
        const matched = this.slots.filter((s) => s.matched).length;
        const wrong = this.slots.some((s) => s.filled && !s.matched);
        const fit = book.subject === slot.subject && book.volume === slot.volume;
        if (this.loose.length === 0 && !wrong && matched > 0) {
            this.hint(`全部放对了（${matched} 本）。`);
            return;
        }
        if (fit) {
            this.hint(`放对了（${bookLabel(book)}）。已对上 ${matched} 本`);
        } else if (book.subject !== slot.subject) {
            this.audio.play('wrong_place', 0.55, 0.08, 0.08);
            this.hint('放上了，这排是别的学科，不算完成');
        } else {
            this.audio.play('wrong_place', 0.55, 0.08, 0.08);
            this.hint(`放上了，这格是${volumeName(slot.volume)}，不算完成`);
        }
    }

    /** Take the book standing in this slot back into the hand. */
    private takeShelved(slot: Slot): void {
        const book = slot.filled;
        if (!book) return;
        if (this.held.length >= CARRY_CAP) {
            this.hint(`手里已有 ${CARRY_CAP} 本，先放一本`);
            return;
        }
        slot.filled = null;
        slot.matched = false;
        this.cancelPlace(book);
        if (this.loose.indexOf(book) < 0) this.loose.push(book);
        this.pick(book);
        this.hint(`从书架上拿起了书（${bookLabel(book)}）。手里 ${this.held.length}/${CARRY_CAP}`);
    }

    /** Toss the top book forward. It leaves flat and lands wherever it falls. */
    private throwTop(): void {
        const book = this.held.pop();
        if (!book) {
            this.hint('手里没有书');
            return;
        }
        this.releaseLoose(book, 3.2, 1.5);
        this.audio.play('book_throw', 0.7, 0.08, 0.05);
        this.hint(`扔了出去。手里 ${this.held.length}/${CARRY_CAP}`);
    }

    /** Let go flat. `speed` is forward, `lift` is upward. */
    private releaseLoose(book: LooseBook, speed: number, lift: number): void {
        this.glides.delete(book);
        book.node.getWorldPosition(this.scratch);
        book.node.getWorldRotation(this.qTmp);
        Vec3.transformQuat(this.scratch2, BOOK_MID, this.qTmp);
        this.scratch.add(this.scratch2);
        book.node.setParent(this.world, true);
        Quat.fromAxisAngle(TOSS_YAW, new Vec3(0, 1, 0), this.yaw * Math.PI / 180);
        Quat.fromAxisAngle(TOSS_TILT, new Vec3(0, 0, 1), Math.PI / 2);
        Quat.multiply(TOSS_ROT, TOSS_YAW, TOSS_TILT);
        Vec3.transformQuat(this.scratch2, BOOK_MID, TOSS_ROT);
        book.node.setWorldRotation(TOSS_ROT);
        book.node.setWorldPosition(
            this.scratch.x - this.scratch2.x,
            this.scratch.y - this.scratch2.y,
            this.scratch.z - this.scratch2.z,
        );
        this.cameraForward(this.forward);
        Vec3.transformQuat(this.right, LOCAL_RIGHT, this.cameraNode.worldRotation);
        const side = (Math.random() - 0.5) * 0.8;
        this.scratch2.set(
            this.forward.x * speed + this.right.x * side,
            lift,
            this.forward.z * speed + this.right.z * side,
        );
        this.restP.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 2);
        this.bookSim?.toss(book.sim, this.scratch2, this.restP);
        for (const other of this.held) this.beginGlide(other, STACK_FLY, false);
    }

    private frameMark(mark: AimMark, pos: Vec3, rot: Quat, fill: Material, edge: Material): void {
        mark.fill.setSharedMaterial(fill, 0);
        for (const renderer of mark.edges) renderer.setSharedMaterial(edge, 0);
        mark.node.setWorldRotation(rot);
        Vec3.transformQuat(this.scratch2, BOOK_MID, rot);
        mark.node.setWorldPosition(pos.x + this.scratch2.x, pos.y + this.scratch2.y, pos.z + this.scratch2.z);
        mark.node.active = true;
    }

    private updateAim(): void {
        if (!this.aimBook || !this.aimSlot) return;
        if (!this.matHoverFill || !this.matHoverEdge || !this.matGoodFill || !this.matGoodEdge) return;
        if (!this.matBadFill || !this.matBadEdge) return;
        const loose = this.held.length < CARRY_CAP ? this.nearestLoose() : null;
        const top = this.topHeld();
        const slot = this.aimedSlot();
        const looseT = loose ? this.hitBook(loose) ?? 999 : 999;
        const slotT = slot ? this.rayTravel(slot.world) ?? 999 : 999;
        const slotWins = !!slot && slotT < looseT;
        const shelved = slotWins && slot?.filled ? slot.filled : null;
        if (shelved) {
            shelved.node.getWorldPosition(this.scratch);
            this.frameMark(this.aimBook, this.scratch, shelved.node.worldRotation, this.matHoverFill, this.matHoverEdge);
        } else if (loose) {
            loose.node.getWorldPosition(this.scratch);
            this.frameMark(this.aimBook, this.scratch, loose.node.worldRotation, this.matHoverFill, this.matHoverEdge);
        } else {
            this.aimBook.node.active = false;
        }
        if (slotWins && slot && top && !slot.filled) {
            const ok = slot.subject === top.subject && slot.volume === top.volume;
            this.frameMark(
                this.aimSlot,
                slot.world,
                slot.bayQuat,
                ok ? this.matGoodFill : this.matHoverFill,
                ok ? this.matGoodEdge : this.matHoverEdge,
            );
        } else {
            this.aimSlot.node.active = false;
        }
    }

    /** The loose book the crosshair ray hits first. */
    private nearestLoose(): LooseBook | null {
        let best: LooseBook | null = null;
        let bestT = REACH;
        this.cameraNode.getWorldPosition(this.eye);
        this.cameraForward(this.forward);
        for (const b of this.loose) {
            if (this.held.indexOf(b) >= 0) continue;
            const t = this.hitBook(b);
            if (t !== null && t < bestT) {
                best = b;
                bestT = t;
            }
        }
        return best;
    }

    private hitBook(b: LooseBook): number | null {
        b.node.getWorldPosition(this.scratch);
        Vec3.subtract(this.scratch, this.eye, this.scratch);
        b.node.getWorldRotation(this.qTmp);
        Quat.invert(this.qTmp, this.qTmp);
        Vec3.transformQuat(this.scratch, this.scratch, this.qTmp);
        Vec3.transformQuat(this.scratch2, this.forward, this.qTmp);
        return raySlab(this.scratch, this.scratch2);
    }

    /** The slot closest to the crosshair, filled or not. */
    private aimedSlot(): Slot | null {
        let best: Slot | null = null;
        let bestMiss = SLOT_AIM;
        this.cameraNode.getWorldPosition(this.eye);
        this.cameraForward(this.forward);
        for (const s of this.slots) {
            Vec3.subtract(this.scratch2, s.world, this.eye);
            const t = Vec3.dot(this.scratch2, this.forward);
            if (t < 0.2 || t > REACH) continue;
            Vec3.scaleAndAdd(this.scratch, this.eye, this.forward, t);
            const miss = Vec3.distance(this.scratch, s.world);
            if (miss < bestMiss) {
                    best = s;
                bestMiss = miss;
            }
        }
        return best;
    }

    private placeHint(book: LooseBook, slot: Slot): string {
        if (slot.subject !== book.subject) return '可以放，这排是别的学科，不算完成 · E / 左键';
        if (slot.volume !== book.volume) return `可以放，这格是卷${slot.volume}，不算完成 · E / 左键`;
        return '这格正合适 · E / 左键 放上书架';
    }

    private tryInteract(): void {
        const loose = this.held.length < CARRY_CAP ? this.nearestLoose() : null;
        const top = this.topHeld();
        const slot = this.aimedSlot();
        const looseT = loose ? this.hitBook(loose) : null;
        const slotT = slot ? this.rayTravel(slot.world) : null;
        if (slot && slotT !== null && (looseT === null || slotT < looseT)) {
            if (slot.filled) {
                this.takeShelved(slot);
            return;
        }
            if (top) {
                this.placeTop(slot);
            return;
        }
        }
        if (loose) this.pick(loose);
        else if (top) this.hint('对准书架空位，E 放上 · Q 扔出');
        else if (this.held.length >= CARRY_CAP) this.hint(`手里已有 ${CARRY_CAP} 本，先放一本`);
    }

    /** Distance along the view ray when the point sits under the crosshair. */
    private rayTravel(pos: Vec3): number | null {
        this.cameraNode.getWorldPosition(this.eye);
        this.cameraForward(this.forward);
        Vec3.subtract(this.scratch2, pos, this.eye);
        const t = Vec3.dot(this.scratch2, this.forward);
        if (t < 0.2 || t > REACH) return null;
        Vec3.scaleAndAdd(this.scratch, this.eye, this.forward, t);
        return Vec3.distance(this.scratch, pos) <= SLOT_AIM ? t : null;
    }

    private refreshHint(): void {
        const top = this.topHeld();
        const loose = this.held.length < CARRY_CAP ? this.nearestLoose() : null;
        const slot = this.aimedSlot();
        const looseT = loose ? this.hitBook(loose) ?? 999 : 999;
        const slotT = slot ? this.rayTravel(slot.world) ?? 999 : 999;
        const looked = slot && slot.filled && slotT < looseT ? slot.filled : loose;
        if (looked) this.hud.setLook(bookLabel(looked), subjectName(looked.subject), subjectColor(looked.subject));
        else this.hud.setLook(null);

        let primary = '捡起';
        if (slot && slot.filled && slotT < looseT) primary = '拿起';
        else if (slot && top && !slot.filled && slotT < looseT) primary = '放入';
        else if (!loose && top) primary = '放下';
        this.hud.setActions(primary, this.held.length > 0, this.held.length > 1);

        if (this.skills.isActive('guide') && top) {
            const fit = this.fitSlot(top, null);
            this.hint(fit
                ? `指引：${subjectName(top.subject)} · ${volumeName(fit.volume)} 那一格`
                : `${subjectName(top.subject)}书架已经没有它的空位`);
            return;
        }
        if (slot && slotT < looseT) {
            if (slot.filled) {
                this.hint('对准架上的书 · E / 左键 拿起');
                return;
            }
            if (top) {
                this.hint(this.placeHint(top, slot));
                return;
            }
        }
        if (loose) {
            this.hint(this.held.length > 0
                ? `再捡一本 · 手里 ${this.held.length}/${CARRY_CAP} · Q 扔出`
                : '准星对准书 · E / 左键 捡起');
            return;
        }
        if (top) this.hint(`手里 ${this.held.length}/${CARRY_CAP} · Q 扔出 · R 换书 · 1–5 技能`);
        else if (this.held.length >= CARRY_CAP) this.hint(`手里已有 ${CARRY_CAP} 本，先放一本`);
    }

    private refreshHud(): void {
        const tally = this.tally();
        const floor = this.loose.filter((b) => this.held.indexOf(b) < 0).length;
        this.hud.setProgress({
            shelved: tally.shelved,
            total: LOOSE_BOOKS.length,
            loose: floor,
            cols: tally.cols,
            colsTotal: this.colsTotal,
            rows: tally.rows,
            rowsTotal: this.rowsTotal,
        });
        this.hud.setSkills(this.skills.view(tally.cols));
    }

    private primaryAction(): void {
        const top = this.topHeld();
        const loose = this.held.length < CARRY_CAP ? this.nearestLoose() : null;
        const slot = this.aimedSlot();
        const looseT = loose ? this.hitBook(loose) ?? 999 : 999;
        const slotT = slot ? this.rayTravel(slot.world) ?? 999 : 999;
        if ((slot && slotT < looseT && (slot.filled || top)) || loose) {
            this.tryInteract();
            return;
        }
        if (top) this.dropTop();
    }

    private tally(): { cols: number; rows: number; shelved: number } {
        const trios = new Map<string, Slot[]>();
        const rowKeys = new Map<string, { need: number; got: number }>();
        let shelved = 0;
        for (const slot of this.slots) {
            if (slot.filled) shelved += 1;
            const key = `${slot.bay}|${slot.row}|${slot.series}`;
            const list = trios.get(key);
            if (list) list.push(slot);
            else trios.set(key, [slot]);
        }
        let cols = 0;
        for (const [key, list] of trios) {
            const tidy = this.trioTidy(list);
            if (tidy) cols += 1;
            const rowKey = key.split('|').slice(0, 2).join('|');
            const row = rowKeys.get(rowKey) ?? { need: 0, got: 0 };
            row.need += 1;
            if (tidy) row.got += 1;
            rowKeys.set(rowKey, row);
        }
        let rows = 0;
        for (const row of rowKeys.values()) if (row.need > 0 && row.got === row.need) rows += 1;
        return { cols, rows, shelved };
    }

    private tidyCols(): number {
        return this.tally().cols;
    }

    private tidyRows(): number {
        return this.tally().rows;
    }

    private trioTidy(list: Slot[]): boolean {
        if (list.length < 3) return false;
        const emblem = list[0].filled?.emblem;
        if (emblem === undefined) return false;
        const vols = new Set<number>();
        for (const slot of list) {
            if (!slot.filled || !slot.matched || slot.filled.emblem !== emblem) return false;
            vols.add(slot.volume);
        }
        return vols.has(1) && vols.has(2) && vols.has(3);
    }

    private noteProgress(beforeCols: number, beforeRows: number, book?: LooseBook): void {
        const now = this.tally();
        const unlocked = newlyUnlocked(beforeCols, now.cols);
        if (unlocked.length > 0) {
            this.audio.play('unlock', 0.8);
            this.hud.toast(`解锁技能 ${unlocked.map((d) => `「${d.name}」${d.desc}`).join('；')}`, 5);
        } else if (skillLevel(now.cols) > skillLevel(beforeCols)) {
            this.audio.play('unlock', 0.45, 0.15);
            this.hud.toast(`技能升到 Lv${skillLevel(now.cols)}，冷却更短了`, 4);
        } else if (now.rows > beforeRows) {
            this.audio.play('row_done', 0.85);
            this.hud.toast('这一层书架整理完毕', 3.5);
        } else if (now.cols > beforeCols && book) {
            this.audio.play('set_done', 0.8);
            this.hud.toast(`《${bookTitle(book.subject, book.emblem)}》三卷整齐了`, 2.5);
        }
        if (now.rows >= this.rowsTotal && this.rowsTotal > 0 && beforeRows < this.rowsTotal) {
            this.audio.play('win_fanfare', 0.9);
            this.hud.toast(`${this.level.title}整理完毕`, 6);
        }
    }

    private useSkill(id: SkillId): void {
        const cols = this.tidyCols();
        const gate = this.skills.gate(id, cols);
        if (!gate.ok) {
            if (gate.message) this.hud.toast(gate.message, 2);
            return;
        }
        const result = this.cast(id);
        if (!result.ok) {
            this.hud.toast(result.message, 2);
            return;
        }
        this.skills.commit(id, cols);
        this.audio.play(`skill_${id}`, 0.8);
        if (result.message) this.hud.toast(result.message, 2.5);
    }

    private cast(id: SkillId): { ok: boolean; message: string } {
        if (id === 'insight') return this.castInsight();
        if (id === 'guide') return this.castGuide();
        if (id === 'sort') return this.castSort();
        if (id === 'summon') return this.castSummon();
        return this.castShelve();
    }

    private sameSet(a: LooseBook, b: LooseBook): boolean {
        return a.subject === b.subject && a.emblem === b.emblem;
    }

    /** True when a should sit above b. The set in hand stays together, 卷一 on top. */
    private above(a: LooseBook, b: LooseBook, top: LooseBook): boolean {
        const ta = this.sameSet(a, top);
        const tb = this.sameSet(b, top);
        if (ta !== tb) return ta;
        if (a.subject !== b.subject) return a.subject < b.subject;
        if (a.emblem !== b.emblem) return a.emblem < b.emblem;
        if (a.volume !== b.volume) return a.volume < b.volume;
        return false;
    }

    private sortHeld(top: LooseBook): void {
        this.held.sort((a, b) => (this.above(a, b, top) ? 1 : this.above(b, a, top) ? -1 : 0));
        for (const book of this.held) this.beginGlide(book, 0.22, true);
    }

    private castInsight(): { ok: boolean; message: string } {
        const held = this.topHeld();
        if (!held) return { ok: false, message: '先拿起一本书，再看它的同套书在哪' };
        const found: LooseBook[] = [];
        for (let volume = 1; volume <= 3; volume++) {
            found.push(...this.findLoose((b) => this.sameSet(b, held) && b.volume === volume, 3));
        }
        if (found.length === 0) return { ok: false, message: '地上已经没有这套书了' };
        this.glowBooks.length = 0;
        this.glowBooks.push(...found);
        return { ok: true, message: `洞察：${found.length} 本同套的书亮起来了` };
    }

    private castGuide(): { ok: boolean; message: string } {
        if (!this.topHeld()) return { ok: false, message: '先拿起一本书，再找它的书架' };
        return { ok: true, message: '指引：金框就是这本书该去的格子' };
    }

    private castSort(): { ok: boolean; message: string } {
        const top = this.topHeld();
        if (!top || this.held.length < 2) return { ok: false, message: '手里至少两本书才需要排列' };
        this.sortHeld(top);
        return { ok: true, message: '排列好了：同一套放一起，卷一在最上面' };
    }

    private castSummon(): { ok: boolean; message: string } {
        const top = this.topHeld();
        if (!top) return { ok: false, message: '先拿起一本书，再召回它的同套书' };
        const have = new Set(this.held.filter((b) => this.sameSet(b, top)).map((b) => b.volume));
        const free = CARRY_CAP - this.held.length;
        if (free <= 0) return { ok: false, message: '手里拿满了，先放一些' };
        let got = 0;
        this.cameraNode.getWorldPosition(this.eye);
        for (let volume = 1; volume <= 3 && got < free; volume++) {
            if (have.has(volume)) continue;
            const book = this.findLoose((b) => this.sameSet(b, top) && b.volume === volume, 1)[0];
            if (!book) continue;
            const p = book.node.worldPosition;
            const dist = Vec3.distance(p, this.eye);
            if (this.pick(book, 0.45 + Math.min(0.5, dist * 0.05), true)) got += 1;
        }
        if (got === 0) {
            if (have.has(1) && have.has(2) && have.has(3)) return { ok: false, message: '这套三卷已经都在手里了' };
            return { ok: false, message: '地上找不到这套书缺的卷了' };
        }
        this.sortHeld(top);
        return { ok: true, message: `召回：${got} 本飞到了手里` };
    }

    private castShelve(): { ok: boolean; message: string } {
        if (this.held.length === 0) return { ok: false, message: '手里没有书' };
        const bay = this.facingBay();
        if (bay === null) return { ok: false, message: '走到一个书架前、面向它再用' };
        const subject = this.baySubject[bay];
        const top = this.topHeld()!;
        const books = [...this.held].sort((a, b) => (this.above(a, b, top) ? -1 : 1));
        const beforeCols = this.tidyCols();
        const beforeRows = this.tidyRows();
        let matching = 0;
        let placed = 0;
        for (const book of books) {
            if (book.subject !== subject) continue;
            matching += 1;
            const slot = this.fitSlot(book, bay);
            if (!slot) continue;
            this.flyToSlot(book, slot, placed * 0.08);
            placed += 1;
        }
        if (matching === 0) return { ok: false, message: '手里没有这个书架学科的书' };
        if (placed === 0) return { ok: false, message: '这个书架没有能放下它们的空位了' };
        this.noteProgress(beforeCols, beforeRows, top);
        return { ok: true, message: `上架：放好 ${placed} 本` };
    }

    private findLoose(pred: (book: LooseBook) => boolean, n: number): LooseBook[] {
        this.cameraNode.getWorldPosition(this.eye);
        const found: { book: LooseBook; d: number }[] = [];
        for (const book of this.loose) {
            if (this.held.indexOf(book) >= 0) continue;
            if (!pred(book)) continue;
            const p = book.node.worldPosition;
            const dx = p.x - this.eye.x;
            const dy = p.y - this.eye.y;
            const dz = p.z - this.eye.z;
            found.push({ book, d: dx * dx + dy * dy + dz * dz });
        }
        found.sort((a, b) => a.d - b.d);
        return found.slice(0, n).map((item) => item.book);
    }

    /** Empty slot for this book: a row already holding its set, else the nearest empty row. */
    private fitSlot(book: LooseBook, bayLimit: number | null): Slot | null {
        this.cameraNode.getWorldPosition(this.eye);
        const groups = new Map<string, Slot[]>();
        for (const slot of this.slots) {
            if (slot.subject !== book.subject) continue;
            if (bayLimit !== null && slot.bay !== bayLimit) continue;
            const key = `${slot.bay}|${slot.row}|${slot.series}`;
            const list = groups.get(key);
            if (list) list.push(slot);
            else groups.set(key, [slot]);
        }
        let best: Slot | null = null;
        let bestScore = Infinity;
        for (const list of groups.values()) {
            const target = list.find((slot) => slot.volume === book.volume);
            if (!target || target.filled) continue;
            const sitting = list.filter((slot) => slot.filled);
            let score: number | null = null;
            if (sitting.length === 0) score = 1000;
            else if (sitting.every((slot) => slot.filled!.emblem === book.emblem && slot.matched)) score = 0;
            if (score === null) continue;
            score += Vec3.distance(target.world, this.eye);
            if (score < bestScore) {
                best = target;
                bestScore = score;
            }
        }
        return best;
    }

    private facingBay(): number | null {
        this.cameraNode.getWorldPosition(this.eye);
        this.cameraForward(this.forward);
        const fl = Math.hypot(this.forward.x, this.forward.z);
        if (fl < 0.01) return null;
        let best = -1;
        let bestScore = Infinity;
        for (let i = 0; i < this.bayPos.length; i++) {
            const p = this.bayPos[i];
            const face = this.bayFace[i];
            const tx = this.eye.x - p.x;
            const tz = this.eye.z - p.z;
            const d = Math.hypot(tx, tz);
            if (d < 0.01 || d > 3.5) continue;
            if (face.x * tx + face.z * tz <= 0) continue;
            const look = -((this.forward.x / fl) * (tx / d) + (this.forward.z / fl) * (tz / d));
            if (look > 0.55) {
                const score = d * (2 - look);
                if (score < bestScore) {
                    best = i;
                    bestScore = score;
                }
            }
        }
        return best >= 0 ? best : null;
    }

    private updateGuide(): void {
        if (!this.guideMark || !this.matGoodFill || !this.matGoodEdge) return;
        const top = this.topHeld();
        const slot = this.skills.isActive('guide') && top ? this.fitSlot(top, null) : null;
        if (!slot) {
            this.guideMark.node.active = false;
            return;
        }
        this.frameMark(this.guideMark, slot.world, slot.bayQuat, this.matGoodFill, this.matGoodEdge);
    }

    private updateGlows(dt: number): void {
        this.glowT += dt;
        const pulse = 1 + 0.08 * Math.sin(this.glowT * 6);
        for (let i = 0; i < this.glowNodes.length; i++) {
            const node = this.glowNodes[i];
            const book = this.glowBooks[i];
            if (!book || this.held.indexOf(book) >= 0 || book.sim.shelved) {
                node.active = false;
                continue;
            }
            book.node.getWorldPosition(this.scratch);
            book.node.getWorldRotation(this.qTmp);
            Vec3.transformQuat(this.scratch2, BOOK_MID, this.qTmp);
            node.setWorldPosition(this.scratch.x + this.scratch2.x, this.scratch.y + this.scratch2.y, this.scratch.z + this.scratch2.z);
            node.setWorldRotation(this.qTmp);
            node.setScale(pulse, pulse, pulse);
            node.active = true;
        }
    }

    private cycleHeld(): void {
        if (this.held.length < 2) return;
        const top = this.held.pop()!;
        this.held.unshift(top);
        for (const book of this.held) this.beginGlide(book, STACK_FLY, true);
        this.hint('换到下一本');
    }

    private dropTop(): void {
        const book = this.held.pop();
        if (!book) {
            this.hint('手里没有书');
            return;
        }
        this.releaseLoose(book, 0.35, 0.2);
        this.audio.play('book_setdown', 0.75, 0.1, 0.05);
        this.hint('放下了');
    }
}
