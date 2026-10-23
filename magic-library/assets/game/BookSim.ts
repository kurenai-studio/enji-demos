import {
    BoxCollider, CylinderCollider, EAxisDirection, ERigidBodyType, Node, PhysicsSystem,
    Quat, RigidBody, Vec3,
} from 'cc';

/** Collision bits. Sleeping books stay kinematic so 3000 bodies are not all solved. */
const G_STATIC = 1;
const G_BOOK = 2;
const G_PLAYER = 4;

const BOOK_H = 0.24;
const BOOK_D = 0.16;
const BOOK_T = 0.04;
const BOOK_MASS = 0.45;

const FLAT_UP = new Vec3(0, 1, 0);
const FLAT_FWD = new Vec3(0, 0, 1);
const FLAT_HALF_H = new Vec3(0, BOOK_H * 0.5, 0);
const flatTilt = new Quat();
const flatYaw = new Quat();
const flatRot = new Quat();
const flatOffset = new Vec3();

/** Lie flat: this mesh's thickness is local X, so ±90° around Z points it up. */
export function layFlat(node: Node, x: number, floorY: number, z: number, yawDeg: number) {
    Quat.fromAxisAngle(flatYaw, FLAT_UP, yawDeg * Math.PI / 180);
    Quat.fromAxisAngle(flatTilt, FLAT_FWD, Math.PI / 2);
    Quat.multiply(flatRot, flatYaw, flatTilt);
    Vec3.transformQuat(flatOffset, FLAT_HALF_H, flatRot);
    const cy = floorY + BOOK_T * 0.5 + 0.004;
    node.setRotation(flatRot);
    node.setPosition(x - flatOffset.x, cy - flatOffset.y, z - flatOffset.z);
}

/** Books underfoot get a real kick so walking through a pile feels messy. */
const WAKE_R = 0.55;
const WAKE_BUDGET = 10;
const WAKE_UP = 0.4;
const NUDGE = 1.8;
const WALK_KICK = 2.2;
const KICK_UP = 0.45;
const SPIN = 4.5;
const CHAIN_R = 0.32;
const CHAIN_BUDGET = 5;
const REST_LIN = 0.12;
const REST_ANG = 0.7;
const REST_TIME = 0.2;
const MAX_AWAKE = 1.6;
const TOSS_AWAKE = 2.4;
const PUSH_SPEED = 0.85;

export type SimBook = {
    node: Node;
    held: boolean;
    shelved: boolean;
    dynamic: boolean;
    restT: number;
    age: number;
    awakeMax: number;
    body: RigidBody;
    collider: BoxCollider;
};

function setBits(col: { setGroup: (v: number) => void; setMask: (v: number) => void }, group: number, mask: number) {
    col.setGroup(group);
    col.setMask(mask);
}

function staticBox(parent: Node, name: string, pos: Vec3, size: Vec3) {
    const n = new Node(name);
    parent.addChild(n);
    n.setPosition(pos);
    const body = n.addComponent(RigidBody);
    body.type = ERigidBodyType.STATIC;
    body.useGravity = false;
    const box = n.addComponent(BoxCollider);
    box.size = size;
    setBits(box, G_STATIC, G_BOOK);
    return n;
}

export type SimFloor = {
    y: number;
    walk_zone_xz: readonly number[];
    holes?: readonly { min_xz: readonly number[]; max_xz: readonly number[] }[];
};

export type SimRamp = {
    axis: string;
    from: number;
    to: number;
    y0: number;
    y1: number;
    min_xz: readonly number[];
    max_xz: readonly number[];
};

/** Ammo bodies for floors, stairs and loose books. Books rest kinematic until disturbed. */
export class BookSim {
    private books: SimBook[] = [];
    private readonly active: SimBook[] = [];
    private playerNode: Node | null = null;
    private stepX = 0;
    private stepZ = 0;
    private stepped = false;
    private readonly vel = new Vec3();
    private readonly ang = new Vec3();
    private readonly pos = new Vec3();
    private readonly floors: readonly SimFloor[];
    private readonly ramps: readonly SimRamp[];

    constructor(parent: Node, floors: readonly SimFloor[], ramps: readonly SimRamp[] = []) {
        this.floors = floors;
        this.ramps = ramps;
        const sys = PhysicsSystem.instance;
        sys.enable = true;
        sys.gravity = new Vec3(0, -9.81, 0);
        sys.allowSleep = true;
        this.buildSolids(parent);
        this.playerNode = this.buildPlayer(parent);
    }

    bindLoose(node: Node): SimBook {
        const body = node.addComponent(RigidBody);
        body.type = ERigidBodyType.KINEMATIC;
        body.mass = 0;
        body.useGravity = false;
        body.linearDamping = 0.35;
        body.angularDamping = 0.7;
        const collider = node.addComponent(BoxCollider);
        // Mesh: thickness X, height Y from the bottom, depth Z.
        collider.size = new Vec3(BOOK_T, BOOK_H, BOOK_D);
        collider.center = new Vec3(0, BOOK_H * 0.5, 0);
        setBits(collider, G_BOOK, G_STATIC | G_BOOK | G_PLAYER);
        const book: SimBook = {
            node, held: false, shelved: false, dynamic: false,
            restT: 0, age: 0, awakeMax: MAX_AWAKE, body, collider,
        };
        this.books.push(book);
        return book;
    }

    /** Carry / shelf: stop simulating and ignore pushes. */
    freezeHeld(book: SimBook) {
        this.sleep(book);
        book.held = true;
        book.shelved = false;
        book.collider.enabled = false;
    }

    freezeShelved(book: SimBook) {
        this.sleep(book);
        book.held = false;
        book.shelved = true;
        book.collider.enabled = false;
    }

    /** Let go as a loose book and give it a shove. Stays awake long enough to land. */
    toss(book: SimBook, lin: Vec3, ang: Vec3): void {
        book.held = false;
        book.shelved = false;
        if (!book.dynamic) this.wake(book);
        else book.age = 0;
        book.awakeMax = TOSS_AWAKE;
        book.body.linearDamping = 0.2;
        book.body.angularDamping = 0.35;
        book.body.setLinearVelocity(lin);
        book.body.setAngularVelocity(ang);
    }

    syncPlayer(x: number, feetY: number, z: number) {
        this.playerNode?.setPosition(x, feetY, z);
        if (!this.stepped) {
            this.stepX = x;
            this.stepZ = z;
            this.stepped = true;
        }
    }

    /**
     * Kick books under the feet. Returns how many newly woken (for shove SFX).
     * The player body is a trigger, so we apply the shove by hand.
     */
    wakeNearPlayer(x: number, feetY: number, z: number): number {
        let mx = x - this.stepX;
        let mz = z - this.stepZ;
        this.stepX = x;
        this.stepZ = z;
        const mlen = Math.hypot(mx, mz);
        if (mlen > 1e-4) {
            mx /= mlen;
            mz /= mlen;
        } else {
            mx = 0;
            mz = 0;
        }
        const walk = Math.min(1, mlen / 0.04);
        const r2 = WAKE_R * WAKE_R;
        let left = WAKE_BUDGET;
        let woken = 0;
        for (const book of this.books) {
            if (left <= 0) break;
            if (book.dynamic || book.held || book.shelved) continue;
            book.node.getWorldPosition(this.pos);
            if (this.pos.y < feetY - 0.02 || this.pos.y > feetY + WAKE_UP) continue;
            const dx = this.pos.x - x;
            const dz = this.pos.z - z;
            if (dx * dx + dz * dz > r2) continue;
            this.wake(book);
            woken += 1;
            const d = Math.hypot(dx, dz) || 1;
            const out = NUDGE * (0.55 + 0.45 * walk);
            const along = WALK_KICK * walk;
            this.vel.set(
                (dx / d) * out + mx * along,
                KICK_UP * (0.4 + 0.6 * walk),
                (dz / d) * out + mz * along,
            );
            book.body.setLinearVelocity(this.vel);
            this.ang.set(
                (Math.random() - 0.5) * SPIN,
                (Math.random() - 0.5) * SPIN,
                (Math.random() - 0.5) * SPIN,
            );
            book.body.setAngularVelocity(this.ang);
            left--;
        }
        return woken;
    }

    update(dt: number) {
        for (let i = this.active.length - 1; i >= 0; i--) {
            const book = this.active[i];
            if (book.held || book.shelved) {
                this.active.splice(i, 1);
                continue;
            }
            book.body.getLinearVelocity(this.vel);
            book.body.getAngularVelocity(this.ang);
            const speed = this.vel.length();
            const spin = this.ang.length();
            book.node.getWorldPosition(this.pos);
            book.age += dt;
            if (this.pos.y < -0.4) {
                this.rescue(book);
                continue;
            }
            if (speed > PUSH_SPEED) {
                this.wakeNear(this.pos.x, this.pos.y, this.pos.z, CHAIN_R, CHAIN_BUDGET);
            }
            if (speed < REST_LIN && spin < REST_ANG) {
                book.restT += dt;
                if (book.restT >= REST_TIME || book.age > book.awakeMax) this.sleep(book);
            } else {
                book.restT = 0;
                if (book.age > book.awakeMax) this.sleep(book);
            }
        }
    }

    private wakeNear(x: number, y: number, z: number, radius: number, budget: number) {
        const r2 = radius * radius;
        let left = budget;
        for (const book of this.books) {
            if (left <= 0) break;
            if (book.dynamic || book.held || book.shelved) continue;
            book.node.getWorldPosition(this.pos);
            const dx = this.pos.x - x;
            const dy = this.pos.y - y;
            const dz = this.pos.z - z;
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            this.wake(book);
            left--;
        }
    }

    private wake(book: SimBook) {
        book.dynamic = true;
        book.restT = 0;
        book.age = 0;
        book.collider.enabled = true;
        book.body.mass = BOOK_MASS;
        book.awakeMax = MAX_AWAKE;
        book.body.linearDamping = 0.65;
        book.body.angularDamping = 0.85;
        book.body.useGravity = true;
        book.body.type = ERigidBodyType.DYNAMIC;
        book.body.wakeUp();
        this.active.push(book);
    }

    private sleep(book: SimBook) {
        if (!book.dynamic && book.body.type === ERigidBodyType.KINEMATIC) return;
        book.dynamic = false;
        book.restT = 0;
        book.age = 0;
        this.vel.set(0, 0, 0);
        book.body.setLinearVelocity(this.vel);
        book.body.setAngularVelocity(this.vel);
        book.body.useGravity = false;
        book.body.type = ERigidBodyType.KINEMATIC;
        const i = this.active.indexOf(book);
        if (i >= 0) this.active.splice(i, 1);
    }

    private rescue(book: SimBook) {
        const p = book.node.position;
        const floorY = p.y > 1.6 ? 3.2 : 0;
        this.sleep(book);
        layFlat(book.node, p.x, floorY, p.z, 0);
    }

    private buildPlayer(parent: Node): Node {
        const n = new Node('PlayerBody');
        parent.addChild(n);
        const body = n.addComponent(RigidBody);
        body.type = ERigidBodyType.KINEMATIC;
        body.useGravity = false;
        const cyl = n.addComponent(CylinderCollider);
        cyl.radius = 0.34;
        cyl.height = 0.85;
        cyl.direction = EAxisDirection.Y_AXIS;
        cyl.center = new Vec3(0, 0.42, 0);
        cyl.isTrigger = true;
        setBits(cyl, G_PLAYER, G_BOOK);
        return n;
    }

    private buildSolids(parent: Node) {
        const root = new Node('Solids');
        parent.addChild(root);
        const floor0 = this.floors[0];
        if (!floor0) return;
        const wz = floor0.walk_zone_xz;
        const x0 = wz[0];
        const x1 = wz[1];
        const z0 = wz[2];
        const z1 = wz[3];
        const cx = (x0 + x1) * 0.5;
        const cz = (z0 + z1) * 0.5;
        const sx = x1 - x0 + 2;
        const sz = z1 - z0 + 2;
        const wallH = 8;

        staticBox(root, 'Floor0', new Vec3(cx, floor0.y - 0.1, cz), new Vec3(sx, 0.2, sz));
        const upper = this.floors[1];
        if (upper) {
            const hole = upper.holes?.[0];
            const uz0 = hole ? hole.max_xz[1] + 0.05 : z0;
            staticBox(
                root, 'Floor1',
                new Vec3(cx, upper.y - 0.12, (uz0 + z1) * 0.5),
                new Vec3(sx, 0.24, z1 - uz0),
            );
        }

        staticBox(root, 'WallX0', new Vec3(x0 - 0.3, wallH * 0.5, cz), new Vec3(0.4, wallH, sz));
        staticBox(root, 'WallX1', new Vec3(x1 + 0.3, wallH * 0.5, cz), new Vec3(0.4, wallH, sz));
        staticBox(root, 'WallZ0', new Vec3(cx, wallH * 0.5, z0 - 0.3), new Vec3(sx, wallH, 0.4));
        staticBox(root, 'WallZ1', new Vec3(cx, wallH * 0.5, z1 + 0.3), new Vec3(sx, wallH, 0.4));

        const ramp = this.ramps[0];
        if (ramp) this.buildSteps(root, ramp);
    }

    private buildSteps(root: Node, ramp: SimRamp) {
        const n = 12;
        const z0 = ramp.min_xz[1];
        const z1 = ramp.max_xz[1];
        const zc = (z0 + z1) * 0.5;
        const zd = z1 - z0;
        for (let i = 0; i < n; i++) {
            const t1 = (i + 1) / n;
            const t0 = i / n;
            const x0 = ramp.from + (ramp.to - ramp.from) * t0;
            const x1 = ramp.from + (ramp.to - ramp.from) * t1;
            const y = ramp.y0 + (ramp.y1 - ramp.y0) * t1;
            staticBox(
                root, `Step${i}`,
                new Vec3((x0 + x1) * 0.5, y * 0.5, zc),
                new Vec3(Math.abs(x1 - x0) + 0.02, Math.max(y, 0.08), zd),
            );
        }
    }
}
