"""Export the Infinity Castle block variants as .glb for the Enji example.

    Blender -b --python tools/export_blocks.py

Reuses the kit / block builders of the reference Blender generator
(tools/build_infinity_castle.py, exec'd, not modified) and writes, per block variant:

  assets/resources/models/<name>.glb   one mesh, one material ("Castle")
  assets/resources/models/blocks.json  lantern centres + bounds per block (Cocos axes)

Everything a block needs for shading goes into COLOR_0 (float, linear, exported as is):
  r = material slot id  (id + 0.5) / 16   -> decoded in castle.effect
  g = baked warm light from the block's own lanterns and shoji paper (0..1)
  b = per-part random (0..1), varies the paper glow and wood tone per panel
  a = 1
A single material keeps every placed block at one draw call.
"""
import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, 'build_infinity_castle.py')
PROJECT = os.path.dirname(HERE)
OUT = os.path.join(PROJECT, 'assets', 'resources', 'models')

ns = {'__name__': 'ic_ref'}
exec(compile(open(REF).read(), REF, 'exec'), ns)
MATS = ns['MATS']
PAPER, LANTERN = MATS.index('Paper'), MATS.index('Lantern')


def blocks():
    """Same variants as step_blocks(); the layout keeps the support legs out of the camera's path."""
    ns['step_materials']()
    made = [
        ns['blk_room']('B_room_a', 1, ('shoji', 'shoji', 'open', 'shoji')),
        ns['blk_room']('B_room_b', 2, ('shoji', 'open', 'open', 'shoji'), under=12.0),
        ns['blk_room']('B_room_c', 3, ('open', 'shoji', 'open', 'shoji')),
        ns['blk_corridor']('B_corr_a', 4, 'railing', 'shoji'),
        ns['blk_corridor']('B_corr_b', 5, 'railing', 'railing', red=True),
        ns['blk_corridor']('B_corr_c', 6, 'railing', 'shoji', under=14.0),
        ns['blk_stair']('B_stair_a', 7),
    ]
    for i in range(4):
        made.append(ns['blk_facade'](f'B_facade_{i}', 10 + i, red=(i == 2)))
    return made


def to_cocos(v):
    """Blender Z-up (x, y, z) -> glTF / Cocos Y-up (x, z, -y), what export_yup does."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def castle_material():
    """Single material whose base colour reads the 'Col' attribute (the shader decodes it)."""
    mat = bpy.data.materials.get('Castle')
    if mat:
        return mat
    mat = bpy.data.materials.new('Castle')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.bl_idname == 'ShaderNodeBsdfPrincipled')
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def bake(me, lanterns):
    """Fill the COLOR_0 attribute (corner domain) and collapse to one material."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    rng = random.Random(me.name)

    # Light sources: lantern centres (strong) + paper face centres (weak, many).
    paper = [f.calc_center_median() for f in bm.faces if f.material_index == PAPER and f.calc_area() > 0.05]
    src = [(Vector(p), 1.0) for p in lanterns] + [(c, 0.08) for c in paper[::2]]
    sp = np.array([s[0][:] for s in src], dtype=np.float32).reshape(-1, 3)
    sw = np.array([s[1] for s in src], dtype=np.float32)

    vpos = np.array([v.co[:] for v in bm.verts], dtype=np.float32)
    if len(sp):
        d2 = ((vpos[:, None, :] - sp[None, :, :]) ** 2).sum(-1)
        glow = (sw[None, :] / (1.0 + 0.35 * d2)).sum(-1)
        glow = 1.0 - np.exp(-1.6 * glow)
    else:
        glow = np.zeros(len(vpos), dtype=np.float32)

    # One random value per connected box (faces sharing verts), not per face.
    part = {}
    for f in bm.faces:
        key = min(v.index for v in f.verts) // 8
        part.setdefault(key, rng.random())

    layer = bm.loops.layers.float_color.new('Col')
    for f in bm.faces:
        mid = (f.material_index + 0.5) / 16.0
        rnd = part[min(v.index for v in f.verts) // 8]
        for loop in f.loops:
            loop[layer] = (mid, float(glow[loop.vert.index]), rnd, 1.0)
        f.material_index = 0
    bm.to_mesh(me)
    bm.free()

    me.materials.clear()
    me.materials.append(castle_material())
    me.color_attributes.active_color = me.color_attributes['Col']
    return len(me.vertices), len(me.polygons)


def main():
    ns['step_reset']()
    made = blocks()
    os.makedirs(OUT, exist_ok=True)
    scene = bpy.context.scene
    info = {}
    for me in made:
        lanterns = ns['_lantern_slots'](me)
        nv, nf = bake(me, lanterns)
        ob = bpy.data.objects.new(me.name, me)
        scene.collection.objects.link(ob)
        for o in scene.objects:
            o.select_set(o is ob)
        bpy.context.view_layer.objects.active = ob
        path = os.path.join(OUT, f'{me.name}.glb')
        bpy.ops.export_scene.gltf(
            filepath=path, export_format='GLB', use_selection=True, export_yup=True,
            # Blender 5.2: 'ACTIVE' + export_all_vertex_colors (default on) writes a fake white
            # COLOR_0 and the real attribute as COLOR_1, which the Cocos importer ignores;
            # 'ACTIVE' without it exports no colour at all. 'NAME' writes 'Col' as COLOR_0.
            export_apply=False, export_materials='EXPORT', export_vertex_color='NAME',
            export_vertex_color_name='Col', export_all_vertex_colors=False,
            export_normals=True, export_texcoords=False, export_animations=False,
        )
        xs = [to_cocos(v.co) for v in me.vertices]
        lo = [min(p[i] for p in xs) for i in range(3)]
        hi = [max(p[i] for p in xs) for i in range(3)]
        info[me.name] = {
            'lanterns': [to_cocos(p) for p in lanterns],
            'min': lo, 'max': hi, 'verts': nv, 'faces': nf,
        }
        print(f'EXPORT {me.name}: {nv} verts, {nf} faces, {len(lanterns)} lanterns -> {path}')
        scene.collection.objects.unlink(ob)
    with open(os.path.join(OUT, 'blocks.json'), 'w') as fh:
        json.dump(info, fh, indent=1)
    print('DONE', len(info))


main()
