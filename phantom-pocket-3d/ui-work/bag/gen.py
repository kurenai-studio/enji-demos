"""Generate layout.svg — 怪谈口袋 3D：道具袋模态弹窗, region grammar v2, Persona 5 style."""
import os
from xml.sax.saxutils import escape

C = dict(bg="#0A0A0A", base="#1A1A1A", base_dark="#050505", base_light="#2E2E2E", panel="#F5F0E8",
         panel_ink="#111111", accent="#E60012", accent_deep="#8B0000", hazard="#F5D76E", glow="#FF6B6B",
         text="#FFFFFF", text_ink="#111111", text_dim="#9A9A9A", disabled="#4A4A4A", danger="#FF2A2A")
FONT = "PingFang SC"

PRE = ("Persona 5 graphic battle UI, flat ink print, razor chamfers, pure black ground, crimson and warm "
       "off-white, no blur, no soft plastic, no creature art; ")
D = dict(
    comic_panel=PRE + "off-white manga panel, razor chamfer or slash edge, thin ink grime, clean center for type",
    ink_plate=PRE + "charcoal black comic plate, razor chamfer, faint halftone dots, thin off-white keyline, "
                    "clean center for white type",
    lv_chip=PRE + "small crimson level tag, sharp chamfer, flat ink, center clear for white level text",
    skill_rim=PRE + "off-white bevel rim of a skill key, sharp 14px chamfer, hard cut, printed manga outline",
    skill_face=PRE + "flat crimson skill-key face, saturated red ink, sharp chamfer, clean center for white move "
                     "name and PP",
    util_rim=PRE + "crimson hard rim around a secondary key, sharp chamfer, narrow printed border",
    util_face=PRE + "off-white secondary key face, flat manga paper, sharp chamfer, clean center for black label",
    hazard_stripe=PRE + "yellow diagonal hazard stripes, hard edges, scuffed print, seamless horizontal tile, "
                        "no lettering",
    spike_tri=PRE + "solid crimson right triangle ornament, razor points, flat ink, mounted on a panel corner",
    slash_wedge=PRE + "long diagonal crimson wedge, sharp parallelogram slash, flat manga graphic, not organic",
)


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


def tex(pid, role, typ, render, box, z, shape, tone, texture, family, edge, height, prio, body="",
        hw=None, cut=None, points=None, **kw):
    """Textured part: exactly one region shape filled with its tone colour."""
    x, y, w, h = box
    if shape == "chamfer":
        sh = f'<polygon points="{chamfer(x, y, w, h, cut)}" fill="{C[tone]}"/>'
    else:
        sh = f'<polygon points="{pts(points)}" fill="{C[tone]}"/>'
    return g(pid, role, typ, render, box, z, sh + body, shape=shape, cut=cut, tone=tone, texture=texture,
             family=family, edge=edge, height=height, height_w=hw, priority=prio, desc=D[texture], **kw)


def t(x, y, s, fs, col, anchor="start", weight=None):
    return (f'<text x="{x:g}" y="{y:g}" font-family="{FONT}" font-size="{fs}" fill="{C[col]}" '
            f'text-anchor="{anchor}"' + (f' font-weight="{weight}"' if weight else "") + f">{escape(s)}</text>")


# ------------------------------------------------------------------ layered buttons
def use_key(pid, role, x, y, w, h, label, bind, state="normal"):
    bd = 6
    rim = tex(pid + "_rim", "deco", "frame", "ring_mesh", (x, y, w, h), 5, "chamfer", "panel", "skill_rim",
              "button", "hard", "bevel", "normal", hw=6, cut=14, border=bd, fill="hollow", layer="rim",
              stretch="x", derive="pressed=relief_invert,disabled=steel")
    face = tex(pid + "_face", "deco", "plate", "nine_slice", (x + bd, y + bd, w - 2 * bd, h - 2 * bd), 6,
               "chamfer", "accent", "skill_face", "button", "hard", "flat", "normal", cut=8,
               slice="12,10,12,10", layer="face", stretch="x", derive="pressed=darken,disabled=desaturate")
    fs = 28
    txt = g(pid + "_label", "label", "text", "program", (x + 20, y + h / 2 - 18, w - 40, 36), 7,
            t(x + w / 2, y + h / 2 + fs * 0.36, label, fs, "text", "middle", "bold"))
    return g(pid, role, "button", "program", (x, y, w, h), 5, rim + face + txt, importance=5,
             states="normal,pressed,disabled", state=state, bind=bind, maxlen=4, align="col_use", stretch="none")


def close_key(pid, x, y, w, h):
    bd = 5
    rim = tex(pid + "_rim", "deco", "frame", "ring_mesh", (x, y, w, h), 5, "chamfer", "accent", "util_rim",
              "button", "hard", "bevel", "normal", hw=5, cut=10, border=bd, fill="hollow", layer="rim",
              stretch="x", derive="pressed=relief_invert,disabled=steel")
    face = tex(pid + "_face", "deco", "plate", "nine_slice", (x + bd, y + bd, w - 2 * bd, h - 2 * bd), 6,
               "chamfer", "panel", "util_face", "button", "hard", "flat", "normal", cut=5,
               slice="12,10,12,10", layer="face", stretch="x", derive="pressed=darken,disabled=desaturate")
    fs = 26
    txt = g(pid + "_label", "label", "text", "program", (x + 40, y + h / 2 - 17, w - 80, 34), 7,
            t(x + w / 2, y + h / 2 + fs * 0.36, "关闭", fs, "text_ink", "middle", "bold"))
    return g(pid, "bag_close", "button", "program", (x, y, w, h), 5, rim + face + txt, importance=3,
             states="normal,pressed", state="normal", bind="bag.close_label:text", maxlen=4, align="center",
             stretch="none")


# ------------------------------------------------------------------ item rows
ITEMS = [("伤药", "回复 30 HP", "×3"), ("灵露", "回复 10 MP", "×2")]
RX, RH, RG, RY0 = 96, 120, 20, 500
PANEL_R = 490          # top-right x of the slashed row panel
KEY_X, KEY_W, KEY_H = 488, 140, 72


def item_row(i, name, desc, count):
    y = RY0 + i * (RH + RG)
    pid = f"item_row_{i}"
    body = []
    panel = [(RX, y), (PANEL_R, y), (PANEL_R - 30, y + RH), (RX + 20, y + RH), (RX, y + RH - 20)]
    body.append(tex(pid + "_panel", "panel", "panel", "nine_slice", (RX, y, PANEL_R - RX, RH), 3, "polygon",
                    "panel", "comic_panel", "frame", "hard", "bevel", "normal", hw=4, points=panel,
                    slice="20,16,20,16", stretch="x", align="rows"))
    body.append(g(f"item_name_{i}", f"item_name_{i}", "text", "program", (120, y + 16, 124, 40), 4,
                  t(120, y + 48, name, 30, "text_ink", weight="bold"),
                  importance=4, bind=f"items[{i}].name:text", maxlen=4, align="col_left"))
    chip_x, chip_y, chip_w, chip_h = 258, y + 18, 72, 36
    chip = tex(f"item_count_{i}_chip", "badge", "badge", "nine_slice", (chip_x, chip_y, chip_w, chip_h), 4,
               "chamfer", "accent", "lv_chip", "frame", "hard", "emboss", "minor", hw=3, cut=8,
               slice="8,8,8,8", stretch="x")
    ctxt = t(chip_x + chip_w / 2, chip_y + chip_h / 2 + 22 * 0.36, count, 22, "text", "middle", "bold")
    body.append(g(f"item_count_{i}", f"item_count_{i}", "text", "program", (chip_x, chip_y, chip_w, chip_h), 4,
                  chip + ctxt, importance=4, bind=f"items[{i}].count:text", maxlen=4, align="col_count"))
    body.append(g(f"item_desc_{i}", f"item_desc_{i}", "text", "program", (120, y + 68, 300, 32), 4,
                  t(120, y + 93, desc, 22, "text_ink"),
                  importance=3, bind=f"items[{i}].desc:text", maxlen=12, align="col_left"))
    body.append(use_key(f"item_use_{i}", f"item_use_{i}", KEY_X, y + (RH - KEY_H) / 2, KEY_W, KEY_H, "使用",
                        f"items[{i}].use_label:text"))
    return g(pid, "item_row", "panel", "program", (RX, y, KEY_X + KEY_W - RX, RH), 3, "".join(body),
             importance=3, stretch="x", align="rows")


def build():
    out = []
    out.append(g("bg", "bg", "deco", "vector", (0, 0, 720, 1280), 0,
                 f'<rect x="0" y="0" width="720" height="1280" fill="{C["bg"]}"/>',
                 desc="preview-only stand-in for the dimmed live 3D battle; dropped on export"))

    d = []
    body_box = (72, 320, 576, 588)
    d.append(tex("dlg_body", "panel", "panel", "nine_slice", body_box, 1, "chamfer", "base", "ink_plate", "frame",
                 "hard", "bevel", "normal", hw=4, cut=10, slice="16,14,16,14", stretch="xy"))

    # header: crimson slash wedge behind an off-white title panel, hint underneath
    d.append(tex("title_wedge", "deco", "deco", "affine", (104, 352, 348, 80), 2, "polygon", "accent",
                 "slash_wedge", "deco", "hard", "emboss", "minor", hw=3,
                 points=[(128, 352), (452, 352), (428, 432), (104, 432)], attach="title_panel:br"))
    title = g("bag_title", "bag_title", "text", "program", (120, 352, 140, 56), 4,
              t(120, 398, "道具袋", 44, "text_ink", weight="bold"), importance=5, align="col_left")
    d.append(tex("title_panel", "panel", "panel", "nine_slice", (96, 340, 324, 80), 3, "polygon", "panel",
                 "comic_panel", "frame", "hard", "bevel", "hero", title, hw=4,
                 points=[(96, 340), (420, 340), (396, 420), (96, 420)], slice="20,16,20,16", stretch="x"))
    d.append(g("bag_hint", "bag_hint", "text", "program", (120, 432, 180, 26), 4,
               t(120, 452, "选择要使用的道具", 20, "text_dim"), importance=2, align="col_left"))
    d.append(tex("hazard_band", "deco", "deco", "nine_slice", (72, 468, 576, 12), 3, "polygon", "hazard",
                 "hazard_stripe", "deco", "hard", "emboss", "minor", hw=2,
                 points=[(84, 468), (648, 468), (636, 480), (72, 480)], slice="8,2,8,2", tile="x", stretch="x"))

    # item list
    lst = "".join(item_row(i, *it) for i, it in enumerate(ITEMS))
    d.append(g("item_list", "panel", "panel", "program", (RX, RY0, KEY_X + KEY_W - RX, 2 * RH + RG), 2, lst,
               stretch="x", align="rows"))

    # close key
    d.append(close_key("bag_close", 240, 808, 240, 64))

    # corner spikes mounted on the dialog body
    d.append(tex("spike_tl", "deco", "deco", "affine", (60, 308, 80, 80), 6, "polygon", "accent", "spike_tri",
                 "deco", "hard", "emboss", "minor", hw=3, points=[(60, 308), (140, 308), (60, 388)],
                 attach="dlg_body:tl"))
    d.append(tex("spike_br", "deco", "deco", "affine", (580, 840, 80, 80), 6, "polygon", "accent", "spike_tri",
                 "deco", "hard", "emboss", "minor", hw=3, points=[(660, 840), (660, 920), (580, 920)],
                 attach="dlg_body:br"))

    out.append(g("bag_dialog", "bag_dialog", "panel", "program", (60, 300, 600, 640), 1, "".join(d),
                 anchor="center", stretch="none"))

    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280" '
           'data-style="persona3d_bag" data-light="-0.3,-0.8">'
           "<title>怪谈口袋 3D 道具袋弹窗 区域稿</title>" + "".join(out) + "</svg>")
    return svg


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "layout.svg"), "w", encoding="utf-8") as f:
        f.write(build())
    print("wrote layout.svg")
