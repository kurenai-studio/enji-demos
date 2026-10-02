#!/usr/bin/env python3
"""Compare runtime prefab dumps (tools/dump_prefabs.mjs) with what the generators meant.

    python3 tools/verify_dumps.py [dump_dir]     (default tools/dumps) -> prints + writes <dump_dir>/SUMMARY.md

Per prefab:
  1. file vs runtime: every node in the .prefab JSON exists at runtime with the same transform, active flag,
     layer, UITransform and component types / key fields (frames, colours, label text, mesh, materials,
     camera, lights);
  2. intent: UI prefabs against uilayout.json (one node per part, design-space centre and size, baked frame
     for the part's state, layout text); BattleStage against gen_stage.py's constants;
  3. rules: no nested prefab instances, no script components, nothing outside cc.*.
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from prefablib import RES  # noqa: E402
import gen_stage as GS  # noqa: E402

EPS = 0.02


def close(a, b, eps=EPS):
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(close(x, y, eps) for x, y in zip(a, b))
    return abs(float(a) - float(b)) <= eps * max(1.0, abs(float(b)))


def load_prefab(rel):
    arr = json.load(open(os.path.join(RES, rel + ".prefab"), encoding="utf-8"))
    nodes = {}

    def walk(i, path):
        n = arr[i]
        nodes[path] = (n, [arr[c["__id__"]] for c in n["_components"]])
        for c in n["_children"]:
            ch = arr[c["__id__"]]
            walk(c["__id__"], f"{path}/{ch['_name']}" if path else ch["_name"])

    walk(1, "")
    return arr, nodes


def comp_expect(c):
    t = c["__type__"]
    e = {"type": t}
    if t == "cc.Sprite":
        e.update(frame=c["_spriteFrame"]["__uuid__"], spriteType=c["_type"], color=[c["_color"][k] for k in "rgba"])
    elif t == "cc.Label":
        e.update(string=c["_string"], fontSize=c["_fontSize"])
    elif t == "cc.MeshRenderer":
        e.update(mesh=c["_mesh"]["__uuid__"], materials=[m["__uuid__"] for m in c["_materials"]])
    elif t == "cc.Camera":
        e.update(fov=c["_fov"], fovAxis=c["_fovAxis"], clearFlags=c["_clearFlags"], visibility=c["_visibility"],
                 priority=c["_priority"], projection=c["_projection"])
    elif t == "cc.DirectionalLight":
        e.update(illuminance=c["_illuminance"])
    elif t in ("cc.SphereLight", "cc.SpotLight"):
        e.update(luminance=c["_luminance"])
    return e


def comp_actual_ok(exp, act):
    for k, v in exp.items():
        if k == "type":
            continue
        a = act.get(k)
        if k == "materials":
            a = [m.get("uuid") for m in (a or [])]
        if a is None:
            if k in ("luminance", "illuminance") and act.get(k + "HDR") is not None:
                a = act[k + "HDR"]
            else:
                return f"{k}: missing at runtime"
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            if not close(a, v):
                return f"{k}: file {v} runtime {a}"
        elif a != v:
            return f"{k}: file {v!r} runtime {a!r}"
    return None


def file_vs_runtime(rel, rows):
    arr, nodes = load_prefab(rel)
    by_path = {r["path"]: r for r in rows}
    issues = []
    for path, (n, comps) in nodes.items():
        r = by_path.get(path)
        if r is None:
            issues.append(f"{path or '<root>'}: missing at runtime")
            continue
        pos = [n["_lpos"][k] for k in "xyz"]
        if not close(r["pos"], pos):
            issues.append(f"{path}: pos file {pos} runtime {r['pos']}")
        sc = [n["_lscale"][k] for k in "xyz"]
        if not close(r["scale"], sc):
            issues.append(f"{path}: scale file {sc} runtime {r['scale']}")
        q = [n["_lrot"][k] for k in "xyzw"]
        if not close(r["quat"], q, 0.002):
            issues.append(f"{path}: rotation file {q} runtime {r['quat']}")
        if r["active"] != n["_active"] or r["layer"] != n["_layer"]:
            issues.append(f"{path}: active/layer file {n['_active']}/{n['_layer']} runtime {r['active']}/{r['layer']}")
        act = {c["type"]: c for c in r["comps"]}
        for c in comps:
            if c["__type__"] == "cc.UITransform":
                ui = r.get("ui") or {}
                want = [c["_contentSize"]["width"], c["_contentSize"]["height"], c["_anchorPoint"]["x"], c["_anchorPoint"]["y"]]
                if not close([ui.get("w"), ui.get("h"), ui.get("ax"), ui.get("ay")], want):
                    issues.append(f"{path}: UITransform file {want} runtime {ui}")
                continue
            e = comp_expect(c)
            a = act.get(e["type"])
            if a is None:
                if e["type"] not in ("cc.Button", "cc.Widget", "cc.BlockInputEvents"):
                    issues.append(f"{path}: {e['type']} missing at runtime")
                continue
            msg = comp_actual_ok(e, a)
            if msg:
                issues.append(f"{path}: {e['type']} {msg}")
    rules = []
    types = {o.get("__type__") for o in arr if isinstance(o, dict)}
    if "cc.PrefabInstance" in types or any(
            isinstance(o, dict) and any(isinstance(v, dict) and v.get("__expectedType__") == "cc.Prefab" for v in o.values())
            for o in arr):
        rules.append("nested prefab reference")
    bad = sorted(t for t in types if t and not t.startswith("cc."))
    if bad:
        rules.append(f"non-engine types {bad}")
    return len(nodes), issues, rules


def ui_intent(ui_name, rows):
    L = json.load(open(os.path.join(RES, "ui", ui_name, "uilayout.json"), encoding="utf-8"))
    S = L["scale"]
    by_path = {r["path"]: r for r in rows}
    world = {"": (0.0, 0.0)}  # root centre = design centre, 2x units
    for r in sorted(rows, key=lambda r: r["path"].count("/")):
        if r["path"] == "":
            continue
        par = r["path"].rsplit("/", 1)[0] if "/" in r["path"] else ""
        px, py = world[par]
        world[r["path"]] = (px + r["pos"][0], py + r["pos"][1])
    parents = {p["id"]: p["parent"] for p in L["parts"]}

    def path_of(pid):
        chain = []
        while pid:
            chain.append(pid)
            pid = parents[pid]
        return "/".join(reversed(chain))

    issues, checked = [], 0
    for p in L["parts"]:
        path = path_of(p["id"])
        r = by_path.get(path)
        if r is None:
            issues.append(f"{p['id']}: no node at {path}")
            continue
        checked += 1
        wx, wy = world[path]
        if p["type"] == "bar":
            want = (p["x"] * S - L["W"] * S / 2, L["H"] * S / 2 - (p["y"] + p["h"] / 2) * S)
            size = (p["w"] * S, p["h"] * S)
        else:
            want = ((p["x"] + p["w"] / 2) * S - L["W"] * S / 2, L["H"] * S / 2 - (p["y"] + p["h"] / 2) * S)
            pad = 2 * p.get("pad", 0) if p.get("img") else 0
            size = (p["w"] * S + pad, p["h"] * S + pad)
        if not (close(wx, want[0], 0.002) and close(wy, want[1], 0.002)):
            issues.append(f"{p['id']}: centre {wx:.1f},{wy:.1f} layout {want[0]:.1f},{want[1]:.1f}")
        ui = r.get("ui") or {}
        if not close([ui.get("w"), ui.get("h")], list(size), 0.002):
            issues.append(f"{p['id']}: size {ui.get('w')}x{ui.get('h')} layout {size}")
        comps = {c["type"]: c for c in r["comps"]}
        if p.get("img"):
            sp = comps.get("cc.Sprite")
            st = p.get("state") or "normal"
            fn = p["img"].get(st) or p["img"]["normal"]
            meta = json.load(open(os.path.join(RES, "ui", ui_name, fn + ".meta")))
            if not sp or sp["frame"] != meta["subMetas"]["f9941"]["uuid"]:
                issues.append(f"{p['id']}: sprite frame is not {fn}")
            elif sp["spriteType"] != (1 if p.get("kind") == "nine_slice" else 0):
                issues.append(f"{p['id']}: sprite type {sp['spriteType']} for kind {p.get('kind')}")
        if p["type"] == "button" and "cc.Button" not in comps:
            issues.append(f"{p['id']}: button part without cc.Button")
        t = (p.get("text") or {}).get("s")
        if t:
            lab = comps.get("cc.Label") or next((c for c in by_path.get(path + "/Text", {}).get("comps", [])
                                                  if c["type"] == "cc.Label"), None)
            if not lab or lab.get("string") != t:
                issues.append(f"{p['id']}: label {lab and lab.get('string')!r} layout {t!r}")
    return checked, len(L["parts"]), issues


def stage_intent(rows):
    by = {r["path"]: r for r in rows}
    issues = []

    def comp(path, t):
        r = by.get(path)
        return next((c for c in (r or {}).get("comps", []) if c["type"] == t), None)

    cam = comp("CameraRig/MainCamera", "cc.Camera")
    if not cam or cam["projection"] != 1 or not close(cam["fov"], GS.CAM_FOV_H) or cam["fovAxis"] != 1:
        issues.append(f"camera not perspective / fov {GS.CAM_FOV_H} horizontal: {cam}")
    if not close(by["CameraRig/MainCamera"]["pos"], list(GS.CAM_POS)):
        issues.append("camera position")
    if not comp("Lights/KeyLight", "cc.DirectionalLight"):
        issues.append("no directional key light")
    if not (comp("Lights/RimRed", "cc.SphereLight") and comp("Lights/PlayerSpot", "cc.SpotLight")):
        issues.append("accent lights missing")
    for name, at in (("PlayerAnchor", GS.PLAYER), ("EnemyAnchor", GS.ENEMY)):
        if not close(by[name]["pos"], list(at)):
            issues.append(f"{name} position")
        for k in ("Model", "FxPoint", "Shadow"):
            if f"{name}/{k}" not in by:
                issues.append(f"{name}/{k} missing")
    for fx in ("HitBurst", "Slash", "Fireball", "CallingCard", "ShockRing", "HealRing"):
        r = by.get(f"Fx/{fx}")
        if not r or r["active"]:
            issues.append(f"Fx/{fx} missing or active")
    meshes = sum(1 for r in rows for c in r["comps"] if c["type"] == "cc.MeshRenderer")
    return meshes, issues


def main(d):
    out = ["# Prefab runtime dumps vs intent", "",
           "Generated by `python3 tools/verify_dumps.py` from the `*.dump.json` files next to this summary "
           "(`node tools/dump_prefabs.mjs tools/dumps <prefab>...`).", ""]
    ok_all = True
    for rel, kind in (("prefabs/battle/BattleStage", "stage"), ("prefabs/ui/BattleHud", "battle"),
                      ("prefabs/ui/BagDialog", "bag"), ("prefabs/ui/ResultDialog", "result")):
        name = rel.split("/")[-1]
        dump = json.load(open(os.path.join(d, name + ".dump.json"), encoding="utf-8"))
        rows = dump["rows"]
        n, issues, rules = file_vs_runtime(rel, rows)
        if kind == "stage":
            meshes, intent = stage_intent(rows)
            intent_line = f"stage intent ({meshes} mesh renderers, camera, lights, anchors, fx): " + (
                "OK" if not intent else f"{len(intent)} issue(s)")
        else:
            checked, total, intent = ui_intent(kind, rows)
            intent_line = f"layout intent ({checked}/{total} parts: centre, size, frame, 9-slice type, text, button): " + (
                "OK" if not intent else f"{len(intent)} issue(s)")
        errs = dump.get("errors", [])
        ok = not issues and not intent and not rules and not errs and dump["nodeCount"] == n
        ok_all &= ok
        out += [f"## {name} — {'OK' if ok else 'MISMATCH'}", "",
                f"- nodes: file {n}, runtime {dump['nodeCount']}",
                f"- file vs runtime (transform, layer, UITransform, component fields): "
                + ("OK" if not issues else f"{len(issues)} issue(s)"),
                f"- {intent_line}",
                f"- rules (no nested prefab, cc.* components only): " + ("OK" if not rules else "; ".join(rules)),
                f"- console errors while loading: {len(errs)}", ""]
        for i in (issues + intent + rules + errs)[:30]:
            out.append(f"  - {i}")
        if issues or intent or rules or errs:
            out.append("")
    text = "\n".join(out)
    open(os.path.join(d, "SUMMARY.md"), "w", encoding="utf-8").write(text + "\n")
    print(text)
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "dumps")))
