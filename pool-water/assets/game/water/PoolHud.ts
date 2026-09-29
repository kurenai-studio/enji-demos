import { Color, Graphics, Label, Layers, Node, RichText, UITransform, Vec2, Widget } from 'cc';

const WIDTH = 340;
const PADDING = 12;
const FONT_SIZE = 15;
const LINE_HEIGHT = 24;
const KEY = '#9fd8ff';

const HELP = [
    `<color=${KEY}>Drag the water</color>: make ripples`,
    `<color=${KEY}>Drag the ball</color>: push it through the water`,
    `<color=${KEY}>Drag elsewhere</color>: orbit, wheel to zoom`,
    `<color=${KEY}>G</color> gravity · <color=${KEY}>R</color> rain · <color=${KEY}>Space</color> pause`,
    `<color=${KEY}>D</color> drops · <color=${KEY}>B</color> drop ball · <color=${KEY}>F</color> flatten`,
];

export interface HudStatus {
    fps: number;
    simMs: number;
    gravity: boolean;
    rain: boolean;
    paused: boolean;
}

/** Bottom-left panel: live status (FPS, CPU simulation time, toggles) and controls help. */
export class PoolHud {
    private readonly status: Label;

    constructor(canvas: Node) {
        const height = PADDING * 2 + LINE_HEIGHT * (HELP.length + 2);
        const panel = uiNode('Hud', canvas, WIDTH, height);
        panel.getComponent(UITransform)!.anchorPoint = new Vec2(0, 0);
        const widget = panel.addComponent(Widget);
        widget.isAlignLeft = widget.isAlignBottom = true;
        widget.left = widget.bottom = 16;

        const background = panel.addComponent(Graphics);
        background.fillColor = new Color(10, 20, 35, 150);
        background.roundRect(0, 0, WIDTH, height, 8);
        background.fill();

        const statusNode = uiNode('Status', panel, WIDTH - PADDING * 2, LINE_HEIGHT * 2);
        statusNode.getComponent(UITransform)!.anchorPoint = new Vec2(0, 1);
        statusNode.setPosition(PADDING, height - PADDING, 0);
        this.status = statusNode.addComponent(Label);
        this.status.fontSize = FONT_SIZE;
        this.status.lineHeight = LINE_HEIGHT;
        this.status.color = new Color(255, 236, 170, 255);
        this.status.horizontalAlign = Label.HorizontalAlign.LEFT;
        this.status.overflow = Label.Overflow.CLAMP;

        const helpNode = uiNode('Help', panel, WIDTH - PADDING * 2, LINE_HEIGHT * HELP.length);
        helpNode.setPosition(PADDING, height - PADDING - LINE_HEIGHT * 2, 0);
        const help = helpNode.addComponent(RichText);
        help.fontSize = FONT_SIZE;
        help.lineHeight = LINE_HEIGHT;
        help.fontColor = new Color(238, 246, 255, 255);
        help.horizontalAlign = RichText.HorizontalAlign.LEFT;
        help.string = HELP.join('<br/>');
        helpNode.getComponent(UITransform)!.anchorPoint = new Vec2(0, 1);
    }

    setStatus(s: HudStatus): void {
        const flags = [`gravity ${s.gravity ? 'on' : 'off'}`, `rain ${s.rain ? 'on' : 'off'}`];
        if (s.paused) flags.push('PAUSED');
        this.status.string = `FPS ${s.fps.toFixed(0)} · CPU sim ${s.simMs.toFixed(2)} ms\n${flags.join(' · ')}`;
    }
}

function uiNode(name: string, parent: Node, width: number, height: number): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    parent.addChild(node);
    node.addComponent(UITransform).setContentSize(width, height);
    return node;
}
