Follow AGENTS.md in this project and the Enji workflow in the enji package docs (getting-started).

Environment:
- This project is already `enji init`'d (2d, Creator 3.8.8).
- The Enji preview host runs **inside Docker** with WATCH_POLL=1. It is already up at:
  http://localhost:7460/?scene=db://assets/main.scene
- Do NOT run `enji host start` or `enji host stop` on the Mac host — that would fight the container. The Mac-side `enji host status` reports "not running" because the PID lives in the container; ignore that. Use HTTP instead:
  - status: `curl -s http://localhost:7460/__enji/status`
  - errors: `curl -s 'http://localhost:7460/__enji/logs?errors=1'`
  - import still works from the host: `enji import <path> --project .` (talks to the same mounted assets/; watcher polls).
  - Or `curl -s 'http://localhost:7460/__enji/asset?path=assets/…'`
- Node for the host-side CLI: `export PATH=/Users/shinjiyu/tools/node-v24.21.0-darwin-arm64/bin:$PATH; unset NODE_OPTIONS`
  `enji() { node /Users/shinjiyu/Documents/sub-private/enji/bin/enji.mjs "$@"; }`
- Do not stop or touch any other preview ports.

Task — one shot, ship a playable slots game:
Build a classic 3-reel (or 5-reel) casino slots game in this Cocos 2D project.
Requirements:
1. Spin button, reels that animate (spin then stop with ease), payline highlight, win / lose feedback.
2. Credit balance, bet amount, win amount on screen. Start with a sensible credit (e.g. 1000).
3. At least 6 distinct symbols (procedural/drawn with Graphics / Labels / simple sprites is fine — no need for external art assets).
4. A small paytable (e.g. 3-of-a-kind pays). RNG fair enough for a demo.
5. Clean UI that fits the default canvas; keep the Canvas camera rules from AGENTS.md.
6. When done: open/reload the preview URL, confirm `curl -s 'http://localhost:7460/__enji/logs?errors=1'` reports `"clean": true`, and `enji check --project .` is ok.
7. Write a short `README.md` in this project: controls, how to run (mention Docker host), screenshot note.

Prefer editing TypeScript under assets/game. Use enji import for new assets. Stop when the game is playable and clean; do not over-polish.
