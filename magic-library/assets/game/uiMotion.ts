import { Node, Tween, UIOpacity, Vec3, tween } from 'cc';

/** Ensure a node can fade via UIOpacity. */
export function ensureOpacity(node: Node): UIOpacity {
    return node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
}

export function stopMotion(node: Node): void {
    Tween.stopAllByTarget(node);
    const op = node.getComponent(UIOpacity);
    if (op) Tween.stopAllByTarget(op);
}

export function easeOut(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

export function easeInOut(t: number): number {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Fade opacity 0–255. */
export function fadeTo(node: Node, opacity: number, seconds: number): Promise<void> {
    const op = ensureOpacity(node);
    stopMotion(node);
    if (seconds <= 0) {
        op.opacity = opacity;
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        tween(op)
            .to(seconds, { opacity }, { easing: 'sineOut' })
            .call(() => resolve())
            .start();
    });
}

/** Slide from an offset into the current local position, with fade-in. */
export function flyIn(node: Node, from: Vec3, seconds = 0.38): Promise<void> {
    const home = node.position.clone();
    const op = ensureOpacity(node);
    stopMotion(node);
    node.active = true;
    node.setPosition(home.x + from.x, home.y + from.y, home.z + from.z);
    op.opacity = 0;
    return new Promise((resolve) => {
        tween(op).to(seconds, { opacity: 255 }, { easing: 'sineOut' }).start();
        tween(node)
            .to(seconds, { position: home }, { easing: 'cubicOut' })
            .call(() => resolve())
            .start();
    });
}

/** Slide toward an offset and fade out, then deactivate. Restores home pos. */
export function flyOut(node: Node, to: Vec3, seconds = 0.28): Promise<void> {
    if (!node.active) return Promise.resolve();
    const home = node.position.clone();
    const op = ensureOpacity(node);
    stopMotion(node);
    const end = new Vec3(home.x + to.x, home.y + to.y, home.z + to.z);
    return new Promise((resolve) => {
        tween(op).to(seconds, { opacity: 0 }, { easing: 'sineIn' }).start();
        tween(node)
            .to(seconds, { position: end }, { easing: 'cubicIn' })
            .call(() => {
                node.active = false;
                node.setPosition(home);
                op.opacity = 255;
                resolve();
            })
            .start();
    });
}

/** Quick press squash for buttons. */
export function pressPulse(node: Node): void {
    const s = node.scale.clone();
    Tween.stopAllByTarget(node);
    node.setScale(s);
    tween(node)
        .to(0.06, { scale: new Vec3(s.x * 0.9, s.y * 0.9, s.z) }, { easing: 'sineOut' })
        .to(0.14, { scale: s }, { easing: 'sineOut' })
        .start();
}
