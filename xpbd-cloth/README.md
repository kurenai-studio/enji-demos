# XPBD cloth

A minimal Extended Position Based Dynamics cloth for Cocos Creator 3.8, built
and previewed with Enji, sized to run on phones.

| Drape over a sphere | Grab and lift | Curtain in the wind |
|---|---|---|
| ![Drape](shots/drape.jpg) | ![Grab](shots/grab.jpg) | ![Curtain](shots/curtain.jpg) |

## How it works

- `XpbdCloth.ts`: the solver, plain TypeScript with no engine imports.
  - XPBD (Macklin, Müller, Chentanez 2016) with the small-steps schedule
    (Macklin et al. 2019): many substeps per frame, one Gauss-Seidel sweep each.
    With one sweep the Lagrange multiplier starts at zero, so each distance
    constraint update is `dλ = -C / (w_a + w_b + α/h²)`.
  - Three constraint groups with their own compliance α (m/N): stretch (grid
    edges, α = 0), shear (cell diagonals) and bending (every second particle).
    They are solved bend, shear, stretch, so the stiffest group goes last, and
    the sweep direction alternates between substeps.
  - Long range attachments (tethers, Kim et al. 2012) keep a hanging sheet from
    stretching: a free particle may not get farther from a pin than in the rest
    pose. This cuts the worst edge stretch of a 64×64 curtain hung by two
    corners from 63% to under 1%.
  - Colliders: a kinematic sphere (its motion is spread over the substeps) and
    the ground, with position-level friction. Wind is a drag along the particle
    normals.
  - All state lives in preallocated `Float32Array`s. `step()` allocates nothing,
    so there are no GC stalls on phones.
- `ClothScene.ts`: streams positions and normals into a dynamic mesh every frame.
  UVs are uploaded only once, because `updateSubMesh` maps buffers to
  attributes in order. It also owns the scene presets, the stiffness presets and
  the quality levels.
- `xpbd-cloth.effect`: two-sided cloth, with a different colour per side and a
  procedural weave. `xpbd-lit.effect`: ground grid with an analytic contact
  shadow for the sphere. There are no shadow maps, which keeps the fill cost
  low on phones.

## Mobile

| Level | Grid | Substeps | Constraints |
|---|---|---|---|
| Low | 20×20 | 8 | 2,202 |
| Medium (phone default) | 32×32 | 10 | 5,826 |
| High (desktop default) | 48×48 | 12 | 13,346 |
| Ultra | 64×64 | 15 | 23,938 |

Phones start on Medium. Auto quality drops one level when the solver averages
more than 5 ms per frame while the frame rate is under about 55 FPS. Tapping the
quality button picks a level by hand and turns auto off. The HUD lays out in CSS
pixels, so buttons stay 44 px tall on any screen. Touch controls: one finger
grabs the cloth or drags the sphere, a drag elsewhere orbits, and two fingers
pinch to zoom.

## Controls

- Drag the cloth to grab a particle, or drag the ball to move it. Drag anywhere
  else to orbit. Zoom with the wheel or a pinch.
- The buttons switch the scene (drape or curtain), reset, pause, toggle wind,
  unpin, cycle stiffness (silk, cotton, leather) and set quality.
- Keys: `C` scene, `R` reset, `Space` pause, `W` wind, `U` unpin, `B`
  stiffness, `Q` quality.

## Performance

Headless solver, including normals (`node --experimental-strip-types tools/bench.mts`,
Apple Silicon Mac, Node 24):

| Grid | Substeps | Drape | Curtain | Worst edge stretch |
|---|---|---|---|---|
| 20×20 | 8 | 0.15 ms | 0.16 ms | 2.4% / 0.0% |
| 32×32 | 10 | 0.50 ms | 0.57 ms | 2.6% / 0.0% |
| 48×48 | 12 | 1.42 ms | 1.50 ms | 2.8% / 0.2% |
| 64×64 | 15 | 3.21 ms | 3.39 ms | 2.9% / 0.5% |

Enji preview measurements:

- Desktop, High (48×48): 60.2 FPS, with a median frame of 16.7 ms and a p95 of
  18.6 ms. The solver, normals and mesh upload take about 3 ms per frame. The
  viewport was 410×713 at DPR 2.
- With Chrome CPU throttling at 4× (a rough mid-range phone), Medium ran at
  60 FPS with about 3 ms of simulation, and High at 54–56 FPS with 6 ms.

## Not in this demo yet

- Self collision. Folded layers can pass through each other; a spatial hash is
  the next step.
- Dihedral bending, and strain limiting beyond tethers.

Made with Enji 0.4 (`feat/3d-water`).
