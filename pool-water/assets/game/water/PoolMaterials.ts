import { Material, RenderTexture, Texture2D, TextureCube, Vec3, Vec4 } from 'cc';
import { loadEffect } from '../../enji/helpers';

export interface PoolTextureSet {
    water: Texture2D;
    tiles: Texture2D;
    deck: Texture2D;
    caustics: RenderTexture;
    sky: TextureCube;
}

/**
 * Creates the materials of every pool effect and keeps their shared uniforms
 * (`PoolScene` block in pool-common.chunk) in sync. Texture objects are bound
 * once; the simulation re-uploads into the same Texture2D every frame.
 */
export class PoolMaterials {
    private readonly all: Material[];
    private readonly sphereParams = new Vec4();

    private constructor(
        readonly waterAbove: Material,
        readonly waterBelow: Material,
        readonly walls: Material,
        readonly sphere: Material,
        readonly caustics: Material,
        readonly sky: Material,
        readonly deck: Material,
    ) {
        this.all = [waterAbove, waterBelow, walls, sphere, caustics, sky, deck];
    }

    static async create(textures: PoolTextureSet): Promise<PoolMaterials> {
        const [water, walls, sphere, caustics, sky, deck] = await Promise.all(
            ['water', 'walls', 'sphere', 'caustics', 'sky', 'deck'].map((name) => loadEffect(`effects/pool-${name}`)),
        );
        const make = (effectAsset: typeof water, technique = 0) => {
            const material = new Material();
            material.initialize({ effectAsset, technique });
            return material;
        };
        const materials = new PoolMaterials(
            make(water, 0),
            make(water, 1),
            make(walls),
            make(sphere),
            make(caustics),
            make(sky),
            make(deck),
        );
        materials.bindTextures(textures);
        return materials;
    }

    setLight(direction: Readonly<Vec3>): void {
        const value = new Vec4(direction.x, direction.y, direction.z, 0);
        for (const material of this.all) material.setProperty('lightDir', value);
    }

    setSphere(center: Readonly<Vec3>, radius: number): void {
        this.sphereParams.set(center.x, center.y, center.z, radius);
        for (const material of this.all) material.setProperty('sphereParams', this.sphereParams);
    }

    private bindTextures(t: PoolTextureSet): void {
        for (const material of [this.waterAbove, this.waterBelow]) {
            material.setProperty('waterTex', t.water);
            material.setProperty('tileTex', t.tiles);
            material.setProperty('causticTex', t.caustics);
            material.setProperty('skyTex', t.sky);
        }
        this.walls.setProperty('waterTex', t.water);
        this.walls.setProperty('tileTex', t.tiles);
        this.walls.setProperty('causticTex', t.caustics);
        this.sphere.setProperty('waterTex', t.water);
        this.sphere.setProperty('causticTex', t.caustics);
        this.caustics.setProperty('waterTex', t.water);
        this.deck.setProperty('deckTex', t.deck);
    }
}
