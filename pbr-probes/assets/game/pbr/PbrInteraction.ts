import { Camera, EventKeyboard, EventMouse, EventTouch, geometry, Input, input, KeyCode, Touch, Vec2, Vec3, view } from 'cc';
import type { OrbitCamera } from './OrbitCamera';
import type { PbrScene } from './PbrScene';

export interface PbrActions {
    toggleDirect(): void;
    toggleIndirect(): void;
    toggleSpecular(): void;
    toggleBox(): void;
    toggleProbes(): void;
    cycleBands(): void;
    cycleProbeMode(): void;
    cycleMaterial(): void;
    reset(): void;
}

type Mode = 'hero' | 'orbit' | 'pinch' | 'ui' | null;

/**
 * Touch and mouse input. One finger on the hero sphere drags it in the plane
 * facing the camera, elsewhere orbits. Two fingers pinch to zoom; the mouse
 * wheel zooms too.
 */
export class PbrInteraction {
    private mode: Mode = null;
    private primaryId = -1;
    private readonly touches = new Map<number, Vec2>();
    private pinchDistance = 0;
    private readonly ray = new geometry.Ray();
    private readonly planeNormal = new Vec3();
    private planeOffset = 0;
    private readonly hit = new Vec3();
    private readonly grabOffset = new Vec3();

    constructor(
        private readonly camera: Camera,
        private readonly orbit: OrbitCamera,
        private readonly scene: () => PbrScene | null,
        private readonly isOverUi: (uiX: number, uiY: number) => boolean,
        private readonly actions: PbrActions,
    ) {}

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
            if (this.touches.size === 1) this.beginPrimary(touch);
            else if (this.touches.size === 2 && (this.mode === 'orbit' || this.mode === null)) {
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
            if (this.mode !== 'pinch' && id === this.primaryId) this.movePrimary(touch);
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
            if (id === this.primaryId || this.mode === 'pinch') {
                this.mode = null;
                this.primaryId = -1;
            }
        }
    }

    private beginPrimary(touch: Touch): void {
        this.primaryId = touch.getID();
        const ui = touch.getUILocation();
        if (this.isOverUi(ui.x, ui.y)) {
            this.mode = 'ui';
            return;
        }
        const scene = this.scene();
        const loc = touch.getLocation();
        const ray = this.camera.screenPointToRay(loc.x, loc.y, this.ray);
        const t = scene?.pickHero(ray.o.x, ray.o.y, ray.o.z, ray.d.x, ray.d.y, ray.d.z) ?? null;
        if (!scene || t === null) {
            this.mode = 'orbit';
            return;
        }
        this.mode = 'hero';
        ray.computeHit(this.hit, t);
        const h = scene.hero;
        this.grabOffset.set(h.x - this.hit.x, h.y - this.hit.y, h.z - this.hit.z);
        Vec3.negate(this.planeNormal, this.camera.node.forward);
        this.planeOffset = Vec3.dot(this.planeNormal, this.hit);
    }

    private movePrimary(touch: Touch): void {
        if (this.mode === 'orbit') {
            const delta = touch.getUIDelta();
            const height = view.getVisibleSize().height;
            this.orbit.rotate(delta.x / height, delta.y / height);
            return;
        }
        const scene = this.scene();
        if (!scene || this.mode !== 'hero') return;
        const loc = touch.getLocation();
        const ray = this.camera.screenPointToRay(loc.x, loc.y, this.ray);
        const denom = Vec3.dot(ray.d, this.planeNormal);
        if (Math.abs(denom) < 1e-6) return;
        const t = (this.planeOffset - Vec3.dot(ray.o, this.planeNormal)) / denom;
        if (t < 0) return;
        ray.computeHit(this.hit, t);
        scene.moveHero(this.hit.x + this.grabOffset.x, this.hit.y + this.grabOffset.y, this.hit.z + this.grabOffset.z);
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
            case KeyCode.KEY_D: this.actions.toggleDirect(); break;
            case KeyCode.KEY_I: this.actions.toggleIndirect(); break;
            case KeyCode.KEY_S: this.actions.toggleSpecular(); break;
            case KeyCode.KEY_B: this.actions.toggleBox(); break;
            case KeyCode.KEY_P: this.actions.toggleProbes(); break;
            case KeyCode.KEY_L: this.actions.cycleBands(); break;
            case KeyCode.KEY_G: this.actions.cycleProbeMode(); break;
            case KeyCode.KEY_M: this.actions.cycleMaterial(); break;
            case KeyCode.KEY_R: this.actions.reset(); break;
            default: break;
        }
    }
}
