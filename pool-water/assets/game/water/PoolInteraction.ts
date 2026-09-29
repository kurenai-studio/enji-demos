import { Camera, EventKeyboard, EventMouse, EventTouch, geometry, Input, input, KeyCode, Vec3, view } from 'cc';
import type { FloatingSphere } from './FloatingSphere';
import type { OrbitCamera } from './OrbitCamera';
import type { WaterSimulation } from './WaterSimulation';

export interface PoolActions {
    toggleGravity(): void;
    toggleRain(): void;
    togglePause(): void;
    randomDrops(): void;
    dropSphere(): void;
    flatten(): void;
}

type DragMode = 'sphere' | 'water' | 'orbit' | null;

const WHEEL_SENSITIVITY = 5;

/**
 * Pointer and keyboard input. A press on the sphere drags it in the plane
 * facing the camera, a press on the water makes ripples along the drag, a
 * press anywhere else orbits the camera; the wheel zooms.
 */
export class PoolInteraction {
    private mode: DragMode = null;
    private touchId = -1;
    private readonly ray = new geometry.Ray();
    private readonly prevHit = new Vec3();
    private readonly planeNormal = new Vec3();
    private planeOffset = 0;
    private readonly hit = new Vec3();
    private readonly delta = new Vec3();

    constructor(
        private readonly camera: Camera,
        private readonly orbit: OrbitCamera,
        private readonly sphere: FloatingSphere,
        private readonly simulation: WaterSimulation,
        private readonly actions: PoolActions,
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
        if (this.mode) return;
        this.touchId = event.getID();
        const ray = this.pointerRay(event);
        const t = intersectSphere(ray, this.sphere.center, this.sphere.radius);
        if (t !== null) {
            this.mode = 'sphere';
            this.sphere.dragging = true;
            ray.computeHit(this.prevHit, t);
            Vec3.negate(this.planeNormal, this.camera.node.forward);
            this.planeOffset = Vec3.dot(this.planeNormal, this.prevHit);
        } else if (hitWater(ray, this.hit)) {
            this.mode = 'water';
            this.simulation.addDrop(this.hit.x, this.hit.z, 0.03, 0.01);
        } else {
            this.mode = 'orbit';
        }
    }

    private onTouchMove(event: EventTouch): void {
        if (!this.mode || event.getID() !== this.touchId) return;
        if (this.mode === 'orbit') {
            const delta = event.getUIDelta();
            const height = view.getVisibleSize().height;
            this.orbit.rotate(delta.x / height, delta.y / height);
            return;
        }
        const ray = this.pointerRay(event);
        if (this.mode === 'sphere') {
            if (!intersectPlane(ray, this.planeNormal, this.planeOffset, this.hit)) return;
            this.sphere.moveBy(Vec3.subtract(this.delta, this.hit, this.prevHit));
            this.prevHit.set(this.hit);
        } else if (hitWater(ray, this.hit)) {
            this.simulation.addDrop(this.hit.x, this.hit.z, 0.03, 0.01);
        }
    }

    private onTouchEnd(event: EventTouch): void {
        if (event.getID() !== this.touchId) return;
        this.mode = null;
        this.touchId = -1;
        this.sphere.dragging = false;
    }

    private onWheel(event: EventMouse): void {
        // Cocos web input reports scrollY = -5 * DOM deltaY; OrbitControls expects deltaY.
        this.orbit.zoom(-event.getScrollY() / WHEEL_SENSITIVITY);
    }

    private onKey(event: EventKeyboard): void {
        switch (event.keyCode) {
            case KeyCode.KEY_G: this.actions.toggleGravity(); break;
            case KeyCode.KEY_R: this.actions.toggleRain(); break;
            case KeyCode.SPACE: this.actions.togglePause(); break;
            case KeyCode.KEY_D: this.actions.randomDrops(); break;
            case KeyCode.KEY_B: this.actions.dropSphere(); break;
            case KeyCode.KEY_F: this.actions.flatten(); break;
            default: break;
        }
    }

    private pointerRay(event: EventTouch): geometry.Ray {
        const loc = event.getLocation();
        return this.camera.screenPointToRay(loc.x, loc.y, this.ray);
    }
}

/** Distance to the first hit in front of the ray origin, or null. */
function intersectSphere(ray: geometry.Ray, center: Readonly<Vec3>, radius: number): number | null {
    const ox = ray.o.x - center.x;
    const oy = ray.o.y - center.y;
    const oz = ray.o.z - center.z;
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

/** Hit on the resting water plane (y = 0) inside the pool. */
function hitWater(ray: geometry.Ray, out: Vec3): boolean {
    if (Math.abs(ray.d.y) < 1e-6) return false;
    const t = -ray.o.y / ray.d.y;
    if (t < 0) return false;
    ray.computeHit(out, t);
    return Math.abs(out.x) < 1 && Math.abs(out.z) < 1;
}
