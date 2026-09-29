import { Material, Mesh, MeshRenderer, Node, primitives, RenderTexture, Texture2D, toRadian, utils, Vec3 } from 'cc';
import { createTexturePass } from '../../enji/helpers';
import { FloatingSphere } from './FloatingSphere';
import { createDeck, createPoolBox, createWaterGrid } from './PoolGeometry';
import { PoolMaterials } from './PoolMaterials';
import { createDeckTexture, createSkyCubemap, createTileTexture } from './PoolTextures';
import { WaterSimulation } from './WaterSimulation';

/** Physics and wave simulation run at a fixed 60 Hz, at most 4 steps per frame. */
const STEP = 1 / 60;
const MAX_STEPS = 4;

export interface PoolSettings {
    rain: boolean;
    rainIntensity: number;
    paused: boolean;
}

/**
 * The whole pool: water simulation, floating sphere and every renderer
 * (water surface from above and below, walls, sphere, deck, sky, caustics pass).
 * Call `update(dt)` once per frame before rendering.
 */
export class PoolScene {
    readonly settings: PoolSettings = { rain: false, rainIntensity: 0.35, paused: false };
    readonly sphere = new FloatingSphere();
    /** CPU time of the last frame's physics, simulation and texture upload, in ms. */
    simMs = 0;

    private accumulator = 0;

    private constructor(
        readonly simulation: WaterSimulation,
        private readonly materials: PoolMaterials,
        private readonly sphereNode: Node,
    ) {}

    static async create(parent: Node, sunAzimuth = -26.6, sunElevation = 41.8): Promise<PoolScene> {
        const az = toRadian(sunAzimuth);
        const el = toRadian(sunElevation);
        const light = new Vec3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();

        const simulation = new WaterSimulation(256);
        const caustics = new RenderTexture();
        caustics.reset({ width: 1024, height: 1024 });
        caustics.setFilters(Texture2D.Filter.LINEAR, Texture2D.Filter.LINEAR);
        caustics.setWrapMode(Texture2D.WrapMode.CLAMP_TO_EDGE, Texture2D.WrapMode.CLAMP_TO_EDGE);

        const materials = await PoolMaterials.create({
            water: simulation.texture,
            tiles: createTileTexture(),
            deck: createDeckTexture(),
            caustics,
            sky: createSkyCubemap(light),
        });
        materials.setLight(light);

        const waterGrid = createWaterGrid(200);
        addRenderer(parent, 'Sky', utils.MeshUtils.createMesh(primitives.sphere(150, { segments: 64 })), materials.sky);
        addRenderer(parent, 'Deck', createDeck(400), materials.deck);
        addRenderer(parent, 'PoolWalls', createPoolBox(), materials.walls);
        addRenderer(parent, 'WaterAbove', waterGrid, materials.waterAbove);
        addRenderer(parent, 'WaterBelow', waterGrid, materials.waterBelow);
        const sphereNode = addRenderer(parent, 'Sphere', utils.MeshUtils.createMesh(primitives.sphere(1, { segments: 64 })), materials.sphere);
        createTexturePass(parent, materials.caustics, caustics, { mesh: waterGrid });

        const pool = new PoolScene(simulation, materials, sphereNode);
        pool.randomDrops();
        pool.syncSphere();
        simulation.upload();
        return pool;
    }

    update(dt: number): void {
        if (!this.settings.paused) {
            const start = performance.now();
            this.accumulator += Math.min(dt, 0.1);
            let steps = 0;
            while (this.accumulator >= STEP && steps < MAX_STEPS) {
                this.physicsStep();
                this.accumulator -= STEP;
                steps++;
            }
            if (steps === MAX_STEPS) this.accumulator = 0;
            if (steps > 0) {
                this.simulation.updateNormals();
                this.simulation.upload();
            }
            this.simMs = performance.now() - start;
        }
        this.syncSphere();
    }

    randomDrops(count = 20): void {
        for (let i = 0; i < count; i++) {
            this.simulation.addDrop(Math.random() * 2 - 1, Math.random() * 2 - 1, 0.03, i & 1 ? 0.01 : -0.01);
        }
    }

    flatten(): void {
        this.simulation.reset();
        this.simulation.upload();
    }

    private physicsStep(): void {
        const sphere = this.sphere;
        sphere.step(STEP);
        this.simulation.moveSphere(sphere.oldCenter, sphere.center, sphere.radius);
        sphere.commitMove();

        if (this.settings.rain) {
            const rate = this.settings.rainIntensity * 3;
            const count = Math.floor(rate) + (Math.random() < rate - Math.floor(rate) ? 1 : 0);
            for (let i = 0; i < count; i++) {
                this.simulation.addDrop(
                    Math.random() * 2 - 1,
                    Math.random() * 2 - 1,
                    0.012 + Math.random() * 0.01,
                    -(0.004 + Math.random() * 0.006),
                );
            }
        }

        this.simulation.step();
        this.simulation.step();
    }

    private syncSphere(): void {
        const { center, radius } = this.sphere;
        this.sphereNode.setPosition(center);
        this.sphereNode.setScale(radius, radius, radius);
        this.materials.setSphere(center, radius);
    }
}

function addRenderer(parent: Node, name: string, mesh: Mesh, material: Material): Node {
    const node = new Node(name);
    parent.addChild(node);
    const renderer = node.addComponent(MeshRenderer);
    renderer.mesh = mesh;
    renderer.setSharedMaterial(material, 0);
    return node;
}
