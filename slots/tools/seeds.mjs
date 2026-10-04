// usage: node tools/seeds.mjs [maxSeed=20000]
// Replays MainView's RNG use (quiet boot board, then spins at bet 1) and lists
// seeds whose first spin shows a given feature, for ?seed= demos.
import { makeRng, spin } from '../assets/game/math/ThorMath.ts';

const max = Number(process.argv[2] ?? 20000);
const found = { orbWin: [], bigTumble: [], freeSpins: [], superFree: [] };
for (let seed = 1; seed <= max; seed++) {
    const rng = makeRng(seed);
    for (;;) {
        const r = spin(rng, 1, 'base');
        if (!r.tumbles.length && !r.orbs.length && r.scatterCount < 3) break;
    }
    const r = spin(rng, 1, 'base', 0);
    const tag = `${seed}:${r.tumbles.length}t,${r.totalWin}`;
    if (r.tumbleWin > 0 && r.orbs.length) found.orbWin.push(`${tag},x${r.orbSum}`);
    if (r.tumbles.length >= 4) found.bigTumble.push(tag);
    if (r.freeSpinsAwarded && !r.triggersSuper) found.freeSpins.push(tag);
    if (r.triggersSuper) found.superFree.push(tag);
}
for (const [k, v] of Object.entries(found)) console.log(k, v.length, v.slice(0, 8).join('  '));
