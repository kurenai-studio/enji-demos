import { Camera, director, Layers, Node, Prefab, resources } from 'cc';

const cache = new Map<string, Promise<Prefab>>();

/** Loads `assets/resources/<path>.prefab` once. */
export function loadPrefabAsset(path: string): Promise<Prefab> {
    let p = cache.get(path);
    if (!p) {
        p = new Promise<Prefab>((resolve, reject) => {
            resources.load(path, Prefab, (err, prefab) => (err ? reject(err) : resolve(prefab)));
        });
        p.catch(() => cache.delete(path));
        cache.set(path, p);
    }
    return p;
}

/** Node at `path` below `root` (e.g. 'top_block/enemy_plate/enemy_name'); throws when the prefab changed. */
export function find(root: Node, path: string): Node {
    let n: Node | null = root;
    for (const part of path.split('/')) {
        n = n.getChildByName(part);
        if (!n) throw new Error(`node "${path}" not found under ${root.name} (missing "${part}")`);
    }
    return n;
}

/**
 * The template Canvas camera clears colour and also renders DEFAULT; make it a
 * HUD-only overlay above the 3D camera of BattleStage.prefab.
 */
export function makeCanvasCamerasOverlay(): void {
    const scene = director.getScene()!;
    for (const cam of scene.getComponentsInChildren(Camera)) {
        if (cam.visibility === Layers.Enum.DEFAULT && cam.node.name === 'MainCamera') continue;
        cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
        cam.visibility = Layers.Enum.UI_2D;
        cam.priority = 1 << 30;
    }
}
