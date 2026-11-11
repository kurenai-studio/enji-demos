# Saltline

A daytime harbor, played in first person. The dock, gun, hound and gull are
exported glTF from the original browser scene.

## How it works

- `assets/game/MainView.ts` builds the harbor, sun, wet materials, sky,
  volume and post grade, then dismisses the startup plate when the dock is in.
- `assets/resources/harbor/saltline.gltf` is the exported dock. Its buffer,
  `saltline.bin` (143MB), is stored with Git LFS.
- `assets/game/viewmodel.ts` is the rifle: hip and aim poses, full-auto fire,
  magazine reload, and rain stuck to the mesh.
- `assets/game/enemies.ts` drives the hound and the gull.

## Controls

Click the canvas to capture the mouse. `W` `A` `S` `D` walk, `Shift` sprint,
`C` crouch, `Space` jump. Mouse looks. Hold left mouse to fire, right mouse to
aim. `R` reloads. `F` inspects the gun.

## Performance

The dock buffer is 143MB, so the first preview import and the first load are
the slow part. Not frame-timed in this drop.

Preview with Enji. A Creator 3.8.8 web-mobile build of this project does not
draw: the custom pipeline is named `Forward`, and that builder is not in the
3.8.8 web package.

Made with Enji 0.3.1.
