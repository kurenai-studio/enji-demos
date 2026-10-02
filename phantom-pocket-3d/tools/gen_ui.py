#!/usr/bin/env python3
"""uilayout.json (auto-ui-pipeline export) -> UI prefabs + assets/game/ui/UiGen.ts.

    python3 tools/gen_ui.py

Writes resources/prefabs/ui/{BattleHud,BagDialog,ResultDialog}.prefab. One node per layout part
(named by part id, nested like the layout), children ordered by z:
  - textured parts: cc.Sprite showing the baked PNG for the part's state; SLICED when the export is
    nine_slice (the borders go into each image's .meta userData, then `enji import` re-imports it);
  - type=button parts: cc.Button (SCALE transition) on the part node;
  - type=bar parts: white cc.Sprite tinted with the bar colour, anchor (0, 0.5) so width grows from the left;
  - text: cc.Label on the part node, or on a trailing `Text` child when the part also has a sprite or
    children (keeps the text above the badge it sits on).
The prefab is authored in baked-pixel units (2x the 720x1280 design) with root scale 0.5, so 9-slice
borders keep the thickness they were baked at.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from prefablib import (PROJECT, RES, UI2D, BlockInputEvents, Button, Label, N, Sprite, UIOpacity,  # noqa: E402
                       W_BOT, W_CENTER, W_LEFT, W_MID, W_RIGHT, W_TOP, Widget, count_nodes, sprite_frame,
                       write_prefab)

WHITE_PNG = "ui/common/white.png"
DIM = (0, 0, 0, 170)


def load_layout(name):
    return json.load(open(os.path.join(RES, "ui", name, "uilayout.json"), encoding="utf-8"))


BORDERS: dict[str, list[int]] = {}


def set_border(res_path, border):
    old = BORDERS.setdefault(res_path, border)
    if old != border:
        raise SystemExit(f"{res_path}: 9-slice border {border} conflicts with {old} used by another part")


def write_borders():
    """Write BORDERS into subMetas.f9941.userData of each image .meta; return the changed image paths."""
    changed = []
    for res_path, (l, t, r, b) in sorted(BORDERS.items()):
        img = os.path.join(RES, res_path)
        meta_path = img + ".meta"
        meta = json.load(open(meta_path, encoding="utf-8"))
        user = meta["subMetas"]["f9941"]["userData"]
        want = {"borderLeft": l, "borderTop": t, "borderRight": r, "borderBottom": b}
        if all(user.get(k) == v for k, v in want.items()):
            continue
        user.update(want)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)
            f.write("\n")
        changed.append(img)
    return changed


class Gen:
    def __init__(self, ui_name, prefab_name):
        self.L = load_layout(ui_name)
        self.ui = ui_name
        self.prefab = prefab_name
        self.S = self.L["scale"]
        self.W, self.H = self.L["W"] * self.S, self.L["H"] * self.S
        self.parts = self.L["parts"]
        self.kids = {}
        for i, p in enumerate(self.parts):
            self.kids.setdefault(p["parent"], []).append((p["z"] or 0, i, p))
        self.paths, self.states, self.bars = {}, {}, {}
        self.white = sprite_frame(WHITE_PNG)

    def frame(self, file):
        return sprite_frame(f"ui/{self.ui}/{file}")

    def center(self, p):
        S = self.S
        return (p["x"] + p["w"] / 2) * S, (p["y"] + p["h"] / 2) * S

    def label(self, t, w, h):
        fs = round(t["fs"] * self.S)
        return Label(t["s"], fs, color=t["col"], bold=t["bold"], h=t["align"],
                     line_height=max(fs, min(round(fs * 1.2), round(h))))

    def widget(self, p):
        S, a = self.S, p.get("anchor")
        if a == "top":
            return Widget(W_TOP, top=p["y"] * S)
        if a == "bottom":
            return Widget(W_BOT, bottom=self.H - (p["y"] + p["h"]) * S)
        if a == "fill":
            return Widget(W_TOP | W_BOT | W_LEFT | W_RIGHT, left=p["x"] * S, top=p["y"] * S,
                          right=self.W - (p["x"] + p["w"]) * S, bottom=self.H - (p["y"] + p["h"]) * S)
        if a == "center":
            cx, cy = self.center(p)
            return Widget(W_CENTER | W_MID, hcenter=cx - self.W / 2, vcenter=self.H / 2 - cy)
        return None

    def node(self, p, pc, path):
        S = self.S
        cx, cy = self.center(p)
        w, h = p["w"] * S, p["h"] * S
        pos = (cx - pc[0], pc[1] - cy, 0)
        comps, ui = [], (w, h)
        img, text = p.get("img"), p.get("text")
        self.paths[p["id"]] = path
        kids = sorted(self.kids.get(p["id"], []), key=lambda k: (k[0], k[1]))
        if img:
            pad = p["pad"]
            ui = (w + 2 * pad, h + 2 * pad)
            st = p.get("state") or "normal"
            file = img.get(st) or img.get("normal") or next(iter(img.values()))
            sliced = p.get("kind") == "nine_slice" and p.get("slice")
            comps.append(Sprite(self.frame(file), sliced=bool(sliced), trim=False))
            if sliced:
                border = [round(v + pad) for v in p["slice"]]
                for f in set(img.values()):
                    set_border(f"ui/{self.ui}/{f}", border)
            if len(img) > 1:
                self.states[path] = {k: f"ui/{self.ui}/{os.path.splitext(v)[0]}" for k, v in img.items()}
        elif p["type"] == "bar":
            col = (p.get("bar") or {}).get("col") or [255, 255, 255]
            comps.append(Sprite(self.white, color=tuple(col) + (255,), trim=False))
            ui = (w, h, 0, 0.5)
            pos = (p["x"] * S - pc[0], pos[1], 0)
            self.bars[path] = w
        elif p["render"] == "program" and p["role"] == "deco" and not kids:
            comps.append(Sprite(self.white, color=(34, 30, 32, 255), trim=False))
        elif p["render"] == "program" and p["role"] == "icon" and not kids:
            comps.append(Label("▶", round(p["h"] * S * 0.9), color=(245, 240, 232, 255), h="middle"))
        if p["type"] == "button":
            comps.append(Button(path))
        wdg = self.widget(p)
        if wdg:
            comps.append(wdg)
        children = []
        for _, _, c in kids:
            children.append(self.node(c, (cx, cy), f"{path}/{c['id']}"))
        if text and text.get("s"):
            if img or children or p["type"] == "bar":
                children.append(N("Text", ui=(w, h), comps=[self.label(text, w, h)]))
                self.paths[p["id"] + ".text"] = f"{path}/Text"
            else:
                comps.append(self.label(text, w, h))
        return N(p["id"], pos=pos, ui=ui, comps=comps, children=children)

    def tree(self, prefix=()):
        pc = (self.W / 2, self.H / 2)
        top = sorted(self.kids.get(None, []), key=lambda k: (k[0], k[1]))
        return list(prefix) + [self.node(p, pc, p["id"]) for _, _, p in top]

    def root(self, children, comps=()):
        return N(self.prefab, scale=(0.5, 0.5, 1), ui=(self.W, self.H), comps=list(comps), children=children)

    def gen_entry(self, root):
        return {"prefab": f"prefabs/ui/{self.prefab}", "nodes": count_nodes(root), "paths": self.paths,
                "states": self.states, "bars": self.bars}


def hud():
    g = Gen("battle", "BattleHud")
    W, H = g.W, g.H
    white = g.white
    band_y = (300 + 230) * g.S  # stage band centre (design y 530)
    fx = N("Fx", ui=(W, H), children=[
        N("ScreenFlash", active=False, ui=(W, H), comps=[Sprite(white, trim=False), UIOpacity(0)]),
        N("CutIn", active=False, pos=(0, H / 2 - band_y, 0), euler=(0, 0, 6), ui=(W + 200, 150),
          comps=[Sprite(white, color=(230, 0, 18, 255), trim=False), UIOpacity(255)],
          children=[N("Text", ui=(W, 130), comps=[Label("怪谈斩！", 96, color=(245, 240, 232, 255),
                                                        outline=((10, 10, 10, 255), 6))])]),
        N("PopEnemy", active=False, ui=(320, 110), comps=[Label("-12", 80, color=(245, 240, 232, 255),
                                                               outline=((230, 0, 18, 255), 6)), UIOpacity(255)]),
        N("PopPlayer", active=False, ui=(320, 110), comps=[Label("-12", 80, color=(245, 240, 232, 255),
                                                                outline=((230, 0, 18, 255), 6)), UIOpacity(255)]),
    ])
    for k in ("ScreenFlash", "CutIn", "CutIn/Text", "PopEnemy", "PopPlayer"):
        g.paths["fx." + k] = "Fx/" + k
    root = g.root(g.tree([fx]))
    write_prefab("prefabs/ui/BattleHud.prefab", root)
    return g.gen_entry(root)


def dialog(ui_name, prefab_name):
    g = Gen(ui_name, prefab_name)
    dim = N("Dim", ui=(g.W, g.H), comps=[Sprite(g.white, color=DIM, trim=False), BlockInputEvents()])
    g.paths["dim"] = "Dim"
    root = g.root(g.tree([dim]), comps=[UIOpacity(255)])
    write_prefab(f"prefabs/ui/{prefab_name}.prefab", root)
    return g.gen_entry(root)


def main():
    out = {"BattleHud": hud(), "BagDialog": dialog("bag", "BagDialog"),
           "ResultDialog": dialog("result", "ResultDialog")}
    ts = os.path.join(PROJECT, "assets", "game", "ui", "UiGen.ts")
    os.makedirs(os.path.dirname(ts), exist_ok=True)
    with open(ts, "w", encoding="utf-8") as f:
        f.write("// Generated by tools/gen_ui.py from assets/resources/ui/*/uilayout.json. Do not edit.\n")
        f.write("// paths: part id -> node path in the prefab;\n")
        f.write("// states: node path -> state -> SpriteFrame resource dir; bars: fill node path -> full width.\n\n")
        f.write("export interface UiGenEntry {\n    prefab: string;\n    nodes: number;\n"
                "    paths: Record<string, string>;\n"
                "    states: Record<string, Record<string, string>>;\n    bars: Record<string, number>;\n}\n\n")
        f.write("export const UI_GEN: Record<string, UiGenEntry> = ")
        f.write(json.dumps(out, ensure_ascii=False, indent=4))
        f.write(";\n")
    print("wrote", os.path.relpath(ts, PROJECT))
    changed = write_borders()
    print(f"9-slice borders: {len(BORDERS)} images, {len(changed)} .meta changed")
    if changed:
        dirs = sorted({os.path.dirname(c) for c in changed})
        subprocess.run(["enji", "import", *dirs, "--project", PROJECT], check=True, stdout=subprocess.DEVNULL)
        print("re-imported", ", ".join(os.path.relpath(d, PROJECT) for d in dirs))


if __name__ == "__main__":
    main()
