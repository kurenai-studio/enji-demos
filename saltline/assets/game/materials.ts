import { Color, EffectAsset, Material, Vec3, Vec4 } from 'cc';
import { bakeAsphalt, bakeCaution, bakeConcrete, bakeHull, bakeMetal, bakePaint, bakeWater, bakeWood, type SurfaceMaps } from './textures';

export interface HarborMaterials {
    asphalt: Material;
    water: Material;
    concrete: Material;
    metal: Material;
    hull: Material;
    caution: Material;
    wood: Material;
    dark: Material;
    lamp: Material;
    stripe: Material;
    paints: Material[];
}

const PAINTS: Array<[number, number, number]> = [
    [168, 46, 40],
    [28, 74, 138],
    [32, 102, 78],
    [176, 90, 38],
    [122, 124, 118],
    [206, 164, 36],
];

export function makeMaterials(effect: EffectAsset): HarborMaterials {
    const flat = (maps: SurfaceMaps, tile: Vec4) => surfaceMaterial(effect, maps, tile, false);
    const ribbed = (maps: SurfaceMaps, tile: Vec4) => surfaceMaterial(effect, maps, tile, true);
    return {
        asphalt: flat(bakeAsphalt(), new Vec4(1, 1, 0, 0)),
        water: flat(bakeWater(), new Vec4(5, 3, 0, 0)),
        concrete: ribbed(bakeConcrete(), new Vec4(2, 2, 0, 0)),
        metal: flat(bakeMetal(), new Vec4(2, 2, 0, 0)),
        hull: ribbed(bakeHull(), new Vec4(2, 1, 0, 0)),
        caution: flat(bakeCaution(), new Vec4(1, 1, 0, 0)),
        wood: flat(bakeWood(), new Vec4(2, 1, 0, 0)),
        dark: solid(effect, new Color(12, 14, 16, 255), 0.9, 0),
        lamp: lampMaterial(effect),
        stripe: solid(effect, new Color(214, 216, 210, 255), 0.55, 0.05),
        paints: PAINTS.map((rgb) => ribbed(bakePaint(rgb), new Vec4(1, 1, 0, 0))),
    };
}

function surfaceMaterial(effect: EffectAsset, maps: SurfaceMaps, tile: Vec4, normals: boolean): Material {
    const defines: Record<string, boolean> = {
        USE_ALBEDO_MAP: true,
        USE_PBR_MAP: true,
    };
    if (normals) defines.USE_NORMAL_MAP = true;
    const mat = new Material();
    mat.initialize({ effectAsset: effect, defines });
    mat.setProperty('mainTexture', maps.albedo);
    if (normals) mat.setProperty('normalMap', maps.normal);
    mat.setProperty('pbrMap', maps.pbr);
    mat.setProperty('mainColor', Color.WHITE);
    mat.setProperty('roughness', 1);
    mat.setProperty('metallic', 1);
    mat.setProperty('specularIntensity', 1);
    mat.setProperty('occlusion', 1);
    if (normals) mat.setProperty('normalStrength', 1);
    mat.setProperty('tilingOffset', tile);
    return mat;
}

function solid(effect: EffectAsset, color: Color, roughness: number, metallic: number): Material {
    const mat = new Material();
    mat.initialize({ effectAsset: effect });
    mat.setProperty('mainColor', color);
    mat.setProperty('roughness', roughness);
    mat.setProperty('metallic', metallic);
    mat.setProperty('specularIntensity', 0.5);
    return mat;
}

function lampMaterial(effect: EffectAsset): Material {
    const mat = new Material();
    mat.initialize({ effectAsset: effect });
    const color = new Color(255, 186, 120, 255);
    mat.setProperty('mainColor', color);
    mat.setProperty('emissive', color);
    mat.setProperty('emissiveScale', new Vec3(3, 2.4, 1.6));
    mat.setProperty('roughness', 0.35);
    mat.setProperty('metallic', 0);
    return mat;
}
