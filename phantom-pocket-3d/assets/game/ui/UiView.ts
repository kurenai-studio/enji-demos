import { Button, easing, instantiate, Label, Node, resources, Sprite, SpriteFrame, tween, UIOpacity, UITransform, Vec3 } from 'cc';
import { find, loadPrefabAsset } from '../core/Prefabs';
import { UI_GEN, UiGenEntry } from './UiGen';

const frameCache = new Map<string, Promise<SpriteFrame>>();

function loadFrame(dir: string): Promise<SpriteFrame> {
    let p = frameCache.get(dir);
    if (!p) {
        p = new Promise<SpriteFrame>((resolve, reject) => {
            resources.load(`${dir}/spriteFrame`, SpriteFrame, (err, sf) => (err ? reject(err) : resolve(sf)));
        });
        frameCache.set(dir, p);
    }
    return p;
}

/**
 * A UI prefab written by tools/gen_ui.py, addressed by layout part id.
 * Sets text, bar widths, button handlers and sprite states.
 */
export class UiView {
    private readonly gen: UiGenEntry;
    private readonly barTweens = new Map<string, ReturnType<typeof tween>>();

    static async create(name: string, parent: Node): Promise<UiView> {
        const gen = UI_GEN[name];
        const node = instantiate(await loadPrefabAsset(gen.prefab));
        parent.addChild(node);
        return new UiView(node, gen);
    }

    constructor(readonly root: Node, gen: UiGenEntry) {
        this.gen = gen;
    }

    path(id: string): string {
        const p = this.gen.paths[id];
        if (p === undefined) throw new Error(`${this.root.name}: no part "${id}"`);
        return p;
    }

    node(id: string): Node {
        return find(this.root, this.path(id));
    }

    /** Label of a text part (on the node itself or its trailing `Text` child). */
    label(id: string): Label {
        const own = this.node(id).getComponent(Label);
        if (own) return own;
        return find(this.root, this.path(id + '.text')).getComponent(Label)!;
    }

    setText(id: string, s: string): void {
        const l = this.label(id);
        if (l.string !== s) l.string = s;
    }

    /** Bar fill width = ratio of the full width; animated fills grow / shrink from the left edge. */
    setBar(id: string, ratio: number, animate = true): void {
        const path = this.path(id);
        const full = this.gen.bars[path];
        const ui = find(this.root, path).getComponent(UITransform)!;
        const w = Math.max(0, Math.min(1, ratio)) * full;
        this.barTweens.get(path)?.stop();
        if (!animate) {
            ui.width = w;
            return;
        }
        const t = tween(ui).to(0.45, { width: w }, { easing: easing.quadOut });
        this.barTweens.set(path, t);
        t.start();
    }

    barWidth(id: string): number {
        return find(this.root, this.path(id)).getComponent(UITransform)!.width;
    }

    onClick(id: string, fn: () => void): void {
        this.node(id).on(Button.EventType.CLICK, fn);
    }

    /** Swap a textured part to one of its baked states (normal / pressed / disabled). */
    async setState(id: string, state: string): Promise<void> {
        const path = this.path(id);
        const dir = this.gen.states[path]?.[state];
        if (!dir) return;
        const sf = await loadFrame(dir);
        const sp = find(this.root, path).getComponent(Sprite)!;
        if (sp.spriteFrame !== sf) sp.spriteFrame = sf;
    }

    /** Button on/off plus the disabled art on its rim and face parts. */
    setEnabled(id: string, on: boolean, art: string[] = [`${id}_rim`, `${id}_face`]): void {
        const b = this.node(id).getComponent(Button)!;
        b.interactable = on;
        for (const a of art) {
            if (this.gen.paths[a] !== undefined) void this.setState(a, on ? 'normal' : 'disabled');
        }
    }

    /** Dialog in: root fades, the panel pops from 0.86. */
    async show(panelId: string): Promise<void> {
        this.root.active = true;
        const op = this.root.getComponent(UIOpacity);
        const panel = this.node(panelId);
        panel.setScale(0.86, 0.86, 1);
        if (op) op.opacity = 0;
        await new Promise<void>((resolve) => {
            if (op) tween(op).to(0.16, { opacity: 255 }).start();
            tween(panel).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: easing.backOut }).call(() => resolve()).start();
        });
    }

    async hide(): Promise<void> {
        const op = this.root.getComponent(UIOpacity);
        if (op) await new Promise<void>((resolve) => tween(op).to(0.12, { opacity: 0 }).call(() => resolve()).start());
        this.root.active = false;
    }
}
