import {
    Color, HorizontalTextAlignment, Label, Layers, Mask, Node, Overflow,
    Sprite, UITransform, Vec3, tween, view,
} from 'cc';
import type { UiPack } from './uiArt';
import { ensureOpacity, fadeTo, stopMotion } from './uiMotion';

const CREAM = new Color(232, 218, 186, 255);

/**
 * Velvet stage curtains. Closed during level load so the player never sees a black void;
 * open once the scene is ready.
 */
export class Curtain {
    readonly root: Node;
    private readonly left: Node;
    private readonly right: Node;
    private readonly banner: Node;
    private readonly status: Label;
    private readonly halfW: number;
    private closed = true;
    private busy: Promise<void> = Promise.resolve();

    constructor(parent: Node, art: UiPack) {
        const size = view.getVisibleSize();
        this.halfW = size.width * 0.5 + 40;

        this.root = new Node('Curtain');
        this.root.layer = parent.layer;
        parent.addChild(this.root);
        this.root.addComponent(UITransform).setContentSize(size.width, size.height);
        ensureOpacity(this.root).opacity = 255;

        this.left = this.panel(this.root, art, -this.halfW * 0.5, size.width * 0.52 + 20, size.height + 40, false);
        this.right = this.panel(this.root, art, this.halfW * 0.5, size.width * 0.52 + 20, size.height + 40, true);

        this.banner = new Node('Banner');
        this.banner.layer = Layers.Enum.UI_2D;
        this.root.addChild(this.banner);
        this.banner.setPosition(0, 40, 0);
        this.banner.addComponent(UITransform).setContentSize(420, 64);
        const rim = new Node('Rim');
        rim.layer = Layers.Enum.UI_2D;
        this.banner.addChild(rim);
        rim.addComponent(UITransform).setContentSize(420, 64);
        const rimSp = rim.addComponent(Sprite);
        rimSp.sizeMode = Sprite.SizeMode.CUSTOM;
        rimSp.spriteFrame = art.titleRibbon;
        rim.getComponent(UITransform)!.setContentSize(420, 56);
        this.status = this.label(this.banner, '正在整理藏书阁…', 20, CREAM, 0, 0, 380);
        ensureOpacity(this.banner);

        // Start closed
        this.left.setPosition(-this.halfW * 0.5, 0, 0);
        this.right.setPosition(this.halfW * 0.5, 0, 0);
        this.root.active = true;
        this.closed = true;
    }

    setStatus(text: string): void {
        this.status.string = text;
    }

    /** Keep the curtain above title/HUD while loading. */
    bringToFront(): void {
        const parent = this.root.parent;
        if (!parent) return;
        this.root.setSiblingIndex(parent.children.length - 1);
    }

    /** Cover the stage immediately (or animate shut). */
    close(seconds = 0.45, status = '正在整理藏书阁…'): Promise<void> {
        this.bringToFront();
        this.busy = this.busy.then(() => this.runClose(seconds, status));
        return this.busy;
    }

    /** Part the curtains after the world is ready. */
    open(seconds = 0.7): Promise<void> {
        this.busy = this.busy.then(() => this.runOpen(seconds));
        return this.busy;
    }

    private async runClose(seconds: number, status: string): Promise<void> {
        this.setStatus(status);
        this.root.active = true;
        ensureOpacity(this.root).opacity = 255;
        this.banner.active = true;
        ensureOpacity(this.banner).opacity = 0;
        stopMotion(this.left);
        stopMotion(this.right);
        stopMotion(this.banner);
        const leftHome = -this.halfW * 0.5;
        const rightHome = this.halfW * 0.5;
        if (this.closed) {
            this.left.setPosition(leftHome, 0, 0);
            this.right.setPosition(rightHome, 0, 0);
            ensureOpacity(this.banner).opacity = 255;
            return;
        }
        await Promise.all([
            this.slide(this.left, leftHome, seconds),
            this.slide(this.right, rightHome, seconds),
            fadeTo(this.banner, 255, seconds * 0.6),
        ]);
        this.closed = true;
    }

    private async runOpen(seconds: number): Promise<void> {
        if (!this.closed) return;
        stopMotion(this.left);
        stopMotion(this.right);
        stopMotion(this.banner);
        await fadeTo(this.banner, 0, Math.min(0.25, seconds * 0.35));
        this.banner.active = false;
        const out = this.halfW + 80;
        await Promise.all([
            this.slide(this.left, -out, seconds),
            this.slide(this.right, out, seconds),
        ]);
        this.closed = false;
        this.root.active = false;
    }

    private slide(node: Node, x: number, seconds: number): Promise<void> {
        return new Promise((resolve) => {
            const y = node.position.y;
            if (seconds <= 0) {
                node.setPosition(x, y, 0);
                resolve();
                return;
            }
            tween(node)
                .to(seconds, { position: new Vec3(x, y, 0) }, { easing: 'cubicInOut' })
                .call(() => resolve())
                .start();
        });
    }

    private panel(parent: Node, art: UiPack, x: number, w: number, h: number, flip: boolean): Node {
        const node = new Node(flip ? 'CurtainR' : 'CurtainL');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        node.setPosition(x, 0, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        const mask = node.addComponent(Mask);
        mask.type = Mask.Type.GRAPHICS_RECT;

        // Cover the half-screen with the painted drape. Keep the valance at the top.
        const cloth = new Node('Cloth');
        cloth.layer = Layers.Enum.UI_2D;
        node.addChild(cloth);
        const aspect = 9 / 16;
        let sw = w;
        let sh = w / aspect;
        if (sh < h) {
            sh = h;
            sw = h * aspect;
        }
        cloth.setPosition(0, (h - sh) / 2, 0);
        const ui = cloth.addComponent(UITransform);
        const sp = cloth.addComponent(Sprite);
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.spriteFrame = art.curtainPanel;
        ui.setContentSize(sw, sh);
        if (flip) cloth.setScale(-1, 1, 1);

        ensureOpacity(node);
        return node;
    }

    private label(parent: Node, text: string, size: number, color: Color, x: number, y: number, width: number): Label {
        const node = new Node('Label');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(width, size + 10);
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
