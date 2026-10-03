import { Camera, EventKeyboard, EventMouse, EventTouch, geometry, Input, input, KeyCode, Touch, Vec2, view } from 'cc';
import type { OrbitCamera } from './OrbitCamera';

export interface RigidActions {
    togglePause(): void;
    reset(): void;
    cycleScene(): void;
    cycleMode(): void;
    cycleIterations(): void;
    /** A tap in the scene: the camera ray through the tapped pixel. */
    shoot(ray: geometry.Ray): void;
}

/** Taps shorter than this (time and travel) throw a ball; anything longer orbits. */
const TAP_MS = 300;
const TAP_PIXELS = 10;

/**
 * One finger: a tap throws a ball, a drag orbits. Two fingers pinch to zoom;
 * the mouse wheel zooms too.
 */
export class RigidInteraction {
    private mode: 'scene' | 'pinch' | 'ui' | null = null;
    private primaryId = -1;
    private startTime = 0;
    private travel = 0;
    private readonly touches = new Map<number, Vec2>();
    private pinchDistance = 0;
    private readonly ray = new geometry.Ray();
    private readonly camera: Camera;
    private readonly orbit: OrbitCamera;
    private readonly isOverUi: (uiX: number, uiY: number) => boolean;
    private readonly actions: RigidActions;

    constructor(camera: Camera, orbit: OrbitCamera, isOverUi: (uiX: number, uiY: number) => boolean, actions: RigidActions) {
        this.camera = camera;
        this.orbit = orbit;
        this.isOverUi = isOverUi;
        this.actions = actions;
    }

    enable(): void {
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        input.on(Input.EventType.MOUSE_WHEEL, this.onWheel, this);
        input.on(Input.EventType.KEY_DOWN, this.onKey, this);
    }

    disable(): void {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
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
            const delta = touch.getUIDelta();
            this.travel += Math.abs(delta.x) + Math.abs(delta.y);
            if (this.travel > TAP_PIXELS) {
                const height = view.getVisibleSize().height;
                this.orbit.rotate(delta.x / height, delta.y / height);
            }
        }
        if (this.mode === 'pinch' && this.touches.size >= 2) {
            const spread = this.touchSpread();
            if (spread > 1 && this.pinchDistance > 1) this.orbit.dolly(this.pinchDistance / spread);
            this.pinchDistance = spread;
        }
    }

    private onTouchEnd(event: EventTouch): void {
        for (const touch of event.getTouches()) {
            const id = touch.getID();
            this.touches.delete(id);
            if (id !== this.primaryId) continue;
            if (this.mode === 'scene' && this.travel <= TAP_PIXELS && performance.now() - this.startTime < TAP_MS) {
                const loc = touch.getLocation();
                this.actions.shoot(this.camera.screenPointToRay(loc.x, loc.y, this.ray));
            }
            this.end();
        }
        if (this.touches.size === 0) this.end();
    }

    private onTouchCancel(event: EventTouch): void {
        for (const touch of event.getTouches()) this.touches.delete(touch.getID());
        this.end();
    }

    private begin(touch: Touch): void {
        this.primaryId = touch.getID();
        const ui = touch.getUILocation();
        this.mode = this.isOverUi(ui.x, ui.y) ? 'ui' : 'scene';
        this.startTime = performance.now();
        this.travel = 0;
    }

    private end(): void {
        this.mode = null;
        this.primaryId = -1;
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
        switch (event.keyCode) {
            case KeyCode.SPACE: this.actions.togglePause(); break;
            case KeyCode.KEY_R: this.actions.reset(); break;
            case KeyCode.KEY_C: this.actions.cycleScene(); break;
            case KeyCode.KEY_M: this.actions.cycleMode(); break;
            case KeyCode.KEY_I: this.actions.cycleIterations(); break;
            default: break;
        }
    }
}
