// usage: node tools/demo-seed.mjs [maxSeed=200000]
// Replays MainView's RNG use for a whole session at bet 1 and lists seeds whose first few base spins
// show a cascade and an orb win, then trigger free spins with a presentable total - for tools/record.mjs.
import { FREE_SPINS_AWARD, SUPER_START_MULTIPLIER, makeRng, round2, spin } from '../assets/game/math/ThorMath.ts';

const max = Number(process.argv[2] ?? 200000);
const hits = [];
for (let seed = 1; seed <= max && hits.length < 12; seed++) {
    const rng = makeRng(seed);
    for (;;) {
        const r = spin(rng, 1, 'base');
        if (!r.tumbles.length && !r.orbs.length && r.scatterCount < 3) break;
    }
    let cascade = -1;
    let orb = -1;
    let trigger = -1;
    let superFs = false;
    for (let i = 0; i < 5; i++) {
        const r = spin(rng, 1, 'base', 0);
        if (r.freeSpinsAwarded) {
            trigger = i;
            superFs = r.triggersSuper;
            break;
        }
        if (r.tumbles.length >= 3 && cascade < 0) cascade = i;
        if (r.tumbleWin > 0 && r.orbs.length && orb < 0) orb = i;
    }
    if (trigger < 3 || cascade < 0 || orb < 0) continue;
    let left = FREE_SPINS_AWARD;
    let running = superFs ? SUPER_START_MULTIPLIER : 0;
    let total = 0;
    let spins = 0;
    let retriggers = 0;
    let bigWins = 0;
    while (left > 0) {
        left--;
        spins++;
        const r = spin(rng, 1, 'free', running);
        if (r.tumbleWin > 0 && r.appliedMultiplier > 1) running = r.appliedMultiplier;
        if (r.freeSpinsAwarded) {
            left += r.freeSpinsAwarded;
            retriggers++;
        }
        if (r.totalWin >= 20) bigWins++;
        total = round2(total + r.totalWin);
    }
    if (total < 40 || total > 400 || spins > 20 || bigWins < 1) continue;
    hits.push(`${seed}: cascade@${cascade} orb@${orb} fs@${trigger}${superFs ? ' SUPER' : ''} spins ${spins} retrig ${retriggers} big ${bigWins} total ${total} endX${running}`);
}
console.log(hits.join('\n'));
