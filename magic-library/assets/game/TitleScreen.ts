import {
    Color, Graphics, HorizontalTextAlignment, Label, Layers, Node, Overflow,
    Sprite, SpriteFrame, UITransform, Vec3, view,
} from 'cc';
import type { UiPack } from './uiArt';
import { ensureOpacity, fadeTo, flyIn, flyOut, pressPulse } from './uiMotion';

export type TitleActions = {
    onPlay: (level: 'archive' | 'gothic') => void;
    onSettings: () => void;
};

const CREAM = new Color(232, 218, 186, 255);
const GOLD = new Color(216, 188, 130, 255);
const DIM = new Color(168, 151, 122, 255);

/** Full-screen title in the walnut / brass Route C look. */
export class TitleScreen {
    readonly root: Node;
    private actions: TitleActions = { onPlay: () => {}, onSettings: () => {} };
    private readonly art: UiPack;
    private readonly plate: Node;
    private readonly btnArchive: Node;
    private readonly btnGothic: Node;
    private readonly btnSettings: Node;
    private readonly foot: Node;
    private readonly wash: Node;
    private shown = true;

    constructor(parent: Node, art: UiPack) {
        this.art = art;
        this.root = new Node('Title');
        this.root.layer = parent.layer;
        parent.addChild(this.root);
        const size = view.getVisibleSize();

        this.paintBackdrop(art.titleBackdrop, size.width, size.height);
        this.wash = this.paintWash(size.width, size.height);

        this.plate = this.sprite(this.root, art.titleCartouche, 0, 170, 540, 180);
        this.sprite(this.plate, art.titleCrest, 0, 96, 76, 76);
        this.label(this.plate, '魔法书库整理', 48, GOLD, 0, 18, 460);
        this.sprite(this.plate, art.titleDivider, 0, -37, 240, 14);
        this.sprite(this.plate, art.titleCorner, -252, 72, 52, 52);
        this.sprite(this.plate, art.titleCornerFlip, 252, -72, 52, 52);
        const ribbon = this.sprite(this.plate, art.titleRibbon, 0, -92, 360, 48);
        this.label(ribbon, '藏书阁 · 让每一套书回到原位', 16, CREAM, 0, 0, 300);

        this.btnArchive = this.levelButton(this.root, '第一关 · 档案馆', 0, -40, () => {
            pressPulse(this.btnArchive);
            this.actions.onPlay('archive');
        });
        this.btnGothic = this.levelButton(this.root, '第二关 · 哥特大厅', 0, -130, () => {
            pressPulse(this.btnGothic);
            this.actions.onPlay('gothic');
        });

        this.foot = this.labelNode(this.root, '整理整齐的套可解锁技能 · WASD 走动', 13, DIM, 0, -210, 480);
        this.btnSettings = this.levelButton(this.root, '设置', size.width / 2 - 110, size.height / 2 - 48, () => {
            pressPulse(this.btnSettings);
            this.actions.onSettings();
        }, 140, 48, 18);
        this.shown = false;
        this.root.active = false;
    }

    bind(actions: TitleActions): void {
        this.actions = actions;
    }

    setVisible(on: boolean): void {
        if (on) void this.show();
        else void this.hide();
    }

    /** Painted hall only, so the opening curtain reveals the title background. */
    presentBackdrop(): void {
        this.shown = false;
        this.root.active = true;
        this.wash.active = true;
        ensureOpacity(this.wash).opacity = 255;
        this.plate.active = false;
        this.btnArchive.active = false;
        this.btnGothic.active = false;
        this.btnSettings.active = false;
        this.foot.active = false;
    }

    async show(): Promise<void> {
        if (this.shown) {
            this.root.active = true;
            return;
        }
        this.shown = true;
        this.root.active = true;
        await this.playIntro();
    }

    async hide(): Promise<void> {
        if (!this.shown) return;
        this.shown = false;
        await Promise.all([
            flyOut(this.plate, new Vec3(0, 80, 0), 0.32),
            flyOut(this.btnArchive, new Vec3(-80, 0, 0), 0.28),
            flyOut(this.btnGothic, new Vec3(80, 0, 0), 0.28),
            flyOut(this.btnSettings, new Vec3(80, 40, 0), 0.24),
            fadeTo(this.foot, 0, 0.2),
            fadeTo(this.wash, 0, 0.3),
        ]);
        this.root.active = false;
        ensureOpacity(this.foot).opacity = 255;
        ensureOpacity(this.wash).opacity = 255;
        this.plate.active = true;
        this.btnArchive.active = true;
        this.btnGothic.active = true;
        this.btnSettings.active = true;
        this.foot.active = true;
        this.wash.active = true;
    }

    private async playIntro(): Promise<void> {
        ensureOpacity(this.wash).opacity = 0;
        ensureOpacity(this.plate).opacity = 0;
        ensureOpacity(this.btnArchive).opacity = 0;
        ensureOpacity(this.btnGothic).opacity = 0;
        ensureOpacity(this.btnSettings).opacity = 0;
        ensureOpacity(this.foot).opacity = 0;
        this.plate.active = true;
        this.btnArchive.active = true;
        this.btnGothic.active = true;
        this.btnSettings.active = true;
        this.foot.active = true;
        this.wash.active = true;
        await Promise.all([
            fadeTo(this.wash, 255, 0.45),
            flyIn(this.plate, new Vec3(0, 70, 0), 0.48),
            flyIn(this.btnArchive, new Vec3(-100, 0, 0), 0.42),
            flyIn(this.btnGothic, new Vec3(100, 0, 0), 0.46),
            flyIn(this.btnSettings, new Vec3(80, 40, 0), 0.36),
            fadeTo(this.foot, 255, 0.5),
        ]);
    }

    /** Painted hall, cropped to cover the screen. Sits under a light vignette. */
    private paintBackdrop(frame: SpriteFrame, w: number, h: number): Node {
        const node = new Node('Backdrop');
        node.layer = Layers.Enum.UI_2D;
        this.root.addChild(node);
        const aspect = 16 / 9;
        let sw = w;
        let sh = w / aspect;
        if (sh < h) {
            sh = h;
            sw = h * aspect;
        }
        const ui = node.addComponent(UITransform);
        const sp = node.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.spriteFrame = frame;
        ui.setContentSize(sw, sh);
        ensureOpacity(node);
        return node;
    }

    private paintWash(w: number, h: number): Node {
        const node = new Node('Wash');
        node.layer = Layers.Enum.UI_2D;
        this.root.addChild(node);
        node.addComponent(UITransform).setContentSize(w, h);
        ensureOpacity(node);
        const g = node.addComponent(Graphics);
        // Soft vignette only, so the painted hall stays visible behind the plaque.
        g.fillColor = new Color(18, 10, 6, 70);
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();
        g.fillColor = new Color(8, 4, 2, 110);
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
            g.ellipse(sx * w * 0.55, sy * h * 0.55, w * 0.38, h * 0.38);
            g.fill();
        }
        return node;
    }

    private levelButton(
        parent: Node, text: string, x: number, y: number, onTap: () => void,
        w = 420, h = 68, font = 24,
    ): Node {
        const node = new Node('LevelBtn');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        ensureOpacity(node);
        this.sprite(node, this.art.btnRimWide, 0, 0, w, h);
        this.sprite(node, this.art.btnFaceVelvet, 0, 0, w - 12, h - 12);
        this.label(node, text, font, CREAM, 0, 0, w - 24);
        node.on(Node.EventType.TOUCH_END, (event: { propagationStopped?: boolean }) => {
            event.propagationStopped = true;
            onTap();
        });
        return node;
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
        return node;
    }

    private labelNode(parent: Node, text: string, size: number, color: Color, x: number, y: number, width: number): Node {
        const node = new Node('Label');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(width, size + 10);
        ensureOpacity(node);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = size;
        label.lineHeight = size + 6;
        label.color = color;
        label.horizontalAlign = HorizontalTextAlignment.CENTER;
        label.overflow = Overflow.CLAMP;
        return node;
    }

    private label(parent: Node, text: string, size: number, color: Color, x: number, y: number, width: number): Label {
        const node = new Node('Label');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        const ui = node.addComponent(UITransform);
        ui.setContentSize(width, size + 10);
        const label = node.addComponent(Label);
        label.string = text;
        label.fontSize = size;
        label.lineHeight = size + 6;
        label.color = color;
        label.horizontalAlign = HorizontalTextAlignment.CENTER;
        label.overflow = Overflow.CLAMP;
        return label;
    }
}
