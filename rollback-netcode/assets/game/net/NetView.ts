import { Color, Graphics, Label, Layers, Node, UITransform } from 'cc';
import { ONE } from './Fixed';
import { BALL, BALL_R, DASH_COOLDOWN, GOAL, HX, HY, KICKOFF, P, PLAYER_R, SCORE0, SCORE1 } from './Game';
import { MAX_PREDICTION, type Peer } from './Peer';

/** Ticks of rollback / stall history drawn under each arena. */
export const HISTORY_TICKS = 180;

const FIELD = new Color(22, 38, 44, 255);
const LINES = new Color(70, 110, 120, 255);
const PANEL = new Color(10, 13, 18, 255);
const PLAYER_COLORS = [new Color(236, 90, 80, 255), new Color(80, 150, 240, 255)];
const PUCK = new Color(240, 240, 230, 255);
const GHOST = new Color(255, 255, 255, 150);
const BAR_IDLE = new Color(40, 52, 60, 255);
const BAR_ROLLBACK = new Color(250, 170, 60, 255);
const BAR_STALL = new Color(230, 60, 60, 255);
const TEXT = new Color(220, 228, 240, 255);

/** What happened to one peer in one tick, for the strip under its arena. */
export interface TickRecord {
    depth: number;
    stalled: boolean;
}

export interface PanelRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Draws both peers' games side by side (or stacked): each peer's own state,
 * white ghost outlines where the reference (no network) has the other player
 * and the puck at the same frame, and a strip of the last 3 s of ticks:
 * orange bars are rollbacks (height: frames re-simulated), red bars stalls.
 */
export class NetView {
    private readonly g: Graphics;
    private readonly labels: Label[] = [];

    constructor(canvas: Node) {
        const node = new Node('NetView');
        node.layer = Layers.Enum.UI_2D;
        canvas.insertChild(node, 0);
        node.addComponent(UITransform);
        this.g = node.addComponent(Graphics);
        for (let i = 0; i < 2; i++) {
            const n = new Node(`PeerLabel${i}`);
            n.layer = Layers.Enum.UI_2D;
            canvas.insertChild(n, 1);
            n.addComponent(UITransform).setContentSize(400, 24);
            const label = n.addComponent(Label);
            label.fontSize = 15;
            label.lineHeight = 20;
            label.color = TEXT;
            label.horizontalAlign = Label.HorizontalAlign.LEFT;
            label.overflow = Label.Overflow.SHRINK;
            this.labels.push(label);
        }
    }

    /** `rects` in canvas coordinates (origin at the centre), one per peer. */
    draw(peers: Peer[], ghosts: (Int32Array | null)[], history: TickRecord[][], rects: PanelRect[], titles: string[]): void {
        const g = this.g;
        g.clear();
        for (let i = 0; i < 2; i++) {
            const r = rects[i];
            const labelH = 26, stripH = Math.max(18, r.h * 0.09), pad = 6;
            g.fillColor = PANEL;
            g.roundRect(r.x, r.y, r.w, r.h, 8);
            g.fill();
            // Arena: largest 16:9 box under the label and above the strip.
            const aw = r.w - 2 * pad, ah = r.h - labelH - stripH - 3 * pad;
            const scale = Math.min(aw / (2 * HX / ONE + 1), ah / (2 * HY / ONE));
            const cx = r.x + r.w / 2, cy = r.y + stripH + 2 * pad + ah / 2;
            this.arena(peers[i], ghosts[i], cx, cy, scale);
            this.strip(history[i], r.x + pad, r.y + pad, r.w - 2 * pad, stripH);
            const label = this.labels[i];
            label.string = titles[i];
            const t = label.node.getComponent(UITransform)!;
            t.setContentSize(r.w - 2 * pad, labelH);
            label.node.setPosition(r.x + r.w / 2, r.y + r.h - labelH / 2 - 2, 0);
        }
    }

    private arena(peer: Peer, ghost: Int32Array | null, cx: number, cy: number, k: number): void {
        const g = this.g;
        const s = peer.state;
        const X = (v: number) => cx + (v / ONE) * k;
        const Y = (v: number) => cy + (v / ONE) * k;
        const hx = (HX / ONE) * k, hy = (HY / ONE) * k, goal = (GOAL / ONE) * k;
        g.fillColor = FIELD;
        g.rect(cx - hx, cy - hy, 2 * hx, 2 * hy);
        g.fill();
        g.lineWidth = 2;
        g.strokeColor = LINES;
        g.rect(cx - hx, cy - hy, 2 * hx, 2 * hy);
        g.moveTo(cx, cy - hy);
        g.lineTo(cx, cy + hy);
        g.circle(cx, cy, 1.2 * k);
        g.stroke();
        // Goal mouths in the colour of the player defending them.
        g.lineWidth = 5;
        for (let i = 0; i < 2; i++) {
            const x = i === 0 ? cx - hx : cx + hx;
            g.strokeColor = PLAYER_COLORS[i];
            g.moveTo(x, cy - goal);
            g.lineTo(x, cy + goal);
            g.stroke();
        }

        const pr = (PLAYER_R / ONE) * k, br = (BALL_R / ONE) * k;
        for (let i = 0; i < 2; i++) {
            const o = P + 5 * i;
            g.fillColor = PLAYER_COLORS[i];
            g.circle(X(s[o]), Y(s[o + 1]), pr);
            g.fill();
            // Dash cooldown: a ring that closes as the dash recharges.
            const cool = s[o + 4];
            if (cool > 0) {
                g.lineWidth = 3;
                g.strokeColor = PUCK;
                const a = (1 - cool / DASH_COOLDOWN) * Math.PI * 2;
                g.arc(X(s[o]), Y(s[o + 1]), pr + 4, Math.PI / 2, Math.PI / 2 + a, true);
                g.stroke();
            }
        }
        g.fillColor = PUCK;
        g.circle(X(s[BALL]), Y(s[BALL + 1]), br);
        g.fill();

        if (ghost) {
            g.lineWidth = 2;
            g.strokeColor = GHOST;
            const o = P + 5 * (1 - peer.id);
            const far = (a: number, b: number, c: number, d: number) => Math.hypot(a - c, b - d) / ONE > 0.02;
            if (far(ghost[o], ghost[o + 1], s[o], s[o + 1])) {
                g.circle(X(ghost[o]), Y(ghost[o + 1]), pr);
                g.stroke();
            }
            if (far(ghost[BALL], ghost[BALL + 1], s[BALL], s[BALL + 1])) {
                g.circle(X(ghost[BALL]), Y(ghost[BALL + 1]), br);
                g.stroke();
            }
        }
        if (s[KICKOFF] > 0) {
            g.fillColor = new Color(255, 255, 255, 40);
            g.rect(cx - hx, cy - hy, 2 * hx, 2 * hy);
            g.fill();
        }
    }

    private strip(history: TickRecord[], x: number, y: number, w: number, h: number): void {
        const g = this.g;
        const bw = w / HISTORY_TICKS;
        g.fillColor = BAR_IDLE;
        g.rect(x, y, w, h);
        g.fill();
        history.forEach((t, j) => {
            if (!t.stalled && t.depth === 0) return;
            const bx = x + (HISTORY_TICKS - history.length + j) * bw;
            if (t.stalled) {
                g.fillColor = BAR_STALL;
                g.rect(bx, y, Math.max(1, bw), h);
            } else {
                g.fillColor = BAR_ROLLBACK;
                g.rect(bx, y, Math.max(1, bw), Math.max(2, (h * t.depth) / (MAX_PREDICTION + 1)));
            }
            g.fill();
        });
    }
}

export function scoreText(s: Int32Array): string {
    return `${s[SCORE0]} : ${s[SCORE1]}`;
}
