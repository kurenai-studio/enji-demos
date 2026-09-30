import {
    _decorator,
    Color,
    Component,
    Graphics,
    Label,
    Node,
    UIOpacity,
    UITransform,
} from 'cc';
import type { IView } from '../enji/IView';
import { addLabel } from '../enji/helpers';
import { ReelView } from './ReelView';
import {
    BET_STEPS,
    CELL_H,
    CELL_W,
    DEFAULT_BET_INDEX,
    REEL_COUNT,
    REEL_GAP,
    START_CREDITS,
    VISIBLE_ROWS,
    paytableLines,
    payoutForWindow,
    randomSymbolIndex,
} from './SlotsConfig';

const { ccclass } = _decorator;

@ccclass('MainView')
export class MainView extends Component implements IView {
    private credits = START_CREDITS;
    private betIndex = DEFAULT_BET_INDEX;
    private lastWin = 0;
    private busy = false;

    private reels: ReelView[] = [];
    private creditsLabel: Label | null = null;
    private betLabel: Label | null = null;
    private winLabel: Label | null = null;
    private statusLabel: Label | null = null;
    private paylineGfx: Graphics | null = null;
    private paylineFlash = 0;
    private spinBtnLabel: Label | null = null;

    bind(root: Node): void {
        this.drawBackdrop(root);
        this.buildTitle(root);
        this.buildMachine(root);
        this.buildHud(root);
        this.buildPaytable(root);
        this.buildControls(root);
        this.refreshHud();
        this.setStatus('Place a bet and spin!', new Color(220, 220, 230, 255));

        // Seed each reel with random visible symbols.
        for (const reel of this.reels) {
            reel.setVisible(randomSymbolIndex(), randomSymbolIndex(), randomSymbolIndex());
        }
    }

    update(dt: number): void {
        if (this.paylineFlash > 0 && this.paylineGfx) {
            this.paylineFlash -= dt;
            const pulse = 0.5 + 0.5 * Math.sin(this.paylineFlash * 14);
            this.drawPayline(true, 120 + Math.floor(pulse * 135));
            if (this.paylineFlash <= 0) this.drawPayline(false);
        }
    }

    private drawBackdrop(root: Node): void {
        const bg = new Node('Backdrop');
        bg.layer = root.layer;
        root.addChild(bg);
        bg.setSiblingIndex(0);
        const g = bg.addComponent(Graphics);
        // Deep green felt + vignette-ish frame.
        g.fillColor = new Color(18, 48, 36, 255);
        g.rect(-480, -320, 960, 640);
        g.fill();
        g.fillColor = new Color(12, 32, 24, 255);
        g.roundRect(-300, -250, 600, 420, 24);
        g.fill();
    }

    private buildTitle(root: Node): void {
        addLabel(root, 'LUCKY REELS', {
            name: 'Title',
            fontSize: 42,
            color: new Color(255, 215, 90, 255),
            y: 280,
        });
        addLabel(root, '3-reel · demo', {
            name: 'Subtitle',
            fontSize: 16,
            color: new Color(170, 190, 170, 255),
            y: 248,
        });
    }

    private buildMachine(root: Node): void {
        const machine = new Node('Machine');
        machine.layer = root.layer;
        root.addChild(machine);
        machine.setPosition(0, 20, 0);

        const frameW = REEL_COUNT * CELL_W + (REEL_COUNT - 1) * REEL_GAP + 40;
        const frameH = VISIBLE_ROWS * CELL_H + 40;
        const frame = machine.addComponent(Graphics);
        frame.fillColor = new Color(40, 28, 18, 255);
        frame.roundRect(-frameW / 2, -frameH / 2, frameW, frameH, 16);
        frame.fill();
        frame.strokeColor = new Color(200, 160, 60, 255);
        frame.lineWidth = 4;
        frame.roundRect(-frameW / 2, -frameH / 2, frameW, frameH, 16);
        frame.stroke();

        const totalW = REEL_COUNT * CELL_W + (REEL_COUNT - 1) * REEL_GAP;
        const startX = -totalW / 2 + CELL_W / 2;

        for (let i = 0; i < REEL_COUNT; i++) {
            const node = new Node(`Reel${i}`);
            const reel = node.addComponent(ReelView);
            reel.build(machine, startX + i * (CELL_W + REEL_GAP), 0);
            this.reels.push(reel);
        }

        const payline = new Node('Payline');
        payline.layer = machine.layer;
        machine.addChild(payline);
        this.paylineGfx = payline.addComponent(Graphics);
        this.drawPayline(false);
    }

    private drawPayline(highlight: boolean, alpha = 255): void {
        const g = this.paylineGfx;
        if (!g) return;
        g.clear();
        const totalW = REEL_COUNT * CELL_W + (REEL_COUNT - 1) * REEL_GAP;
        const color = highlight
            ? new Color(255, 220, 60, alpha)
            : new Color(255, 255, 255, 90);
        g.strokeColor = color;
        g.lineWidth = highlight ? 5 : 2;
        g.moveTo(-totalW / 2 - 8, 0);
        g.lineTo(totalW / 2 + 8, 0);
        g.stroke();
        // End caps
        g.fillColor = color;
        g.circle(-totalW / 2 - 8, 0, highlight ? 6 : 4);
        g.circle(totalW / 2 + 8, 0, highlight ? 6 : 4);
        g.fill();
    }

    private buildHud(root: Node): void {
        const hudY = -200;
        this.creditsLabel = addLabel(root, '', {
            name: 'Credits',
            fontSize: 22,
            color: new Color(220, 255, 220, 255),
            x: -280,
            y: hudY,
        });
        this.betLabel = addLabel(root, '', {
            name: 'Bet',
            fontSize: 22,
            color: new Color(255, 230, 160, 255),
            x: 0,
            y: hudY,
        });
        this.winLabel = addLabel(root, '', {
            name: 'Win',
            fontSize: 22,
            color: new Color(160, 220, 255, 255),
            x: 280,
            y: hudY,
        });
        this.statusLabel = addLabel(root, '', {
            name: 'Status',
            fontSize: 24,
            color: Color.WHITE,
            y: -150,
        });
    }

    private buildPaytable(root: Node): void {
        const panel = new Node('Paytable');
        panel.layer = root.layer;
        root.addChild(panel);
        panel.setPosition(380, 40, 0);

        const g = panel.addComponent(Graphics);
        g.fillColor = new Color(0, 0, 0, 100);
        g.roundRect(-70, -130, 140, 260, 10);
        g.fill();

        addLabel(panel, 'PAYTABLE', {
            name: 'PayTitle',
            fontSize: 16,
            color: new Color(255, 215, 90, 255),
            y: 110,
        });
        const lines = paytableLines();
        lines.forEach((line, i) => {
            addLabel(panel, line, {
                name: `Pay${i}`,
                fontSize: 14,
                color: new Color(210, 210, 210, 255),
                y: 80 - i * 28,
            });
        });
    }

    private buildControls(root: Node): void {
        this.makeButton(root, 'Bet-', -200, -270, 100, 48, () => this.changeBet(-1));
        this.makeButton(root, 'Bet+', -80, -270, 100, 48, () => this.changeBet(1));
        const spin = this.makeButton(root, 'SPIN', 120, -270, 160, 56, () => this.onSpin());
        this.spinBtnLabel = spin.getComponentInChildren(Label);
    }

    private makeButton(
        parent: Node,
        text: string,
        x: number,
        y: number,
        w: number,
        h: number,
        onClick: () => void,
    ): Node {
        const node = new Node(`Btn_${text}`);
        node.layer = parent.layer;
        parent.addChild(node);
        node.setPosition(x, y, 0);
        node.addComponent(UITransform).setContentSize(w, h);
        if (!node.getComponent(UIOpacity)) node.addComponent(UIOpacity);

        const g = node.addComponent(Graphics);
        const paint = (pressed: boolean) => {
            g.clear();
            g.fillColor = pressed
                ? new Color(160, 50, 40, 255)
                : new Color(190, 55, 45, 255);
            g.roundRect(-w / 2, -h / 2, w, h, 12);
            g.fill();
            g.strokeColor = new Color(255, 200, 120, 255);
            g.lineWidth = 2;
            g.roundRect(-w / 2, -h / 2, w, h, 12);
            g.stroke();
        };
        paint(false);

        addLabel(node, text, {
            name: 'Label',
            fontSize: text === 'SPIN' ? 28 : 20,
            color: Color.WHITE,
        });

        // TOUCH_* covers mouse clicks in the Cocos preview input path.
        node.on(Node.EventType.TOUCH_START, () => paint(true));
        node.on(Node.EventType.TOUCH_CANCEL, () => paint(false));
        node.on(Node.EventType.TOUCH_END, () => {
            paint(false);
            onClick();
        });
        return node;
    }

    private changeBet(dir: number): void {
        if (this.busy) return;
        this.betIndex = Math.max(0, Math.min(BET_STEPS.length - 1, this.betIndex + dir));
        this.refreshHud();
    }

    private get bet(): number {
        return BET_STEPS[this.betIndex];
    }

    private refreshHud(): void {
        if (this.creditsLabel) this.creditsLabel.string = `CREDITS  ${this.credits}`;
        if (this.betLabel) this.betLabel.string = `BET  ${this.bet}`;
        if (this.winLabel) this.winLabel.string = `WIN  ${this.lastWin}`;
    }

    private setStatus(text: string, color: Color): void {
        if (!this.statusLabel) return;
        this.statusLabel.string = text;
        this.statusLabel.color = color;
    }

    private onSpin(): void {
        if (this.busy) return;
        if (this.credits < this.bet) {
            this.setStatus('Not enough credits!', new Color(255, 120, 100, 255));
            return;
        }

        this.busy = true;
        this.credits -= this.bet;
        this.lastWin = 0;
        this.refreshHud();
        this.drawPayline(false);
        this.paylineFlash = 0;
        this.setStatus('Good luck…', new Color(200, 200, 210, 255));
        if (this.spinBtnLabel) this.spinBtnLabel.string = '…';

        const results = Array.from({ length: REEL_COUNT }, () => randomSymbolIndex());

        for (const reel of this.reels) reel.spin();

        // Stagger stops: reel 0, then 1, then 2.
        let stopped = 0;
        const scheduleStop = (index: number, delayMs: number) => {
            this.scheduleOnce(() => {
                this.reels[index].stopAt(results[index], () => {
                    stopped += 1;
                    if (stopped >= REEL_COUNT) this.onAllStopped(results);
                });
            }, delayMs / 1000);
        };
        scheduleStop(0, 700);
        scheduleStop(1, 1100);
        scheduleStop(2, 1500);
    }

    private onAllStopped(results: number[]): void {
        const win = payoutForWindow(results, this.bet);
        this.lastWin = win;
        if (win > 0) {
            this.credits += win;
            this.paylineFlash = 1.6;
            this.drawPayline(true);
            this.setStatus(`YOU WIN  ${win}!`, new Color(255, 220, 80, 255));
        } else {
            this.setStatus('No win — try again', new Color(180, 180, 190, 255));
        }
        this.refreshHud();
        this.busy = false;
        if (this.spinBtnLabel) this.spinBtnLabel.string = 'SPIN';
    }
}
