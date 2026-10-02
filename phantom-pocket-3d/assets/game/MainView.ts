import { _decorator, Component, director, instantiate, Layers, Node, ResolutionPolicy, view } from 'cc';
import type { IView } from '../enji/IView';
import { loadPrefabAsset, makeCanvasCamerasOverlay } from './core/Prefabs';
import { BattleGame } from './battle/BattleGame';

const { ccclass } = _decorator;

/**
 * Entry. Normal mode runs the battle game. `?prefab=<resources path>` only
 * instantiates that prefab (3D prefabs under the scene, UI prefabs under the
 * Canvas) so tools/dump.js can compare the runtime values with the generator.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private game: BattleGame | null = null;

    bind(root: Node): void {
        view.setDesignResolutionSize(720, 1280, ResolutionPolicy.SHOW_ALL);
        makeCanvasCamerasOverlay();
        const debugPrefab = new URLSearchParams(location.search).get('prefab');
        if (debugPrefab) {
            void this.harness(root, debugPrefab);
            return;
        }
        this.game = new BattleGame(root, director.getScene()!);
        void this.game.start().catch((err) => console.error('[PhantomPocket3D] start failed', err));
    }

    update(dt: number): void {
        this.game?.update(dt);
    }

    private async harness(root: Node, path: string): Promise<void> {
        const w = window as any;
        try {
            const node = instantiate(await loadPrefabAsset(path));
            (node.layer === Layers.Enum.DEFAULT ? director.getScene()! : root).addChild(node);
            w.__harnessRoot = node;
            w.__harness = { ok: true, name: node.name };
            console.log('[Harness] ready', node.name);
        } catch (e) {
            w.__harness = { err: (e as Error).message };
            console.error('[Harness] failed', (e as Error).message);
        }
    }
}
