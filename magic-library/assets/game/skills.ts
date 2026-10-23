/** Five tidy-up skills. Unlock after tidy sets; cooldown shrinks from level 1 to 10. */

export type SkillId = 'insight' | 'guide' | 'sort' | 'summon' | 'shelve';

export type SkillDef = {
    id: SkillId;
    name: string;
    unlock: number;
    cd: readonly [number, number];
    dur?: number;
    desc: string;
};

export const SKILL_DEFS: readonly SkillDef[] = [
    { id: 'insight', name: '洞察', unlock: 2, cd: [40, 8], dur: 12, desc: '手里这套书的其他卷会发光' },
    { id: 'guide', name: '指引', unlock: 2, cd: [30, 6], dur: 20, desc: '标出手里这本该放的书架格子' },
    { id: 'sort', name: '排列', unlock: 5, cd: [12, 2], desc: '手里的书按套、卷一在上排好' },
    { id: 'summon', name: '召回', unlock: 10, cd: [120, 10], desc: '把这套书缺的卷飞到手里' },
    { id: 'shelve', name: '上架', unlock: 20, cd: [90, 15], desc: '手里对得上的书一次放进面前的书架' },
];

const LEVEL_EVERY = 20;
const MAX_LEVEL = 10;

const byId = new Map(SKILL_DEFS.map((d) => [d.id, d]));

export function skillLevel(cols: number): number {
    return Math.min(MAX_LEVEL, 1 + Math.floor(cols / LEVEL_EVERY));
}

export function skillCooldown(def: SkillDef, cols: number): number {
    const k = (skillLevel(cols) - 1) / (MAX_LEVEL - 1);
    return def.cd[0] + (def.cd[1] - def.cd[0]) * k;
}

export function skillUnlocked(def: SkillDef, cols: number): boolean {
    return cols >= def.unlock;
}

export function newlyUnlocked(before: number, after: number): SkillDef[] {
    return SKILL_DEFS.filter((d) => before < d.unlock && after >= d.unlock);
}

export type SkillMode = 'locked' | 'ready' | 'active' | 'cooling';

/** Timers only. The world decides whether the cast actually did something. */
export class SkillBook {
    private cd = new Map<SkillId, number>();
    private active = new Map<SkillId, number>();

    gate(id: SkillId, cols: number): { ok: true } | { ok: false; message: string } {
        const def = byId.get(id);
        if (!def) return { ok: false, message: '' };
        if (!skillUnlocked(def, cols)) {
            return { ok: false, message: `「${def.name}」整理好 ${def.unlock} 套书后解锁` };
        }
        const left = this.cd.get(id) ?? 0;
        if (left > 0) return { ok: false, message: `「${def.name}」还要 ${Math.ceil(left)} 秒` };
        return { ok: true };
    }

    commit(id: SkillId, cols: number): void {
        const def = byId.get(id);
        if (!def) return;
        this.cd.set(id, skillCooldown(def, cols));
        if (def.dur) this.active.set(id, def.dur);
    }

    isActive(id: SkillId): boolean {
        return (this.active.get(id) ?? 0) > 0;
    }

    /** Tick timers. Returns skills whose effect just ended. */
    update(dt: number): SkillId[] {
        for (const [id, t] of this.cd) {
            if (t > dt) this.cd.set(id, t - dt);
            else this.cd.delete(id);
        }
        const ended: SkillId[] = [];
        for (const [id, t] of this.active) {
            if (t > dt) this.active.set(id, t - dt);
            else {
                this.active.delete(id);
                ended.push(id);
            }
        }
        return ended;
    }

    view(cols: number): { name: string; sub: string; mode: SkillMode }[] {
        return SKILL_DEFS.map((def, i) => {
            if (!skillUnlocked(def, cols)) {
                return { name: def.name, sub: `${def.unlock}套解锁`, mode: 'locked' as const };
            }
            const activeLeft = this.active.get(def.id) ?? 0;
            if (activeLeft > 0) {
                return { name: `${Math.ceil(activeLeft)}s`, sub: `${def.name}中`, mode: 'active' as const };
            }
            const cdLeft = this.cd.get(def.id) ?? 0;
            if (cdLeft > 0) {
                return { name: `${Math.ceil(cdLeft)}s`, sub: def.name, mode: 'cooling' as const };
            }
            return { name: def.name, sub: `Lv${skillLevel(cols)} ${i + 1}`, mode: 'ready' as const };
        });
    }
}
