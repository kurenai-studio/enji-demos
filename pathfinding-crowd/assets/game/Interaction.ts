import { EventKeyboard, EventMouse, EventTouch, Input, input, KeyCode, Touch, Vec2, view } from 'cc';
import type { OrbitCamera } from './OrbitCamera';

/** Screen-space travel (pixels) below which a one-finger touch counts as a tap rather than a drag. */
const TAP_SLOP = 8;

/**
 * One finger drags to orbit, two pinch to zoom; the mouse wheel zooms. A
 * one-finger tap that barely moves calls `onTap` with its screen location.
 * Keys mirror the buttons.
 */
export class Interaction {
    private mode: 'scene' | 'pinch' | 'ui' | null = null;
    private primaryId = -1;
    private readonly touches = new Map<number, Vec2>();
    private pinchDistance = 0;
    private travel = 0;
    private readonly orbit: OrbitCamera;
    private readonly isOverUi: (uiX: number, uiY: number) => boolean;
    private readonly keys: Map<KeyCode, () => void>;
    private readonly onTap: ((screen: Vec2) => void) | undefined;

    constructor(orbit: OrbitCamera, isOverUi: (uiX: number, uiY: number) => boolean, keys: [KeyCode, () => void][], onTap?: (screen: Vec2) => void) {
        this.orbit = orbit;
        this.isOverUi = isOverUi;
        this.keys = new Map(keys);
        this.onTap = onTap;
    }

    enable(): void {
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        input.on(Input.EventType.MOUSE_WHEEL, this.onWheel, this);
        input.on(Input.EventType.KEY_DOWN, this.onKey, this);
    }

    disable(): void {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        input.off(Input.EventType.MOUSE_WHEEL, this.onWheel, this);
        input.off(Input.EventType.KEY_DOWN, this.onKey, this);
    }

    private onTouchStart(event: EventTouch): void {
        for (const touch of event.getTouches()) {
            this.touches.set(touch.getID(), touch.getLocation(new Vec2()));
            if (this.touches.size === 1) this.begin(touch);
            else if (this.touches.size === 2 && this.mode !== 'ui') {
                this.mode = 'pinch';
                this.pinchDistance = this.touchSpread();
            }
        }
    }

    private onTouchMove(event: EventTouch): void {
        for (const touch of event.getTouches()) {
            const id = touch.getID();
            const stored = this.touches.get(id);
            if (!stored) continue;
            touch.getLocation(stored);
            if (this.mode !== 'scene' || id !== this.primaryId) continue;
            this.travel += touch.getDelta().length();
            const delta = touch.getUIDelta();
            const height = view.getVisibleSize().height;
            this.orbit.rotate(delta.x / height, delta.y / height);
        }
        if (this.mode === 'pinch' && this.touches.size >= 2) {
            const spread = this.touchSpread();
            if (spread > 1 && this.pinchDistance > 1) this.orbit.dolly(this.pinchDistance / spread);
            this.pinchDistance = spread;
        }
    }

    private onTouchEnd(event: EventTouch): void {
        for (const touch of event.getTouches()) {
            if (this.mode === 'scene' && touch.getID() === this.primaryId && this.travel < TAP_SLOP && event.type === Input.EventType.TOUCH_END) {
                this.onTap?.(touch.getLocation());
            }
            this.touches.delete(touch.getID());
        }
        if (this.touches.size === 0) {
            this.mode = null;
            this.primaryId = -1;
        }
    }

    private begin(touch: Touch): void {
        this.primaryId = touch.getID();
        this.travel = 0;
        const ui = touch.getUILocation();
        this.mode = this.isOverUi(ui.x, ui.y) ? 'ui' : 'scene';
    }

    private touchSpread(): number {
        const it = this.touches.values();
        const a = it.next().value as Vec2 | undefined;
        const b = it.next().value as Vec2 | undefined;
        return a && b ? Vec2.distance(a, b) : 0;
    }

    private onWheel(event: EventMouse): void {
        // Cocos web input reports scrollY = -5 * DOM deltaY.
        this.orbit.dolly(Math.exp(-event.getScrollY() * 0.0005));
    }

    private onKey(event: EventKeyboard): void {
        this.keys.get(event.keyCode)?.();
    }
}
