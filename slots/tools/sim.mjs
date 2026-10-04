// usage: node tools/sim.mjs [spins=1000000] [seed=1]
// Monte Carlo RTP of assets/game/math/ThorMath.ts (base game + free spins).
import { makeRng, spin, FREE_SPINS_AWARD, SUPER_START_MULTIPLIER } from '../assets/game/math/ThorMath.ts';

const N = Number(process.argv[2] ?? 1e6);
const rng = makeRng(Number(process.argv[3] ?? 1));
const bet = 1;

let base = 0, scatter = 0, free = 0, hits = 0, triggers = 0, supers = 0, maxWin = 0, freeSpinsPlayed = 0;
let tumbleSum = 0, orbHits = 0;
const buckets = { '0': 0, '<1x': 0, '1-5x': 0, '5-20x': 0, '20-100x': 0, '100-1000x': 0, '1000x+': 0 };

for (let i = 0; i < N; i++) {
    const r = spin(rng, bet, 'base');
    let win = r.totalWin;
    base += r.totalWin - r.scatterWin;
    scatter += r.scatterWin;
    tumbleSum += r.tumbles.length;
    if (r.tumbleWin > 0 && r.orbSum > 0) orbHits++;
    if (r.freeSpinsAwarded) {
        triggers++;
        if (r.triggersSuper) supers++;
        let left = r.freeSpinsAwarded;
        let running = r.triggersSuper ? SUPER_START_MULTIPLIER : 0;
        while (left > 0) {
            left--;
            freeSpinsPlayed++;
            const f = spin(rng, bet, 'free', running);
            if (f.tumbleWin > 0) running += f.orbSum;
            left += f.freeSpinsAwarded;
            free += f.totalWin;
            win += f.totalWin;
        }
    }
    if (win > 0) hits++;
    maxWin = Math.max(maxWin, win);
    const x = win / bet;
    buckets[x === 0 ? '0' : x < 1 ? '<1x' : x < 5 ? '1-5x' : x < 20 ? '5-20x' : x < 100 ? '20-100x' : x < 1000 ? '100-1000x' : '1000x+']++;
}

const pct = (v) => ((100 * v) / (N * bet)).toFixed(2) + '%';
console.log(`spins ${N}`);
console.log(`RTP ${pct(base + scatter + free)}  (base ${pct(base)}, scatter ${pct(scatter)}, free spins ${pct(free)})`);
console.log(`hit rate ${(100 * hits / N).toFixed(1)}%  avg tumbles ${(tumbleSum / N).toFixed(2)}  orb-multiplied wins 1 in ${Math.round(N / Math.max(1, orbHits))}`);
console.log(`free spins 1 in ${Math.round(N / Math.max(1, triggers))} (super ${supers}), avg length ${(freeSpinsPlayed / Math.max(1, triggers)).toFixed(1)}, max win ${maxWin.toFixed(1)}x`);
console.log('win distribution', Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, (100 * v / N).toFixed(2) + '%'])));
