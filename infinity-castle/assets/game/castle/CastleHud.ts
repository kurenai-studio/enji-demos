import { Color, Graphics, Label, Layers, Node, UITransform, Vec2, Widget } from 'cc';

const WIDTH = 330;
const PADDING = 10;
const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const HELP = 'W/S or ↑/↓ speed · Space pause · drag to look · R recenter';

/** Top-left panel: FPS, depth, speed and pool counters, plus the controls line. */
export class CastleHud {
    private readonly status: Label;

    constructor(canvas: Node) {
        const lines = 5;
        const height = PADDING * 2 + LINE_HEIGHT * lines;
        const panel = uiNode('Hud', canvas, WIDTH, height);
        panel.getComponent(UITransform)!.anchorPoint = new Vec2(0, 1);
        const widget = panel.addComponent(Widget);
        widget.isAlignLeft = widget.isAlignTop = true;
        widget.left = widget.top = 12;

        const background = panel.addComponent(Graphics);
        background.fillColor = new Color(20, 8, 4, 150);
        background.roundRect(0, -height, WIDTH, height, 6);
        background.fill();

        const statusNode = uiNode('Status', panel, WIDTH - PADDING * 2, LINE_HEIGHT * lines);
        statusNode.getComponent(UITransform)!.anchorPoint = new Vec2(0, 1);
        statusNode.setPosition(PADDING, -PADDING, 0);
        this.status = statusNode.addComponent(Label);
        this.status.fontSize = FONT_SIZE;
        this.status.lineHeight = LINE_HEIGHT;
        this.status.color = new Color(255, 214, 160, 255);
        this.status.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.status.verticalAlign = Label.VerticalAlign.TOP;
        this.status.overflow = Label.Overflow.CLAMP;
        this.status.string = 'loading castle blocks…';
    }

    set(lines: string[]): void {
        this.status.string = [...lines, HELP].join('\n');
    }
}

function uiNode(name: string, parent: Node, width: number, height: number): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    parent.addChild(node);
    node.addComponent(UITransform).setContentSize(width, height);
    return node;
}
