"""Tiny Cocos Creator 3.8 prefab writer shared by the gen_*.py scripts.

Describe the tree with N(...) and component helpers, then `write_prefab(path, root)`.
Every node gets cc.PrefabInfo, every component cc.CompPrefabInfo, `__id__`s are
assigned here. Node references inside components are written as
`{"__node__": "<path from root>"}` and resolved at the end; a value
`{"__obj__": {...}}` becomes its own array element (e.g. ModelBakeSettings).
Field names follow engine-saved 3.8 files (see README "Prefabs").
"""
from __future__ import annotations

import hashlib
import json
import math
import os

UI2D = 33554432
DEFAULT = 1073741824
WHITE = (255, 255, 255, 255)

PROJECT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
RES = os.path.join(PROJECT, "assets", "resources")


# ------------------------------------------------------------------ uuids
def meta(rel: str) -> dict:
    p = os.path.join(RES, rel + ".meta")
    if not os.path.isfile(p):
        raise SystemExit(f"missing {p}: run `enji import` on the asset first")
    return json.load(open(p, encoding="utf-8"))


def uuid(rel: str) -> str:
    return meta(rel)["uuid"]


def sprite_frame(rel: str) -> str:
    return meta(rel)["subMetas"]["f9941"]["uuid"]


# ------------------------------------------------------------------ value helpers
def V2(x, y):
    return {"__type__": "cc.Vec2", "x": x, "y": y}


def V3(v):
    return {"__type__": "cc.Vec3", "x": v[0], "y": v[1], "z": v[2]}


def COL(c):
    c = tuple(c) + (255,) * (4 - len(c))
    return {"__type__": "cc.Color", "r": c[0], "g": c[1], "b": c[2], "a": c[3]}


def SIZE(w, h):
    return {"__type__": "cc.Size", "width": w, "height": h}


def euler_to_quat(x, y, z):
    """Same formula as cc.Quat.fromEuler (degrees, YZX order)."""
    h = math.pi / 360
    x, y, z = x * h, y * h, z * h
    sx, cx, sy, cy, sz, cz = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
    return [sx * cy * cz + cx * sy * sz, cx * sy * cz + sx * cy * sz,
            cx * cy * sz - sx * sy * cz, cx * cy * cz - sx * sy * sz]


def look_euler(eye, target):
    """Euler (deg) that points a Cocos camera / light (-Z forward) from eye to target."""
    dx, dy, dz = target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]
    yaw = math.degrees(math.atan2(-dx, -dz))
    pitch = math.degrees(math.atan2(dy, math.hypot(dx, dz)))
    return (round(pitch, 4), round(yaw, 4), 0)


# ------------------------------------------------------------------ tree
def N(name, *, pos=(0, 0, 0), euler=(0, 0, 0), scale=(1, 1, 1), layer=UI2D, active=True,
      ui=None, comps=(), children=()):
    """ui = (w, h) or (w, h, ax, ay) adds a UITransform."""
    return dict(name=name, pos=list(pos), euler=list(euler), scale=list(scale), layer=layer,
                active=active, ui=ui, comps=list(comps), children=list(children))


def Sprite(frame_uuid, *, sliced=False, color=WHITE, size_mode=0, trim=True):
    return {"__type__": "cc.Sprite", "_customMaterial": None, "_srcBlendFactor": 2, "_dstBlendFactor": 4,
            "_color": COL(color), "_spriteFrame": {"__uuid__": frame_uuid, "__expectedType__": "cc.SpriteFrame"},
            "_type": 1 if sliced else 0, "_fillType": 0, "_sizeMode": size_mode,
            "_fillCenter": V2(0, 0), "_fillStart": 0, "_fillRange": 0, "_isTrimmedMode": trim,
            "_useGrayscale": False, "_atlas": None}


H_ALIGN = {"start": 0, "left": 0, "middle": 1, "center": 1, "end": 2, "right": 2}


def Label(text, fs, *, color=WHITE, bold=True, h="middle", v=1, overflow=2, line_height=None,
          outline=None):
    """overflow: 0 NONE, 1 CLAMP, 2 SHRINK, 3 RESIZE_HEIGHT. Fixed boxes use SHRINK."""
    c = {"__type__": "cc.Label", "_customMaterial": None, "_srcBlendFactor": 2, "_dstBlendFactor": 4,
         "_color": COL(color), "_string": text, "_horizontalAlign": H_ALIGN.get(h, h),
         "_verticalAlign": v, "_actualFontSize": fs, "_fontSize": fs, "_fontFamily": "Arial",
         "_lineHeight": line_height or round(fs * 1.2), "_overflow": overflow, "_enableWrapText": False,
         "_font": None, "_isSystemFontUsed": True, "_spacingX": 0, "_isItalic": False, "_isBold": bold,
         "_isUnderline": False, "_underlineHeight": 2, "_cacheMode": 0,
         "_enableOutline": bool(outline), "_outlineColor": COL(outline[0] if outline else (0, 0, 0, 255)),
         "_outlineWidth": outline[1] if outline else 2, "_enableShadow": False,
         "_shadowColor": COL((0, 0, 0, 255)), "_shadowOffset": V2(2, 2), "_shadowBlur": 2}
    return c


def Button(target_path, *, transition=3, zoom=0.94):
    """transition 3 = SCALE. target is a node path relative to the prefab root."""
    return {"__type__": "cc.Button", "clickEvents": [], "_interactable": True, "_transition": transition,
            "_normalColor": COL(WHITE), "_hoverColor": COL((211, 211, 211, 255)), "_pressedColor": COL(WHITE),
            "_disabledColor": COL((124, 124, 124, 255)), "_normalSprite": None, "_hoverSprite": None,
            "_pressedSprite": None, "_disabledSprite": None, "_duration": 0.08, "_zoomScale": zoom,
            "_target": {"__node__": target_path}}


W_TOP, W_MID, W_BOT, W_LEFT, W_CENTER, W_RIGHT = 1, 2, 4, 8, 16, 32


def Widget(flags, *, left=0, right=0, top=0, bottom=0, hcenter=0, vcenter=0, mode=2):
    """flags: OR of W_*; mode 2 = ON_WINDOW_RESIZE. Offsets are in the parent's units."""
    return {"__type__": "cc.Widget", "_alignFlags": flags, "_target": None, "_left": left, "_right": right,
            "_top": top, "_bottom": bottom, "_horizontalCenter": hcenter, "_verticalCenter": vcenter,
            "_isAbsLeft": True, "_isAbsRight": True, "_isAbsTop": True, "_isAbsBottom": True,
            "_isAbsHorizontalCenter": True, "_isAbsVerticalCenter": True, "_originalWidth": 0,
            "_originalHeight": 0, "_alignMode": mode, "_lockFlags": 0}


def BlockInputEvents():
    return {"__type__": "cc.BlockInputEvents"}


def UIOpacity(opacity=255):
    return {"__type__": "cc.UIOpacity", "_opacity": opacity}


def MeshRenderer(mesh_uuid, mat_uuids, *, cast=False, receive=True):
    return {"__type__": "cc.MeshRenderer",
            "_materials": [{"__uuid__": u, "__expectedType__": "cc.Material"} for u in mat_uuids],
            "_visFlags": 0,
            "bakeSettings": {"__obj__": {"__type__": "cc.ModelBakeSettings", "texture": None,
                                         "uvParam": {"__type__": "cc.Vec4", "x": 0, "y": 0, "z": 0, "w": 0},
                                         "_bakeable": False, "_castShadow": cast, "_receiveShadow": receive,
                                         "_recieveShadow": receive, "_lightmapSize": 64, "_useLightProbe": False,
                                         "_bakeToLightProbe": True, "_reflectionProbeType": 0,
                                         "_bakeToReflectionProbe": True}},
            "_mesh": {"__uuid__": mesh_uuid, "__expectedType__": "cc.Mesh"},
            "_shadowCastingMode": 1 if cast else 0, "_shadowReceivingMode": 1 if receive else 0,
            "_shadowBias": 0, "_shadowNormalBias": 0, "_reflectionProbeId": -1,
            "_reflectionProbeBlendId": -1, "_reflectionProbeBlendWeight": 0,
            "_enabledGlobalStandardSkinObject": False, "_enableMorph": True}


def Camera(*, fov=45, fov_axis=0, near=0.1, far=200, clear=(20, 4, 8, 255), clear_flags=7,
           priority=0, visibility=DEFAULT, projection=1, ortho_height=10):
    """clear_flags: 7 SOLID_COLOR, 14 SKYBOX, 6 DEPTH_ONLY. projection 1 = PERSPECTIVE."""
    return {"__type__": "cc.Camera", "_projection": projection, "_priority": priority, "_fov": fov,
            "_fovAxis": fov_axis, "_orthoHeight": ortho_height, "_near": near, "_far": far,
            "_color": COL(clear), "_depth": 1, "_stencil": 0, "_clearFlags": clear_flags,
            "_rect": {"__type__": "cc.Rect", "x": 0, "y": 0, "width": 1, "height": 1},
            "_aperture": 19, "_shutter": 7, "_iso": 0, "_screenScale": 1, "_visibility": visibility,
            "_targetTexture": None, "_postProcess": None, "_usePostProcess": False, "_cameraType": -1,
            "_trackingType": 0}


def _light_common(color):
    return {"_color": COL(color), "_useColorTemperature": False, "_colorTemperature": 6550,
            "_staticSettings": {"__type__": "cc.StaticLightSettings", "_baked": False, "_editorOnly": False,
                                "_castShadow": False},
            "_visibility": -325058561}


def DirectionalLight(color, illuminance, *, shadow=False):
    # runtime reads the legacy `_illuminance`; write both names
    return {"__type__": "cc.DirectionalLight", **_light_common(color), "_illuminanceHDR": illuminance,
            "_illuminance": illuminance, "_illuminanceLDR": illuminance / 38400, "_shadowEnabled": shadow}


def SphereLight(color, luminance, *, size=0.3, range_=8):
    return {"__type__": "cc.SphereLight", **_light_common(color), "_size": size, "_luminanceHDR": luminance,
            "_luminance": luminance, "_luminanceLDR": luminance / 3.84, "_term": 0, "_range": range_}


def SpotLight(color, luminance, *, size=0.2, range_=14, angle=40):
    return {"__type__": "cc.SpotLight", **_light_common(color), "_size": size, "_luminanceHDR": luminance,
            "_luminance": luminance, "_luminanceLDR": luminance / 3.84, "_term": 0, "_range": range_,
            "_spotAngle": angle, "_angleAttenuationStrength": 0, "_shadowEnabled": False}


# ------------------------------------------------------------------ serializer
def _fid(seed: str) -> str:
    return hashlib.sha1(seed.encode()).hexdigest()[:22]


def build(root: dict) -> list:
    arr = [{"__type__": "cc.Prefab", "_name": root["name"], "_objFlags": 0, "__editorExtras__": {}, "_native": "",
            "data": {"__id__": 1}, "optimizationPolicy": 0, "persistent": False}]
    paths = {}
    fixups = []

    def put_obj(v):
        if isinstance(v, dict):
            if "__obj__" in v:
                idx = len(arr)
                arr.append(None)
                arr[idx] = {k: put_obj(x) for k, x in v["__obj__"].items()}
                return {"__id__": idx}
            if "__node__" in v:
                ref = {"__node__": v["__node__"]}
                fixups.append(ref)
                return ref
            return {k: put_obj(x) for k, x in v.items()}
        if isinstance(v, list):
            return [put_obj(x) for x in v]
        return v

    def emit(n, path, parent_id):
        if path in paths:
            raise SystemExit(f"duplicate node path {path}")
        nid = len(arr)
        arr.append(None)
        paths[path] = nid
        comps = []
        all_comps = list(n["comps"])
        if n["ui"] is not None:
            w, h, *anc = n["ui"]
            ax, ay = anc if anc else (0.5, 0.5)
            all_comps.insert(0, {"__type__": "cc.UITransform", "_contentSize": SIZE(w, h), "_anchorPoint": V2(ax, ay)})
        for i, c in enumerate(all_comps):
            cid = len(arr)
            arr.append(None)
            body = {"__type__": c["__type__"], "_name": "", "_objFlags": 0, "__editorExtras__": {},
                    "node": {"__id__": nid}, "_enabled": True, "__prefab": {"__id__": cid + 1}}
            arr.append({"__type__": "cc.CompPrefabInfo", "fileId": _fid(f"{path}#{i}{c['__type__']}")})
            for k, v in c.items():
                if k != "__type__":
                    body[k] = put_obj(v)
            body["_id"] = ""
            arr[cid] = body
            comps.append({"__id__": cid})
        pid = len(arr)
        arr.append({"__type__": "cc.PrefabInfo", "root": {"__id__": 1}, "asset": {"__id__": 0},
                    "fileId": _fid(path or "<root>")})
        kids = []
        for c in n["children"]:
            kids.append({"__id__": emit(c, f"{path}/{c['name']}" if path else c["name"], nid)})
        q = euler_to_quat(*n["euler"])
        arr[nid] = {"__type__": "cc.Node", "_name": n["name"], "_objFlags": 0, "__editorExtras__": {},
                    "_parent": {"__id__": parent_id} if parent_id is not None else None,
                    "_children": kids, "_active": n["active"], "_components": comps,
                    "_prefab": {"__id__": pid}, "_lpos": V3(n["pos"]),
                    "_lrot": {"__type__": "cc.Quat", "x": q[0], "y": q[1], "z": q[2], "w": q[3]},
                    "_lscale": V3(n["scale"]), "_mobility": 0, "_layer": n["layer"],
                    "_euler": V3(n["euler"]), "_id": ""}
        return nid

    emit(root, "", None)
    for ref in fixups:
        p = ref.pop("__node__")
        if p not in paths:
            raise SystemExit(f"unresolved node ref {p}")
        ref["__id__"] = paths[p]
    return arr


def count_nodes(n) -> int:
    return 1 + sum(count_nodes(c) for c in n["children"])


def write_prefab(rel_path: str, root: dict) -> str:
    out = os.path.join(RES, rel_path)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    arr = build(root)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(arr, f, ensure_ascii=False, indent=1)
    print(f"{rel_path}: nodes={count_nodes(root)} objects={len(arr)}")
    return out
