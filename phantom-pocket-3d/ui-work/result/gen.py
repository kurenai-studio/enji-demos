"""Generate layout.svg — 怪谈口袋 3D 结算弹窗, region grammar v2, Persona 5 style."""
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
    skill_face=PRE + "flat crimson skill-key face, saturated red ink, sharp chamfer, clean center for white "
                     "move name and PP",
    hazard_stripe=PRE + "yellow diagonal hazard stripes, hard edges, scuffed print, seamless horizontal tile, "
                        "no lettering",
    spike_tri=PRE + "solid crimson right triangle ornament, razor points, flat ink, mounted on a panel corner",
    slash_wedge=PRE + "long diagonal crimson wedge, sharp parallelogram slash, flat manga graphic, not organic",
    title_banner=PRE + "huge skewed crimson result banner, slashed parallelogram like a manga splash caption, "
                       "flat saturated red ink, thin black ink keyline inset, sparse halftone at the slashed "
                       "ends, large clean center for giant white headline",
    caption_bar=PRE + "deep black slanted caption strip sunk into the plate, razor slash ends, faint off-white "
                      "inner lip, clean center for one line of white type",
)


def attrs(d):
    return " ".join(f'{k}="{escape(str(v), {chr(34): "&quot;"})}"' for k, v in d.items() if v is not None)


def pts(p):
    return " ".join(f"{a:g},{b:g}" for a, b in p)


def chamfer(x, y, w, h, c):
    return pts([(x + c, y), (x + w - c, y), (x + w, y + c), (x + w, y + h - c), (x + w - c, y + h),
                (x + c, y + h), (x, y + h - c), (x, y + c)])


def g(pid, role, typ, render, box, z, body="", **kw):
    x, y, w, h = box
    a = {"id": pid, "data-role": role, "data-type": typ, "data-render": render,
         "data-x": f"{x:g}", "data-y": f"{y:g}", "data-w": f"{w:g}", "data-h": f"{h:g}", "data-z": z}
    for k, v in kw.items():
        a["data-" + k.replace("_", "-")] = v
    return f"<g {attrs(a)}>{body}</g>"


def tex(pid, role, typ, render, box, z, shape, tone, texture, family, edge, height, prio, body="",
        hw=None, cut=None, points=None, **kw):
    x, y, w, h = box
    if shape == "chamfer":
        sh = f'<polygon points="{chamfer(x, y, w, h, cut)}" fill="{C[tone]}"/>'
    else:
        sh = f'<polygon points="{pts(points)}" fill="{C[tone]}"/>'
    return g(pid, role, typ, render, box, z, sh + body, shape=shape, cut=cut, tone=tone, texture=texture,
             family=family, edge=edge, height=height, height_w=hw, priority=prio, desc=D[texture], **kw)


def t(x, y, s, fs, col, anchor="start", weight="bold"):
    return (f'<text x="{x:g}" y="{y:g}" font-family="{FONT}" font-size="{fs}" fill="{C[col]}" '
            f'text-anchor="{anchor}" font-weight="{weight}">{escape(s)}</text>')


def build():
    out = [g("bg", "bg", "deco", "vector", (0, 0, 720, 1280), 0,
             f'<rect x="0" y="0" width="720" height="1280" fill="{C["bg"]}"/>',
             desc="preview-only stand-in for the live 3D battle scene, dropped on export")]

    d = []
    # dialog body plate
    d.append(tex("dialog_plate", "panel", "panel", "nine_slice", (60, 392, 600, 548), 1, "chamfer", "base",
                 "ink_plate", "frame", "hard", "bevel", "normal", hw=4, cut=10, slice="16,14,16,14",
                 stretch="xy"))

    # title banner (skewed crimson parallelogram) + headline
    d.append(tex("title_slash", "deco", "deco", "affine", (500, 470, 160, 28), 2, "polygon", "accent",
                 "slash_wedge", "deco", "hard", "emboss", "minor", hw=3,
                 points=[(524, 470), (660, 470), (636, 498), (500, 498)], attach="title_banner:br"))
    title = g("result_title", "result_title", "text", "program", (220, 384, 280, 80), 4,
              t(360, 446, "捕获成功", 64, "text", "middle"),
              importance=5, bind="result.title:text", maxlen=4, align="center", anim="pulse:1.2")
    d.append(tex("title_banner", "panel", "panel", "nine_slice", (60, 360, 600, 120), 3, "polygon", "accent",
                 "title_banner", "frame", "hard", "emboss", "hero", title, hw=4,
                 points=[(92, 366), (660, 360), (628, 474), (60, 480)], slice="40,16,40,16", stretch="x",
                 align="center"))

    # result caption strip
    sub = g("result_sub", "result_sub", "text", "program", (110, 508, 500, 40), 3,
            t(360, 537, "赤影狐 成为了伙伴", 26, "text", "middle"),
            importance=4, bind="result.sub:text", maxlen=12, align="center")
    d.append(tex("sub_bar", "panel", "plate", "nine_slice", (96, 502, 528, 52), 2, "polygon", "base_dark",
                 "caption_bar", "frame", "hard", "engrave", "normal", sub, hw=3,
                 points=[(112, 502), (624, 502), (608, 554), (96, 554)], slice="20,10,20,10", stretch="x",
                 align="center"))

    # settlement lines on a manga panel
    lines = []
    lines.append(tex("lines_tag", "label", "plate", "nine_slice", (120, 584, 88, 32), 3, "chamfer", "accent",
                     "lv_chip", "frame", "hard", "emboss", "minor",
                     t(164, 607, "结算", 18, "text", "middle"), hw=3, cut=8, slice="8,8,8,8",
                     align="lines_left"))
    lines.append(g("result_line_0", "result_line_0", "text", "program", (120, 628, 384, 40), 3,
                   t(120, 660, "获得经验 24", 30, "text_ink", "start"),
                   importance=3, bind="result.line0:text", maxlen=10, align="lines_left"))
    lines.append(g("lines_rule", "deco", "deco", "program", (120, 676, 480, 4), 3,
                   f'<rect x="120" y="676" width="480" height="4" fill="{C["panel_ink"]}"/>'))
    lines.append(g("result_line_1", "result_line_1", "text", "program", (120, 688, 384, 40), 3,
                   t(120, 720, "队伍 2/6", 30, "text_ink", "start"),
                   importance=3, bind="result.line1:text", maxlen=10, align="lines_left"))
    d.append(tex("lines_panel", "panel", "panel", "nine_slice", (96, 568, 528, 176), 2, "polygon", "panel",
                 "comic_panel", "frame", "hard", "bevel", "normal", "".join(lines), hw=4,
                 points=[(96, 568), (604, 568), (624, 588), (624, 744), (116, 744), (96, 724)],
                 slice="20,16,20,16", stretch="xy", align="center"))
    d.append(tex("lines_hazard", "deco", "deco", "nine_slice", (96, 760, 528, 16), 2, "polygon", "hazard",
                 "hazard_stripe", "deco", "hard", "emboss", "minor", hw=2,
                 points=[(104, 760), (624, 760), (616, 776), (96, 776)], slice="8,2,8,2", tile="x",
                 stretch="x", attach="lines_panel:b"))

    # primary key: 下一战
    bx, by, bw, bh = 170, 800, 380, 72
    rim = tex("next_rim", "button_rim", "frame", "ring_mesh", (bx, by, bw, bh), 4, "chamfer", "panel",
              "skill_rim", "button", "hard", "bevel", "normal", hw=6, cut=14, border=6, fill="hollow",
              layer="rim", stretch="x", derive="pressed=relief_invert,disabled=steel")
    face = tex("next_face", "button_face", "plate", "nine_slice", (bx + 6, by + 6, bw - 12, bh - 12), 5,
               "chamfer", "accent", "skill_face", "button", "hard", "flat", "hero", cut=8,
               slice="12,10,12,10", layer="face", stretch="x", derive="pressed=darken,disabled=desaturate")
    label = g("next_label", "label", "text", "program", (300, 816, 120, 40), 6,
              t(360, 847, "下一战", 32, "text", "middle"), maxlen=3)
    arrow = g("next_arrow", "icon", "icon", "program", (488, 822, 28, 28), 6,
              f'<polygon points="488,822 516,836 488,850" fill="{C["text"]}"/>')
    d.append(g("result_next", "result_next", "button", "program", (bx, by, bw, bh), 4,
               rim + face + label + arrow, importance=5, states="normal,pressed,disabled", state="normal",
               align="center", anim="pulse:1.6"))

    # corner spikes
    d.append(tex("spike_bl", "deco", "deco", "affine", (60, 880, 60, 60), 2, "polygon", "accent", "spike_tri",
                 "deco", "hard", "emboss", "minor", hw=3, points=[(60, 880), (120, 940), (60, 940)],
                 attach="dialog_plate:bl"))
    d.append(tex("spike_br", "deco", "deco", "affine", (600, 880, 60, 60), 2, "polygon", "accent", "spike_tri",
                 "deco", "hard", "emboss", "minor", hw=3, points=[(660, 880), (660, 940), (600, 940)],
                 attach="dialog_plate:br"))

    out.append(g("result_dialog", "panel", "panel", "program", (60, 360, 600, 580), 1, "".join(d),
                 anchor="center", stretch="none"))

    return ('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280" '
            'data-style="persona3d_result" data-light="-0.3,-0.8">'
            "<title>怪谈口袋 3D 结算弹窗 区域稿</title>" + "".join(out) + "</svg>")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "layout.svg"), "w", encoding="utf-8") as f:
        f.write(build())
    print("wrote layout.svg")
