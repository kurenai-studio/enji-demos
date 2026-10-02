export type MoveFx = 'claw' | 'fire' | 'howl' | 'big' | 'bite' | 'pinch' | 'stomp';

export interface MoveDef {
    name: string;
    power: number;
    pp: number;
    mp: number;
    fx: MoveFx;
}

export interface SpeciesDef {
    id: string;
    name: string;
    /** imported glTF under assets/resources (without extension) */
    model: string;
    lv: number;
    hp: number;
    mp: number;
    atk: number;
    def: number;
    moves: MoveDef[];
}

export const PLAYER_MOVES: MoveDef[] = [
    { name: '影爪', power: 12, pp: 20, mp: 0, fx: 'claw' },
    { name: '鬼火', power: 18, pp: 10, mp: 6, fx: 'fire' },
    { name: '夜啼', power: 15, pp: 15, mp: 4, fx: 'howl' },
    { name: '怪谈斩', power: 30, pp: 5, mp: 12, fx: 'big' },
];

export const PLAYER_SPECIES: SpeciesDef = {
    id: 'cat', name: '墨猫', model: 'models/pets/animal-cat', lv: 16, hp: 90, mp: 30, atk: 14, def: 11,
    moves: PLAYER_MOVES,
};

export const ENEMY_SPECIES: SpeciesDef[] = [
    { id: 'fox', name: '赤影狐', model: 'models/pets/animal-fox', lv: 14, hp: 68, mp: 0, atk: 11, def: 10,
        moves: [{ name: '狐咬', power: 9, pp: 99, mp: 0, fx: 'bite' }, { name: '影遁击', power: 13, pp: 99, mp: 0, fx: 'claw' }] },
    { id: 'crab', name: '血钳蟹', model: 'models/pets/animal-crab', lv: 13, hp: 74, mp: 0, atk: 10, def: 12,
        moves: [{ name: '血钳', power: 10, pp: 99, mp: 0, fx: 'pinch' }, { name: '泡沫', power: 8, pp: 99, mp: 0, fx: 'bite' }] },
    { id: 'polar', name: '白幽熊', model: 'models/pets/animal-polar', lv: 15, hp: 80, mp: 0, atk: 12, def: 11,
        moves: [{ name: '冰掌', power: 11, pp: 99, mp: 0, fx: 'stomp' }, { name: '咆哮', power: 7, pp: 99, mp: 0, fx: 'bite' }] },
    { id: 'tiger', name: '虎煞', model: 'models/pets/animal-tiger', lv: 16, hp: 84, mp: 0, atk: 13, def: 10,
        moves: [{ name: '虎扑', power: 12, pp: 99, mp: 0, fx: 'stomp' }, { name: '撕咬', power: 10, pp: 99, mp: 0, fx: 'bite' }] },
];

export interface ItemDef {
    name: string;
    desc: string;
    heal: number;
    mp: number;
}

export const ITEMS: ItemDef[] = [
    { name: '伤药', desc: '回复 30 HP', heal: 30, mp: 0 },
    { name: '灵露', desc: '回复 10 MP', heal: 0, mp: 10 },
];

export const START_ITEMS = [3, 2];
export const PARTY_MAX = 6;

/** Deterministic RNG (mulberry32) so `?seed=` playthroughs repeat exactly. */
export function makeRng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function damage(power: number, atk: number, def: number, lv: number, roll: number): number {
    return Math.max(1, Math.round(power * (atk / def) * (0.85 + 0.15 * roll) * (0.8 + lv / 80)));
}

/** Chance to catch rises as the target's HP falls: 25 % at full HP, ~90 % near 0. */
export function catchChance(hp: number, maxHp: number): number {
    return Math.min(0.95, 0.25 + 0.7 * (1 - hp / maxHp));
}
