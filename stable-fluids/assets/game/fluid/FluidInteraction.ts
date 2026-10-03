import { Camera, EventKeyboard, EventMouse, EventTouch, Input, input, KeyCode, Vec3 } from 'cc';

export interface FluidActions {
    cycleAdvection(): void;
    cycleScene(): void;
    cyclePressure(): void;
    toggleVorticity(): void;
    cycleView(): void;
    reset(): void;
    toggleLite(): void;
}

/**
 * One finger stirs the fluid, or drags the obstacle when it starts on it.
 * The pointer is reported in view space; MainView maps it into each grid, so
 * in compare mode both panels get the same hand. Keyboard shortcuts mirror
 * the buttons.
 */
export class FluidInteraction {
    readonly pointer = { down: false, x: 0, y: 0, started: false };
    private primaryId = -1;
    private readonly screen = new Vec3();
    private readonly world = new Vec3();

    constructor(
        private readonly camera: Camera,
        private readonly isOverUi: (uiX: number, uiY: number) => boolean,
        private readonly actions: FluidActions,
    ) {}

    enable(): void {
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        input.on(Input.EventType.KEY_DOWN, this.onKey, this);
    }

    disable(): void {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd, this);
        input.off(Input.EventType.KEY_DOWN, this.onKey, this);
    }

    private onTouchStart(event: EventTouch): void {
        if (this.primaryId !== -1) return;
        const touch = event.touch;
        if (!touch) return;
        const ui = touch.getUILocation();
        if (this.isOverUi(ui.x, ui.y)) return;
        this.primaryId = touch.getID();
        this.track(event);
        this.pointer.down = true;
        this.pointer.started = true;
    }

    private onTouchMove(event: EventTouch): void {
        if (event.touch?.getID() === this.primaryId) this.track(event);
    }

    private onTouchEnd(event: EventTouch): void {
        if (event.touch?.getID() !== this.primaryId) return;
        this.primaryId = -1;
        this.pointer.down = false;
    }

    private track(event: EventTouch | EventMouse): void {
        const loc = event.getLocation();
        this.camera.screenToWorld(this.screen.set(loc.x, loc.y, 0), this.world);
        this.pointer.x = this.world.x;
        this.pointer.y = this.world.y;
    }

    private onKey(event: EventKeyboard): void {
        switch (event.keyCode) {
            case KeyCode.KEY_A: this.actions.cycleAdvection(); break;
            case KeyCode.KEY_C: this.actions.cycleScene(); break;
            case KeyCode.KEY_P: this.actions.cyclePressure(); break;
            case KeyCode.KEY_V: this.actions.toggleVorticity(); break;
            case KeyCode.KEY_D: this.actions.cycleView(); break;
            case KeyCode.KEY_R: this.actions.reset(); break;
            case KeyCode.KEY_Q: this.actions.toggleLite(); break;
            default: break;
        }
    }
}
