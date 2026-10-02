# Region draft task (auto-ui-pipeline, Route C) — screen: bag

You are drafting a **production region SVG** for a mobile game UI screen. Skill hard rules:
- Flat colour-block SVG + data-* only (no gradients/filters/images/opacity).
- **Oneshot** protocol: write it once, then run validate and change things ONLY to fix validator errors. Do not open preview.png / wire.png / colorblock.png and do not iterate on design by looking at renders.
- Layered buttons (shell + rim + face + text); dynamic numbers are program text, never textures.
- Do NOT run or read score.py.

## Paths
- Work dir (write ONLY here): `/Users/shinjiyu/Documents/sub-private/enji-demos/phantom-pocket-3d/ui-work/bag`
- Brief (source of truth, read fully, especially the last sections about the shared texture vocabulary and this screen's layout constraints): `BRIEF.md` in the work dir
- Grammar checklist: `/Users/shinjiyu/Documents/auto-ui-pipeline/.cursor/skills/auto-ui-pipeline/grammar-checklist.md`
- Reference gen.py for script structure / helper functions only (different game, do not copy its design):
  `/Users/shinjiyu/Documents/auto-ui-pipeline/ui-kit-test/boundary-lab/runs/e4_contrast/industrial_oneshot_opus55_2/gen.py`
- Validate: `python3 /Users/shinjiyu/Documents/auto-ui-pipeline/bin/auto-ui validate /Users/shinjiyu/Documents/sub-private/enji-demos/phantom-pocket-3d/ui-work/bag`

## Deliverable
1. `date +%s > t_start` in the work dir first.
2. Write `gen.py` in the work dir that writes `layout.svg` (720×1280, data-style as the brief says). Run it.
3. Run validate until **errors = 0** (fix only from validator errors; reduce warnings where it is a simple fix).
4. Write `NOTES.md` (≤ 30 lines) as the brief asks. Then `date +%s > t_end`.
5. Final reply: validate summary (errors, warnings, n_parts, unique textures, families), list of interactive shells and their ids, and any brief constraint you could not satisfy.

Do not run pack/bake/GenerateImage. Do not modify anything in the auto-ui-pipeline repo. Do not touch any game code or other work dirs.
