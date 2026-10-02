# Cocos project rules (Enji / Creator 3.8)

This is a **Cocos Creator 3.8.8** project. Preview runs through Enji (4.0 host
with **3.8 `.meta` caps**). There is **no** `enji publish` — build in the
Creator 3.8.8 IDE (or a separate build MCP).

## Where to write

- Game code goes under `assets/game/`. Create files and folders freely.
- `assets/game/MainView.ts` must export `class MainView` with `bind(root: Node)`.
  It is the entry point: `assets/enji/Boot.ts` runs
  `root.addComponent(MainView).bind(root)` when the scene starts.
- Prefabs go under `assets/resources/prefabs/`, materials under
  `assets/resources/materials/`, other files (images, audio) under `assets/resources/`.
- Do not edit `assets/enji/Boot.ts` or `*.scene`.
- Never write or edit `.meta` files by hand. `enji import` creates them and
  **keeps importer `ver` on Creator 3.8.8 gold**.
- `assets/enji/helpers.ts` holds small helpers (`loadPrefab`, canvas, labels).

## `@ccclass` reserved names

Do **not** use these `@ccclass` names (engine collisions):

- `game`, `Game`
- `camera`, `Camera`
- `cc`, `CC`

Prefer unique names like `MainView`, `EnemyView`.

## Prefabs

- A prefab must not contain script components.
- A prefab must not reference another prefab. Compose in code.
- Prefer handwritten minimal prefabs; the importer may reformat them.

## Importing files and getting uuids

After you create or change files under `assets/`, import them. This writes the
`.meta` and returns the uuids you reference from prefabs, materials and code:

```sh
enji import assets/resources/materials/red.mtl        # one file
enji import assets/resources/images                   # a whole folder
```

Returns `{ ok, imported, failed, assets: [{ ok, path, uuid, type, importer, subAssets }] }`.
Sub-assets carry their own uuid (e.g. an image's `spriteFrame` is `<uuid>@f9941`).
A non-zero `failed` means the file content was rejected; fix the file and import again.

To look up a file that is already imported, without importing:

```sh
enji asset info assets/resources/images/hero.png
```

It only reads the existing `.meta` (`uuid`, `importer`, `subAssets`) and fails
with “not imported yet” if there is none — run `enji import` then.

## Feedback loop

```sh
enji host start
# edit assets/…
enji import <new or changed asset files>   # scripts do not need this
enji logs --errors
enji check
```

`enji check` scans reserved `@ccclass` names and re-caps any `.meta` above
3.8 gold. It does **not** run a full TypeScript publish build.

When a 3D view looks wrong, check `enji logs --errors` **before** redesigning
art. Several failure modes look like “bad visuals” but are hard runtime errors.

Engine modules (Spine, DragonBones, TiledMap, physics backend, …) come from
`settings/v2/packages/engine.json`, i.e. Creator 3.8.8 Project Settings →
Feature Cropping. The host reads it at start: after changing modules, run
`enji host stop && enji host start`. Spine runs only the selected version
(`spine-3.8` or `spine-4.2`); skeletons exported for the other version fail
to load.

Read `clean` from `enji logs --errors`, not the length of `entries`. `clean: true`
means a preview page booted and no current errors remain. `clean: false` with
`previewPage: "none"` means no browser page has run since `host start` (not
opened yet, or the tab still shows a connection error from the restart): open or
reload the `previewUrl` and ask again. The port is not fixed; always take the URL
from `enji host start` / `enji host status`.

## 3D scenes: cameras vs Canvas

The template `main.scene` already has a Canvas + UI camera. That UI camera
defaults to clearing **color**. If you add a world / player camera and leave
the Canvas camera alone, the 3D frame is wiped every frame → **black screen**
(or only HUD).

When adding a 3D camera:

1. Game camera: `clearFlags = SOLID_COLOR` (or SKYBOX), lower `priority`.
2. Every other camera (Canvas / UI): `clearFlags = DEPTH_ONLY`, higher `priority`.
3. Prefer `ensureCanvas()` from `assets/enji/helpers.ts` for new UI cameras —
   it already sets `DEPTH_ONLY`. Still fix any **existing** scene Canvas camera.

```ts
for (const cam of scene.getComponentsInChildren(Camera)) {
    if (cam.node.name === 'PlayerCamera') continue;
    cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
}
```

## Runtime materials (Enji preview)

Enji preview is a 4.0 host with a **thin** builtin effect set. Do **not** assume
Creator IDE defaults are all registered.

Verified available for runtime `Material.initialize({ effectName })` in preview:

- `builtin-unlit` (primary for code-built meshes)
- `legacy/terrain`, a few `util/*` / pipeline helpers

**Not** registered in preview (common agent mistake):

- `builtin-standard` / PBR lit materials

Symptoms when the effect is missing or defines did not apply:

| Log / crash | Meaning |
|-------------|---------|
| `illegal property name: mainTexture` (or roughness / metallic) | Effect resolved poorly, or `USE_TEXTURE` / `USE_ALBEDO_MAP` never applied — property not on the pass |
| `Cannot read properties of undefined (reading 'localSetLayout')` on `setSharedMaterial` | Material passes broken; do not keep swapping materials — fix `effectName` / defines first |

Preferred pattern for procedural / voxel / debug meshes:

```ts
const mat = new Material();
mat.initialize({
    effectName: 'builtin-unlit',
    defines: { USE_TEXTURE: true, USE_VERTEX_COLOR: true },
});
mat.setProperty('mainTexture', atlas);
mat.setProperty('mainColor', Color.WHITE);
```

Face lighting: bake shade into vertex `colors` (top ≈ 1.0, sides ≈ 0.7–0.9,
bottom ≈ 0.5). Do not rely on `DirectionalLight` + `builtin-standard` in Enji
preview.

Before shipping a new effect name, confirm it exists:

```ts
!!EffectAsset.get('builtin-unlit') // true in preview
!!EffectAsset.get('builtin-standard') // false in preview today
```

Imported model materials (from glTF / prefab under `resources/`) are a separate
path — use `loadModel` / `replaceMaterials`; those assets carry their own
effects and are not limited to the runtime `effectName` list above.

## Build (not Enji)

Open this project in **Cocos Creator 3.8.8** and build there. Do not install
kurenai into a 3.8 project (kurenai would write 4.0-oriented defaults / publish).

## Product line

| Tool | Engine | Role |
|------|--------|------|
| Akane | Creator 2.x | reserved (not this package) |
| **Enji** | Creator **3.8** | preview / edit, no publish |
| Kurenai | Creator 4.0 | full preview + publish |
