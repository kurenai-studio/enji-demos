/**
 * A stand-in for a player: reads its own peer's view of the game and holds
 * each decision for a human-like 6–13 frames, so its inputs change a few
 * times a second, which is what makes remote input prediction miss.
 * Seeded, so a session replays the same way.
 */
import { BALL, DASH, DOWN, HX, LEFT, P, RIGHT, UP } from './Game';
import { ONE } from './Fixed';

export class Bot {
    private input = 0;
    private hold = 0;
    private seed: number;
    private readonly player: number;

    constructor(player: number, seed: number) {
        this.player = player;
        this.seed = seed | 0 || 1;
    }

    next(s: Int32Array): number {
        if (this.hold > 0) {
            this.hold--;
            return this.input;
        }
        this.hold = 5 + (this.random() % 8);
        const o = P + 5 * this.player;
        const me = this.player === 0 ? -1 : 1;
        const px = s[o] / ONE, py = s[o + 1] / ONE;
        const bx = s[BALL] / ONE, by = s[BALL + 1] / ONE;
        const ballOnMySide = bx * me > -0.5;
        let tx: number, ty: number;
        if (ballOnMySide) {
            // Get behind the puck on the line to the opponent's goal, then drive through it.
            const gx = -me * (HX / ONE), gy = 0;
            const dx = bx - gx, dy = by - gy;
            const l = Math.hypot(dx, dy) || 1;
            const behind = (px - bx) * me > 0.2 ? 0.2 : 0.9;
            tx = bx + (dx / l) * behind;
            ty = by + (dy / l) * behind;
        } else {
            // Guard the goal, shadowing the puck.
            tx = me * 6;
            ty = by * 0.45;
        }
        // Some decisions are a little off, as a human's would be.
        if (this.random() % 5 === 0) ty += ((this.random() % 3) - 1) * 0.8;
        const dx = tx - px, dy = ty - py;
        let input = 0;
        if (dx > 0.15) input |= RIGHT;
        if (dx < -0.15) input |= LEFT;
        if (dy > 0.15) input |= UP;
        if (dy < -0.15) input |= DOWN;
        const near = Math.hypot(bx - px, by - py) < 1.6;
        if (ballOnMySide && near && s[o + 4] === 0 && this.random() % 3 === 0) input |= DASH;
        this.input = input;
        return input;
    }

    private random(): number {
        let x = this.seed;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.seed = x;
        return x >>> 0;
    }
}
