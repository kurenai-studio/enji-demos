# Enji demos

Cocos Creator 3.8 projects built with [Enji](https://github.com/kurenai-studio/enji),
kept out of the Enji repository so that installing Enji does not download them.
Each directory is a complete project (open it in Creator 3.8.8 or preview it with
Enji).

| Demo | What it shows | Enji |
|---|---|---|
| [pool-water](pool-water) | Port of the three.js / WebGL Water pool: CPU height field in a float texture, caustics render pass, ray-traced refraction and reflection, floating sphere | 0.4 (`feat/3d-water`) |
| [infinity-castle](infinity-castle) | Endless fall through a procedural Infinity Castle shaft: Blender-generated glTF blocks, pooled chunks, custom lantern lighting and haze | 0.4 (`feat/3d-water`) |
| [pbf-water](pbf-water) | 3D Position Based Fluids in a glass tank: grid neighbour search, density constraint with XSPH and vorticity, closed water surface rebuilt every frame with Surface Nets; dam break, shake, tilt | 0.3 |
| [xpbd-cloth](xpbd-cloth) | Minimal XPBD cloth sized for phones: typed-array solver with substeps, tethers, sphere/ground collision and self collision, streamed into a dynamic mesh; PBD vs XPBD side by side; grab, wind, auto quality | 0.4 (`feat/3d-water`) |
| [slots](slots) | Lucky Reels — 3-reel casino slots (2D UI, paytable, spin animation). Built one-shot with Cursor CLI against an Enji host in Docker | 0.4 (`feat/3d-water`) |

## Run a demo

Install Enji as described in its
[getting started guide](https://github.com/kurenai-studio/enji/blob/main/docs/getting-started.md),
then:

```sh
git clone https://github.com/kurenai-studio/enji-demos.git
cd enji-demos
enji host start --project pool-water   # prints previewUrl
```

Open the printed `previewUrl` in a browser. The first boot imports every asset
and takes about a minute. `enji host stop --project pool-water` when done.

## Adding a demo

1. `enji init <name> [--3d]` inside this repository.
2. Build it; keep `library/`, `temp/`, `local/` out of git (the root
   `.gitignore` does this).
3. Put comparison screenshots in `<name>/shots/` as JPEG and write
   `<name>/README.md`: what it shows, controls, measured performance, and the
   Enji version it was made with.
4. Add a row to the table above.

Screenshots and generated models go in the demo folder, not in the Enji
repository.
