import {
    Color, Graphics, HorizontalTextAlignment, Label, Layers, Node, Overflow,
    Sprite, SpriteFrame, UITransform, Vec2, Vec3, view,
} from 'cc';
import type { UiPack } from './uiArt';
import { ensureOpacity, fadeTo, flyIn, flyOut, pressPulse, stopMotion } from './uiMotion';

export type HudActions = {
    onPrimary: () => void;
    onDrop: () => void;
    onThrow: () => void;
    onCycle: () => void;
    onSkill: (index: number) => void;
    onMenu: () => void;
};

type SkillView = { name: string; sub: string; mode: 'locked' | 'ready' | 'active' | 'cooling' };

const CREAM = new Color(232, 218, 186, 255);
const GOLD = new Color(216, 188, 130, 255);
const DIM = new Color(168, 151, 122, 255);

/** In-play HUD with fly / fade motion and press feedback. */
export class Hud {
    private readonly root: Node;
    private readonly buttons: Node[] = [];
    private readonly hintLabel: Label;
    private readonly shelvedLabel: Label;
    private readonly colsLabel: Label;
    private readonly rowsLabel: Label;
    private readonly colsFill: Node;
    private readonly rowsFill: Node;
    private readonly lookNode: Node;
    private readonly lookTitle: Label;
    private readonly lookSub: Label;
    private readonly toastNode: Node;
    private readonly toastLabel: Label;
    private readonly skills: { name: Label; sub: Label; socket: Sprite; node: Node; subNode: Node }[] = [];
    private readonly skillKey: string[] = [];
    private readonly primaryLabel: Label;
    private readonly primaryNode: Node;
    private readonly dropNode: Node;
    private readonly throwNode: Node;
    private readonly cycleNode: Node;
    private readonly menuNode: Node;
    private readonly cardNode: Node;
    private readonly crossNode: Node;
    private readonly art: UiPack;
    private toastT = 0;
    private hintText = '';
    private lookKey = '';
    private primaryText = '';
    private shown = false;
    private lookShown = false;
    private dropShown = false;
    private throwShown = false;
    private cycleShown = false;
    private actions: HudActions = {
        onPrimary: () => {},
        onDrop: () => {},
        onThrow: () => {},
        onCycle: () => {},
        onSkill: () => {},
        onMenu: () => {},
    };

    constructor(parent: Node, art: UiPack) {
        this.art = art;
        this.root = new Node('Hud');
        this.root.layer = parent.layer;
        parent.addChild(this.root);
        const size = view.getVisibleSize();
        const left = -size.width / 2;
        const right = size.width / 2;
        const bottom = -size.height / 2;
        const top = size.height / 2;

        this.menuNode = this.rimButton(this.root, '设置', right - 80, top - 48, 96, 44, () => this.tap(this.menuNode, () => this.actions.onMenu()));
        this.buttons.push(this.menuNode);

        this.cardNode = this.sprite(this.root, art.hudFrame, left + 168, top - 112, 290, 176);
        this.sprite(this.cardNode, art.hudCorner, -131, 74, 40, 40);
        this.sprite(this.cardNode, art.hudCornerFlip, 131, -74, 40, 40);
        this.shelvedLabel = this.label(this.cardNode, '已上架', 13, CREAM, -123, 60, 246, HorizontalTextAlignment.LEFT);
        this.sprite(this.cardNode, art.hudDivider, 0, 39, 246, 10);
        this.colsLabel = this.label(this.cardNode, '整齐的套', 13, GOLD, -123, 19, 246, HorizontalTextAlignment.LEFT);
        this.colsFill = this.bar(this.cardNode, 0, 0);
        this.rowsLabel = this.label(this.cardNode, '完整的书架层', 13, GOLD, -123, -23, 246, HorizontalTextAlignment.LEFT);
        this.rowsFill = this.bar(this.cardNode, 0, -42);
        this.hintLabel = this.label(this.cardNode, '', 12, DIM, -123, -65, 246, HorizontalTextAlignment.LEFT);

        this.lookNode = this.sprite(this.root, art.hudRow, 0, -72, 300, 58);
        this.lookTitle = this.label(this.lookNode, '', 16, CREAM, -132, 10, 264, HorizontalTextAlignment.LEFT);
        this.lookSub = this.label(this.lookNode, '', 12, DIM, -132, -14, 264, HorizontalTextAlignment.LEFT);
        this.lookNode.active = false;
        ensureOpacity(this.lookNode).opacity = 0;

        this.toastNode = this.sprite(this.root, art.hudRibbon, 0, top - 72, 460, 48);
        this.toastLabel = this.label(this.toastNode, '', 16, CREAM, 0, 0, 392, HorizontalTextAlignment.CENTER);
        this.toastNode.active = false;
        ensureOpacity(this.toastNode).opacity = 0;

        this.crossNode = this.labelNode(this.root, '+', 28, new Color(246, 222, 168, 220), 0, 0, 40);

        const skillY = bottom + 108;
        for (let i = 0; i < 5; i++) {
            const x = (i - 2) * 70;
            const socket = this.circleButton(this.root, `Skill${i}`, x, skillY, 58, () => this.tap(socket, () => this.actions.onSkill(i)));
            this.disc(socket, 42);
            const name = this.label(socket, '', 15, CREAM, 0, 0, 46, HorizontalTextAlignment.CENTER);
            const subNode = this.labelNode(this.root, '', 11, DIM, x, skillY - 40, 68);
            const sub = subNode.getComponent(Label)!;
            this.skills.push({ name, sub, socket: socket.getComponent(Sprite)!, node: socket, subNode });
        }

        this.dropNode = this.circleButton(this.root, 'Drop', right - 162, bottom + 92, 60, () => this.tap(this.dropNode, () => this.actions.onDrop()));
        this.disc(this.dropNode, 44);
        this.label(this.dropNode, '放下', 14, CREAM, 0, 0, 48, HorizontalTextAlignment.CENTER);
        this.throwNode = this.circleButton(this.root, 'Throw', right - 66, bottom + 210, 60, () => this.tap(this.throwNode, () => this.actions.onThrow()));
        this.disc(this.throwNode, 44);
        this.label(this.throwNode, '扔', 16, CREAM, 0, 0, 48, HorizontalTextAlignment.CENTER);
        this.cycleNode = this.circleButton(this.root, 'Cycle', right - 144, bottom + 172, 52, () => this.tap(this.cycleNode, () => this.actions.onCycle()));
        this.disc(this.cycleNode, 38);
        this.label(this.cycleNode, '换', 14, CREAM, 0, 0, 40, HorizontalTextAlignment.CENTER);
        this.primaryNode = this.circleButton(this.root, 'Primary', right - 70, bottom + 122, 92, () => this.tap(this.primaryNode, () => this.actions.onPrimary()), true);
        this.disc(this.primaryNode, 66);
        this.primaryLabel = this.label(this.primaryNode, '捡起', 18, CREAM, 0, 0, 72, HorizontalTextAlignment.CENTER);

        this.dropNode.active = false;
        this.throwNode.active = false;
        this.cycleNode.active = false;
        this.root.active = false;
        this.parkOff();
    }

    bind(actions: HudActions): void {
        this.actions = actions;
    }

    /** Instant park (used before first show). Prefer show()/hide() for play. */
    setVisible(on: boolean): void {
        if (on) void this.show();
        else void this.hide();
    }

    async show(): Promise<void> {
        if (this.shown) {
            this.root.active = true;
            return;
        }
        this.shown = true;
        this.root.active = true;
        this.parkOff();
        const jobs = [
            flyIn(this.cardNode, new Vec3(-120, 40, 0), 0.42),
            flyIn(this.menuNode, new Vec3(80, 40, 0), 0.36),
            flyIn(this.primaryNode, new Vec3(90, -60, 0), 0.4),
            fadeTo(this.crossNode, 255, 0.35),
        ];
        for (let i = 0; i < this.skills.length; i++) {
            const row = this.skills[i];
            jobs.push(flyIn(row.node, new Vec3(0, -80, 0), 0.34 + i * 0.04));
            jobs.push(flyIn(row.subNode, new Vec3(0, -60, 0), 0.34 + i * 0.04));
        }
        await Promise.all(jobs);
    }

    async hide(): Promise<void> {
        if (!this.shown && !this.root.active) return;
        this.shown = false;
        const jobs = [
            flyOut(this.cardNode, new Vec3(-120, 40, 0), 0.28),
            flyOut(this.menuNode, new Vec3(80, 40, 0), 0.24),
            flyOut(this.primaryNode, new Vec3(90, -60, 0), 0.26),
            fadeTo(this.crossNode, 0, 0.2),
        ];
        if (this.lookShown) jobs.push(flyOut(this.lookNode, new Vec3(0, -40, 0), 0.2));
        if (this.dropShown) jobs.push(flyOut(this.dropNode, new Vec3(60, -40, 0), 0.2));
        if (this.throwShown) jobs.push(flyOut(this.throwNode, new Vec3(60, -40, 0), 0.2));
        if (this.cycleShown) jobs.push(flyOut(this.cycleNode, new Vec3(60, -40, 0), 0.2));
        for (const row of this.skills) {
            jobs.push(flyOut(row.node, new Vec3(0, -70, 0), 0.22));
            jobs.push(flyOut(row.subNode, new Vec3(0, -50, 0), 0.22));
        }
        if (this.toastNode.active) jobs.push(flyOut(this.toastNode, new Vec3(0, 50, 0), 0.2));
        await Promise.all(jobs);
        this.lookShown = this.dropShown = this.throwShown = this.cycleShown = false;
        this.root.active = false;
        this.parkHome();
    }

    hit(x: number, y: number): boolean {
        const p = new Vec2(x, y);
        for (const node of this.buttons) {
            if (!node.active) continue;
            const ui = node.getComponent(UITransform);
            if (ui?.getBoundingBoxToWorld().contains(p)) return true;
        }
        return false;
    }

    setProgress(p: { shelved: number; total: number; loose: number; cols: number; colsTotal: number; rows: number; rowsTotal: number }): void {
        this.shelvedLabel.string = `已上架 ${p.shelved} / ${p.total} · 地上 ${p.loose}`;
        this.colsLabel.string = `整齐的套 ${p.cols} / ${p.colsTotal}`;
        this.rowsLabel.string = `完整的书架层 ${p.rows} / ${p.rowsTotal}`;
        this.colsFill.setScale(Math.max(0.001, p.cols / Math.max(1, p.colsTotal)), 1, 1);
        this.rowsFill.setScale(Math.max(0.001, p.rows / Math.max(1, p.rowsTotal)), 1, 1);
    }

    setHint(text: string): void {
        if (text === this.hintText) return;
        this.hintText = text;
        this.hintLabel.string = text;
    }

    setLook(title: string | null, sub = '', color?: readonly [number, number, number]): void {
        if (!title) {
            if (this.lookShown) {
                this.lookShown = false;
                void flyOut(this.lookNode, new Vec3(0, -36, 0), 0.2);
            }
            this.lookKey = '';
            return;
        }
        const key = `${title}|${sub}`;
        if (!this.lookShown) {
            this.lookShown = true;
            this.lookNode.active = true;
            void flyIn(this.lookNode, new Vec3(0, -40, 0), 0.28);
        }
        if (key === this.lookKey) return;
        this.lookKey = key;
        this.lookTitle.string = title;
        this.lookSub.string = sub;
        if (color) {
            this.lookSub.color = new Color(
                Math.floor(color[0] * 255 * 0.55 + 100),
                Math.floor(color[1] * 255 * 0.55 + 90),
                Math.floor(color[2] * 255 * 0.55 + 70),
                255,
            );
        }
    }

    setActions(primary: string, held: boolean, canCycle: boolean): void {
        if (primary !== this.primaryText) {
            this.primaryText = primary;
            this.primaryLabel.string = primary;
        }
        this.setActionNode(this.dropNode, held, 'drop');
        this.setActionNode(this.throwNode, held, 'throw');
        this.setActionNode(this.cycleNode, canCycle, 'cycle');
    }

    setSkills(views: SkillView[]): void {
        for (let i = 0; i < views.length && i < this.skills.length; i++) {
            const view = views[i];
            const key = `${view.name}|${view.sub}|${view.mode}`;
            if (this.skillKey[i] === key) continue;
            this.skillKey[i] = key;
            const row = this.skills[i];
            row.name.string = view.name;
            row.sub.string = view.sub;
            row.socket.spriteFrame = view.mode === 'active' ? this.art.hudSocketSelected
                : view.mode === 'locked' || view.mode === 'cooling' ? this.art.hudSocketDisabled
                    : this.art.hudSocket;
            row.name.color = view.mode === 'locked' || view.mode === 'cooling' ? DIM : CREAM;
            row.sub.color = view.mode === 'active' ? GOLD : DIM;
        }
    }

    toast(text: string, seconds = 3): void {
        this.toastLabel.string = text;
        this.toastT = text ? seconds : 0;
        if (this.toastT > 0) {
            if (!this.toastNode.active) {
                this.toastNode.active = true;
                void flyIn(this.toastNode, new Vec3(0, 50, 0), 0.3);
            }
        } else if (this.toastNode.active) {
            void flyOut(this.toastNode, new Vec3(0, 50, 0), 0.22);
        }
    }

    update(dt: number): void {
        if (this.toastT <= 0) return;
        this.toastT -= dt;
        if (this.toastT <= 0 && this.toastNode.active) {
            void flyOut(this.toastNode, new Vec3(0, 50, 0), 0.22);
        }
    }

    private setActionNode(node: Node, on: boolean, kind: 'drop' | 'throw' | 'cycle'): void {
        const shown = kind === 'drop' ? this.dropShown : kind === 'throw' ? this.throwShown : this.cycleShown;
        if (on === shown) return;
        if (kind === 'drop') this.dropShown = on;
        else if (kind === 'throw') this.throwShown = on;
        else this.cycleShown = on;
        if (on) void flyIn(node, new Vec3(70, -40, 0), 0.28);
        else void flyOut(node, new Vec3(70, -40, 0), 0.2);
    }

    private tap(node: Node, fn: () => void): void {
        pressPulse(node);
        fn();
    }

    private parkOff(): void {
        ensureOpacity(this.cardNode).opacity = 0;
        ensureOpacity(this.menuNode).opacity = 0;
        ensureOpacity(this.primaryNode).opacity = 0;
        ensureOpacity(this.crossNode).opacity = 0;
        for (const row of this.skills) {
            ensureOpacity(row.node).opacity = 0;
            ensureOpacity(row.subNode).opacity = 0;
        }
    }

    private parkHome(): void {
        for (const n of [this.cardNode, this.menuNode, this.primaryNode, this.crossNode, this.dropNode, this.throwNode, this.cycleNode, this.lookNode, this.toastNode]) {
            stopMotion(n);
            ensureOpacity(n).opacity = 255;
        }
        for (const row of this.skills) {
            stopMotion(row.node);
            stopMotion(row.subNode);
            ensureOpacity(row.node).opacity = 255;
            ensureOpacity(row.subNode).opacity = 255;
            row.node.active = true;
            row.subNode.active = true;
        }
        this.dropNode.active = false;
        this.throwNode.active = false;
        this.cycleNode.active = false;
        this.lookNode.active = false;
        this.toastNode.active = false;
        this.cardNode.active = true;
        this.menuNode.active = true;
        this.primaryNode.active = true;
        this.crossNode.active = true;
    }

    private sprite(parent: Node, frame: SpriteFrame, x: number, y: number, w: number, h: number): Node {
        const node = new Node('Sprite');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.addComponent(UITransform);
        const sp = node.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.type = Sprite.Type.SIMPLE;
        sp.spriteFrame = frame;
        ui.setContentSize(w, h);
        ensureOpacity(node);
        return node;
    }

    private disc(parent: Node, size: number): void {
        const node = new Node('Disc');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(0, 0, 0);
        node.addComponent(UITransform).setContentSize(size, size);
        const g = node.addComponent(Graphics);
        g.fillColor = new Color(42, 28, 21, 255);
        g.circle(0, 0, size * 0.5);
        g.fill();
    }

    private bar(parent: Node, x: number, y: number): Node {
        const track = this.sprite(parent, this.art.hudBar, x, y, 246, 12);
        const fill = new Node('Fill');
        fill.layer = parent.layer;
        track.addChild(fill);
        const ui = fill.addComponent(UITransform);
        ui.setContentSize(240, 6);
        ui.anchorX = 0;
        fill.setPosition(-117, 0, 0);
        const fg = fill.addComponent(Graphics);
        fg.fillColor = GOLD;
        fg.roundRect(0, -3, 234, 6, 3);
        fg.fill();
        fill.setScale(0.001, 1, 1);
        return fill;
    }

    private circleButton(
        parent: Node, name: string, x: number, y: number, size: number, onTap: () => void, primary = false,
    ): Node {
        const frame = primary ? this.art.hudPrimarySocket : this.art.hudSocket;
        const node = this.sprite(parent, frame, x, y, size, size);
        node.name = name;
        node.on(Node.EventType.TOUCH_END, (event: { propagationStopped?: boolean }) => {
            event.propagationStopped = true;
            onTap();
        });
        this.buttons.push(node);
        return node;
    }

    private rimButton(parent: Node, text: string, x: number, y: number, w: number, h: number, onTap: () => void): Node {
        const node = new Node('RimBtn');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        ensureOpacity(node);
        this.sprite(node, this.art.hudBtnRim, 0, 0, w, h);
        this.sprite(node, this.art.hudBtnFace, 0, 0, w - 10, h - 10);
        this.label(node, text, 17, CREAM, 0, 0, w - 16, HorizontalTextAlignment.CENTER);
        node.on(Node.EventType.TOUCH_END, (event: { propagationStopped?: boolean }) => {
            event.propagationStopped = true;
            onTap();
        });
        return node;
    }

    private labelNode(parent: Node, text: string, size: number, color: Color, x: number, y: number, width: number): Node {
        const node = new Node('Label');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.addComponent(UITransform);
        ui.setContentSize(width, size + 8);
        ensureOpacity(node);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = size;
        label.lineHeight = size + 4;
        label.color = color;
        label.horizontalAlign = HorizontalTextAlignment.CENTER;
        label.overflow = Overflow.CLAMP;
        label.enableWrapText = false;
        return node;
    }

    private label(
        parent: Node, text: string, size: number, color: Color, x: number, y: number, width: number,
        align: HorizontalTextAlignment,
    ): Label {
        const node = new Node('Label');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.addComponent(UITransform);
        ui.setContentSize(width, size + 8);
        ui.anchorX = align === HorizontalTextAlignment.CENTER ? 0.5 : 0;
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = size;
        label.lineHeight = size + 4;
        label.color = color;
        label.horizontalAlign = align;
        label.overflow = Overflow.CLAMP;
        label.enableWrapText = false;
        return label;
    }
}
