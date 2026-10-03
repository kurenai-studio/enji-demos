// Bake cost and accuracy tables for the README.
// Run: node --no-warnings --import ./tools/ts-resolve.mjs tools/bench.mts
import { Bake, RGB_STRIDE } from '../assets/game/prt/Bake.ts';
import { LAMP_SIZES, posed, presets, projectEnv, projectSky, withGroundBounce } from '../assets/game/prt/Env.ts';
import { prtRadiance, Reference, relativeRms } from '../assets/game/prt/Reference.ts';
import { GROUND, SCENES } from '../assets/game/prt/Scenes.ts';
import { COEFFS, hannWindow, truncate } from '../assets/game/prt/SH.ts';

const envs = presets().map((e) => withGroundBounce(e, GROUND));

console.log('scene      vertices  rays   BVH ms  rays s  M rays/s  bounces s  W non-zeros  bake MB');
for (const make of SCENES) {
    const geo = make();
    for (const rays of [64, 256, 1024]) {
        const t = performance.now();
        const bake = new Bake(geo, rays, 3);
        const bvhMs = performance.now() - t;
        bake.run();
        console.log(`${geo.name.padEnd(10)} ${String(geo.vertexCount).padStart(8)} ${String(rays).padStart(5)} ${bvhMs.toFixed(0).padStart(8)} `
            + `${(bake.rayMs / 1000).toFixed(2).padStart(7)} ${(bake.raysTraced / bake.rayMs / 1000).toFixed(2).padStart(9)} `
            + `${(bake.bounceMs / 1000).toFixed(2).padStart(10)} ${String(bake.nonZeros).padStart(12)} ${(bake.bytes / 1e6).toFixed(1).padStart(8)}`);
    }
}

console.log('\nshadowed PRT vs reference, relative RMS (bands 2 / 3 / 4 / 5, plain | Hann)');
for (const make of SCENES) {
    const geo = make();
    const bake = new Bake(geo, 256, 3).run();
    const tr = new Float32Array(geo.vertexCount * RGB_STRIDE), out = new Float32Array(geo.vertexCount * 3);
    bake.transfer(1, tr);
    for (const base of [envs[0], envs[3]]) for (const size of LAMP_SIZES) {
        const env = posed(base, 0, size);
        const full = new Float64Array(COEFFS * 3);
        projectEnv(env, projectSky(env), full);
        const ref = new Reference(bake, env, 3).run();
        const row = (window: boolean): string => [2, 3, 4, 5].map((bands) => {
            const l = Float64Array.from(full);
            truncate(l, bands, window ? hannWindow(bands) : null);
            prtRadiance(tr, l, geo.vertexCount, out);
            return (relativeRms(out, ref.direct) * 100).toFixed(1).padStart(5);
        }).join(' ');
        console.log(`${geo.name.padEnd(10)} ${env.name.padEnd(7)} lamps ×${String(size).padEnd(4)} ${row(false)} | ${row(true)}   reference ${ref.ms.toFixed(0)} ms`);
    }
}
