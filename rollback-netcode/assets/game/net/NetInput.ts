import { EventKeyboard, EventTouch, Input, input, KeyCode, Vec2 } from 'cc';
import { DASH, DOWN, LEFT, RIGHT, UP } from './Game';

export interface NetActions {
    cycleMode(): void;
    cycleLatency(): void;
    cycleDelay(): void;
    cycleLoss(): void;
    toggleHuman(): void;
    toggleDesync(): void;
    togglePause(): void;
    reset(): void;
}

/** Drag farther than this (UI units) to steer; a shorter, quick touch dashes. */
const DEAD_ZONE = 14;
const TAP_MS = 220;

/**
 * The human's controller for the red player: WASD or the arrows and Space,
 * or on a phone a drag (direction from where the finger went down, 8-way)
 * and a tap to dash. Other keys mirror the buttons.
 */
export class NetInput {
    private readonly keys = new Set<number>();
    private touchId = -1;
    private readonly start = new Vec2();
    private readonly at = new Vec2();
    private touchTime = 0;
    private dashQueued = false;
    private readonly isOverUi: (x: number, y: number) => boolean;
    private readonly actions: NetActions;

    constructor(isOverUi: (x: number, y: number) => boolean, actions: NetActions) {
        this.isOverUi = isOverUi;
        this.actions = actions;
    }

    enable(): void {
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    disable(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
    }

    /** This tick's input bits; a queued tap dash is used once. */
    sample(): number {
        const k = this.keys;
        let bits = 0;
        if (k.has(KeyCode.KEY_W) || k.has(KeyCode.ARROW_UP)) bits |= UP;
        if (k.has(KeyCode.KEY_S) || k.has(KeyCode.ARROW_DOWN)) bits |= DOWN;
        if (k.has(KeyCode.KEY_A) || k.has(KeyCode.ARROW_LEFT)) bits |= LEFT;
        if (k.has(KeyCode.KEY_D) || k.has(KeyCode.ARROW_RIGHT)) bits |= RIGHT;
        if (k.has(KeyCode.SPACE)) bits |= DASH;
        if (this.touchId >= 0) {
            const dx = this.at.x - this.start.x, dy = this.at.y - this.start.y;
            if (Math.hypot(dx, dy) > DEAD_ZONE) {
                const a = Math.atan2(dy, dx);
                const sector = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
                bits |= [RIGHT, RIGHT | UP, UP, UP | LEFT, LEFT, LEFT | DOWN, DOWN, DOWN | RIGHT][sector];
            }
        }
        if (this.dashQueued) {
            bits |= DASH;
            this.dashQueued = false;
        }
        return bits;
    }

    private onKeyDown(e: EventKeyboard): void {
        this.keys.add(e.keyCode);
        switch (e.keyCode) {
            case KeyCode.KEY_M: this.actions.cycleMode(); break;
            case KeyCode.KEY_L: this.actions.cycleLatency(); break;
            case KeyCode.KEY_I: this.actions.cycleDelay(); break;
            case KeyCode.KEY_K: this.actions.cycleLoss(); break;
            case KeyCode.KEY_H: this.actions.toggleHuman(); break;
            case KeyCode.KEY_X: this.actions.toggleDesync(); break;
            case KeyCode.KEY_P: this.actions.togglePause(); break;
            case KeyCode.KEY_R: this.actions.reset(); break;
            default: break;
        }
    }

    private onKeyUp(e: EventKeyboard): void {
        this.keys.delete(e.keyCode);
    }

    private onTouchStart(e: EventTouch): void {
        if (this.touchId >= 0) {
            // A second finger dashes.
            this.dashQueued = true;
            return;
        }
        const t = e.touch!;
        const ui = t.getUILocation();
        if (this.isOverUi(ui.x, ui.y)) return;
        this.touchId = t.getID();
        t.getUILocation(this.start);
        this.at.set(this.start);
        this.touchTime = performance.now();
    }

    private onTouchMove(e: EventTouch): void {
        const t = e.touch!;
        if (t.getID() === this.touchId) t.getUILocation(this.at);
    }

    private onTouchEnd(e: EventTouch): void {
        const t = e.touch!;
        if (t.getID() !== this.touchId) return;
        t.getUILocation(this.at);
        if (performance.now() - this.touchTime < TAP_MS && Math.hypot(this.at.x - this.start.x, this.at.y - this.start.y) <= DEAD_ZONE) this.dashQueued = true;
        this.touchId = -1;
    }
}
