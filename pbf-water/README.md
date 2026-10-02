# PBF water

3D Position Based Fluids in a glass tank for Cocos Creator 3.8, built and
previewed with Enji. The particles are simulated on the CPU, and a closed water
surface is rebuilt from them every frame.

| Dam break | Shaking the tank | Particles, tank tilted 12° |
|---|---|---|
| ![Dam break](shots/dam-break.jpg) | ![Shake](shots/shake.jpg) | ![Particles](shots/particles.jpg) |

## How it works

- `PBFSolver.ts`: the solver, plain TypeScript with no engine imports.
  - Position Based Fluids (Macklin, Müller 2013). Each step predicts positions,
    finds neighbours, then runs a few Jacobi iterations of the density
    constraint `C_i = ρ_i / ρ0 - 1`, using the poly6 kernel for density and the
    spiky kernel gradient for the position correction. The rest density `ρ0` is
    the poly6 density of the initial cubic lattice, so the starting block is
    exactly at rest.
  - The constraint is one-sided (only compression is corrected), and the
    artificial pressure term `s_corr` keeps the free surface from clumping.
  - XSPH viscosity smooths the velocities. Vorticity confinement is optional
    (button `O`).
  - Neighbour search uses a uniform grid with cell size `h`. A counting sort
    reorders the particle arrays by cell every step, so the 3×3×3 cell query
    reads contiguous memory. Per-pair kernel values from the density pass are
    reused by the correction pass.
  - Tilting rotates gravity into tank space. Shaking moves the x walls.
  - All state lives in preallocated `Float32Array`s. A step allocates nothing.
- `SurfaceMesher.ts`: splats a `(1 - d²/r²)³` kernel per particle onto a node
  grid clipped to the tank, blurs it with a separable `[1 2 1]` filter, and
  extracts the iso-surface with Naive Surface Nets: one vertex per crossing
  cell, one quad per crossing edge. Normals come from the analytic gradient of
  the trilinear field.
- `ParticleMesh.ts`: draws each particle as a small octahedron coloured by
  speed (the `Particles` and `Both` views).
- `MainView.ts`: scene, shadow-mapped sun, HUD and the dynamic mesh upload.
  Enji's preview draws the whole preallocated index buffer of a dynamic mesh,
  so the tail left over from a larger earlier frame is zeroed before upload.

## Controls

- Drag to orbit, wheel to zoom.
- Buttons and keys: `R` dam break, `S` shake, `T` tilt (0°, 12°, -12°), `D`
  drop a block of 512 particles, `V` view (surface, particles, both), `I`
  solver iterations (2, 3, 4, 6), `O` vorticity, `P` or `Space` pause.

## Performance

Headless dam break, 5,472 particles, 6 s at 60 Hz
(`node --experimental-strip-types tools/bench.mts`, Apple Silicon Mac, Node 24):

| Iterations | Solver | Surface mesh | Density error after settling |
|---|---|---|---|
| 2 | 14.3 ms | 3.6 ms | 6.6% |
| 3 (default) | 14.7 ms | 3.1 ms | 4.1% |
| 4 | 15.7 ms | 3.0 ms | 2.9% |
| 6 | 19.0 ms | 2.9 ms | 1.4% |

About 12 ms of each step does not depend on the iteration count: the neighbour
search alone takes about a third of the frame. The Enji preview on the same
desktop runs at 52 FPS with the solver at 14.9 ms, the mesher at 3.2 ms and the
upload under 0.2 ms.

This demo is tuned for desktop only. A phone would need fewer particles and a
cheaper neighbour pass.

## Not in this demo yet

- Phone tuning. Processing each neighbour pair once instead of twice would
  halve the neighbour search and the constraint passes, and a quality level
  with a larger particle spacing would cut the particle count.
- Two-way coupling with rigid bodies, and foam or spray particles.
- Refraction. The water is a lit, semi-transparent surface.

Made with Enji 0.3. Based on Macklin and Müller, "Position Based Fluids",
SIGGRAPH 2013.
