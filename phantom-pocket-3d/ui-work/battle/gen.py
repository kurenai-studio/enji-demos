"""Generate layout.svg — 怪谈口袋 3D battle HUD, region grammar v2, Persona-5 style (persona3d_battle)."""
import os
from xml.sax.saxutils import escape

C = dict(bg="#0A0A0A", base="#1A1A1A", base_dark="#050505", base_light="#2E2E2E", panel="#F5F0E8",
         panel_ink="#111111", accent="#E60012", accent_deep="#8B0000", hazard="#F5D76E", glow="#FF6B6B",
         text="#FFFFFF", text_ink="#111111", text_dim="#9A9A9A", disabled="#4A4A4A", danger="#FF2A2A")
FONT = "PingFang SC"

PREFIX = ("Persona 5 graphic battle UI, flat ink print, razor chamfers, pure black ground, crimson and warm "
          "off-white, no blur, no soft plastic, no creature art; ")

# Shared texture vocabulary (battle / bag / result screens) — fields copied verbatim from the brief.
V = {
    "comic_panel": dict(family="frame", render="nine_slice", shape="polygon", slice="20,16,20,16", tone="panel",
                        edge="hard", height="bevel", hw=4,
                        desc="off-white manga panel, razor chamfer or slash edge, thin ink grime, clean center for type"),
    "ink_plate": dict(family="frame", render="nine_slice", shape="chamfer", cut=10, slice="16,14,16,14", tone="base",
                      edge="hard", height="bevel", hw=4,
                      desc="charcoal black comic plate, razor chamfer, faint halftone dots, thin off-white keyline, "
                           "clean center for white type"),
    "lv_chip": dict(family="frame", render="nine_slice", shape="chamfer", cut=8, slice="8,8,8,8", tone="accent",
                    edge="hard", height="emboss", hw=3,
                    desc="small crimson level tag, sharp chamfer, flat ink, center clear for white level text"),
    "skill_rim": dict(family="button", render="ring_mesh", shape="chamfer", cut=14, border=6, fill="hollow",
                      layer="rim", derive="pressed=relief_invert,disabled=steel", tone="panel", edge="hard",
                      height="bevel", hw=6,
                      desc="off-white bevel rim of a skill key, sharp 14px chamfer, hard cut, printed manga outline"),
    "skill_face": dict(family="button", render="nine_slice", shape="chamfer", cut=8, slice="12,10,12,10",
                       layer="face", derive="pressed=darken,disabled=desaturate", tone="accent", edge="hard",
                       height="flat",
                       desc="flat crimson skill-key face, saturated red ink, sharp chamfer, clean center for white "
                            "move name and PP"),
    "util_rim": dict(family="button", render="ring_mesh", shape="chamfer", cut=10, border=5, fill="hollow",
                     layer="rim", derive="pressed=relief_invert,disabled=steel", tone="accent", edge="hard",
                     height="bevel", hw=5,
                     desc="crimson hard rim around a secondary key, sharp chamfer, narrow printed border"),
    "util_face": dict(family="button", render="nine_slice", shape="chamfer", cut=5, slice="12,10,12,10",
                      layer="face", derive="pressed=darken,disabled=desaturate", tone="panel", edge="hard",
                      height="flat",
                      desc="off-white secondary key face, flat manga paper, sharp chamfer, clean center for black label"),
    "bar_track": dict(family="meter", render="nine_slice", shape="chamfer", cut=3, slice="6,3,6,3", tone="base_dark",
                      edge="hard", height="engrave", hw=3,
                      desc="narrow engraved meter groove, matte charcoal, hard edges, inner lip, seamless along its length"),
    "hazard_stripe": dict(family="deco", render="nine_slice", shape="polygon", slice="8,2,8,2", tile="x",
                          tone="hazard", edge="hard", height="emboss", hw=2,
                          desc="yellow diagonal hazard stripes, hard edges, scuffed print, seamless horizontal tile, "
                               "no lettering"),
    "spike_tri": dict(family="deco", render="affine", shape="polygon", tone="accent", edge="hard", height="emboss",
                      hw=3, desc="solid crimson right triangle ornament, razor points, flat ink, mounted on a panel corner"),
    "slash_wedge": dict(family="deco", render="affine", shape="polygon", tone="accent", edge="hard", height="emboss",
                        hw=3, desc="long diagonal crimson wedge, sharp parallelogram slash, flat manga graphic, not organic"),
}


def attrs(d):
    return " ".join(f'{k}="{escape(str(v), {chr(34): "&quot;"})}"' for k, v in d.items() if v is not None)


def pts(p):
    return " ".join(f"{a:g},{b:g}" for a, b in p)


def chamfer(x, y, w, h, c):
    return pts([(x + c, y), (x + w - c, y), (x + w, y + c), (x + w, y + h - c), (x + w - c, y + h), (x + c, y + h),
                (x, y + h - c), (x, y + c)])


def g(pid, role, typ, render, box, z, body="", **kw):
    x, y, w, h = box
    a = {"id": pid, "data-role": role, "data-type": typ, "data-render": render,
         "data-x": f"{x:g}", "data-y": f"{y:g}", "data-w": f"{w:g}", "data-h": f"{h:g}", "data-z": z}
    for k, v in kw.items():
        a["data-" + k.replace("_", "-")] = v
    return f"<g {attrs(a)}>{body}</g>"


def tex(pid, role, typ, box, z, texture, body="", prio="normal", points=None, tone=None, **kw):
    """Textured part from the shared vocabulary: exactly one region shape filled with its tone colour."""
    v = dict(V[texture])
    x, y, w, h = box
    tone = tone or v.pop("tone")
    v.pop("tone", None)
    shape, render, hw, desc = v.pop("shape"), v.pop("render"), v.pop("hw", None), v.pop("desc")
    if shape == "chamfer":
        sh = f'<polygon points="{chamfer(x, y, w, h, v["cut"])}" fill="{C[tone]}"/>'
    else:
        sh = f'<polygon points="{points}" fill="{C[tone]}"/>'
    fields = dict(shape=shape, tone=tone, texture=texture, height_w=hw, priority=prio, desc=PREFIX + desc)
    fields.update(v)
    fields.update(kw)
    return g(pid, role, typ, render, box, z, sh + body, **fields)


def t(x, y, s, fs, col, anchor="start", weight="bold"):
    return (f'<text x="{x:g}" y="{y:g}" font-family="{FONT}" font-size="{fs}" fill="{C[col]}" '
            f'text-anchor="{anchor}"' + (f' font-weight="{weight}"' if weight else "") + f">{escape(s)}</text>")


def txt(pid, role, box, z, x, y, s, fs, col, anchor="start", **kw):
    return g(pid, role, "text", "program", box, z, t(x, y, s, fs, col, anchor), **kw)


def meter(pid, box, z, frac, col, bind):
    """bar_track groove + program fill (box = full-value fill area, scales left→right)."""
    x, y, w, h = box
    fx, fy, fw, fh = x + 3, y + 3, w - 6, h - 6
    fill = g(pid + "_fill", pid.split("_")[0] + "_" + pid.split("_")[1] + "_fill", "bar", "program",
             (fx, fy, fw, fh), z + 1,
             f'<rect x="{fx:g}" y="{fy:g}" width="{fw * frac:g}" height="{fh:g}" fill="{C[col]}"/>',
             bind=bind, stretch="x")
    return tex(pid, "meter", "socket", box, z, "bar_track", fill, prio="minor", stretch="x")


def skill_key(i, x, y, w, h, name, pp, mp):
    pid = f"move_{i}"
    rim = tex(pid + "_rim", "button_rim", "frame", (x, y, w, h), 5, "skill_rim", stretch="x")
    face = tex(pid + "_face", "button_face", "plate", (x + 6, y + 6, w - 12, h - 12), 6, "skill_face", stretch="x")
    label = txt(pid + "_name", "label", (x + 28, y + 16, 132, 40), 7, x + 28, y + 48, name, 30, "text",
                bind=f"moves.{i}.name:text", maxlen=4)
    ppt = txt(f"move_pp_{i}", f"move_pp_{i}", (x + w - 120, y + 14, 96, 22), 7, x + w - 26, y + 31, pp, 16, "text",
              "end", importance=2, bind=f"moves.{i}.pp:text", maxlen=6)
    mpt = txt(f"move_mp_{i}", f"move_mp_{i}", (x + w - 120, y + 38, 96, 22), 7, x + w - 26, y + 55, mp, 16, "text",
              "end", importance=2, bind=f"moves.{i}.mp:text", maxlen=6)
    return g(pid, pid, "button", "program", (x, y, w, h), 5, rim + face + label + ppt + mpt, importance=5,
             states="normal,pressed,disabled,selected", state="normal", bind=f"moves.{i}.name:text", maxlen=4,
             align="skill_l" if i % 2 == 0 else "skill_r", stretch="x")


def util_key(pid, x, y, w, h, body, **kw):
    rim = tex(pid + "_rim", "button_rim", "frame", (x, y, w, h), 5, "util_rim", stretch="x")
    face = tex(pid + "_face", "button_face", "plate", (x + 5, y + 5, w - 10, h - 10), 6, "util_face", stretch="x")
    return g(pid, pid, "button", "program", (x, y, w, h), 5, rim + face + body,
             states="normal,pressed,disabled", state="normal", **kw)


def build():
    out = []
    # ---------------------------------------------------------------- preview backdrop (dropped on export)
    out.append(g("bg", "bg", "deco", "vector", (0, 0, 720, 1280), 0,
                 f'<rect x="0" y="0" width="720" height="1280" fill="{C["bg"]}"/>'))

    # ---------------------------------------------------------------- top block: title + enemy panel
    top = []
    title = txt("title", "title", (40, 54, 200, 44), 4, 40, 88, "怪谈口袋", 32, "text", importance=3)
    top.append(tex("titlebar", "panel", "panel", (16, 48, 568, 56), 3, "ink_plate", title, stretch="x",
                   align="col_l"))
    top.append(tex("hazard_top", "deco", "deco", (16, 110, 568, 10), 3, "hazard_stripe", prio="minor",
                   points=pts([(22, 110), (584, 110), (578, 120), (16, 120)]), attach="titlebar:b", stretch="x"))
    top.append(util_key("settings", 596, 48, 108, 56,
                        g("settings_label", "label", "text", "program", (616, 60, 68, 30), 7,
                          t(650, 84, "菜单", 22, "text_ink", "middle")),
                        importance=2, align="col_r"))

    ex, ey, ew, eh = 16, 128, 688, 148
    enemy = []
    enemy.append(txt("enemy_name", "enemy_name", (44, 142, 180, 46), 4, 44, 178, "赤影狐", 34, "text_ink",
                     importance=4, bind="enemy.name:text", maxlen=5, align="name_l"))
    chip = tex("enemy_lv_chip", "badge", "badge", (232, 150, 84, 32), 4, "lv_chip",
               t(274, 172, "Lv14", 18, "text", "middle"), prio="minor")
    enemy.append(g("enemy_lv", "enemy_lv", "text", "program", (232, 150, 84, 32), 4, chip, importance=3,
                   bind="enemy.level:text", maxlen=5))
    enemy.append(txt("enemy_hp_pct", "enemy_hp_pct", (520, 136, 132, 54), 4, 650, 180, "62%", 40, "accent", "end",
                     importance=4, bind="enemy.hp:percent", maxlen=4))
    enemy.append(txt("enemy_hp_label", "label", (44, 212, 34, 24), 4, 44, 231, "HP", 16, "text_ink"))
    enemy.append(meter("enemy_hp_track", (84, 212, 420, 24), 4, 42 / 68, "accent", "enemy.hp:percent"))
    enemy.append(txt("enemy_hp", "enemy_hp", (520, 206, 164, 34), 4, 520, 233, "42 / 68", 24, "text_ink",
                     importance=4, bind="enemy.hp:ratio", maxlen=9))
    enemy.append(tex("enemy_spike", "deco", "deco", (672, 128, 32, 32), 5, "spike_tri", prio="minor",
                     points=pts([(672, 128), (704, 128), (704, 160)]), attach="enemy_panel:tr"))
    enemy.append(tex("enemy_slash", "deco", "deco", (24, 266, 180, 26), 5, "slash_wedge", prio="minor",
                     points=pts([(44, 266), (204, 266), (184, 292), (24, 292)]), attach="enemy_panel:bl"))
    top.append(tex("enemy_panel", "panel", "panel", (ex, ey, ew, eh), 3, "comic_panel", "".join(enemy), prio="hero",
                   points=pts([(40, 128), (704, 128), (704, 252), (680, 276), (16, 276), (16, 152)]),
                   stretch="x", align="panel_w"))
    out.append(g("top_block", "panel", "panel", "program", (0, 40, 720, 260), 1, "".join(top), anchor="top",
                 stretch="x"))

    # ---------------------------------------------------------------- 3D stage viewport (camera framing rect)
    out.append(g("stage_view", "stage_view", "frame", "program", (0, 300, 720, 460), 1,
                 f'<rect x="0" y="300" width="720" height="460" fill="none" stroke="{C["base_light"]}" '
                 f'stroke-width="2"/>', anchor="fill", importance=5))

    # ---------------------------------------------------------------- bottom block
    bot = []
    pl = []
    pl.append(txt("player_name", "player_name", (36, 778, 124, 40), 4, 36, 810, "墨猫", 30, "text",
                  importance=4, bind="player.name:text", maxlen=4, align="name_l"))
    chip = tex("player_lv_chip", "badge", "badge", (168, 784, 80, 30), 4, "lv_chip",
               t(208, 805, "Lv16", 18, "text", "middle"), prio="minor")
    pl.append(g("player_lv", "player_lv", "text", "program", (168, 784, 80, 30), 4, chip, importance=3,
                bind="player.level:text", maxlen=5))
    pl.append(txt("player_hp_pct", "player_hp_pct", (552, 776, 132, 46), 4, 684, 812, "87%", 34, "glow", "end",
                  importance=4, bind="player.hp:percent", maxlen=4))
    pl.append(txt("player_hp_label", "label", (36, 826, 34, 22), 4, 36, 843, "HP", 16, "text_dim"))
    pl.append(meter("player_hp_track", (76, 826, 420, 20), 4, 78 / 90, "accent", "player.hp:percent"))
    pl.append(txt("player_hp", "player_hp", (512, 820, 172, 32), 4, 512, 844, "78 / 90", 22, "text",
                  importance=4, bind="player.hp:ratio", maxlen=9, align="num_l"))
    pl.append(txt("player_mp_label", "label", (36, 854, 34, 22), 4, 36, 871, "MP", 16, "text_dim"))
    pl.append(meter("player_mp_track", (76, 856, 420, 16), 4, 24 / 30, "hazard", "player.mp:percent"))
    pl.append(txt("player_mp", "player_mp", (512, 850, 172, 28), 4, 512, 871, "24 / 30", 20, "text",
                  importance=3, bind="player.mp:ratio", maxlen=9, align="num_l"))
    bot.append(tex("player_panel", "panel", "panel", (16, 772, 688, 112), 3, "ink_plate", "".join(pl), prio="hero",
                   stretch="x", align="panel_w"))

    st = []
    st.append(tex("status_slash", "deco", "deco", (24, 898, 44, 40), 5, "slash_wedge", prio="minor",
                  points=pts([(40, 898), (68, 898), (52, 938), (24, 938)]), attach="status_bar:l"))
    st.append(txt("status", "status", (84, 900, 600, 36), 4, 84, 926, "野生的赤影狐出现了", 22, "text_ink",
                  importance=4, bind="battle.status:text", maxlen=16, anim="pulse:2"))
    bot.append(tex("status_bar", "panel", "panel", (16, 894, 688, 48), 3, "comic_panel", "".join(st),
                   points=pts([(28, 894), (704, 894), (692, 942), (16, 942)]), stretch="x", align="col_l"))

    moves = [("影爪", "PP 20", "MP 0"), ("鬼火", "PP 10", "MP 6"), ("夜啼", "PP 15", "MP 4"), ("怪谈斩", "PP 5", "MP 12")]
    sk = []
    for i, (name, pp, mp) in enumerate(moves):
        x = 16 if i % 2 == 0 else 368
        y = 952 if i < 2 else 1032
        sk.append(skill_key(i, x, y, 336, 72, name, pp, mp))
    sk.append(tex("ult_spike", "deco", "deco", (672, 1026, 32, 32), 8, "spike_tri", prio="minor",
                  points=pts([(672, 1026), (704, 1026), (704, 1058)]), attach="move_3:tr", anim="pulse:1.5"))
    bot.append(g("skill_grid", "panel", "panel", "program", (16, 952, 688, 152), 2, "".join(sk), stretch="x"))

    uy, uh = 1114, 72
    ut = []
    ut.append(util_key("bag", 16, uy, 136, uh,
                       g("bag_label", "label", "text", "program", (44, uy + 20, 80, 32), 7,
                         t(84, uy + 45, "道具", 24, "text_ink", "middle")), importance=3, align="col_l"))
    ut.append(util_key("run", 160, uy, 136, uh,
                       g("run_label", "label", "text", "program", (188, uy + 20, 80, 32), 7,
                         t(228, uy + 45, "逃跑", 24, "text_ink", "middle")), importance=3))
    ut.append(util_key("party", 304, uy, 160, uh,
                       g("party_label", "label", "text", "program", (326, uy + 22, 52, 30), 7,
                         t(376, uy + 45, "队伍", 22, "text_ink", "end"))
                       + g("party_count", "label", "text", "program", (384, uy + 20, 60, 32), 7,
                           t(384, uy + 46, "1/6", 26, "text_ink")),
                       importance=3, bind="party.count:ratio", maxlen=3))
    cx, cw = 472, 232
    catch_rim = tex("catch_rim", "button_rim", "frame", (cx, uy, cw, uh), 5, "skill_rim", stretch="x")
    catch_face = tex("catch_face", "button_face", "plate", (cx + 6, uy + 6, cw - 12, uh - 12), 6, "skill_face",
                     stretch="x")
    catch_label = g("catch_label", "label", "text", "program", (cx + 76, uy + 16, 80, 42), 7,
                    t(cx + cw / 2, uy + 48, "捕捉", 34, "text", "middle"))
    ut.append(g("catch", "catch", "button", "program", (cx, uy, cw, uh), 5, catch_rim + catch_face + catch_label,
                importance=4, states="normal,pressed,disabled", state="normal", align="col_r", anim="pulse:2"))
    ut.append(tex("hazard_bottom", "deco", "deco", (16, 1198, 688, 12), 3, "hazard_stripe", prio="minor",
                  points=pts([(22, 1198), (704, 1198), (698, 1210), (16, 1210)]), attach="util_row:b", stretch="x"))
    bot.append(g("util_row", "panel", "panel", "program", (16, uy, 688, 96), 2, "".join(ut), stretch="x"))

    out.append(g("bottom_block", "panel", "panel", "program", (0, 760, 720, 480), 1, "".join(bot), anchor="bottom",
                 stretch="x"))

    return ('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280" '
            'data-style="persona3d_battle" data-light="-0.3,-0.8">'
            "<title>怪谈口袋 3D 战斗 HUD 区域稿</title>" + "".join(out) + "</svg>")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "layout.svg"), "w", encoding="utf-8") as f:
        f.write(build())
    print("wrote layout.svg")
