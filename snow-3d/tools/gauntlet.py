# Builds the Lich King style gauntlet and exports assets/resources/models/gauntlet.glb.
#   Blender -b --factory-startup --python tools/gauntlet.py
#
# Geometry is laid out in the hand space of assets/game/snow/Hand.ts (x across
# the palm, y up the arm, z out of the palm; wrist at the origin, human size),
# so the model sits on the collision capsules. H() maps hand space to Blender
# (Z up); the glTF exporter's +Y-up conversion maps it back.
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'resources', 'models', 'gauntlet.glb')


bpy.ops.wm.read_factory_settings(use_empty=True)


def H(x, y, z):
    return Vector((x, -z, y))


def material(name, color, metallic, roughness, emission=None, strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1)
        bsdf.inputs['Emission Strength'].default_value = strength
    return mat


# The demo has no reflection probe, so fully metallic surfaces render black: keep metallic moderate.
STEEL = material('GauntletSteel', (0.2, 0.22, 0.27), 0.55, 0.42)
TRIM = material('GauntletTrim', (0.55, 0.6, 0.68), 0.6, 0.3)
RUNE = material('GauntletRune', (0.2, 0.75, 1.0), 0.0, 0.3, (0.25, 0.8, 1.0), 6.0)

bm = bmesh.new()
mat_index = {STEEL.name: 0, TRIM.name: 1, RUNE.name: 2}


def add(geom_fn, mat, transform):
    """Runs a bmesh.ops.create_* into a temp bmesh, transforms it and merges it in."""
    tmp = bmesh.new()
    geom_fn(tmp)
    bmesh.ops.transform(tmp, matrix=transform, verts=tmp.verts)
    for f in tmp.faces:
        f.material_index = mat_index[mat.name]
        f.smooth = False
    me = bpy.data.meshes.new('tmp')
    tmp.to_mesh(me)
    tmp.free()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)


def frame(a, b, up_hint=Vector((0, 0, 1))):
    """Matrix taking local +Z to the segment a→b (Blender space), origin at a."""
    d = (b - a)
    length = d.length
    z = d.normalized()
    x = up_hint.cross(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0)).cross(z)
    x.normalize()
    y = z.cross(x)
    m = Matrix((
        (x.x, y.x, z.x, a.x),
        (x.y, y.y, z.y, a.y),
        (x.z, y.z, z.z, a.z),
        (0, 0, 0, 1),
    ))
    return m, length


def cone(a, b, r0, r1, sides, mat, flat=1.0):
    """Tapered prism from a to b (hand space), radii r0 → r1, squashed by `flat` across its local y."""
    A, B = H(*a), H(*b)
    m, length = frame(A, B, H(0, 0, 1))
    local = Matrix.Translation((0, 0, length / 2)) @ Matrix.Diagonal((1, flat, 1, 1))

    def make(t):
        bmesh.ops.create_cone(t, cap_ends=True, segments=sides, radius1=r0, radius2=r1, depth=length)
    add(make, mat, m @ local)


def spike(base, tip, r, mat, sides=5):
    A, B = H(*base), H(*tip)
    m, length = frame(A, B)

    def make(t):
        bmesh.ops.create_cone(t, cap_ends=True, segments=sides, radius1=r, radius2=0.0, depth=length)
    add(make, mat, m @ Matrix.Translation((0, 0, length / 2)))


def box(center, size, mat, rot=Matrix.Identity(4)):
    c = H(*center)

    def make(t):
        bmesh.ops.create_cube(t, size=1.0)
    add(make, mat, Matrix.Translation(c) @ rot @ Matrix.Diagonal((size[0], size[2], size[1], 1)))


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# Vambrace: wrist to elbow, flaring out, with a trim ring and a spiked cuff.
WRIST, ELBOW = (0, 0, 0), (0, 0.2, -0.17)
cone(WRIST, ELBOW, 0.046, 0.058, 8, STEEL)
cone(lerp(WRIST, ELBOW, 0.08), lerp(WRIST, ELBOW, 0.16), 0.051, 0.052, 8, TRIM)
cone(lerp(WRIST, ELBOW, 0.82), lerp(WRIST, ELBOW, 1.02), 0.066, 0.072, 8, TRIM)
axis = Vector(ELBOW).normalized()
side = Vector((1, 0, 0))
other = axis.cross(side)
for k in range(7):
    ang = (k / 7) * math.tau + 0.3
    out = side * math.cos(ang) + other * math.sin(ang)
    base = Vector(lerp(WRIST, ELBOW, 0.92)) + out * 0.064
    tip = base + out * 0.05 + axis * 0.035
    spike(tuple(base), tuple(tip), 0.013, STEEL)
# A ridge plate down the back of the forearm.
cone(lerp(WRIST, ELBOW, 0.2), lerp(WRIST, ELBOW, 0.85), 0.012, 0.016, 4, TRIM)

# Back of the hand: a plate from the wrist to the knuckles, thicker on the back (−z) side.
KNUCKLE_Y = -0.086
box((0, KNUCKLE_Y / 2, -0.004), (0.098, 0.094, 0.042), STEEL)
box((0, KNUCKLE_Y / 2 + 0.008, -0.027), (0.07, 0.06, 0.01), TRIM)
# Rune on the back of the hand.
box((0, KNUCKLE_Y / 2 + 0.006, -0.033), (0.026, 0.034, 0.006), RUNE, Matrix.Rotation(math.radians(45), 4, 'Y'))
# Knuckle guard and spikes.
cone((-0.052, KNUCKLE_Y, -0.004), (0.052, KNUCKLE_Y, -0.004), 0.018, 0.018, 6, TRIM)
for x in (-0.039, -0.013, 0.013, 0.039):
    spike((x, KNUCKLE_Y, -0.018), (x, KNUCKLE_Y + 0.012, -0.05), 0.009, STEEL)

# Fingers: three plated segments each along the capsule from Hand.ts, ending in a claw.
FINGERS = [
    ((-0.039, -0.085, 0.006), (-0.041, -0.148, 0.03), 0.012),
    ((-0.013, -0.088, 0.006), (-0.013, -0.168, 0.034), 0.013),
    ((0.013, -0.088, 0.006), (0.013, -0.163, 0.033), 0.013),
    ((0.039, -0.085, 0.006), (0.042, -0.142, 0.028), 0.012),
]
for a, b, r in FINGERS:
    for s in range(3):
        t0, t1 = s / 3, (s + 1) / 3 - 0.02
        cone(lerp(a, b, t0), lerp(a, b, t1), r * (1.08 - 0.1 * s), r * (1.0 - 0.1 * s), 6, STEEL, 0.85)
        cone(lerp(a, b, t0 - 0.01), lerp(a, b, t0 + 0.05), r * (1.22 - 0.1 * s), r * (1.2 - 0.1 * s), 6, TRIM, 0.8)
    d = Vector(b) - Vector(a)
    tip = Vector(b) + d.normalized() * 0.03 + Vector((0, 0, 0.012))
    spike(b, tuple(tip), r * 0.75, TRIM, 6)

# Thumb: two segments and a claw.
TA, TB = (0.048, -0.01, 0.012), (0.07, -0.075, 0.035)
cone(TA, lerp(TA, TB, 0.5), 0.016, 0.014, 6, STEEL, 0.85)
cone(lerp(TA, TB, 0.52), TB, 0.014, 0.012, 6, STEEL, 0.85)
cone(lerp(TA, TB, 0.47), lerp(TA, TB, 0.56), 0.017, 0.017, 6, TRIM, 0.8)
tdir = (Vector(TB) - Vector(TA)).normalized()
spike(TB, tuple(Vector(TB) + tdir * 0.026 + Vector((0, 0, 0.01))), 0.009, TRIM, 6)

mesh = bpy.data.meshes.new('Gauntlet')
bm.normal_update()
bm.to_mesh(mesh)
bm.free()
for m in (STEEL, TRIM, RUNE):
    mesh.materials.append(m)
obj = bpy.data.objects.new('Gauntlet', mesh)
bpy.context.scene.collection.objects.link(obj)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_apply=True)
print('wrote', os.path.abspath(OUT), len(mesh.vertices), 'verts', len(mesh.polygons), 'faces')
