# Draws the ice under the snow in the Lich King shot:
#   assets/resources/textures/ice-albedo.png  deep blue ice, cracks, bubbles, frosted letters
#   assets/resources/textures/ice-glow.png    the letters' glow (emissive map)
# python3 tools/ice_text.py ["text"]
# The textures cover the whole tray floor (SHOT.trayW × SHOT.trayL); the text is
# fitted into SHOT.text (0.9 × 0.15 m) at the centre.
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

TEXT = sys.argv[1] if len(sys.argv) > 1 else 'cocos 牛B'
TRAY_W, TRAY_L = 1.8, 1.0
TEXT_W, TEXT_H = 0.9, 0.15
W, H = 2048, round(2048 * TRAY_L / TRAY_W)
FONT = ('/System/Library/Fonts/Supplemental/Songti.ttc', 0)  # Songti SC Black
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'resources', 'textures')
random.seed(3)


def value_noise(w, h, cell):
    """Smooth noise in [0, 1] by bicubic upscaling of a random grid."""
    small = Image.effect_noise((max(2, w // cell), max(2, h // cell)), 64).convert('L')
    return small.resize((w, h), Image.BICUBIC)


def fbm(w, h):
    acc = Image.new('L', (w, h), 128)
    for cell, weight in ((256, 0.5), (96, 0.3), (32, 0.15), (10, 0.05)):
        acc = Image.blend(acc, value_noise(w, h, cell), weight)
    return acc


def lerp_color(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# Base ice: deep blue, mottled.
noise = fbm(W, H)
deep, light = (8, 22, 48), (34, 74, 118)
lut = [lerp_color(deep, light, min(1.0, max(0.0, (v - 70) / 120))) for v in range(256)]
albedo = Image.merge('RGB', [noise.point([c[i] for c in lut]) for i in range(3)])

# Cracks: jagged random walks, bright and thin, with a soft halo.
cracks = Image.new('L', (W, H), 0)
draw = ImageDraw.Draw(cracks)
for _ in range(38):
    x, y = random.uniform(0, W), random.uniform(0, H)
    angle = random.uniform(0, math.tau)
    width = random.choice((1, 1, 2, 2, 3))
    for _ in range(random.randint(6, 26)):
        angle += random.uniform(-0.7, 0.7)
        step = random.uniform(12, 46)
        nx, ny = x + math.cos(angle) * step, y + math.sin(angle) * step
        draw.line((x, y, nx, ny), fill=random.randint(120, 220), width=width)
        if random.random() < 0.12:
            a2 = angle + random.choice((-1, 1)) * random.uniform(0.6, 1.3)
            draw.line((nx, ny, nx + math.cos(a2) * step * 1.5, ny + math.sin(a2) * step * 1.5), fill=110, width=1)
        x, y = nx, ny
crack_halo = cracks.filter(ImageFilter.GaussianBlur(6))
albedo = Image.composite(Image.new('RGB', (W, H), (70, 120, 170)), albedo, crack_halo.point(lambda v: v // 2))
albedo = Image.composite(Image.new('RGB', (W, H), (175, 210, 240)), albedo, cracks)

# Trapped bubbles.
bubbles = Image.new('L', (W, H), 0)
bd = ImageDraw.Draw(bubbles)
for _ in range(900):
    x, y, r = random.uniform(0, W), random.uniform(0, H), random.choice((1, 1, 1.5, 2, 3))
    bd.ellipse((x - r, y - r, x + r, y + r), fill=random.randint(90, 200))
albedo = Image.composite(Image.new('RGB', (W, H), (190, 225, 250)), albedo, bubbles.filter(ImageFilter.GaussianBlur(0.6)))

# The text, fitted into the band.
box_w, box_h = round(TEXT_W / TRAY_W * W), round(TEXT_H / TRAY_L * H)
size = 400
while True:
    font = ImageFont.truetype(FONT[0], size, index=FONT[1])
    l, t, r, b = font.getbbox(TEXT)
    if r - l <= box_w and b - t <= box_h:
        break
    size -= 4
mask = Image.new('L', (W, H), 0)
ImageDraw.Draw(mask).text(((W - (r - l)) / 2 - l, (H - (b - t)) / 2 - t), TEXT, font=font, fill=255)

# Frosted letters with a carved bevel: lit from the top left, shadowed bottom right.
soft = mask.filter(ImageFilter.GaussianBlur(3))
lit = ImageChops.subtract(soft, ImageChops.offset(soft, 3, 3))
shade = ImageChops.subtract(soft, ImageChops.offset(soft, -3, -3))
albedo = Image.composite(Image.new('RGB', (W, H), (4, 12, 30)), albedo, mask.filter(ImageFilter.GaussianBlur(10)).point(lambda v: v * 3 // 5))
albedo = Image.composite(Image.new('RGB', (W, H), (150, 200, 238)), albedo, mask)
frost = fbm(W, H).point(lambda v: max(0, v - 110) * 2)
albedo = Image.composite(Image.new('RGB', (W, H), (225, 242, 255)), albedo, ImageChops.multiply(mask, frost))
albedo = Image.composite(Image.new('RGB', (W, H), (240, 250, 255)), albedo, lit)
albedo = Image.composite(Image.new('RGB', (W, H), (40, 70, 110)), albedo, shade)

# Glow: a bright core and two halos, plus a faint light in the cracks.
glow = Image.new('RGB', (W, H), (0, 0, 0))
for radius, color, gain in ((40, (20, 70, 160), 1.0), (14, (60, 160, 255), 1.0), (0, (170, 235, 255), 1.0)):
    m = mask.filter(ImageFilter.GaussianBlur(radius)) if radius else mask
    if radius:
        m = m.point(lambda v, g=gain: min(255, int(v * 2.2 * g)))
    glow = Image.composite(Image.new('RGB', (W, H), color), glow, m)
glow = ImageChops.add(glow, Image.merge('RGB', [cracks.point(lambda v: v // 14), cracks.point(lambda v: v // 8), cracks.point(lambda v: v // 5)]))

os.makedirs(OUT, exist_ok=True)
albedo.save(os.path.join(OUT, 'ice-albedo.png'))
glow.save(os.path.join(OUT, 'ice-glow.png'))

# The shot's vignette: black, transparent in the middle, darkening toward the corners.
V = 512
vignette = Image.new('L', (V, V), 0)
px = vignette.load()
for y in range(V):
    for x in range(V):
        d = math.hypot((x + 0.5) / V * 2 - 1, (y + 0.5) / V * 2 - 1) / math.sqrt(2)
        px[x, y] = round(255 * min(1.0, max(0.0, (d - 0.45) / 0.55)) ** 1.6 * 0.85)
Image.merge('RGBA', [Image.new('L', (V, V), 0)] * 3 + [vignette]).save(os.path.join(OUT, 'vignette.png'))
print('wrote', W, 'x', H, 'font size', size, repr(TEXT))
