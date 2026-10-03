# 2D IPC: barrier contact vs penalty springs

Small-scale **Incremental Potential Contact** (Li et al. 2020) in 2D on the
CPU, for Cocos Creator 3.8, built and previewed with Enji. Soft Neo-Hookean
bodies are stepped with implicit Euler written as one energy minimisation;
contact is a log barrier on the point–edge distance, and every Newton step is
clipped by continuous collision detection, so boundaries never cross. The
default view runs the same scene twice with the same solver: the left side
uses the barrier, the right side a penalty spring in its place. Red outlines
mark boundary edges that cross another edge.

![Squeeze: IPC on the left, penalty on the right](shots/shot-squeeze.jpg)

A plate is driven down to 10 cm above the floor. IPC flattens the jelly ball,
the rubber ring and the jelly block into pancakes: the ring's hole closes to a
slit without its sides passing through each other, and nothing touches. With
the penalty spring the plate pushes all three into the floor; they stay
stuck there after it lifts, with 12–14 crossing edge pairs.

## How it works

Plain TypeScript in typed arrays (`assets/game/ipc/`), in metres, one 60 Hz
step per rendered frame.

- `IpcWorld.ts`: each step minimises the incremental potential
  ½‖x − x̃‖²_M + h²(Ψ + B + D + S) over the vertex positions, where x̃ is the
  inertial prediction, Ψ the Neo-Hookean energy of the triangles, B the
  contact barrier, D the lagged friction potential and S the springs that
  drive the plate and the finger's grab.
  - Projected Newton: the triangle Hessians are made positive semi-definite
    in closed form (2×2 SVD, then the twist, flip and scaling eigenpairs of
    Smith et al. 2019, checked against a numeric projection in
    `tools/test.mts`); the 6×6 contact Hessians by Jacobi rotations.
  - Linear solve: preconditioned CG on a 2×2-block sparse matrix plus
    matrix-free contact blocks, with one banded Cholesky per body as the
    preconditioner (reverse Cuthill–McKee ordering). The tolerance is loose
    (1e-2), because Newton corrects what CG leaves.
  - Line search: the step is first shortened so no triangle inverts and,
    with IPC, so no point crosses an edge (additive CCD, Li et al. 2021, which
    stops at 10% of the remaining gap), then halved until the energy drops.
    Every iterate is therefore free of intersections.
  - Contact: all point–edge pairs closer than d̂ = 2 mm, found on a uniform
    grid, get b(s) = −κ (s − ŝ)² ln(s/ŝ) on the squared distance s, with
    κ = 1e9. The barrier goes to infinity at contact, so it never has to be
    tuned against how hard bodies hit.
  - Friction: Coulomb (μ = 0.4) with normal forces and tangents from the start
    of the step, smoothed below 1 cm/s of sliding.
  - Driven plate: its vertices are unknowns pulled to the scripted path by
    stiff springs, on top of its own stiff elasticity. A plate with infinite
    force would leave the barrier nothing to push against and drive the gap
    to zero.
- Penalty mode is the same solver with ½k(δ − d)² for d < δ (k = 2e5 N/m,
  δ = 5 mm) instead of the barrier, and no CCD. A finite spring has to be
  tuned for the hardest hit; anything faster or heavier goes through.
- `BandedPreconditioner.ts`, `Geometry.ts` (distances and their derivatives,
  barrier, CCD, PSD projections), `Mesh2D.ts` (disks, rings, rectangles,
  wedges), `Scenes.ts`.
- `IpcView.ts`: one dynamic mesh with every moving triangle (darker when
  compressed, lighter when stretched) and a quad per boundary edge.

### Newton budget

Because every Newton iterate is intersection free, the step can stop early
without breaking the guarantee: an unconverged step is only softer and more
damped. Each world gets 6 ms per step (the button cycles 6 ms, 3 ms and full
convergence); the first iteration always runs. Without the budget, impacts
take up to 26 Newton iterations (40 for the bullet) and single frames over
150 ms on the desktop.

## Scenes

| Pile | Bullet |
|---|---|
| ![Pile](shots/shot-pile.jpg) | ![Bullet](shots/shot-bullet.jpg) |

**Pile**: seven bodies (jelly, rubber and one stiff disk; a C-shape, a ring, a
long bar) fall onto a wedge. With IPC they settle in contact; with the
penalty spring they sink into each other and the orange bar sinks into the
floor.

**Bullet**: a stiff disk at 30 m/s, half a metre per step, against three 3 cm
rubber slabs. CCD finds the first touch inside the step, so IPC stops it and
knocks the slabs over. The penalty spring barely sees the contact: the disk
passes the slabs and the wall within a few steps and leaves the scene (the
label says "1 body escaped").

`tools/bench.mts` runs every scene headless for 6 s with full Newton
convergence (crossings are counted between all boundary edges after every
step):

| Scene | Model | Steps with crossings | Closest gap | Outcome |
|---|---|---|---|---|
| Pile | IPC | 0 of 360 | 0.015 mm | settled |
| Pile | penalty | 348 of 360 (up to 42 pairs) | — | bodies sunk into each other |
| Squeeze | IPC | 0 of 360 | 0.007 mm | ball squashed to 15.9 cm of 30 |
| Squeeze | penalty | 167 of 360 (up to 14 pairs) | — | bodies pushed into the floor |
| Bullet | IPC | 0 of 360 | 0.023 mm | bullet stopped by the slabs |
| Bullet | penalty | 183 of 360 (up to 16 pairs) | — | bullet went through 3 slabs |

`tools/test.mts` checks the distance derivatives and the assembled energy
gradient (barrier, penalty, friction, grab) against finite differences, both
PSD projections, and that no IPC scene ever has a crossing.

## Controls

- Drag a body to pull it by the nearest vertex. In compare mode both sides
  get the same hand.
- Buttons: IPC vs penalty / IPC only / penalty only; scene (Pile, Squeeze,
  Bullet); Newton budget (6 ms, 3 ms, full); pause; reset.
- Keys: `M` mode, `C` scene, `B` budget, `Space` pause, `R` reset.

## Performance

At start-up the demo times 60 frames after a 30-frame warm-up. Below 50 FPS
it drops the Newton budget to 3 ms; if compare mode is still below 40 FPS
after the next 60 frames it shows IPC alone (the mode button brings the
comparison back).

Time per frame for both solvers, the crossing count and the mesh upload,
measured in the Enji preview by stepping the scene 180 frames from reset
(300 for Squeeze), best of three runs. Rendering a thousand flat triangles is
not included and is negligible. The 4× column uses Chrome CPU throttling as a
rough phone.

Median / 95th percentile / worst frame:

| Setup | Vertices | Desktop, 6 ms budget | 4× throttle, 3 ms budget |
|---|---|---|---|
| Compare, Pile | 2 × 358 | 8.3 / 16.7 / 18 ms | 26.1 / 32.5 / 35 ms |
| Compare, Squeeze | 2 × 196 | 3.0 / 14.1 / 18 ms | 10.7 / 27.0 / 39 ms |
| Compare, Bullet | 2 × 137 | 3.2 / 7.4 / 8 ms | 7.3 / 9.5 / 11 ms |
| IPC only, Pile | 358 | 4.2 / 8.8 / 10 ms | 12.6 / 19.0 / 21 ms |
| IPC only, Squeeze | 196 | — | 4.8 / 22.9 / 32 ms |
| Compare, Pile, no budget | 2 × 358 | 13.0 / 83.4 / 159 ms | 57.3 / 309.5 / 661 ms |

So a phone at a quarter of this desktop runs the comparison at about 30–40
FPS on the heaviest scene and IPC alone near 60. Under 4× throttling the
start-up check switched to 3 ms at frame 89; the pile had settled by the
second check, so it kept compare mode. With the 6 ms budget the throttled
Pile compare was 26.4 / 34.4 / 41 ms, about the same: most steps stop after
one Newton iteration either way, so the cost is that of one iteration, about
3 ms per world on Pile at 1×. Roughly two thirds of it is the banded
factorisation and CG, a fifth assembly. The closed-form Hessian projection
took the throttled Pile compare from about 34 to 26 ms per frame and IPC
alone from about 17 to 13 ms, against projecting each 4×4 by Jacobi
rotations.

The machine was heavily loaded by other processes during all runs (load
average 35–60 on 10 cores). A dot-product loop in the page ran at
0.5–0.7 GMAC/s unthrottled and 0.11 GMAC/s throttled, and Node runs of the
same code varied by up to 4× from one minute to the next, so the numbers are
on the pessimistic side.

## Not in this demo yet

- 3D (point–triangle and edge–edge distances, and many more pairs per body).
- Adaptive barrier stiffness (IPC grows κ when contacts get too close); κ is
  fixed here, which is enough at these scales.
- Rigid bodies via affine body dynamics, and codimensional shells and rods.
- Warm-starting Newton from the previous step's velocity, and a multigrid or
  domain-decomposition preconditioner for larger meshes.

Made with Enji 0.3.
