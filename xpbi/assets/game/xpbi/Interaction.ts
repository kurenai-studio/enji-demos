import { Camera, EventKeyboard, EventTouch, Input, input, KeyCode, Vec3 } from 'cc';

export interface Actions {
    cycleSolver(): void;
    cycleScene(): void;
    cycleBudget(): void;
    toggleStiff(): void;
    toggleTool(): void;
    reset(): void;
    toggleLite(): void;
}

export class Interaction {
    readonly pointer = { down: false, x: 0, y: 0 };
    private primaryId = -1;
    private readonly screen = new Vec3();
    private readonly world = new Vec3();

    constructor(
        private readonly camera: Camera,
        private readonly isOverUi: (uiX: number, uiY: number) => boolean,
        private readonly actions: Actions,
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
    }

    private onTouchMove(event: EventTouch): void {
        if (event.touch?.getID() === this.primaryId) this.track(event);
    }

    private onTouchEnd(event: EventTouch): void {
        if (event.touch?.getID() !== this.primaryId) return;
        this.primaryId = -1;
        this.pointer.down = false;
    }

    private track(event: EventTouch): void {
        const loc = event.touch!.getLocation();
        this.camera.screenToWorld(this.screen.set(loc.x, loc.y, 0), this.world);
        this.pointer.x = this.world.x;
        this.pointer.y = this.world.y;
    }

    private onKey(event: EventKeyboard): void {
        switch (event.keyCode) {
            case KeyCode.KEY_S: this.actions.cycleSolver(); break;
            case KeyCode.KEY_C: this.actions.cycleScene(); break;
            case KeyCode.KEY_B: this.actions.cycleBudget(); break;
            case KeyCode.KEY_K: this.actions.toggleStiff(); break;
            case KeyCode.KEY_T: this.actions.toggleTool(); break;
            case KeyCode.KEY_R: this.actions.reset(); break;
            case KeyCode.KEY_Q: this.actions.toggleLite(); break;
            default: break;
        }
    }
}
