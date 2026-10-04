/**
 * BoardStage — 盘面挂载组件（编辑期可视化 + 运行时装配）。
 *
 * 用法：业务 prefab/场景节点挂本组件，拖入
 *   - doc（盘面 SPIR JSON）
 *   - symbolLibrary（symbol-library.prefab）
 *
 * 格宽/格高/行列距默认跟随符号库（`syncFromLibrary`）。
 * 符号库布局请在 H5「SymbolEditor → 包布局」配置（SymbolSheetDoc.packLayout），
 * 不要用 Creator Inspector 改 SymbolLibrary；运行时吃 prefab 已序列化的字段。
 */

import { _decorator, CCObject, Component, JsonAsset, Node, Prefab, RenderRoot2D } from 'cc';
import { EDITOR } from 'cc/env';
import type { EditorDoc } from '../editor-core/index.ts';
import { deserializeDoc } from '../editor-core/index.ts';
import { BoardDirector } from './BoardDirector.ts';
import { BoardView } from './BoardView.ts';
import { SymbolCatalog } from './SymbolCatalog.ts';
import { SymbolLibrary } from './SymbolLibrary.ts';
import { AssetLibrary } from './AssetLibrary.ts';
import { setMultiDigitStyle } from './multiDigitStyle.ts';
import { WAYS_6X7_TOP_MID4 } from './board-layout/index.ts';

const { ccclass, property, executeInEditMode } = _decorator;

const PREVIEW_NODE = '__board_preview__';

export interface BoardHandle {
    node: Node;
    view: BoardView;
    director: BoardDirector;
    doc: EditorDoc;
    /** 从头播放整个文档 */
    playAll(): Promise<number>;
}

@ccclass('BoardStage')
@executeInEditMode
export class BoardStage extends Component {
    @property({ type: JsonAsset, displayName: '盘面文档', tooltip: 'symbolEditor 导出的 EditorDoc JSON' })
    doc: JsonAsset | null = null;

    @property({ type: Prefab, displayName: '符号库', tooltip: 'symbol-library.prefab' })
    symbolLibrary: Prefab | null = null;

    @property({
        type: Prefab,
        displayName: '素材库',
        tooltip: '同包 asset-library.prefab；新包必填（*AssetId 解析）。旧包可空。',
    })
    assetLibrary: Prefab | null = null;

    @property({
        displayName: '跟随符号库布局',
        tooltip:
            '开启后格宽/格高/列距/行距取自 SymbolLibrary（由 H5 packLayout / 包构建写入）。关闭才用下方手动值。',
    })
    syncFromLibrary = true;

    /** @deprecated 请用 H5 包布局；仅 syncFromLibrary=false 时生效 */
    @property({ visible: false })
    cellW = 126;

    /** @deprecated 请用 H5 包布局 */
    @property({ visible: false })
    cellH = 104;

    /** @deprecated 请用 H5 包布局 */
    @property({ visible: false })
    colGap = 4;

    /** @deprecated 请用 H5 包布局 */
    @property({ visible: false })
    rowGap = 4;

    @property({ displayName: '格内填充比例', range: [0.1, 1.5, 0.05] })
    cellFill = 0.9;

    @property({ displayName: '显示网格背景', tooltip: '调试用半透明网格；正式盘面关闭' })
    showGridBg = false;

    // ------------------------------------------------------------------
    // 运行时
    // ------------------------------------------------------------------

    /** 运行时装配：创建 BoardView 子节点、渲染首帧、返回播放句柄 */
    buildRuntime(): BoardHandle | null {
        const doc = this.parseDoc();
        const lib = this.libraryComponent();
        if (!doc || !lib) {
            console.error('[BoardStage] 缺少盘面文档或符号库配置');
            return null;
        }
        const catalog = this.makeCatalog(lib);
        if (doc.multiDigitStyle) {
            setMultiDigitStyle(doc.multiDigitStyle, false);
        }
        const node = new Node('board');
        const view = this.attachBoardView(node, catalog, doc.packId);
        this.node.addChild(node);

        const director = new BoardDirector(view, () => doc);
        view.render(doc.states[0]);
        return {
            node,
            view,
            director,
            doc,
            playAll: () => director.playRange(0, doc.states.length - 1),
        };
    }

    private parseDoc(): EditorDoc | null {
        if (!this.doc?.json) return null;
        try {
            const doc = deserializeDoc(JSON.stringify(this.doc.json));
            return doc.states.length ? doc : null;
        } catch (e) {
            console.error('[BoardStage] 盘面文档解析失败', e);
            return null;
        }
    }

    private libraryComponent(): SymbolLibrary | null {
        return this.symbolLibrary?.data?.getComponent(SymbolLibrary) ?? null;
    }

    private assetLibraryComponent(): AssetLibrary | null {
        return this.assetLibrary?.data?.getComponent(AssetLibrary) ?? null;
    }

    private makeCatalog(lib: SymbolLibrary): SymbolCatalog {
        return SymbolCatalog.fromLibrary(lib, this.assetLibraryComponent());
    }

    private resolveLayout(catalog: SymbolCatalog): {
        cellW: number;
        cellH: number;
        colGap: number;
        rowGap: number;
    } {
        if (this.syncFromLibrary) {
            const sp = catalog.boardSpacing;
            return {
                cellW: catalog.designW,
                cellH: catalog.designH,
                colGap: sp.colGap,
                rowGap: sp.rowGap,
            };
        }
        return {
            cellW: this.cellW,
            cellH: this.cellH,
            colGap: this.colGap,
            rowGap: this.rowGap,
        };
    }

    private attachBoardView(host: Node, catalog: SymbolCatalog, packId?: string | null): BoardView {
        const layout = this.resolveLayout(catalog);
        const view = host.addComponent(BoardView);
        view.cellW = layout.cellW;
        view.cellH = layout.cellH;
        view.colGap = layout.colGap;
        view.rowGap = layout.rowGap;
        view.cellFill = this.cellFill;
        view.showGridBg = this.showGridBg;
        view.setCatalog(catalog);
        // ways 菱形盘：列对齐取自符号库 packLayout（赏金猎人 center）
        view.setColumnVAlign(catalog.boardSpacing.columnVAlign);
        // 吕布：与 BoardEditorMain 一致，挂上 ways-6x7 profile（档高 112~392），
        // 否则 column-fill 会按 designH=392×N 强拉，贴图横向撑破邻列。
        const pid = String(packId || '').trim();
        if (pid === 'lvbu') {
            view.setLayoutProfile(WAYS_6X7_TOP_MID4);
            const sp = WAYS_6X7_TOP_MID4.spacing;
            if (sp) {
                view.colGap = sp.colGap;
                view.rowGap = sp.rowGap;
            }
        } else {
            view.setLayoutProfile(null);
        }
        return view;
    }

    // ------------------------------------------------------------------
    // 编辑期首帧预览
    // ------------------------------------------------------------------

    private preview: Node | null = null;
    private lastSig = '';
    private editorTimer: ReturnType<typeof setInterval> | null = null;

    protected onEnable(): void {
        if (!EDITOR) return;
        this.rebuildPreview();
        this.editorTimer = setInterval(() => this.editorTick(), 500);
    }

    protected onDisable(): void {
        if (!EDITOR) return;
        if (this.editorTimer !== null) {
            clearInterval(this.editorTimer);
            this.editorTimer = null;
        }
        this.destroyPreview();
    }

    private editorTick(): void {
        if (!this.node.isValid) return;
        const sig = this.signature();
        if (sig !== this.lastSig) {
            this.lastSig = sig;
            this.rebuildPreview();
        }
    }

    private signature(): string {
        const lib = this.libraryComponent();
        const sp = lib?.boardSpacing;
        return [
            this.doc?.uuid ?? '',
            this.symbolLibrary?.uuid ?? '',
            this.assetLibrary?.uuid ?? '',
            this.syncFromLibrary ? 1 : 0,
            this.syncFromLibrary ? (lib?.designW ?? 0) : this.cellW,
            this.syncFromLibrary ? (lib?.designH ?? 0) : this.cellH,
            this.syncFromLibrary ? (sp?.colGap ?? 0) : this.colGap,
            this.syncFromLibrary ? (sp?.rowGap ?? 0) : this.rowGap,
            this.cellFill,
            this.showGridBg ? 1 : 0,
        ].join('|');
    }

    private destroyPreview(): void {
        this.node.getChildByName(PREVIEW_NODE)?.destroy();
        this.preview = null;
    }

    private rebuildPreview(): void {
        this.destroyPreview();
        const doc = this.parseDoc();
        const lib = this.libraryComponent();
        if (!doc || !lib) return;

        if (doc.multiDigitStyle) {
            setMultiDigitStyle(doc.multiDigitStyle, false);
        }

        const preview = new Node(PREVIEW_NODE);
        preview.hideFlags = CCObject.Flags.DontSave | CCObject.Flags.HideInHierarchy;
        // prefab 编辑舞台没有 Canvas，2D 渲染需要渲染根；场景里已有 Canvas 时不重复加
        if (!this.hasRenderRootAncestor()) preview.addComponent(RenderRoot2D);
        this.node.addChild(preview);
        this.preview = preview;

        const view = this.attachBoardView(preview, this.makeCatalog(lib), doc.packId);
        view.render(doc.states[0]);
        requestEditorRepaint();
    }

    private hasRenderRootAncestor(): boolean {
        let p: Node | null = this.node;
        while (p) {
            if (p.getComponent(RenderRoot2D)) return true;
            p = p.parent;
        }
        return false;
    }
}

/** 编辑模式下强制场景视图重绘 */
function requestEditorRepaint(): void {
    const cce = (globalThis as Record<string, unknown>).cce as
        | { Engine?: { repaintInEditMode?: () => void } }
        | undefined;
    cce?.Engine?.repaintInEditMode?.();
}
