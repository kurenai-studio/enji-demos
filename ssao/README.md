# Simplified SSAO: half-resolution depth, hemisphere samples, depth-aware blur

Screen-space ambient occlusion for Cocos Creator 3.8, built and previewed with
Enji and sized for phones. The scene's depth and normals go into a small
render texture, the AO is estimated there with a handful of samples per
pixel, blurred, and the lit meshes darken only their ambient light with it.
Everything runs through the engine's ordinary cameras and render textures:
no custom render pipeline, no float or depth textures, no multiple render
targets, only 8-bit RGBA targets.

![Left half without AO, right half with AO](shots/split.jpg)

Split view at the default settings (AO at half resolution, 16 samples,
0.5 m radius, blur on). Without a shadow map, the left half has nothing that
grounds the objects; on the right the spheres sit in dark contacts, the crates
and the bench meet the floor and wall, and the stairs and skirting get their
creases.

## How it works

Five passes per frame, each a camera ordered by priority
(`assets/game/ssao/SsaoPipeline.ts`):

1. **G-buffer.** A camera parented to the scene camera, with the same field of
   view, draws a copy of every mesh (`GBUFFER_LAYER`) with
   `ssao-gbuffer.effect` into an RGBA8 render texture at AO resolution.
   rg holds linear view depth over 40 m in two bytes (16 bits, 0.6 mm steps),
   ba the view-space normal's x and y (z is rebuilt, facing the camera).
   It is sampled with NEAREST filtering, since interpolated packed depth is
   meaningless.
2. **AO** (`ssao-ao.effect`), a full-screen quad at the same size. For each
   pixel it rebuilds the view position from depth and the projection, then
   tests samples in the normal-oriented hemisphere (Crytek 2007, in the
   hemisphere form of Chapman and LearnOpenGL). A sample counts as occluded
   when the stored depth at its screen position is in front of it, weighted
   down when that surface is more than a radius away (range check). Details:
   - The kernel is procedural: cosine-weighted directions on a golden-angle
     spiral, lengths 0.1 to 1 of the radius, squared towards the centre. The
     sample count is a uniform, and no array is uploaded.
   - A 4×4 Bayer pattern rotates the kernel per pixel, so neighbouring pixels
     sample different directions and a 4-pixel blur averages all 16 rotations.
   - The bias is slope-scaled, as for shadow maps: 2.5 cm plus the depth the
     surface spans across half a texel, depth × texel angle × tan(view angle).
     Without the slope term a floor seen at a grazing angle occludes itself,
     because one texel stores one depth for a long strip of floor.
   - The output is r: visibility to the power 1.5, gb: the packed depth copied
     through, so the next passes read one texture instead of two.
3. **Blur x, blur y** (`ssao-blur.effect`): separable, five binomial taps,
   each weighted down by its relative depth difference to the centre, so
   occlusion does not bleed across silhouettes.
4. **Scene.** `ssao-lit.effect` shades with vertex colours, a sky/ground
   hemisphere ambient and one sun, without shadows, and multiplies only the
   ambient term by the AO at the fragment's screen position. Two ways to read
   the smaller AO texture:
   - **Bilinear:** one fetch.
   - **Depth-aware** (joint bilateral upsampling): the four nearest AO
     texels, each weighted by bilinear weight times how close its depth is to
     the fragment's own view depth (`v_clip.w`, free in the vertex shader).
     Texels within 2% count fully, beyond 6% not at all; if none matches (a
     feature thinner than a texel), it takes the nearest in depth.

`assets/game/ssao/AoMath.ts` is the AO estimator in TypeScript, line for line
the shader, and `tools/test.mts` runs it on analytic scenes.

## The AO buffer

| Blurred (default) | Raw, blur off |
|---|---|
| ![AO buffer, blurred](shots/ao-blurred.jpg) | ![AO buffer, raw](shots/ao-raw.jpg) |

Without the blur the 4×4 rotation pattern shows as a dither in every
occluded area. The two 5-tap passes remove it without washing occlusion over
edges: the floor next to the ball, the crates and the column plinths stays
white right up to their outlines.

## Upsampling at quarter resolution

| Bilinear | Depth-aware |
|---|---|
| ![Quarter resolution, bilinear](shots/quarter-bilinear.jpg) | ![Quarter resolution, depth-aware](shots/quarter-depth-aware.jpg) |

At quarter resolution (280×357 AO texels on a 1118×1426 screen) a bilinear
lookup smears dark contact shadows over the silhouettes in blocky steps. The
depth-aware lookup keeps the ball's and the crates' outlines sharp. At half
resolution the two are hard to tell apart in this scene.

## Tests

`node --no-warnings --import ./tools/ts-resolve.mjs tools/test.mts`
ray-casts G-buffers from analytic scenes (camera 1.6 m up, 60° vertical FOV),
quantises depth and normals exactly like the 8-bit texture, and runs the
estimator with the default settings:

| Check | Result |
|---|---|
| Kernel: inside the unit hemisphere, lengths ≥ 0.1, mean cos θ | yes, yes, 0.667 (cosine-weighted: 2/3) |
| 4×4 dither | 16 distinct rotations |
| Depth packing, worst round-trip error | 0.31 mm at 40 m |
| Flat floor, < 10 m | AO 1.000 everywhere |
| Flat floor, 10–30 m (grazing) | 1.000; without the slope term mean 0.894, min 0.650 |
| Floor meeting a wall | crease 0.75, a metre away 1.000 |
| Sphere resting on the floor | ring round the contact 0.70, floor further out 1.000 |

Floor AO against distance to a wall, at three G-buffer sizes (wall 3 m
ahead, camera pitched 35° down). The profile hardly depends on resolution,
which is what makes half and quarter resolution usable:

| G-buffer | 0–0.1 m | 0.1–0.25 m | 0.25–0.5 m | 0.5–1 m |
|---|---|---|---|---|
| 640×480 | 0.700 | 0.917 | 0.987 | 1.000 |
| 320×240 | 0.761 | 0.935 | 0.989 | 1.000 |
| 160×120 | 0.760 | 0.909 | 0.986 | 1.000 |

Mean crease AO is 0.786 with 8 samples, 0.751 with 16 and 0.753 with 32: 16
is enough on average; 8 is a little lighter and noisier.

## Controls

- Drag to orbit, pinch or mouse wheel to zoom.
- Buttons: view (split, AO on, AO off, AO only); AO resolution (half, full,
  quarter); samples (16, 32, 8); radius (0.5, 1, 0.25 m); blur on / off;
  depth-aware / bilinear upsampling; pause the bouncing ball.
- Keys: `V` view, `Q` resolution, `N` samples, `D` radius, `B` blur,
  `U` upsampling, `Space` pause.

## Performance

On the desktop (Apple Silicon, Enji preview, 1118×1426 canvas) every
combination runs at the 60 FPS cap, including full resolution with 32
samples, so frame rate does not separate them; it has not been measured on a
phone yet. What the settings cost is clearer in texture fetches per frame on
that canvas:

| Pass | Half res, 16 samples | Full res, 32 samples | Quarter res, 8 samples |
|---|---|---|---|
| AO (1 + samples per AO pixel) | 6.8 M | 52.6 M | 0.9 M |
| Blur (2 × 5 per AO pixel) | 4.0 M | 15.9 M | 1.0 M |
| Upsample, depth-aware (4 per screen pixel) | 6.4 M | 6.4 M (no gain) | 6.4 M |
| Upsample, bilinear (1 per screen pixel) | 1.6 M | 1.6 M | 1.6 M |

Two things follow for phones. The depth-aware upsample costs about as much
as the AO itself at half resolution, where it barely shows, so bilinear is
the better choice there and depth-aware pays off at quarter resolution. And
copying the depth into the AO texture halves both the blur and the upsample,
which would otherwise also read the G-buffer at every tap. The G-buffer pass
redraws every mesh once more; this scene has two meshes (4,732 + 625 vertices).

## Not in this demo yet

- Phone measurements and an automatic quality pick at start-up.
- Reusing the scene's own depth instead of drawing a G-buffer copy of every
  mesh: Cocos 3.8's built-in forward pipeline does not expose the camera's
  depth buffer to materials without a custom pipeline.
- Temporal accumulation (reprojecting last frame's AO), which would allow 4–8
  samples per frame.
- Horizon-based variants (HBAO, GTAO), which get more out of each sample.
- Native builds: the screen-position lookup assumes WebGL's clip-to-texture
  orientation, as on the other targets render textures may be flipped.

Made with Enji 0.3.
