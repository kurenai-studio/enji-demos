import { Animation, Color, easing, instantiate, MeshRenderer, Node, Prefab, Quat, tween, Vec3 } from 'cc';
import { find } from '../core/Prefabs';

export type Side = 'player' | 'enemy';

const WHITE = new Color(255, 255, 255, 255);
const BLACK = new Color(0, 0, 0, 255);

function play(t: ReturnType<typeof tween>): Promise<void> {
    return new Promise((resolve) => t.call(() => resolve()).start());
}

function wait(s: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, s * 1000));
}

/**
 * Binds BattleStage.prefab: camera, creature anchors and the effect nodes it
 * already contains. Models are instantiated from their imported glTF prefabs
 * under `<Side>Anchor/Model`. Everything here is tweens on existing nodes.
 */
export class StageView {
    readonly camera: Node;
    private readonly camHome: Vec3;
    private readonly camLook = new Vec3(0, 0.2, 0);
    private readonly lookHome = new Vec3(0, 0.2, 0);
    private readonly anchors: Record<Side, Node>;
    private readonly models: Record<Side, Node>;
    private readonly fxPoints: Record<Side, Node>;
    private readonly shadows: Record<Side, Node>;
    private readonly fx: Record<string, Node>;
    private readonly modelScale: Record<Side, number>;
    private time = 0;
    private camBusy = false;

    constructor(readonly root: Node) {
        this.camera = find(root, 'CameraRig/MainCamera');
        this.camHome = this.camera.position.clone();
        this.anchors = { player: find(root, 'PlayerAnchor'), enemy: find(root, 'EnemyAnchor') };
        this.models = { player: find(root, 'PlayerAnchor/Model'), enemy: find(root, 'EnemyAnchor/Model') };
        this.fxPoints = { player: find(root, 'PlayerAnchor/FxPoint'), enemy: find(root, 'EnemyAnchor/FxPoint') };
        this.modelScale = { player: this.models.player.scale.x, enemy: this.models.enemy.scale.x };
        this.shadows = { player: find(root, 'PlayerAnchor/Shadow'), enemy: find(root, 'EnemyAnchor/Shadow') };
        this.fx = {};
        for (const name of ['HitBurst', 'Slash', 'Fireball', 'CallingCard', 'ShockRing', 'HealRing']) {
            this.fx[name] = find(root, `Fx/${name}`);
        }
    }

    /** Replaces the creature on one side with a fresh instance of its model prefab. */
    setCreature(side: Side, prefab: Prefab): Node {
        const holder = this.models[side];
        holder.destroyAllChildren();
        holder.setPosition(0, 0, 0);
        holder.setRotationFromEuler(0, 0, 0);
        const s = this.modelScale[side];
        holder.setScale(s, s, s);
        const model = instantiate(prefab);
        holder.addChild(model);
        model.getComponent(Animation)?.play('idle');
        this.shadows[side].active = true;
        this.shadows[side].setScale(1, 1, 1);
        return model;
    }

    async enter(side: Side): Promise<void> {
        const h = this.models[side];
        const s = this.modelScale[side];
        h.setScale(0.01, 0.01, 0.01);
        await play(tween(h).to(0.35, { scale: new Vec3(s * 1.15, s * 1.15, s * 1.15) }, { easing: easing.backOut })
            .to(0.12, { scale: new Vec3(s, s, s) }));
    }

    /** Attacker dashes toward the target and back. */
    async lunge(side: Side, big = false): Promise<void> {
        const h = this.models[side];
        const anchor = this.anchors[side];
        const other = this.anchors[side === 'player' ? 'enemy' : 'player'];
        const dir = new Vec3();
        Vec3.subtract(dir, other.worldPosition, anchor.worldPosition);
        dir.y = 0;
        dir.normalize();
        // into the anchor's local space (anchors are only rotated around Y)
        const inv = new Quat();
        Quat.invert(inv, anchor.worldRotation);
        Vec3.transformQuat(dir, dir, inv);
        const dist = big ? 2.4 : 1.4;
        const fwd = new Vec3(dir.x * dist, big ? 0.6 : 0.25, dir.z * dist);
        const back = new Vec3(-dir.x * 0.3, 0, -dir.z * 0.3);
        h.children[0]?.getComponent(Animation)?.play('run');
        await play(tween(h).to(0.12, { position: back }).to(0.14, { position: fwd }, { easing: easing.quadIn }));
        void play(tween(h).delay(0.05).to(0.25, { position: Vec3.ZERO.clone() }, { easing: easing.quadOut }))
            .then(() => h.children[0]?.getComponent(Animation)?.play('idle'));
    }

    /** Hit reaction: burst at the target, white flash, shake. */
    async hit(side: Side, strong = false): Promise<void> {
        this.burst(side, strong ? 1.6 : 1.1);
        this.flash(side);
        const h = this.models[side];
        const a = strong ? 0.28 : 0.16;
        await play(tween(h)
            .to(0.04, { position: new Vec3(a, 0, 0) }).to(0.05, { position: new Vec3(-a, 0, 0) })
            .to(0.05, { position: new Vec3(a * 0.6, 0, 0) }).to(0.05, { position: new Vec3(-a * 0.4, 0, 0) })
            .to(0.05, { position: Vec3.ZERO.clone() }));
    }

    burst(side: Side, size: number): void {
        const b = this.fx.HitBurst;
        b.setWorldPosition(this.fxPoints[side].worldPosition);
        b.setWorldRotation(this.camera.worldRotation);
        b.active = true;
        b.setScale(0.1, 0.1, 0.1);
        tween(b).to(0.1, { scale: new Vec3(size, size, size) }, { easing: easing.backOut })
            .by(0.18, { eulerAngles: new Vec3(0, 0, 25) })
            .to(0.08, { scale: new Vec3(0.01, 0.01, 0.01) })
            .call(() => { b.active = false; }).start();
    }

    private flash(side: Side): void {
        const renderers = this.models[side].getComponentsInChildren(MeshRenderer);
        const set = (c: Color) => {
            for (const r of renderers) {
                const m = r.getMaterialInstance(0);
                m?.setProperty('emissive', c);
            }
        };
        set(WHITE);
        setTimeout(() => set(BLACK), 120);
        setTimeout(() => set(WHITE), 200);
        setTimeout(() => set(BLACK), 280);
    }

    async projectile(from: Side, to: Side): Promise<void> {
        const f = this.fx.Fireball;
        const a = this.fxPoints[from].worldPosition.clone();
        const b = this.fxPoints[to].worldPosition.clone();
        f.setWorldPosition(a);
        f.setScale(0.4, 0.4, 0.4);
        f.active = true;
        const mid = new Vec3((a.x + b.x) / 2, Math.max(a.y, b.y) + 1.2, (a.z + b.z) / 2);
        await play(tween(f).to(0.18, { worldPosition: mid, scale: new Vec3(1, 1, 1) }, { easing: easing.sineOut })
            .to(0.16, { worldPosition: b }, { easing: easing.sineIn }));
        f.active = false;
    }

    async slash(to: Side): Promise<void> {
        const s = this.fx.Slash;
        s.setWorldPosition(this.fxPoints[to].worldPosition);
        s.setWorldRotation(this.camera.worldRotation);
        s.setScale(0.05, 1, 1);
        s.active = true;
        const rot = s.eulerAngles.clone();
        s.setRotationFromEuler(rot.x, rot.y, 35);
        await play(tween(s).to(0.08, { scale: new Vec3(1.1, 1, 1) }, { easing: easing.quadOut })
            .to(0.1, { scale: new Vec3(1.1, 0.1, 1) }));
        s.active = false;
    }

    /** Shock ring on the ground under a side (howl / big moves). */
    async ring(side: Side, size = 3): Promise<void> {
        const r = this.fx.ShockRing;
        const p = this.anchors[side].worldPosition;
        r.setWorldPosition(p.x, 0.15, p.z);
        r.setScale(0.3, 0.2, 0.3);
        r.active = true;
        await play(tween(r).to(0.35, { scale: new Vec3(size, 0.3, size) }, { easing: easing.quadOut }));
        r.active = false;
    }

    async heal(side: Side): Promise<void> {
        const r = this.fx.HealRing;
        const p = this.anchors[side].worldPosition;
        r.setWorldPosition(p.x, 0.1, p.z);
        r.setScale(2.2, 0.4, 2.2);
        r.active = true;
        await play(tween(r).to(0.6, { worldPosition: new Vec3(p.x, 2.6, p.z), scale: new Vec3(1.2, 0.4, 1.2) }, { easing: easing.sineOut }));
        r.active = false;
    }

    /** Big move: camera swoops toward the target and back. */
    async cameraPunch(target: Side): Promise<void> {
        this.camBusy = true;
        const t = this.anchors[target].worldPosition;
        const look = new Vec3(t.x, 0.9, t.z);
        const close = new Vec3(this.camHome.x * 0.4 + t.x * 0.6, 1.9, this.camHome.z * 0.45 + t.z * 0.55 + 1.2);
        await play(tween(this.camera).to(0.35, { position: close }, { easing: easing.quadInOut }));
        await play(tween(this.camLook).to(0.2, { x: look.x, y: look.y, z: look.z }));
        await wait(0.25);
        await play(tween(this.camera).to(0.45, { position: this.camHome.clone() }, { easing: easing.quadInOut }));
        await play(tween(this.camLook).to(0.15, { x: this.lookHome.x, y: this.lookHome.y, z: this.lookHome.z }));
        this.camBusy = false;
    }

    async faint(side: Side): Promise<void> {
        const h = this.models[side];
        h.children[0]?.getComponent(Animation)?.stop();
        await play(tween(h).to(0.12, { eulerAngles: new Vec3(0, 0, 18) })
            .to(0.35, { eulerAngles: new Vec3(0, 0, 90), position: new Vec3(0, -0.2, 0) }, { easing: easing.quadIn }));
        await play(tween(h).to(0.3, { scale: new Vec3(0.01, 0.01, 0.01) }, { easing: easing.backIn }));
        this.shadows[side].active = false;
    }

    /**
     * Calling-card catch: the card flies to the enemy, the enemy shrinks into it,
     * the card wobbles three times, then either sticks (caught) or the enemy pops back out.
     */
    async catchSequence(success: boolean): Promise<void> {
        const card = this.fx.CallingCard;
        const from = this.fxPoints.player.worldPosition.clone();
        const at = this.fxPoints.enemy.worldPosition.clone();
        const land = new Vec3(at.x, 0.75, at.z + 0.2);
        card.setWorldPosition(from);
        card.setWorldRotation(this.camera.worldRotation);
        card.setScale(0.6, 0.6, 0.6);
        card.active = true;
        const mid = new Vec3((from.x + at.x) / 2, at.y + 1.6, (from.z + at.z) / 2);
        await play(tween(card).to(0.25, { worldPosition: mid, scale: new Vec3(1, 1, 1) }, { easing: easing.sineOut })
            .to(0.2, { worldPosition: at }, { easing: easing.sineIn }));
        const h = this.models.enemy;
        const s = this.modelScale.enemy;
        this.burst('enemy', 1.2);
        await play(tween(h).to(0.25, { scale: new Vec3(0.01, 0.01, 0.01), position: new Vec3(0, 0.6, 0) }, { easing: easing.backIn }));
        this.shadows.enemy.active = false;
        await play(tween(card).to(0.25, { worldPosition: land }, { easing: easing.bounceOut }));
        const base = card.eulerAngles.clone();
        for (let i = 0; i < 3; i++) {
            await play(tween(card).to(0.1, { eulerAngles: new Vec3(base.x, base.y, base.z + 18) })
                .to(0.16, { eulerAngles: new Vec3(base.x, base.y, base.z - 18) })
                .to(0.1, { eulerAngles: base.clone() }));
            await wait(0.18);
            if (!success && i === 1) break;
        }
        if (success) {
            this.burst('enemy', 1.8);
            await play(tween(card).to(0.18, { scale: new Vec3(1.4, 1.4, 1.4) }, { easing: easing.backOut })
                .delay(0.4).to(0.2, { scale: new Vec3(0.01, 0.01, 0.01) }));
            card.active = false;
        } else {
            card.active = false;
            this.burst('enemy', 1.2);
            this.shadows.enemy.active = true;
            await play(tween(h).to(0.3, { scale: new Vec3(s, s, s), position: Vec3.ZERO.clone() }, { easing: easing.backOut }));
        }
    }

    fxWorld(side: Side): Vec3 {
        return this.fxPoints[side].worldPosition.clone();
    }

    /** Run away: the creature spins and shrinks out. */
    async leave(side: Side): Promise<void> {
        const h = this.models[side];
        await play(tween(h).to(0.3, { eulerAngles: new Vec3(0, 180, 0), position: new Vec3(0, 0.3, 0) }, { easing: easing.quadIn })
            .to(0.2, { scale: new Vec3(0.01, 0.01, 0.01) }));
        this.shadows[side].active = false;
    }

    update(dt: number): void {
        this.time += dt;
        if (!this.camBusy) {
            const sway = Math.sin(this.time * 0.6) * 0.18;
            this.camera.setPosition(this.camHome.x + sway, this.camHome.y + Math.sin(this.time * 0.9) * 0.05, this.camHome.z);
        }
        this.camera.lookAt(this.camLook);
    }
}
