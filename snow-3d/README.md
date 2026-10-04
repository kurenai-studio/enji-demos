# Snow 3D: a gauntlet sweeping real snow

A 3D snow demo for Cocos Creator 3.8, built and previewed with Enji. The idea
comes from the Lich King cinematic (and its memes): an armoured gauntlet
sweeps through deep snow. The snow is a full **3D MLS-MPM** simulation with
the **Stomakhin et al. 2013** snow plasticity: about 17 000 particles on a
46×26×32 grid with 3 cm cells. The gauntlet is a model built by a Blender
script. It pushes the snow through eight kinematic capsules, so the furrow,
the packed walls and the clumps that stick to the claws come from the
physics. None of it is an animation.

| Mid-sweep | After the sweep | Particles (debug view) |
|---|---|---|
| ![Mid-sweep](shots/sweep.jpg) | ![Furrow](shots/furrow.jpg) | ![Particles](shots/particles.jpg) |

In the particle view, yellow particles are awake (being simulated) and violet
ones are asleep. The capsules are the collision shape the model sits on.

## How it works

`assets/game/snow/` is pure TypeScript in typed arrays. The Node tests import
it directly.

| Module | Role |
|---|---|
| `SnowSim` | Explicit MLS-MPM (Hu et al. 2018): quadratic B-splines, APIC, P2G / grid / G2P; snow plasticity; capsule colliders; sleeping |
| `Svd3` | 3×3 SVD by cyclic Jacobi on FᵀF, with U and V kept as rotations (an inverted F shows up as σ₃ < 0) |
| `Hand` | The gauntlet's eight capsules in hand space, posed by (position, yaw, lean); positions and velocities are interpolated across substeps |
| `Frame` | One frame: move the hand, wake or sleep particles, run 6 substeps |
| `Scenes` / `Setup` | Snow bed (noise drifts, a bank at the back) and the scene constants |
| `SurfaceMesher` | Surface Nets surface over a particle density field (from `pbf-water`), with a cached field for sleeping snow |

### Snow (Stomakhin 2013)

Each particle carries **F = F_E F_P**. Stress is fixed-corotated on the
elastic part, stiffened as the snow is packed:

\[ \boldsymbol\tau = 2\mu(J_P)\,(\mathbf F_E-\mathbf R_E)\mathbf F_E^{\mathsf T} + \lambda(J_P)\,(J_E-1)J_E\,\mathbf I, \qquad \mu,\lambda \propto e^{\xi(1-J_P)}. \]

After each step the singular values of F_E are clamped to
[1 − θ_c, 1 + θ_s]. Whatever is clipped moves into F_P. Snow that is squeezed
past 2.5 % stays squeezed (J_P < 1) and gets harder; snow that is stretched
past 0.75 % tears. The parameters are E = 4·10⁴ Pa, ν = 0.2, ρ = 400 kg/m³,
θ_c = 2.5·10⁻², θ_s = 7.5·10⁻³ and ξ = 10, with hardening capped at 4×.

### The hand

Grid nodes inside a capsule (plus a band of dx/2) take the capsule's velocity
in the normal direction, with Coulomb friction (μ = 0.4) along it.
Particles that end up inside are pushed back out in G2P. The B-spline stencil
spans 3 cells, so a hand thinner than about 3 cells lets snow through. The
whole scene is therefore scaled up (gauntlet 2.2× a human hand, snow 25 cm
deep) rather than the grid refined.

`tools/gauntlet.py` builds the model headless (Blender 5.2):

```
Blender -b --factory-startup --python tools/gauntlet.py
```

The script builds the faceted plates, finger segments, claws, knuckle and cuff
spikes, and a glowing rune in the same hand space as the capsules, then
exports `assets/resources/models/gauntlet.glb`. One test checks that 97 % of
the model's vertices lie within 3.5 cm of a capsule.

### Sleeping

Only snow near the hand is simulated. A particle that has stayed slower than
4 cm/s for 40 frames, and is more than 20 cm from the hand, falls asleep.
Grid nodes covered by sleeping snow are treated as solid ground. Snow within
12 cm of the hand wakes up. A sweep keeps up to about 7 000 of the 17 000
particles awake. The surface mesher keeps the density of sleeping snow in a
cached field and only re-splats awake particles each frame.

### Look

The surface is built with Surface Nets on a 2 cm grid, using the builtin
standard material with vertex colour. Snow below the untouched bed top is
tinted blue-grey with depth, so the furrow reads from any angle. A moon
directional light casts shadows.

## Results

`tools/test.mts` (Node, about 7 s):

| Check | Result |
|---|---|
| SVD reconstructs F, near identity and arbitrary | error 3·10⁻¹² |
| Undeformed snow without gravity | stays at rest (|v| = 0) |
| Fresh bed settles | no leak or blow-up; every column sinks 2.0–2.9 cm (drifts kept) |
| Hand hovering far away | nothing awake, nothing moves |
| Full sweep | stable; peak 7 221 of 16 571 awake |
| Furrow along the middle of the sweep | 11.2 cm deep |
| Pile where the sweep ends | 43 cm high |
| Snow 30 cm to the side | unchanged |
| Snow packed by the palm (J_P < 0.97) | 5 152 particles |
| Gauntlet model on the capsules | 97 % of vertices within 3.5 cm |

In the browser preview, simulating a sweep costs 15–30 ms per frame and the
surface 3–4 ms. Settling a fresh bed costs about 55 ms per frame for its 40
frames. All of this was measured on a loaded laptop, single-threaded.

Packed snow behaves cohesively, so the palm pushes it ahead as one mass and
drops it where the sweep ends. It does not spill sideways into berms the way
loose powder would.

## Controls

- **Drag on the snow** to dig with the gauntlet (it follows the pointer, turning toward its motion while it is in the snow).
- **Sweep** (or `S`) plays the scripted sweep: down at the back left, an arc across, up and out.
- **New snow** (`R`) refills the tray; **Surface / Particles / Both** (`V`) switches the view; **Pause** (`P`, space).
- Right drag or two fingers orbit; the wheel zooms; the arrow keys turn the camera.

## Running

```
enji host start            # preview at http://localhost:7463
node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts
node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts
```

## Engine notes

- Dynamic meshes: Enji draws the whole preallocated index buffer, so a shorter frame must zero the old tail and sync `ia.indexCount`.
- `primitives.capsule` with `heightSegments: 1` produces no triangles; use 12.
- No reflection probe, so fully metallic materials render black. The gauntlet uses metallic 0.55.
- A background preview tab is not animated. Screenshots drive frames with `cc.director.tick` and read the canvas in the same evaluate call (`tools/shoot.js`, `tools/grab.py`).

## Not in this demo yet

- Loose powder that spills sideways (lower cohesion near the surface, or a second, weaker snow layer).
- Snow sparkle / subsurface shading in a custom effect; screen-space surface smoothing.
- Phone performance (not measured).
