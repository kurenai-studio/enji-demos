"""Convert Urho UMD2 meshes into one glTF binary for the archive level."""
from __future__ import annotations

import json
import struct
import xml.etree.ElementTree as ET
from pathlib import Path

ELEM = {0: 4, 1: 4, 2: 8, 3: 12, 4: 16, 5: 4, 6: 4}
SEM_POSITION, SEM_NORMAL, SEM_TEXCOORD = 0, 1, 4


def read_umd(path: Path) -> list[dict]:
    data = path.read_bytes()
    if data[:4] != b"UMD2":
        raise SystemExit(f"{path} is not UMD2")
    o = 4

    def u32() -> int:
        nonlocal o
        v = struct.unpack_from("<I", data, o)[0]
        o += 4
        return v

    def f32() -> float:
        nonlocal o
        v = struct.unpack_from("<f", data, o)[0]
        o += 4
        return v

    n_vb = u32()
    vbs = []
    for _ in range(n_vb):
        count = u32()
        n_elem = u32()
        elems = []
        for _e in range(n_elem):
            desc = u32()
            elems.append((desc & 0xFF, (desc >> 8) & 0xFF, (desc >> 16) & 0xFF))
        u32()  # morph start
        u32()  # morph count
        stride = sum(ELEM[t] for t, _s, _i in elems)
        blob = data[o : o + stride * count]
        o += stride * count
        vbs.append((count, stride, elems, blob))

    n_ib = u32()
    ibs = []
    for _ in range(n_ib):
        count = u32()
        size = u32()
        blob = data[o : o + count * size]
        o += count * size
        fmt = "<" + ("H" if size == 2 else "I") * count
        ibs.append(struct.unpack(fmt, blob))

    n_geo = u32()
    prims = []
    for _ in range(n_geo):
        bones = u32()
        o += 4 * bones
        lods = u32()
        for lod in range(lods):
            f32()  # distance
            u32()  # primitive type, triangles
            vb_ref = u32()
            ib_ref = u32()
            index_start = u32()
            index_count = u32()
            if lod == 0:
                prims.append((vb_ref, ib_ref, index_start, index_count))
    return [{"vb": vbs[vb], "idx": ibs[ib][start : start + count]} for vb, ib, start, count in prims]


def verts_of(vb, indices: tuple[int, ...]) -> tuple[list[float], list[float], list[float], list[int]]:
    count, stride, elems, blob = vb
    pos_off = nor_off = uv_off = None
    off = 0
    for typ, sem, _index in elems:
        if sem == SEM_POSITION and pos_off is None:
            pos_off = off
        elif sem == SEM_NORMAL and nor_off is None:
            nor_off = off
        elif sem == SEM_TEXCOORD and uv_off is None:
            uv_off = off
        off += ELEM[typ]
    pos: list[float] = []
    nor: list[float] = []
    uv: list[float] = []
    remap: dict[int, int] = {}
    out_idx: list[int] = []
    for src in indices:
        if src not in remap:
            remap[src] = len(remap)
            base = src * stride
            px, py, pz = struct.unpack_from("<3f", blob, base + (pos_off or 0))
            pos.extend((px, py, pz))
            if nor_off is None:
                nor.extend((0, 1, 0))
            else:
                nor.extend(struct.unpack_from("<3f", blob, base + nor_off))
            if uv_off is None:
                uv.extend((0, 0))
            else:
                u, v = struct.unpack_from("<2f", blob, base + uv_off)
                uv.extend((u, 1 - v))
        out_idx.append(remap[src])
    return pos, nor, uv, out_idx


def material_png(mat_ref: str, root: Path) -> Path | None:
    # "Material;blender/LibraryArchive/Materials/ArchiveFloor.xml"
    rel = mat_ref.split(";")[-1]
    xml = root / rel
    if not xml.exists():
        # path is relative to assets/
        xml = root / "assets" / rel if not str(rel).startswith("assets") else root / rel
    if not xml.exists():
        return None
    tree = ET.parse(xml)
    for tex in tree.getroot().findall("texture"):
        if tex.get("unit") == "diffuse":
            name = tex.get("name") or ""
            png = root / "assets" / name
            return png if png.exists() else None
    return None


def pad4(b: bytes) -> bytes:
    return b + b"\x00" * ((4 - len(b) % 4) % 4)


def build_glb(parts: list[tuple[str, list[dict], list[str]]], asset_root: Path, out: Path) -> None:
    """parts: (node name, prims from read_umd, material refs)."""
    bin_blob = bytearray()
    accessors = []
    buffer_views = []
    meshes = []
    nodes = []
    materials = []
    textures = []
    images = []
    samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
    png_index: dict[str, int] = {}

    def add_view(blob: bytes, target: int) -> int:
        start = len(bin_blob)
        # align to 4
        while len(bin_blob) % 4:
            bin_blob.append(0)
        start = len(bin_blob)
        bin_blob.extend(blob)
        buffer_views.append({"buffer": 0, "byteOffset": start, "byteLength": len(blob), "target": target})
        return len(buffer_views) - 1

    def add_accessor(view: int, count: int, typ: str, comp: int, mins=None, maxs=None) -> int:
        acc = {"bufferView": view, "componentType": comp, "count": count, "type": typ}
        if mins is not None:
            acc["min"] = mins
            acc["max"] = maxs
        accessors.append(acc)
        return len(accessors) - 1

    def texture_for(mat_ref: str) -> int | None:
        png = material_png(mat_ref, asset_root)
        if png is None:
            return None
        key = str(png)
        if key in png_index:
            return png_index[key]
        raw = png.read_bytes()
        view = add_view(raw, 0)  # no target
        # buffer view for images should not have target. Fix: pop target.
        buffer_views[view].pop("target", None)
        images.append({"bufferView": view, "mimeType": "image/png"})
        textures.append({"sampler": 0, "source": len(images) - 1})
        png_index[key] = len(textures) - 1
        return png_index[key]

    for name, prims, mats in parts:
        mesh_prims = []
        for i, prim in enumerate(prims):
            pos, nor, uv, idx = verts_of(prim["vb"], prim["idx"])
            if not idx:
                continue
            pos_b = struct.pack("<" + "f" * len(pos), *pos)
            nor_b = struct.pack("<" + "f" * len(nor), *nor)
            uv_b = struct.pack("<" + "f" * len(uv), *uv)
            idx_b = struct.pack("<" + "H" * len(idx), *idx) if max(idx) < 65535 else struct.pack("<" + "I" * len(idx), *idx)
            comp = 5123 if max(idx) < 65535 else 5125
            xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
            pv = add_view(pos_b, 34962)
            nv = add_view(nor_b, 34962)
            uvv = add_view(uv_b, 34962)
            iv = add_view(idx_b, 34963)
            pa = add_accessor(pv, len(pos) // 3, "VEC3", 5126, [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)])
            na = add_accessor(nv, len(nor) // 3, "VEC3", 5126)
            ta = add_accessor(uvv, len(uv) // 2, "VEC2", 5126)
            ia = add_accessor(iv, len(idx), "SCALAR", comp)
            tex = texture_for(mats[i] if i < len(mats) else "")
            mat = {"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 0.7}, "doubleSided": True}
            if tex is not None:
                mat["pbrMetallicRoughness"]["baseColorTexture"] = {"index": tex}
            materials.append(mat)
            mesh_prims.append({
                "attributes": {"POSITION": pa, "NORMAL": na, "TEXCOORD_0": ta},
                "indices": ia,
                "material": len(materials) - 1,
            })
        meshes.append({"name": name, "primitives": mesh_prims})
        nodes.append({"name": name, "mesh": len(meshes) - 1})

    gltf = {
        "asset": {"version": "2.0", "generator": "umd_to_glb"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "textures": textures,
        "images": images,
        "samplers": samplers,
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": buffer_views,
        "accessors": accessors,
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js = pad4(js)
    bin_blob_b = pad4(bytes(bin_blob))
    # fix buffer length to padded? spec byteLength is unpadded. Keep original.
    gltf["buffers"][0]["byteLength"] = len(bin_blob)
    js = pad4(json.dumps(gltf, separators=(",", ":")).encode())
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        length = 12 + 8 + len(js) + 8 + len(bin_blob_b)
        f.write(struct.pack("<4sII", b"glTF", 2, length))
        f.write(struct.pack("<I4s", len(js), b"JSON"))
        f.write(js)
        f.write(struct.pack("<I4s", len(bin_blob_b), b"BIN\x00"))
        f.write(bin_blob_b)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB) nodes={len(nodes)}")


def mats_of(scene_xml: Path, node_name: str) -> list[str]:
    root = ET.parse(scene_xml).getroot()
    for node in root.iter("node"):
        attrs = {a.get("name"): a.get("value") for a in node.findall("attribute")}
        if attrs.get("Name") != node_name:
            continue
        for comp in node.findall("component"):
            if comp.get("type") != "StaticModel":
                continue
            for a in comp.findall("attribute"):
                if a.get("name") == "Material":
                    return (a.get("value") or "").split(";")[1:]
    return []


def main() -> None:
    asset = Path("/Users/shinjiyu/Documents/magic-library")
    scene = asset / "assets/blender/LibraryArchive/Scene.xml"
    mesh_dir = asset / "assets/blender/LibraryArchive/Meshes"
    out_dir = Path("/Users/shinjiyu/Documents/taptap/magic-library-enji/assets/resources/models")
    names = ["Hall", "Timber", "Openings", "Stairs", "Decor_Stacks", "Decor_Air", "Decor_Front", "Decor_Back", "Decor_Stairs"]
    parts = []
    for name in names:
        prims = read_umd(mesh_dir / f"{name}.mdl")
        mats = mats_of(scene, name)
        print(name, "prims", len(prims), "mats", len(mats))
        parts.append((name, prims, mats))
    build_glb(parts, asset, out_dir / "ArchiveHall.glb")

    bay_scene = asset / "assets/blender/LibraryArchiveBay/Scene.xml"
    bay = read_umd(asset / "assets/blender/LibraryArchiveBay/Meshes/ShelfBay.mdl")
    bay_mats = mats_of(bay_scene, "ShelfBay")
    if len(bay_mats) < len(bay):
        bay_mats = (bay_mats or ["blender/LibraryArchiveBay/Materials/ArchiveOak.xml"]) * len(bay)
    print("ShelfBay prims", len(bay), "mats", bay_mats)
    build_glb([("ShelfBay", bay, bay_mats)], asset, out_dir / "ArchiveBay.glb")


if __name__ == "__main__":
    main()
