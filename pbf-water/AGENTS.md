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

### Guiding LLMs: UI from leaf prefabs

For HUD / battle UI, ship a small **atomic kit** (Sprite / Label / Hit shell /
Graphics bar) under `assets/resources/prefabs/ui/`, then compose in code with
`loadPrefab` / `instantiate`. Do not author one screen-sized prefab, do not
nest prefab assets inside prefabs, and do not paste fullscreen assembled PNGs
with hit zones. Bind `spriteFrame` and Label strings after instantiate. After
writing `.prefab` files: `enji import assets/resources/prefabs/ui`.

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
with “not imported yet” if there is none — run `enji import` then. While the
host runs it waits up to 3 s for the host's own import of a just-created file.

## Feedback loop

```sh
enji host start
# edit assets/…
enji import <new or changed asset files>   # scripts do not need this
enji logs --errors
enji check
```

`enji check` scans reserved `@ccclass` names and re-caps any `.meta` above
3.8 gold **in place** (the rewritten files are listed in `metaNormalize.files`).
Its `warnings` also name `.meta` files with an importer Creator 3.8 does not
know (correct the name, keep the uuid) and orphan `.meta` files whose asset is
gone (delete them). It does **not** run a full TypeScript publish build.

When a 3D view looks wrong, check `enji logs --errors` **before** redesigning
art. Several failure modes look like “bad visuals” but are hard runtime errors.
Error entries carry `source` (the first stack frame mapped to `assets/…ts:line`)
and stack lines in `detail` already point at your TypeScript files.

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
from `enji host start` / `enji host status`. Every open preview tab logs into the
same buffer; `openPages` counts them and browser entries carry `page`. Close
extra tabs when the output looks duplicated. An `asset-error` stays until the
same path imports successfully: fix the file, then run `enji import <path>`
again (a page reload does not clear it).

## 3D scenes: cameras vs Canvas

The template `main.scene` already has a Canvas + UI camera. That UI camera
defaults to clearing **color**. If you add a world / player camera and leave
the Canvas camera alone, the 3D frame is wiped every frame → **black screen**
(or only HUD).

When adding a 3D camera:

1. Game camera: `clearFlags = SOLID_COLOR` (or SKYBOX), lower `priority`,
   `visibility = Layers.Enum.DEFAULT`.
2. Every other camera (Canvas / UI): `clearFlags = DEPTH_ONLY`, higher `priority`,
   `visibility = Layers.Enum.UI_2D`. The template Canvas camera's visibility
   also includes `DEFAULT`, so without this it draws every 3D mesh a second
   time, orthographically, on top of the scene (large meshes show up as flat
   discs or slabs over the view).
3. Prefer `ensureCanvas()` from `assets/enji/helpers.ts` for new UI cameras —
   it already sets `DEPTH_ONLY` and `UI_2D`. Still fix any **existing** scene Canvas camera.

```ts
for (const cam of scene.getComponentsInChildren(Camera)) {
    if (cam.node.name === 'PlayerCamera') continue;
    cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
    cam.visibility = Layers.Enum.UI_2D;
    cam.priority = 1 << 30; // the template camera's priority is 0, same as a new game camera
}
```

## Materials, lighting and custom shaders

Full guide with verified capabilities and recipes: `docs/rendering.md` in the
Enji package (`enji context` prints the docs folder). Short version:

- Start 3D work with `enji init <dir> --3d`: 3d modules, camera, shadowed
  directional light, ambient light and `resources/materials/standard.mtl`
  (`builtin-standard`, PBR) are set up.
- Only `builtin-unlit` is registered at start. `builtin-standard`,
  `builtin-toon` and `advanced/*` effects load on demand: reference them from a
  `.mtl` under `resources/` (needed for Creator builds too) or call
  `loadBuiltinEffect('builtin-standard')` from `assets/enji/helpers.ts`.
  `EffectAsset.get(name)` is only non-null after something loaded the effect.
- Custom `.effect` files under `assets/resources/effects/` work; load them with
  `loadEffect('effects/<name>')`. A shader compiles when its material is first
  used: GLSL errors then appear in `enji logs --errors` as one entry pointing at
  the `.effect` line (they do not fail `enji import`).
- Render textures are 8 bits per channel. Keep float simulation state on the
  CPU and upload it with `createDataTexture(w, h, { float: true })`; use
  `createTexturePass` for 8-bit passes (caustics, blurs).
- Meshes rebuilt every frame: `utils.MeshUtils.createDynamicMesh` once, then
  `updateDynamicMesh(renderer, geometry)`. A bare `mesh.updateSubMesh` keeps
  drawing the old triangle count.

| Log / crash | Meaning |
|-------------|---------|
| `illegal property name: mainTexture` (or roughness / metallic) | The property is not on the pass: wrong effect, or its define (`USE_TEXTURE`, `USE_ALBEDO_MAP`) was not set |
| `Cannot read properties of undefined (reading 'localSetLayout')` on `setSharedMaterial` | The material never initialized (effect missing or failed to compile); fix the effect before swapping materials |

Imported model materials (from glTF / prefab under `resources/`) carry their own
effects; use `loadModel` / `replaceMaterials`.

## Build (not Enji)

Open this project in **Cocos Creator 3.8.8** and build there. Do not install
kurenai into a 3.8 project (kurenai would write 4.0-oriented defaults / publish).

## Product line

| Tool | Engine | Role |
|------|--------|------|
| Akane | Creator 2.x | reserved (not this package) |
| **Enji** | Creator **3.8** | preview / edit, no publish |
| Kurenai | Creator 4.0 | full preview + publish |
