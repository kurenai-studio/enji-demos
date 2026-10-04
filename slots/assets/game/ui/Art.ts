import { Color, Label, Node, resources, Sprite, SpriteFrame, UIOpacity, UITransform, Vec3, tween } from 'cc';

export const GOLD = new Color(255, 214, 102, 255);
export const PALE = new Color(232, 240, 255, 255);
export const DARK_OUTLINE = new Color(24, 10, 0, 255);

export type ArtName = 'bg' | 'logo' | 'frame' | 'btn_spin' | 'btn_minus' | 'btn_plus' | 'btn_auto' | 'bar' | 'panel';
const NAMES: ArtName[] = ['bg', 'logo', 'frame', 'btn_spin', 'btn_minus', 'btn_plus', 'btn_auto', 'bar', 'panel'];

export async function loadArt(): Promise<Record<ArtName, SpriteFrame>> {
    const frames = await Promise.all(
        NAMES.map(
            (n) =>
                new Promise<SpriteFrame>((res, rej) =>
                    resources.load(`ui/${n}/spriteFrame`, SpriteFrame, (e, a) => (e ? rej(e) : res(a))),
                ),
        ),
    );
    return Object.fromEntries(NAMES.map((n, i) => [n, frames[i]])) as Record<ArtName, SpriteFrame>;
}

/** Sprite node sized to `w` x `h` design pixels (h defaults to the frame aspect). */
export function sprite(parent: Node, frame: SpriteFrame, x: number, y: number, w: number, h?: number, name = 'sprite'): Node {
    const n = new Node(name);
    parent.addChild(n);
    n.setPosition(x, y, 0);
    const s = n.addComponent(Sprite);
    s.sizeMode = Sprite.SizeMode.CUSTOM;
    s.spriteFrame = frame;
    const { width, height } = frame.originalSize;
    n.getComponent(UITransform)!.setContentSize(w, h ?? (w * height) / width);
    n.addComponent(UIOpacity);
    return n;
}

export function text(
    parent: Node,
    str: string,
    x: number,
    y: number,
    size: number,
    color: Color = PALE,
    name = 'text',
): Label {
    const n = new Node(name);
    parent.addChild(n);
    n.setPosition(x, y, 0);
    n.addComponent(UIOpacity);
    const l = n.addComponent(Label);
    l.string = str;
    l.fontSize = size;
    l.lineHeight = Math.round(size * 1.15);
    l.color = color;
    l.isBold = true;
    l.enableOutline = true;
    l.outlineColor = DARK_OUTLINE;
    l.outlineWidth = Math.max(2, Math.round(size / 10));
    l.horizontalAlign = Label.HorizontalAlign.CENTER;
    return l;
}

/** Sprite button with a press squash; ignores taps while `enabled()` is false. */
export function button(
    parent: Node,
    frame: SpriteFrame,
    x: number,
    y: number,
    w: number,
    onClick: () => void,
    name = 'button',
): Node {
    const n = sprite(parent, frame, x, y, w, undefined, name);
    n.on(Node.EventType.TOUCH_START, () => {
        tween(n).to(0.06, { scale: new Vec3(0.92, 0.92, 1) }).start();
    });
    const release = () => tween(n).to(0.1, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    n.on(Node.EventType.TOUCH_CANCEL, release);
    n.on(Node.EventType.TOUCH_END, () => {
        release();
        onClick();
    });
    return n;
}

export function pop(node: Node, scale = 1.25): void {
    tween(node)
        .to(0.08, { scale: new Vec3(scale, scale, 1) })
        .to(0.14, { scale: new Vec3(1, 1, 1) }, { easing: 'quadIn' })
        .start();
}
