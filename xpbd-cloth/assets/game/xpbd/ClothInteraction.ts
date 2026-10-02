import { Camera, EventKeyboard, EventMouse, EventTouch, geometry, Input, input, KeyCode, Touch, Vec2, Vec3, view } from 'cc';
import type { ClothScene } from './ClothScene';
import type { OrbitCamera } from './OrbitCamera';

export interface ClothActions {
    togglePause(): void;
    reset(): void;
    togglePreset(): void;
    cycleQuality(): void;
    cycleStiffness(): void;
    unpin(): void;
    toggleWind(): void;
}

type Mode = 'cloth' | 'sphere' | 'orbit' | 'pinch' | 'ui' | null;

/**
 * Touch and mouse input. One finger on the cloth grabs the nearest particle,
 * on the sphere drags it (both in the plane facing the camera), elsewhere
 * orbits. Two fingers pinch to zoom; the mouse wheel zooms too.
 */
export class ClothInteraction {
    private mode: Mode = null;
    private primaryId = -1;
    private readonly touches = new Map<number, Vec2>();
    private pinchDistance = 0;
    private readonly ray = new geometry.Ray();
    private readonly planeNormal = new Vec3();
    private planeOffset = 0;
    private readonly hit = new Vec3();
    private readonly prevHit = new Vec3();
    private readonly pickResult = { index: -1, t: 0 };

    constructor(
        private readonly camera: Camera,
        private readonly orbit: OrbitCamera,
        private readonly scene: () => ClothScene | null,
        private readonly isOverUi: (uiX: number, uiY: number) => boolean,
        private readonly actions: ClothActions,
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
            const id = touch.getID();
            this.touches.set(id, touch.getLocation(new Vec2()));
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
            if (this.mode === 'pinch') continue;
            if (id !== this.primaryId) continue;
            this.movePrimary(touch);
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
            if (id === this.primaryId || this.mode === 'pinch') this.endPrimary();
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
        if (!scene) {
            this.mode = 'orbit';
            return;
        }
        const loc = touch.getLocation();
        const ray = this.camera.screenPointToRay(loc.x, loc.y, this.ray);
        const s = scene.cloth.sphere;
        const sphereT = intersectSphere(ray, s.x, s.y, s.z, s.r);
        const pick = this.pickResult;
        const clothHit = scene.cloth.pick(ray.o.x, ray.o.y, ray.o.z, ray.d.x, ray.d.y, ray.d.z, pick);

        if (clothHit && (sphereT === null || pick.t <= sphereT)) {
            this.mode = 'cloth';
            scene.cloth.grab(pick.index);
            const k = pick.index * 3;
            this.hit.set(scene.cloth.pos[k], scene.cloth.pos[k + 1], scene.cloth.pos[k + 2]);
        } else if (sphereT !== null) {
            this.mode = 'sphere';
            ray.computeHit(this.hit, sphereT);
        } else {
            this.mode = 'orbit';
            return;
        }
        this.prevHit.set(this.hit);
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
        if (!scene || (this.mode !== 'cloth' && this.mode !== 'sphere')) return;
        const loc = touch.getLocation();
        const ray = this.camera.screenPointToRay(loc.x, loc.y, this.ray);
        if (!intersectPlane(ray, this.planeNormal, this.planeOffset, this.hit)) return;
        if (this.mode === 'cloth') {
            scene.cloth.moveGrab(this.hit.x, this.hit.y, this.hit.z);
        } else {
            const s = scene.cloth.sphere;
            scene.moveSphere(
                s.x + this.hit.x - this.prevHit.x,
                s.y + this.hit.y - this.prevHit.y,
                s.z + this.hit.z - this.prevHit.z,
            );
            this.prevHit.set(this.hit);
        }
    }

    private endPrimary(): void {
        this.scene()?.cloth.releaseGrab();
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
            case KeyCode.KEY_C: this.actions.togglePreset(); break;
            case KeyCode.KEY_Q: this.actions.cycleQuality(); break;
            case KeyCode.KEY_B: this.actions.cycleStiffness(); break;
            case KeyCode.KEY_U: this.actions.unpin(); break;
            case KeyCode.KEY_W: this.actions.toggleWind(); break;
            default: break;
        }
    }
}

/** Distance to the first hit in front of the ray origin, or null. */
function intersectSphere(ray: geometry.Ray, cx: number, cy: number, cz: number, radius: number): number | null {
    const ox = ray.o.x - cx;
    const oy = ray.o.y - cy;
    const oz = ray.o.z - cz;
    const b = ox * ray.d.x + oy * ray.d.y + oz * ray.d.z;
    const c = ox * ox + oy * oy + oz * oz - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    const t = -b - s >= 0 ? -b - s : -b + s;
    return t >= 0 ? t : null;
}

/** Hit on the plane dot(normal, p) = offset. */
function intersectPlane(ray: geometry.Ray, normal: Readonly<Vec3>, offset: number, out: Vec3): boolean {
    const denom = Vec3.dot(ray.d, normal);
    if (Math.abs(denom) < 1e-6) return false;
    const t = (offset - Vec3.dot(ray.o, normal)) / denom;
    if (t < 0) return false;
    ray.computeHit(out, t);
    return true;
}
