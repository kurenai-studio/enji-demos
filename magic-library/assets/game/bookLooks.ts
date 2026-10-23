import { Mesh, utils } from 'cc';

/** Book atlas is 2048². glTF flips V, so a pixel shift +Y in the atlas is −V. */
const ATLAS = 2048;
const COVER = 160 / ATLAS;
const COVER_V0 = 1 - 240 / ATLAS;
const SPINE_U = 40 / ATLAS;
const SPINE_V0 = 1 - (960 + 240) / ATLAS;
const SPINE_V1 = 1 - 960 / ATLAS;

function coverOrigin(subject: number, emblem: number) {
    const i = subject * 6 + emblem;
    return { x: (i % 12) * 160, y: Math.floor(i / 12) * 240 };
}

function spineOrigin(subject: number, emblem: number, volumeIndex: number) {
    const i = (subject * 6 + emblem) * 3 + volumeIndex;
    return { x: (i % 48) * 40, y: 960 + Math.floor(i / 48) * 240 };
}

function remapUvs(base: number[], subject: number, emblem: number, volume: number) {
    const cover = coverOrigin(subject, emblem);
    const spine = spineOrigin(subject, emblem, volume - 1);
    const duC = cover.x / ATLAS;
    const dvC = -cover.y / ATLAS;
    const duS = spine.x / ATLAS;
    const dvS = -(spine.y - 960) / ATLAS;
    const uvs = base.slice();
    for (let i = 0; i < uvs.length; i += 2) {
        const u = uvs[i];
        const v = uvs[i + 1];
        if (u >= -0.002 && u <= COVER + 0.002 && v >= COVER_V0 - 0.002 && v <= 1.002) {
            uvs[i] = u + duC;
            uvs[i + 1] = v + dvC;
        } else if (u >= -0.002 && u <= SPINE_U + 0.002 && v >= SPINE_V0 - 0.002 && v <= SPINE_V1 + 0.002) {
            uvs[i] = u + duS;
            uvs[i + 1] = v + dvS;
        }
    }
    return uvs;
}

/** 144 meshes sharing the one book atlas: index = subject*18 + emblem*3 + (volume-1). */
export function buildBookMeshes(source: Mesh): Mesh[] {
    const geo = utils.readMesh(source, 0);
    const base = geo.uvs ?? [];
    const meshes: Mesh[] = [];
    for (let subject = 0; subject < 8; subject++) {
        for (let emblem = 0; emblem < 6; emblem++) {
            for (let volume = 1; volume <= 3; volume++) {
                meshes.push(utils.createMesh({
                    positions: geo.positions,
                    normals: geo.normals,
                    uvs: remapUvs(base, subject, emblem, volume),
                    indices: geo.indices,
                }));
            }
        }
    }
    return meshes;
}

export function bookMeshIndex(subject: number, emblem: number, volume: number) {
    return subject * 18 + emblem * 3 + (volume - 1);
}
