import {
    Color, Graphics, HorizontalTextAlignment, Input, KeyCode, Label, Layers, Node, Overflow,
    Sprite, SpriteFrame, UITransform, input, view,
} from 'cc';
import { GameAudio, TRACKS } from './GameAudio';
import { candlesEnabled, setCandlesEnabled } from './candles';
import { heightCm, lookName, nudgeHeight, nudgeLook } from './playFeel';
import type { UiPack } from './uiArt';
import { ensureOpacity, pressPulse } from './uiMotion';

const CREAM = new Color(232, 218, 186, 255);
const GOLD = new Color(216, 188, 130, 255);
const DIM = new Color(168, 151, 122, 255);

export type SettingsActions = {
    onClose: () => void;
    onLeave: () => void;
    onFeel: () => void;
    onCandles: () => void;
};

/** Audio settings. One looping track, music and effects switches. */
export class SettingsScreen {
    readonly root: Node;
    private readonly audio: GameAudio;
    private actions: SettingsActions = { onClose: () => {}, onLeave: () => {}, onFeel: () => {}, onCandles: () => {} };
    private readonly musicLabel: Label;
    private readonly sfxLabel: Label;
    private readonly trackLabel: Label;
    private readonly lookLabel: Label;
    private readonly heightLabel: Label;
    private readonly candleLabel: Label;
    private readonly leaveNode: Node;
    private openNow = false;

    constructor(parent: Node, art: UiPack, audio: GameAudio) {
        this.audio = audio;
        const size = view.getVisibleSize();
        this.root = new Node('Settings');
        this.root.layer = parent.layer;
        parent.addChild(this.root);
        this.root.addComponent(UITransform).setContentSize(size.width, size.height);

        const dim = new Node('Dim');
        dim.layer = Layers.Enum.UI_2D;
        this.root.addChild(dim);
        dim.addComponent(UITransform).setContentSize(size.width, size.height);
        const g = dim.addComponent(Graphics);
        g.fillColor = new Color(8, 4, 2, 160);
        g.rect(-size.width / 2, -size.height / 2, size.width, size.height);
        g.fill();
        const swallow = (event: { propagationStopped?: boolean }) => {
            event.propagationStopped = true;
        };
        dim.on(Node.EventType.TOUCH_START, swallow);
        dim.on(Node.EventType.TOUCH_END, swallow);

        const card = this.sprite(this.root, art.panelFrame, 0, 0, 520, 680);
        card.on(Node.EventType.TOUCH_START, swallow);
        card.on(Node.EventType.TOUCH_END, swallow);
        const fill = new Node('Fill');
        fill.layer = Layers.Enum.UI_2D;
        card.addChild(fill);
        fill.setSiblingIndex(0);
        fill.addComponent(UITransform).setContentSize(450, 610);
        const plate = fill.addComponent(Graphics);
        plate.fillColor = new Color(48, 28, 18, 255);
        plate.roundRect(-225, -305, 450, 610, 8);
        plate.fill();

        this.sprite(card, art.titleDivider, 0, 228, 220, 12);
        this.label(card, '设置', 30, GOLD, 0, 252, 180);

        this.label(card, '音乐', 20, CREAM, -150, 175, 100);
        const musicBtn = this.smallButton(card, art, 70, 175, 150, 44, () => this.toggleMusic());
        this.musicLabel = this.label(musicBtn, '开', 18, CREAM, 0, 0, 130);

        this.label(card, '音效', 20, CREAM, -150, 118, 100);
        const sfxBtn = this.smallButton(card, art, 70, 118, 150, 44, () => this.toggleSfx());
        this.sfxLabel = this.label(sfxBtn, '开', 18, CREAM, 0, 0, 130);

        this.label(card, '曲目', 20, CREAM, -150, 55, 100);
        this.trackLabel = this.label(card, '', 18, GOLD, 40, 55, 240);
        this.smallButton(card, art, -78, 8, 120, 40, () => this.stepTrack(-1), '上一首');
        this.smallButton(card, art, 78, 8, 120, 40, () => this.stepTrack(1), '下一首');

        this.label(card, '灵敏度', 20, CREAM, -150, -52, 120);
        this.smallButton(card, art, 10, -52, 52, 40, () => this.stepLook(-1), '−');
        this.lookLabel = this.label(card, '', 18, GOLD, 88, -52, 90);
        this.smallButton(card, art, 160, -52, 52, 40, () => this.stepLook(1), '+');

        this.label(card, '身高', 20, CREAM, -150, -112, 120);
        this.smallButton(card, art, 10, -112, 52, 40, () => this.stepHeight(-1), '−');
        this.heightLabel = this.label(card, '', 18, GOLD, 88, -112, 100);
        this.smallButton(card, art, 160, -112, 52, 40, () => this.stepHeight(1), '+');

        this.label(card, '烛火', 20, CREAM, -150, -172, 100);
        const candleBtn = this.smallButton(card, art, 70, -172, 150, 44, () => this.toggleCandles());
        this.candleLabel = this.label(candleBtn, '关', 18, DIM, 0, 0, 130);

        this.leaveNode = this.smallButton(card, art, 0, -232, 260, 44, () => {
            this.dismiss(false);
            this.actions.onLeave();
        }, '返回标题');
        this.smallButton(card, art, 0, -288, 180, 42, () => this.close(), '关闭');

        this.root.active = false;
    }

    bind(actions: SettingsActions): void {
        this.actions = actions;
    }

    get isOpen(): boolean {
        return this.openNow;
    }

    open(inGame: boolean): void {
        this.leaveNode.active = inGame;
        this.refresh();
        this.openNow = true;
        this.root.active = true;
        this.root.setSiblingIndex(this.root.parent ? this.root.parent.children.length - 1 : 0);
        input.on(Input.EventType.KEY_DOWN, this.onKey, this);
    }

    close(): void {
        this.dismiss(true);
    }

    /** `notify` resumes play. Leaving a level keeps the slice paused until it is disposed. */
    private dismiss(notify: boolean): void {
        if (!this.openNow) return;
        this.openNow = false;
        this.root.active = false;
        input.off(Input.EventType.KEY_DOWN, this.onKey, this);
        if (notify) this.actions.onClose();
    }

    private onKey(e: { keyCode: KeyCode }): void {
        if (e.keyCode === KeyCode.ESCAPE) this.close();
    }

    private toggleMusic(): void {
        this.audio.play('ui_click', 0.45);
        this.audio.setMusicEnabled(!this.audio.musicEnabled);
        this.refresh();
    }

    private toggleSfx(): void {
        this.audio.play('ui_click', 0.45);
        this.audio.setSfxEnabled(!this.audio.sfxEnabled);
        this.refresh();
    }

    private stepTrack(dir: number): void {
        this.audio.setTrack(this.audio.trackIndex + dir);
        this.audio.play('ui_click', 0.45);
        this.refresh();
    }

    private stepLook(dir: number): void {
        this.audio.play('ui_click', 0.45);
        nudgeLook(dir);
        this.actions.onFeel();
        this.refresh();
    }

    private stepHeight(dir: number): void {
        this.audio.play('ui_click', 0.45);
        nudgeHeight(dir);
        this.actions.onFeel();
        this.refresh();
    }

    private toggleCandles(): void {
        this.audio.play('ui_click', 0.45);
        setCandlesEnabled(!candlesEnabled());
        this.actions.onCandles();
        this.refresh();
    }

    private refresh(): void {
        this.musicLabel.string = this.audio.musicEnabled ? '开' : '关';
        this.musicLabel.color = this.audio.musicEnabled ? CREAM : DIM;
        this.sfxLabel.string = this.audio.sfxEnabled ? '开' : '关';
        this.sfxLabel.color = this.audio.sfxEnabled ? CREAM : DIM;
        const n = TRACKS.length;
        this.trackLabel.string = `${this.audio.trackIndex + 1}/${n}  ${this.audio.trackTitle}`;
        this.lookLabel.string = lookName();
        this.heightLabel.string = `${heightCm()} cm`;
        const lit = candlesEnabled();
        this.candleLabel.string = lit ? '开' : '关';
        this.candleLabel.color = lit ? CREAM : DIM;
    }

    private smallButton(parent: Node, art: UiPack, x: number, y: number, w: number, h: number, onTap: () => void, text = ''): Node {
        const node = new Node('Btn');
        node.layer = Layers.Enum.UI_2D;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        ensureOpacity(node);
        this.sprite(node, art.btnRim, 0, 0, w, h);
        this.sprite(node, art.btnFaceVelvet, 0, 0, w - 10, h - 10);
        if (text) this.label(node, text, 16, CREAM, 0, 0, w - 16);
        node.on(Node.EventType.TOUCH_END, (event: { propagationStopped?: boolean }) => {
            event.propagationStopped = true;
            pressPulse(node);
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

    private label(parent: Node, text: string, size: number, color: Color, x: number, y: number, width: number): Label {
        const node = new Node('Label');
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(width, size + 8);
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
