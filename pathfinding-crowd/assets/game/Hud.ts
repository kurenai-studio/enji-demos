import { Color, Graphics, Label, Layers, Node, screen, UITransform, Vec2, view } from 'cc';

const PADDING = 10;
const GAP = 8;
const BUTTON_HEIGHT = 44;
const MAX_BUTTON_WIDTH = 130;
const FONT_SIZE = 16;
const STATUS_LINES = 5;
const STATUS_LINE_HEIGHT = 22;
const STATUS_WIDTH = 470;
const PANEL = new Color(12, 18, 30, 170);
const BUTTON = new Color(30, 44, 70, 220);
const BUTTON_ON = new Color(70, 120, 200, 235);

export interface HudButton {
    id: string;
    onTap(): void;
}

interface ButtonView {
    node: Node;
    background: Graphics;
    label: Label;
    width: number;
    on: boolean;
}

/**
 * Status panel (top left) and a wrapping row of touch buttons (bottom).
 * `contains()` tells the scene input which touches belong to the HUD.
 */
export class Hud {
    private readonly status: Label;
    private readonly statusPanel: Node;
    private readonly buttons = new Map<string, ButtonView>();
    private readonly order: string[] = [];
    private readonly root: Node;
    private readonly buttonRects: { x: number; y: number; w: number; h: number }[] = [];

    constructor(canvas: Node, buttons: HudButton[]) {
        this.root = uiNode('Hud', canvas, 0, 0);

        const statusHeight = STATUS_LINES * STATUS_LINE_HEIGHT + PADDING * 2;
        this.statusPanel = uiNode('Status', this.root, STATUS_WIDTH, statusHeight);
        this.statusPanel.getComponent(UITransform)!.anchorPoint = new Vec2(0, 1);
        const statusBg = this.statusPanel.addComponent(Graphics);
        statusBg.fillColor = PANEL;
        statusBg.roundRect(0, -statusHeight, STATUS_WIDTH, statusHeight, 8);
        statusBg.fill();
        const statusText = uiNode('Text', this.statusPanel, STATUS_WIDTH - PADDING * 2, STATUS_LINES * STATUS_LINE_HEIGHT);
        statusText.getComponent(UITransform)!.anchorPoint = new Vec2(0, 1);
        statusText.setPosition(PADDING, -PADDING, 0);
        this.status = statusText.addComponent(Label);
        this.status.fontSize = 14;
        this.status.lineHeight = STATUS_LINE_HEIGHT;
        this.status.color = new Color(255, 236, 170, 255);
        this.status.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.status.verticalAlign = Label.VerticalAlign.TOP;
        this.status.overflow = Label.Overflow.CLAMP;

        for (const button of buttons) {
            const node = uiNode(`Button-${button.id}`, this.root, MAX_BUTTON_WIDTH, BUTTON_HEIGHT);
            const background = node.addComponent(Graphics);
            const labelNode = uiNode('Label', node, MAX_BUTTON_WIDTH, BUTTON_HEIGHT);
            const label = labelNode.addComponent(Label);
            label.fontSize = FONT_SIZE;
            label.lineHeight = BUTTON_HEIGHT;
            label.color = Color.WHITE;
            label.overflow = Label.Overflow.SHRINK;
            node.on(Node.EventType.TOUCH_START, () => undefined);
            node.on(Node.EventType.TOUCH_END, () => button.onTap());
            this.buttons.set(button.id, { node, background, label, width: MAX_BUTTON_WIDTH, on: false });
            this.order.push(button.id);
        }
        this.layout();
        view.on('canvas-resize', this.layout, this);
    }

    destroy(): void {
        view.off('canvas-resize', this.layout, this);
    }

    setButton(id: string, text: string, on = false): void {
        const b = this.buttons.get(id);
        if (!b) return;
        b.label.string = text;
        b.on = on;
        b.background.clear();
        b.background.fillColor = on ? BUTTON_ON : BUTTON;
        b.background.roundRect(-b.width / 2, -BUTTON_HEIGHT / 2, b.width, BUTTON_HEIGHT, 10);
        b.background.fill();
    }

    /** Up to five lines of status text. */
    setStatus(lines: readonly string[]): void {
        this.status.string = lines.slice(0, STATUS_LINES).join('\n');
    }

    /** True when a UI-space point (origin bottom left) is over a button. */
    contains(x: number, y: number): boolean {
        for (const r of this.buttonRects) {
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
        }
        return false;
    }

    /** Lays the HUD out in CSS pixels, so buttons keep a finger-sized height whatever the design resolution. */
    private layout(): void {
        const visible = view.getVisibleSize();
        const cssWidth = screen.windowSize.width / (screen.devicePixelRatio || 1);
        const k = visible.width / Math.max(1, cssWidth);
        this.root.setScale(k, k, 1);
        const size = { width: visible.width / k, height: visible.height / k };
        const count = this.order.length;
        const columns = Math.max(1, Math.min(count, Math.floor((size.width - GAP) / (90 + GAP))));
        const rows = Math.ceil(count / columns);
        const width = Math.min(MAX_BUTTON_WIDTH, (size.width - GAP * (columns + 1)) / columns);

        // Canvas origin is the screen centre; UI locations start at the bottom left.
        this.statusPanel.setPosition(-size.width / 2 + GAP, size.height / 2 - GAP, 0);
        // Narrow phones: shrink the panel rather than wrap its lines.
        const fit = Math.min(1, (size.width - 2 * GAP) / STATUS_WIDTH);
        this.statusPanel.setScale(fit, fit, 1);
        this.buttonRects.length = 0;
        this.order.forEach((id, i) => {
            const button = this.buttons.get(id)!;
            const row = Math.floor(i / columns);
            const inRow = Math.min(columns, count - row * columns);
            const col = i - row * columns;
            const rowWidth = inRow * width + (inRow - 1) * GAP;
            const left = (size.width - rowWidth) / 2 + col * (width + GAP);
            const bottom = GAP + (rows - 1 - row) * (BUTTON_HEIGHT + GAP);
            button.width = width;
            button.node.getComponent(UITransform)!.setContentSize(width, BUTTON_HEIGHT);
            button.label.node.getComponent(UITransform)!.setContentSize(width - 8, BUTTON_HEIGHT);
            button.node.setPosition(left + width / 2 - size.width / 2, bottom + BUTTON_HEIGHT / 2 - size.height / 2, 0);
            this.buttonRects.push({ x: left * k, y: bottom * k, w: width * k, h: BUTTON_HEIGHT * k });
            this.setButton(id, button.label.string, button.on);
        });
    }
}

function uiNode(name: string, parent: Node, width: number, height: number): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    parent.addChild(node);
    node.addComponent(UITransform).setContentSize(width, height);
    return node;
}
