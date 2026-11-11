import { Material, MeshRenderer, Node, primitives, utils, Vec4 } from 'cc';
import type { HarborMaterials } from './materials';

/**
 * A slice of the Saltline yard, in metres.
 * 40-foot box: 12.19 × 2.59 × 2.44. 20-foot: 6.06 × 2.59 × 2.44. One high-cube is 2.90 tall.
 * Parts are boxes and cylinders. Corrugation is the paint normal, not extra triangles.
 */
export function buildHarbor(parent: Node, mats: HarborMaterials): void {
    plane(parent, 'Apron', 42, 28, mats.asphalt, 0, 0, 12, false);
    plane(parent, 'Water', 52, 26, mats.water, 0, -0.05, -16, false);
    box(parent, 'Quay', 46, 0.55, 1.35, mats.concrete, 0, 0.2, -2.15, new Vec4(8, 1, 0, 0), 0.6, undefined, false);

    container(parent, 'Red40', 12.19, 2.59, 2.44, mats.paints[0], mats, -7.2, 6.4, 8);
    container(parent, 'Blue20', 6.06, 2.59, 2.44, mats.paints[1], mats, 4.6, 5.6, -6);
    container(parent, 'Orange20', 6.06, 2.59, 2.44, mats.paints[3], mats, 4.6, 5.6, -6, 2.59);
    container(parent, 'Green40', 12.19, 2.9, 2.44, mats.paints[2], mats, -1.4, 13.6, 4);
    container(parent, 'Gray20', 6.06, 2.59, 2.44, mats.paints[4], mats, 10.2, 11.4, 82);

    shed(parent, mats);
    crane(parent, mats.metal);
    boat(parent, mats);
    forklift(parent, mats);
    bollards(parent, mats.metal);
    lamp(parent, mats, -11.5, 3.2);
    lamp(parent, mats, 6.5, -1.2);

    box(parent, 'Pallet', 1.2, 0.14, 1.0, mats.wood, -2.2, 0.07, 4.2, new Vec4(1, 1, 0, 0));
    box(parent, 'Pallet2', 1.2, 0.14, 1.0, mats.wood, -2.2, 0.22, 4.35, new Vec4(1, 1, 0, 0));
    box(parent, 'Barrier', 2.4, 0.72, 0.16, mats.caution, 7.4, 0.36, 8.2, new Vec4(2, 1, 0, 0), 1, [0, 18, 0]);
    for (let i = 0; i < 3; i++) {
        cyl(parent, `Bottle${i}`, 0.16, 0.95, mats.metal, 11.2 + i * 0.42, 0.48, 12.4);
    }
}

function shed(parent: Node, mats: HarborMaterials): void {
    const root = new Node('Shed');
    parent.addChild(root);
    root.setPosition(14.2, 0, 16.2);
    box(root, 'Walls', 8.4, 4.1, 6.2, mats.concrete, 0, 2.05, 0, new Vec4(2, 1, 0, 0), 0.5);
    box(root, 'Roof', 8.9, 0.16, 6.7, mats.metal, 0, 4.2, 0, new Vec4(3, 2, 0, 0));
    box(root, 'Door', 1.7, 2.5, 0.08, mats.dark, 0, 1.25, 3.12);
    box(root, 'WinL', 0.7, 0.45, 0.06, mats.lamp, -2.2, 2.7, 3.14);
    box(root, 'WinR', 0.7, 0.45, 0.06, mats.lamp, 2.2, 2.7, 3.14);
}

function crane(parent: Node, metal: Material): void {
    const root = new Node('Crane');
    parent.addChild(root);
    box(root, 'LegA', 0.42, 14.5, 0.42, metal, -16.5, 7.25, 1.2, new Vec4(1, 4, 0, 0));
    box(root, 'LegB', 0.42, 14.5, 0.42, metal, -16.5, 7.25, -5.4, new Vec4(1, 4, 0, 0));
    box(root, 'Bridge', 0.5, 0.42, 7.4, metal, -16.5, 14.4, -2.1, new Vec4(1, 2, 0, 0));
    box(root, 'Jib', 11.5, 0.32, 0.38, metal, -10.6, 14.55, -2.1, new Vec4(4, 1, 0, 0));
    box(root, 'Cab', 1.1, 1.3, 1.2, metal, -15.6, 13.2, -2.1, new Vec4(1, 1, 0, 0));
}

function boat(parent: Node, mats: HarborMaterials): void {
    const root = new Node('Boat');
    parent.addChild(root);
    root.setPosition(-1.6, 0, -8.6);
    root.setRotationFromEuler(0, -8, 0);
    box(root, 'Hull', 6.6, 1.15, 2.35, mats.hull, 0, 0.42, 0, new Vec4(2, 1, 0, 0), 0.7);
    box(root, 'Cabin', 2.3, 1.25, 2.05, mats.concrete, 0.7, 1.45, 0, new Vec4(1, 1, 0, 0), 0.5);
    box(root, 'Glass', 0.9, 0.4, 0.05, mats.lamp, 1.5, 1.7, 1.05);
}

function forklift(parent: Node, mats: HarborMaterials): void {
    const root = new Node('Forklift');
    parent.addChild(root);
    root.setPosition(7.8, 0, 8.8);
    root.setRotationFromEuler(0, 24, 0);
    box(root, 'Body', 2.15, 0.62, 1.05, mats.paints[5], -0.15, 0.55, 0, new Vec4(3, 1, 0, 0), 0.6);
    box(root, 'Cab', 0.85, 1.05, 0.95, mats.metal, -0.45, 1.25, 0, new Vec4(1, 1, 0, 0));
    box(root, 'Mast', 0.12, 2.15, 0.95, mats.metal, 0.95, 1.15, 0, new Vec4(1, 2, 0, 0));
    box(root, 'ForkL', 1.15, 0.05, 0.12, mats.metal, 1.45, 0.18, 0.28);
    box(root, 'ForkR', 1.15, 0.05, 0.12, mats.metal, 1.45, 0.18, -0.28);
    const wheels: Array<[number, number]> = [[0.55, 0.42], [0.55, -0.42], [-0.7, 0.42], [-0.7, -0.42]];
    for (const [x, z] of wheels) {
        cyl(root, 'Wheel', 0.28, 0.16, mats.dark, x, 0.28, z, [0, 0, 90]);
    }
}

function bollards(parent: Node, metal: Material): void {
    for (let x = -14; x <= 16; x += 4) {
        const root = new Node('Bollard');
        parent.addChild(root);
        root.setPosition(x, 0, -1.35);
        cyl(root, 'Post', 0.16, 0.7, metal, 0, 0.35, 0);
        cyl(root, 'Cap', 0.22, 0.1, metal, 0, 0.72, 0);
    }
}

function lamp(parent: Node, mats: HarborMaterials, x: number, z: number): void {
    const root = new Node('Lamp');
    parent.addChild(root);
    root.setPosition(x, 0, z);
    cyl(root, 'Mast', 0.1, 7.2, mats.metal, 0, 3.6, 0);
    box(root, 'Arm', 1.4, 0.08, 0.08, mats.metal, 0.6, 7.15, 0);
    box(root, 'Head', 0.55, 0.16, 0.28, mats.lamp, 1.25, 7.02, 0);
}

function container(
    parent: Node,
    name: string,
    sx: number,
    sy: number,
    sz: number,
    paint: Material,
    mats: HarborMaterials,
    x: number,
    z: number,
    yaw: number,
    lift = 0,
): void {
    const root = new Node(name);
    parent.addChild(root);
    root.setPosition(x, 0, z);
    root.setRotationFromEuler(0, yaw, 0);
    const y = sy / 2 + lift;
    box(root, 'Shell', sx, sy, sz, paint, 0, y, 0, new Vec4(Math.max(10, sx * 1.15), 1, 0, 0), 1.6);
    const post = 0.14;
    for (const px of [-1, 1]) {
        for (const pz of [-1, 1]) {
            box(
                root,
                'Post',
                post,
                sy + 0.04,
                post,
                mats.metal,
                px * (sx / 2 - post * 0.25),
                y,
                pz * (sz / 2 - post * 0.25),
                new Vec4(1, 4, 0, 0),
            );
        }
    }
    box(root, 'RailA', sx * 0.96, 0.07, 0.07, mats.metal, 0, lift + sy - 0.04, sz / 2 - 0.02, new Vec4(6, 1, 0, 0));
    box(root, 'RailB', sx * 0.96, 0.07, 0.07, mats.metal, 0, lift + sy - 0.04, -sz / 2 + 0.02, new Vec4(6, 1, 0, 0));
    box(root, 'Door', 0.04, sy * 0.9, sz * 0.84, paint, sx / 2 + 0.015, y, 0, new Vec4(1.2, 1, 0, 0), 0.15);
    box(root, 'Bar', 0.025, sy * 0.76, 0.04, mats.metal, sx / 2 + 0.045, y, 0, new Vec4(1, 3, 0, 0));
    box(root, 'Band', sx * 0.42, 0.09, 0.02, mats.stripe, -sx * 0.12, lift + sy * 0.78, sz / 2 + 0.012);
}

function plane(parent: Node, name: string, width: number, length: number, mat: Material, x: number, y: number, z: number, cast: boolean): Node {
    return mesh(parent, name, primitives.plane({ width, length }), mat, x, y, z, undefined, 1, undefined, cast);
}

function box(
    parent: Node,
    name: string,
    sx: number,
    sy: number,
    sz: number,
    mat: Material,
    x: number,
    y: number,
    z: number,
    tile?: Vec4,
    normal = 1,
    euler?: [number, number, number],
    cast = true,
): Node {
    return mesh(parent, name, primitives.box({ width: sx, height: sy, length: sz }), mat, x, y, z, tile, normal, euler, cast);
}

function cyl(
    parent: Node,
    name: string,
    radius: number,
    height: number,
    mat: Material,
    x: number,
    y: number,
    z: number,
    euler?: [number, number, number],
): Node {
    return mesh(
        parent,
        name,
        primitives.cylinder(radius, radius, height, { radialSegments: 12 }),
        mat,
        x,
        y,
        z,
        undefined,
        1,
        euler,
        true,
    );
}

function mesh(
    parent: Node,
    name: string,
    geometry: primitives.IGeometry,
    mat: Material,
    x: number,
    y: number,
    z: number,
    tile?: Vec4,
    normal = 1,
    euler?: [number, number, number],
    cast = true,
): Node {
    const node = new Node(name);
    parent.addChild(node);
    node.setPosition(x, y, z);
    if (euler) node.setRotationFromEuler(euler[0], euler[1], euler[2]);
    const renderer = node.addComponent(MeshRenderer);
    renderer.mesh = utils.MeshUtils.createMesh(geometry);
    renderer.setSharedMaterial(mat, 0);
    if (tile || normal !== 1) {
        const inst = renderer.getMaterialInstance(0);
        if (tile) inst?.setProperty('tilingOffset', tile);
        if (normal !== 1) inst?.setProperty('normalStrength', normal);
    }
    renderer.shadowCastingMode = cast ? MeshRenderer.ShadowCastingMode.ON : MeshRenderer.ShadowCastingMode.OFF;
    renderer.receiveShadow = MeshRenderer.ShadowReceivingMode.ON;
    return node;
}
