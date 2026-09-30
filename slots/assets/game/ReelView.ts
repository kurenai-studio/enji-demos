import {
    _decorator,
    Color,
    Component,
    Graphics,
    Label,
    Mask,
    Node,
    UIOpacity,
    UITransform,
} from 'cc';
import { addLabel } from '../enji/helpers';
import {
    CELL_H,
    CELL_W,
    SYMBOLS,
    VISIBLE_ROWS,
    randomSymbolIndex,
} from './SlotsConfig';

const { ccclass } = _decorator;

interface Cell {
    root: Node;
    bg: Graphics;
    label: Label;
    symbolIndex: number;
}

/**
 * One vertical reel: a masked strip of symbol cells that scrolls, then eases
 * to a chosen center symbol.
 */
@ccclass('ReelView')
export class ReelView extends Component {
    private strip: Node | null = null;
    private cells: Cell[] = [];
    private offset = 0;
    private spinning = false;
    private stopping = false;
    private velocity = 0;
    private targetCenter = 0;
    private stopCallback: (() => void) | null = null;
    private stripHeight = 0;

    /** Extra cells above/below the visible window for scroll wrapping. */
    private readonly buffer = 2;

    build(parent: Node, x: number, y: number): void {
        const root = this.node;
        root.layer = parent.layer;
        parent.addChild(root);
        root.setPosition(x, y, 0);

        const windowH = CELL_H * VISIBLE_ROWS;
        const frame = root.addComponent(UITransform);
        frame.setContentSize(CELL_W + 8, windowH + 8);

        const maskNode = new Node('Mask');
        maskNode.layer = root.layer;
        root.addChild(maskNode);
        maskNode.addComponent(UITransform).setContentSize(CELL_W, windowH);
        maskNode.addComponent(Mask);

        const strip = new Node('Strip');
        strip.layer = root.layer;
        maskNode.addChild(strip);
        this.strip = strip;

        const total = VISIBLE_ROWS + this.buffer * 2;
        this.stripHeight = total * CELL_H;
        const topY = ((total - 1) * CELL_H) / 2;

        for (let i = 0; i < total; i++) {
            const cell = this.makeCell(strip, 0, topY - i * CELL_H, randomSymbolIndex());
            this.cells.push(cell);
        }

        this.offset = 0;
        this.applyOffset();
    }

    getCenterSymbolIndex(): number {
        // Visible center row is at buffer + 1 within the strip after wrap.
        const mid = this.buffer + 1;
        return this.cells[mid]?.symbolIndex ?? 0;
    }

    /** Instantly set the three visible symbols (top, center, bottom). */
    setVisible(top: number, center: number, bottom: number): void {
        const mid = this.buffer + 1;
        this.setCellSymbol(this.cells[mid - 1], top);
        this.setCellSymbol(this.cells[mid], center);
        this.setCellSymbol(this.cells[mid + 1], bottom);
        this.offset = 0;
        this.applyOffset();
    }

    spin(): void {
        this.spinning = true;
        this.stopping = false;
        this.velocity = 1400 + Math.random() * 400;
        this.stopCallback = null;
    }

    /**
     * Begin decelerating toward `centerIndex` on the payline. Calls `onStopped`
     * once the reel has settled.
     */
    stopAt(centerIndex: number, onStopped: () => void): void {
        this.targetCenter = centerIndex;
        this.stopping = true;
        this.stopCallback = onStopped;
    }

    get isBusy(): boolean {
        return this.spinning;
    }

    update(dt: number): void {
        if (!this.spinning || !this.strip) return;

        if (this.stopping) {
            // Ease velocity down; snap when slow enough.
            this.velocity = Math.max(120, this.velocity * Math.pow(0.15, dt));
            this.offset += this.velocity * dt;

            while (this.offset >= CELL_H) {
                this.offset -= CELL_H;
                this.shiftStrip();
            }
            this.applyOffset();

            if (this.velocity <= 130) {
                // Align: put target on center cell, zero offset.
                const mid = this.buffer + 1;
                this.setCellSymbol(this.cells[mid], this.targetCenter);
                this.setCellSymbol(this.cells[mid - 1], randomSymbolIndex());
                this.setCellSymbol(this.cells[mid + 1], randomSymbolIndex());
                // Fill rest randomly so next spin looks continuous.
                for (let i = 0; i < this.cells.length; i++) {
                    if (i < mid - 1 || i > mid + 1) {
                        this.setCellSymbol(this.cells[i], randomSymbolIndex());
                    }
                }
                this.offset = 0;
                this.applyOffset();
                this.spinning = false;
                this.stopping = false;
                this.velocity = 0;
                const cb = this.stopCallback;
                this.stopCallback = null;
                cb?.();
            }
            return;
        }

        this.offset += this.velocity * dt;
        while (this.offset >= CELL_H) {
            this.offset -= CELL_H;
            this.shiftStrip();
        }
        this.applyOffset();
    }

    private applyOffset(): void {
        this.strip?.setPosition(0, this.offset, 0);
    }

    /** Move bottom cell to top with a new random symbol (scroll down). */
    private shiftStrip(): void {
        const bottom = this.cells.pop();
        if (!bottom) return;
        this.setCellSymbol(bottom, randomSymbolIndex());
        this.cells.unshift(bottom);
        const topY = ((this.cells.length - 1) * CELL_H) / 2;
        for (let i = 0; i < this.cells.length; i++) {
            this.cells[i].root.setPosition(0, topY - i * CELL_H, 0);
        }
    }

    private makeCell(parent: Node, x: number, y: number, symbolIndex: number): Cell {
        const root = new Node('Cell');
        root.layer = parent.layer;
        parent.addChild(root);
        root.setPosition(x, y, 0);
        root.addComponent(UITransform).setContentSize(CELL_W - 6, CELL_H - 8);

        const bg = root.addComponent(Graphics);
        const label = addLabel(root, '', {
            name: 'Face',
            fontSize: 36,
            color: Color.WHITE,
        });
        if (!label.node.getComponent(UIOpacity)) label.node.addComponent(UIOpacity);

        const cell: Cell = { root, bg, label, symbolIndex: 0 };
        this.setCellSymbol(cell, symbolIndex);
        return cell;
    }

    private setCellSymbol(cell: Cell, index: number): void {
        const sym = SYMBOLS[index];
        cell.symbolIndex = index;
        cell.bg.clear();
        cell.bg.fillColor = sym.color;
        cell.bg.roundRect(-(CELL_W - 10) / 2, -(CELL_H - 12) / 2, CELL_W - 10, CELL_H - 12, 10);
        cell.bg.fill();
        cell.bg.strokeColor = new Color(255, 255, 255, 80);
        cell.bg.lineWidth = 2;
        cell.bg.roundRect(-(CELL_W - 10) / 2, -(CELL_H - 12) / 2, CELL_W - 10, CELL_H - 12, 10);
        cell.bg.stroke();
        cell.label.string = sym.face;
        cell.label.color = Color.WHITE;
    }
}
