import { Mesh, utils, Vec3 } from 'cc';
import { POS_MIN, POS_RANGE } from './Particles';

/** Particles per mesh: four vertices each keeps the indices 16-bit. */
export const CHUNK = 16384;

/**
 * Quads for particles [first, first + CHUNK): each vertex is (0 tail / 1
 * head, −1 / +1 across, particle index); hp-particle.effect places them.
 * The bounds are the whole simulation box, so the mesh is never culled.
 */
export function particleChunk(first: number): Mesh {
    const positions = new Float32Array(CHUNK * 12);
    const indices = new Uint16Array(CHUNK * 6);
    for (let i = 0; i < CHUNK; i++) {
        const id = first + i;
        positions.set([0, -1, id, 1, -1, id, 1, 1, id, 0, 1, id], i * 12);
        const v = i * 4;
        indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    return utils.MeshUtils.createMesh({
        positions: Array.from(positions),
        indices: Array.from(indices),
        minPos: new Vec3(POS_MIN[0], POS_MIN[1], POS_MIN[2]),
        maxPos: new Vec3(POS_MIN[0] + POS_RANGE, POS_MIN[1] + POS_RANGE, POS_MIN[2] + POS_RANGE),
    });
}
