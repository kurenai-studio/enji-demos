#!/usr/bin/env python3
"""auto-ui-pipeline export step for Cocos/Enji: layout.svg + prod/bake -> uilayout.json + baked PNGs.

    python3 tools/export_cocos_layout.py ui-work/<screen> <ui name>
      -> assets/resources/ui/<ui name>/uilayout.json + <texture>__WxH__<state>.png

Adapted from phantom-pocket/tools/export_cocos_layout.py. Differences: `role="bg"`
parts are dropped (behind the HUD is the live 3D view, behind dialogs a dim
layer), and text / bar / button / anchor data are exported in full so
tools/gen_ui.py can write the prefab without reading the SVG again.
Coordinates stay in design space (720x1280, origin top-left).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import xml.etree.ElementTree as ET

PIPE = os.environ.get("AUTO_UI_PIPELINE", os.path.expanduser("~/Documents/auto-ui-pipeline")) + "/ui-kit-test"
sys.path.insert(0, os.path.join(PIPE, "boundary-lab", "tools"))
import common as C  # noqa: E402

PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def hexrgb(h):
    h = (h or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return [int(h[i: i + 2], 16) for i in (0, 2, 4)]


def num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def main(work: str, name: str):
    work = os.path.abspath(work)
    svg = os.path.join(work, "layout.svg")
    bake_path = os.path.join(work, "prod", "bake", "bake.json")
    bout = os.path.join(work, "prod", "bake", "out")
    if not os.path.isfile(svg) or not os.path.isfile(bake_path):
        raise SystemExit(f"need layout.svg + prod/bake/bake.json under {work}")

    root = ET.parse(svg).getroot()
    pm = C.parent_map(root)
    B = json.load(open(bake_path, encoding="utf-8"))
    scale = B.get("scale", 2)
    parts = [p for p in C.parts(root) if p["ok_box"]]
    el2part = {p["el"]: p for p in parts}

    def parent_part(el):
        el = pm.get(el)
        while el is not None:
            p = el2part.get(el)
            if p is not None:
                return p
            el = pm.get(el)
        return None

    dst = os.path.join(PROJECT, "assets", "resources", "ui", name)
    if os.path.isdir(dst):
        for fn in os.listdir(dst):  # keep .meta of files that survive so uuids stay stable
            if fn.endswith((".png", ".json")) and not fn.endswith(".meta"):
                os.remove(os.path.join(dst, fn))
    os.makedirs(dst, exist_ok=True)

    dropped = {p["el"] for p in parts if p["role"] == "bg"}
    copied, out = set(), []
    for p in parts:
        if p["el"] in dropped:
            continue
        par = parent_part(p["el"])
        while par is not None and par["el"] in dropped:
            par = parent_part(par["el"])
        el = p["el"]
        d = {
            "id": p["id"], "parent": par["id"] if par else None, "role": p["role"], "type": p["type"],
            "render": p["render"], "x": p["x"], "y": p["y"], "w": p["w"], "h": p["h"], "z": p["z"],
            "bind": p["bind"], "anchor": p["anchor"], "layer": p["layer"],
            "state": el.get("data-state"), "states": el.get("data-states"), "maxlen": el.get("data-maxlen"),
            "attach": el.get("data-attach"), "importance": p["importance"],
        }
        inst = B["instances"].get(p["id"])
        if inst:
            exp = B["exports"][inst["export"]]
            d["img"] = dict(exp["states"])
            d["kind"] = exp.get("kind")
            d["pad"] = exp.get("pad", B.get("pad", 0))  # baked px on each side
            d["slice"] = exp.get("slice")                # L,T,R,B baked px, without pad
            d["scale"] = exp.get("scale", scale)
            d["size"] = exp.get("size")                  # baked px, without pad
            for fn in d["img"].values():
                if fn not in copied:
                    shutil.copy(os.path.join(bout, fn), os.path.join(dst, fn))
                    copied.add(fn)
        own_texts = [t for t in el.iter() if C.tag(t) == "text" and parent_part(t) is p]
        if own_texts:
            def inh(e, a, dflt=None):
                v = C._inherited(e, pm, a)
                return dflt if v is None else v
            t = max(own_texts, key=lambda e: num(inh(e, "font-size"), 16))
            d["text"] = {
                "s": "".join(t.itertext()).strip(), "fs": num(inh(t, "font-size"), 16),
                "col": hexrgb(inh(t, "fill")), "align": inh(t, "text-anchor", "start"),
                "bold": inh(t, "font-weight", "") in ("bold", "700", "800", "900"),
                "tx": num(t.get("x")), "ty": num(t.get("y")),
            }
        if p["type"] == "bar":
            fills = [e for e in el.iter() if C.tag(e) in ("rect", "polygon", "path")
                     and (e.get("fill") or "").lower() not in ("", "none")]
            if fills:
                d["bar"] = {"col": hexrgb(fills[-1].get("fill"))}
        out.append(d)

    table = {"W": int(num(root.get("width"), 720)), "H": int(num(root.get("height"), 1280)),
             "dir": f"ui/{name}/", "scale": scale, "source": os.path.relpath(work, PROJECT), "parts": out}
    with open(os.path.join(dst, "uilayout.json"), "w", encoding="utf-8") as f:
        json.dump(table, f, ensure_ascii=False, indent=1)
    print(f"{name}: parts {len(out)} (dropped bg {len(dropped)}); png {len(copied)} -> {os.path.relpath(dst, PROJECT)}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: export_cocos_layout.py <work_dir> <ui_name>")
    main(sys.argv[1], sys.argv[2])
