#!/usr/bin/env python3
"""Writes assets/resources/prefabs/battle/BattleStage.prefab (the 3D arena).

Run after `enji import assets/resources/materials`:
    python3 tools/gen_stage.py && enji import assets/resources/prefabs/battle/BattleStage.prefab --project .

Everything is engine primitives (internal mesh assets) with the unlit P5
materials, plus the camera, lights, creature anchors and effect nodes. The
creature models are separate imported glTF prefabs that the game instantiates
under PlayerAnchor/Model and EnemyAnchor/Model (a prefab may not reference
another prefab).
"""
from __future__ import annotations

import math

from prefablib import (DEFAULT, Camera, DirectionalLight, MeshRenderer, N, SphereLight, SpotLight, look_euler,
                       uuid, write_prefab)

# engine internal primitive meshes (db://internal/default_file_content/mesh/*)
CUBE = "1263d74c-8167-4928-91a6-4e2672411f47@a804a"        # 1 x 1 x 1
CYL = "1263d74c-8167-4928-91a6-4e2672411f47@8abdc"         # r 0.5, h 2
SPHERE = "1263d74c-8167-4928-91a6-4e2672411f47@17020"      # r 0.5
TORUS = "1263d74c-8167-4928-91a6-4e2672411f47@40ece"
CONE = "1263d74c-8167-4928-91a6-4e2672411f47@38fd2"
QUAD = "1263d74c-8167-4928-91a6-4e2672411f47@fc873"

M = {k: uuid(f"materials/p5_{k}.mtl") for k in ("red", "black", "white", "blood", "yellow", "ink", "glow")}

# layout (world units, y up, ground at 0) — tuned so the creatures land in the HUD's stage_view band
CAM_POS = (0.0, 3.0, 9.0)
CAM_TARGET = (0.0, 0.2, 0.0)
CAM_FOV_H = 44
PLAYER = (-1.15, 0.0, 2.4)
ENEMY = (1.25, 0.0, -2.2)
CREATURE_SCALE = 1.5
PLAYER_SCALE = 1.15  # nearer to the camera, so smaller in world units


def mesh(name, mesh_uuid, mat, *, pos=(0, 0, 0), euler=(0, 0, 0), scale=(1, 1, 1), active=True, children=()):
    return N(name, pos=pos, euler=euler, scale=scale, layer=DEFAULT, active=active,
             comps=[MeshRenderer(mesh_uuid, [M[mat]])], children=children)


def group(name, children, *, pos=(0, 0, 0), euler=(0, 0, 0), scale=(1, 1, 1), active=True):
    return N(name, pos=pos, euler=euler, scale=scale, layer=DEFAULT, active=active, children=children)


def yaw_toward(src, dst):
    """glTF models face +Z; yaw (deg) that turns them from src toward dst."""
    return math.degrees(math.atan2(dst[0] - src[0], dst[2] - src[2]))


def disc(name, mat, r, h, pos, **kw):
    return mesh(name, CYL, mat, pos=pos, scale=(2 * r, h / 2, 2 * r), **kw)


def ground():
    stripes = []
    for i, (ang, mat, w) in enumerate([(12, "red", 0.9), (34, "white", 0.25), (58, "red", 0.5), (-18, "white", 0.18),
                                       (-40, "red", 0.7), (82, "white", 0.3), (-64, "red", 0.35)]):
        stripes.append(mesh(f"Stripe{i}", CUBE, mat, pos=(0, 0.012 + i * 0.001, -1), euler=(0, ang, 0),
                            scale=(w, 0.01, 30)))
    return group("Ground", [
        disc("Floor", "black", 16, 0.1, (0, -0.05, 0)),
        group("Stripes", stripes),
        disc("EnemyPad", "red", 1.55, 0.06, (ENEMY[0], 0.03, ENEMY[2])),
        disc("EnemyPadInk", "black", 1.3, 0.07, (ENEMY[0], 0.035, ENEMY[2])),
        disc("EnemyPadCore", "red", 1.12, 0.08, (ENEMY[0], 0.04, ENEMY[2])),
        disc("PlayerPad", "white", 1.45, 0.06, (PLAYER[0], 0.03, PLAYER[2])),
        disc("PlayerPadInk", "black", 1.22, 0.07, (PLAYER[0], 0.035, PLAYER[2])),
        disc("PlayerPadCore", "white", 1.05, 0.08, (PLAYER[0], 0.04, PLAYER[2])),
    ])


def backdrop():
    kids = [mesh("Wall", CUBE, "red", pos=(0, 9, -15), scale=(60, 26, 0.2))]
    for i, (y, rot, h, mat) in enumerate([(4.5, 16, 1.4, "black"), (10.5, -12, 2.2, "black"), (7.4, 16, 0.35, "white"),
                                          (13.5, 9, 0.6, "blood")]):
        kids.append(mesh(f"Slash{i}", CUBE, mat, pos=(0, y, -14.8 + i * 0.02), euler=(0, 0, rot), scale=(70, h, 0.1)))
    burst = [mesh(f"Ray{i}", CUBE, "white" if i % 2 == 0 else "yellow", pos=(0, 0, i * 0.01),
                  euler=(0, 0, i * 22.5), scale=(16, 0.28 if i % 2 == 0 else 0.14, 0.05)) for i in range(8)]
    kids.append(group("Starburst", burst, pos=(3.2, 6.8, -14.5)))
    kids.append(group("Moon", [
        mesh("Disc", CYL, "white", euler=(90, 0, 0), scale=(6.4, 0.05, 6.4)),
        mesh("Bite", CYL, "red", pos=(1.2, 0.7, 0.12), euler=(90, 0, 0), scale=(5.4, 0.05, 5.4)),
    ], pos=(-6.5, 12.0, -14.4)))
    city = []
    heights = [3.2, 5.6, 2.4, 7.0, 4.1, 2.8, 6.2, 3.6, 8.4, 2.6, 5.0, 3.0, 6.8, 4.4]
    x = -17.0
    for i, h in enumerate(heights):
        w = 1.6 + (i * 7 % 5) * 0.35
        city.append(mesh(f"Tower{i}", CUBE, "black", pos=(x + w / 2, h / 2, -11.5 - (i % 3) * 0.6), scale=(w, h, 1.2)))
        if i % 2 == 0:
            for j in range(2):
                city.append(mesh(f"Window{i}_{j}", CUBE, "yellow",
                                 pos=(x + w / 2 + (j - 0.5) * 0.5, h * (0.45 + 0.25 * j), -10.85 - (i % 3) * 0.6),
                                 scale=(0.22, 0.32, 0.05)))
        x += w + 0.25
    kids.append(group("City", city))
    kids.append(mesh("SpikeL", CONE, "black", pos=(-7.5, 0, -6), euler=(0, 0, -8), scale=(3.0, 9, 3.0)))
    kids.append(mesh("SpikeR", CONE, "black", pos=(8.0, 0, -7), euler=(0, 0, 10), scale=(3.6, 11, 3.6)))
    return group("Backdrop", kids)


def anchor(name, at, facing, pad_mat, scale=CREATURE_SCALE):
    yaw = yaw_toward(at, facing)
    return group(name, [
        disc("Shadow", "ink", 0.72 * scale / 1.5, 0.02, (0, 0.09, 0)),
        group("Model", [], scale=(scale,) * 3),
        group("FxPoint", [], pos=(0, 1.0 * scale, 0)),
    ], pos=at, euler=(0, round(yaw, 3), 0))


def effects():
    burst = []
    for i in range(8):
        a = i * 45
        burst.append(mesh(f"Spike{i}", CUBE, "white" if i % 2 == 0 else "yellow", euler=(0, 0, a),
                          pos=(0, 0, 0.01 * i), scale=(1.6 if i % 2 == 0 else 1.0, 0.16, 0.05)))
    burst.append(mesh("Core", SPHERE, "white", scale=(0.55, 0.55, 0.55)))
    card = [
        mesh("Face", CUBE, "white", scale=(0.9, 1.3, 0.04)),
        mesh("Ink", CUBE, "black", pos=(0, 0, 0.025), scale=(0.74, 1.14, 0.01)),
        mesh("Mark", CUBE, "red", pos=(0, 0.05, 0.035), euler=(0, 0, 45), scale=(0.42, 0.42, 0.01)),
        mesh("Stripe", CUBE, "red", pos=(0, -0.42, 0.035), scale=(0.74, 0.1, 0.01)),
    ]
    return group("Fx", [
        group("HitBurst", burst, active=False),
        group("Slash", [mesh("Blade", CUBE, "white", scale=(3.2, 0.12, 0.04)),
                        mesh("Edge", CUBE, "red", pos=(0, -0.1, -0.01), scale=(3.0, 0.08, 0.03))], active=False),
        group("Fireball", [mesh("Outer", SPHERE, "glow", scale=(0.7, 0.7, 0.7)),
                           mesh("Inner", SPHERE, "yellow", scale=(0.42, 0.42, 0.42))], active=False),
        group("CallingCard", card, active=False),
        mesh("ShockRing", TORUS, "red", euler=(0, 0, 0), scale=(1, 0.2, 1), active=False),
        mesh("HealRing", TORUS, "yellow", scale=(1, 0.2, 1), active=False),
    ])


def lights():
    return group("Lights", [
        N("KeyLight", pos=(-4, 8, 8), euler=look_euler((-4, 8, 8), (0, 0, 0)), layer=DEFAULT,
          comps=[DirectionalLight((255, 244, 232, 255), 60000)]),
        N("RimRed", pos=(ENEMY[0] + 1.5, 2.8, ENEMY[2] - 2.2), layer=DEFAULT,
          comps=[SphereLight((255, 40, 60, 255), 12000, size=0.4, range_=9)]),
        N("PlayerSpot", pos=(PLAYER[0] - 2, 6.5, PLAYER[2] + 3.5),
          euler=look_euler((PLAYER[0] - 2, 6.5, PLAYER[2] + 3.5), (PLAYER[0], 0.8, PLAYER[2])), layer=DEFAULT,
          comps=[SpotLight((255, 250, 235, 255), 16000, size=0.3, range_=16, angle=38)]),
    ])


def main():
    cam = N("MainCamera", pos=CAM_POS, euler=look_euler(CAM_POS, CAM_TARGET), layer=DEFAULT,
            comps=[Camera(fov=CAM_FOV_H, fov_axis=1, near=0.1, far=120, clear=(26, 4, 10, 255), clear_flags=7,
                          priority=0, visibility=DEFAULT)])
    root = group("BattleStage", [
        group("CameraRig", [cam]),
        lights(),
        ground(),
        backdrop(),
        # facing the enemy straight on would show the camera the cat's back; turn it to a 3/4 profile
        anchor("PlayerAnchor", PLAYER, (PLAYER[0] + 3, 0, PLAYER[2] + 3), "white", PLAYER_SCALE),
        anchor("EnemyAnchor", ENEMY, PLAYER, "red"),
        effects(),
    ])
    write_prefab("prefabs/battle/BattleStage.prefab", root)


if __name__ == "__main__":
    main()
