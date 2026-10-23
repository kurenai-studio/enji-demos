"""Export gothic2 Room+Decor / ShelfBay / book templates as glTF for Enji."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def ensure_in_view_layer(obj: bpy.types.Object):
    """Objects only in disabled collections can't be selected; link into scene root."""
    root = bpy.context.scene.collection
    if obj.name not in root.objects:
        try:
            root.objects.link(obj)
        except RuntimeError:
            pass
    obj.hide_set(False)
    obj.hide_viewport = False
    obj.hide_render = False
    obj.hide_select = False


def delete_by_prefix(*prefixes: str) -> int:
    doomed = [o for o in bpy.data.objects if any(o.name.startswith(p) for p in prefixes)]
    for o in doomed:
        bpy.data.objects.remove(o, do_unlink=True)
    return len(doomed)


def collection_meshes(col_name: str) -> list[bpy.types.Object]:
    col = bpy.data.collections.get(col_name)
    if not col:
        return []
    return [o for o in col.objects if o.type == "MESH"]


def select_objects(objs: list[bpy.types.Object]) -> int:
    bpy.ops.object.select_all(action="DESELECT")
    n = 0
    for o in objs:
        ensure_in_view_layer(o)
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        n += 1
    return n


def export_selected(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        use_selection=True,
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_extras=False,
    )
    print(f"[enji-export] wrote {path.name} ({path.stat().st_size // 1024} KB)")


def main():
    args = parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    n = delete_by_prefix("PreviewBook", "PreviewBay", "PreviewShelved")
    print(f"[enji-export] removed preview meshes = {n}")
    # CatRig becomes glTF scene[0] if left in the file — strip before any export.
    n_cat = delete_by_prefix("Cat", "CatRig", "CatBody")
    print(f"[enji-export] removed cat objects = {n_cat}")

    # Hall = Room + Decor (no cat).
    hall = collection_meshes("Room") + collection_meshes("Decor")
    hall = [o for o in hall if not o.name.startswith("Cat")]
    print(f"[enji-export] hall objects = {[o.name for o in hall]}")
    if not hall:
        raise SystemExit("no Room/Decor meshes")
    select_objects(hall)
    export_selected(out / "Hall.glb")

    # Shelf bay from Props (or top-level).
    bay = bpy.data.objects.get("ShelfBay")
    if bay is None:
        for o in collection_meshes("Props"):
            if o.name == "ShelfBay":
                bay = o
                break
    if bay is None:
        raise SystemExit("ShelfBay missing")
    # Reset transform so game can place by layout.
    bay.location = (0.0, 0.0, 0.0)
    bay.rotation_euler = (0.0, 0.0, 0.0)
    select_objects([bay])
    export_selected(out / "ShelfBay.glb")

    book_names = [
        "Book_s0_e0_v1", "Book_s0_e1_v2", "Book_s1_e2_v1",
        "Book_s2_e0_v3", "Book_s3_e1_v1", "Book_s4_e2_v2",
        "Book_s5_e0_v1", "Book_s6_e3_v2", "Book_s7_e4_v1",
    ]
    for name in book_names:
        obj = bpy.data.objects.get(name)
        if obj is None:
            print(f"[enji-export] skip missing {name}")
            continue
        obj.location = (0.0, 0.0, 0.0)
        obj.rotation_euler = (0.0, 0.0, 0.0)
        select_objects([obj])
        export_selected(out / f"{name}.glb")

    print("[enji-export] done")


if __name__ == "__main__":
    main()
