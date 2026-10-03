# Enji demos

Cocos Creator 3.8 projects built with [Enji](https://github.com/kurenai-studio/enji),
kept out of the Enji repository so that installing Enji does not download them.
Each directory is a complete project (open it in Creator 3.8.8 or preview it with
Enji).

| Demo | What it shows | Enji |
|---|---|---|
| [pool-water](pool-water) | Port of the three.js / WebGL Water pool: CPU height field in a float texture, caustics render pass, ray-traced refraction and reflection, floating sphere | 0.4 (`feat/3d-water`) |
| [infinity-castle](infinity-castle) | Endless fall through a procedural Infinity Castle shaft: Blender-generated glTF blocks, pooled chunks, custom lantern lighting and haze | 0.4 (`feat/3d-water`) |
| [pbf-water](pbf-water) | 3D Position Based Fluids in a glass tank: grid neighbour search, density constraint with XSPH and vorticity, closed water surface rebuilt every frame with Surface Nets; dam break, shake, tilt; each neighbour pair solved once, three particle-spacing quality levels with an automatic start-up pick for phones | 0.3 |
| [xpbd-cloth](xpbd-cloth) | Minimal XPBD cloth sized for phones: typed-array solver with substeps, tethers, sphere/ground collision and self collision, streamed into a dynamic mesh; PBD vs XPBD side by side; Projective Dynamics (banded Cholesky or Chebyshev) vs XPBD on a swinging flap; grab, wind, auto quality | 0.4 (`feat/3d-water`) |
| [pbr-probes](pbr-probes) | PBR spheres lit by baked light probes in a Cornell box: offline multi-bounce bake into walls and an L2 SH probe grid, GGX with an analytic area light, box-projected reflection probe prefiltered at startup (RGBM), soft analytic sphere shadows | 0.3 |
| [mpm-2d](mpm-2d) | 2D Material Point Method on the CPU: a port of EA SEED's Position Based MPM next to explicit MLS-MPM on the same scene and pass budget; liquid, jelly, sand and viscoplastic materials, point-sprite rendering, grab / push | 0.3 |
| [fem-softbody](fem-softbody) | Co-rotated linear FEM soft bodies on tetrahedra: implicit Euler solved by CG on a block-sparse R·K·Rᵀ, warm-started polar rotations, contacts filtered inside the solve; linear vs co-rotated beams and spinning cubes, jelly blocks on a ball, grab, auto lite meshes | 0.3 |
| [phantom-pocket-3d](phantom-pocket-3d) | 怪谈口袋 3D — Persona 5–style catch-and-battle game: 3D arena (camera, three lights, Kenney Cube Pets), auto-ui-pipeline HUD and dialogs, moves / bag / catch / run loop. Every UI and stage node is an LLM-written prefab; demo video in `video/` | 0.3 |
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
