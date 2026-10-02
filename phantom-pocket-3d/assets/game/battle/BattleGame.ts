import { Camera, easing, instantiate, Label, Node, Prefab, Scene, tween, UIOpacity, UITransform, Vec3 } from 'cc';
import { preloadModel } from '../../enji/helpers';
import { loadPrefabAsset } from '../core/Prefabs';
import { UiView } from '../ui/UiView';
import {
    catchChance, damage, ENEMY_SPECIES, ITEMS, makeRng, MoveDef, PARTY_MAX, PLAYER_SPECIES, SpeciesDef, START_ITEMS,
} from './BattleData';
import { Side, StageView } from './StageView';

interface Fighter {
    sp: SpeciesDef;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    pp: number[];
}

type Outcome = 'win' | 'catch' | 'lose';

const wait = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
const play = (t: ReturnType<typeof tween>) => new Promise<void>((r) => t.call(() => r()).start());

function fighter(sp: SpeciesDef): Fighter {
    return { sp, hp: sp.hp, maxHp: sp.hp, mp: sp.mp, maxMp: sp.mp, pp: sp.moves.map((m) => m.pp) };
}

/**
 * The battle loop. Scene structure comes from BattleStage.prefab (3D) and the
 * three UI prefabs; this class only binds data, runs turns and plays tweens.
 */
export class BattleGame {
    private stage!: StageView;
    private hud!: UiView;
    private bag!: UiView;
    private result!: UiView;
    private player!: Fighter;
    private enemy!: Fighter;
    private items = [...START_ITEMS];
    private party: string[] = [PLAYER_SPECIES.name];
    private exp = 0;
    private encounter = 0;
    private enemyIdx = -1;
    private busy = true;
    private log: string[] = [];
    private readonly rng: () => number;
    private readonly models = new Map<string, Prefab>();

    constructor(private readonly uiRoot: Node, private readonly scene: Scene) {
        const q = new URLSearchParams(location.search);
        this.rng = makeRng(Number(q.get('seed') ?? Date.now() % 100000));
    }

    async start(): Promise<void> {
        const stageNode = instantiate(await loadPrefabAsset('prefabs/battle/BattleStage'));
        this.scene.addChild(stageNode);
        this.stage = new StageView(stageNode);
        [this.hud, this.bag, this.result] = await Promise.all([
            UiView.create('BattleHud', this.uiRoot),
            UiView.create('BagDialog', this.uiRoot),
            UiView.create('ResultDialog', this.uiRoot),
        ]);
        this.bag.root.active = false;
        this.result.root.active = false;
        await Promise.all([PLAYER_SPECIES, ...ENEMY_SPECIES].map((s) => this.model(s)));

        this.player = fighter(PLAYER_SPECIES);
        this.stage.setCreature('player', await this.model(PLAYER_SPECIES));
        this.bindHud();
        this.bindBag();
        this.result.onClick('result_next', () => void this.onNext());
        this.expose();
        await this.nextEncounter();
    }

    update(dt: number): void {
        this.stage?.update(dt);
    }

    // ------------------------------------------------------------------ setup
    private model(sp: SpeciesDef): Promise<Prefab> {
        const have = this.models.get(sp.model);
        if (have) return Promise.resolve(have);
        return preloadModel(sp.model).then((p) => { this.models.set(sp.model, p); return p; });
    }

    private bindHud(): void {
        const h = this.hud;
        for (let i = 0; i < 4; i++) h.onClick(`move_${i}`, () => void this.onMove(i));
        h.onClick('bag', () => void this.openBag());
        h.onClick('catch', () => void this.onCatch());
        h.onClick('run', () => void this.onRun());
        h.onClick('party', () => this.status(`队伍：${this.party.join('、')}`));
        h.onClick('settings', () => this.status('菜单暂未开放'));
        h.setText('player_name', this.player.sp.name);
        h.setText('player_lv_chip', `Lv${this.player.sp.lv}`);
        this.player.sp.moves.forEach((m, i) => h.setText(`move_${i}_name`, m.name));
    }

    private bindBag(): void {
        const b = this.bag;
        ITEMS.forEach((it, i) => {
            b.setText(`item_name_${i}`, it.name);
            b.setText(`item_desc_${i}`, it.desc);
            b.onClick(`item_use_${i}`, () => void this.useItem(i));
        });
        b.onClick('bag_close', () => { if (!this.busy) void this.bag.hide(); });
    }

    // ------------------------------------------------------------------ view refresh
    private status(s: string): void {
        this.hud.setText('status', s);
        this.log.push(s);
        console.log('[PhantomPocket3D]', s);
    }

    private refresh(animate = true): void {
        const h = this.hud, p = this.player, e = this.enemy;
        h.setText('enemy_name', e.sp.name);
        h.setText('enemy_lv_chip', `Lv${e.sp.lv}`);
        h.setText('enemy_hp', `${e.hp} / ${e.maxHp}`);
        h.setText('enemy_hp_pct', `${Math.round((100 * e.hp) / e.maxHp)}%`);
        h.setBar('enemy_hp_track_fill', e.hp / e.maxHp, animate);
        h.setText('player_hp', `${p.hp} / ${p.maxHp}`);
        h.setText('player_mp', `${p.mp} / ${p.maxMp}`);
        h.setText('player_hp_pct', `${Math.round((100 * p.hp) / p.maxHp)}%`);
        h.setBar('player_hp_track_fill', p.hp / p.maxHp, animate);
        h.setBar('player_mp_track_fill', p.mp / p.maxMp, animate);
        p.sp.moves.forEach((m, i) => {
            h.setText(`move_pp_${i}`, `PP ${p.pp[i]}`);
            h.setText(`move_mp_${i}`, `MP ${m.mp}`);
        });
        h.setText('party_count', `${this.party.length}/${PARTY_MAX}`);
        this.refreshButtons();
    }

    private refreshButtons(): void {
        const h = this.hud, p = this.player, idle = !this.busy;
        p.sp.moves.forEach((m, i) => h.setEnabled(`move_${i}`, idle && p.pp[i] > 0 && p.mp >= m.mp));
        h.setEnabled('bag', idle);
        h.setEnabled('run', idle);
        h.setEnabled('catch', idle && this.party.length < PARTY_MAX);
        this.items.forEach((n, i) => {
            this.bag.setText(`item_count_${i}`, `×${n}`);
            this.bag.setEnabled(`item_use_${i}`, idle && n > 0);
        });
    }

    private setBusy(b: boolean): void {
        this.busy = b;
        this.refreshButtons();
    }

    // ------------------------------------------------------------------ encounters
    private async nextEncounter(): Promise<void> {
        this.setBusy(true);
        let idx = Math.floor(this.rng() * ENEMY_SPECIES.length);
        if (idx === this.enemyIdx) idx = (idx + 1 + Math.floor(this.rng() * (ENEMY_SPECIES.length - 1))) % ENEMY_SPECIES.length;
        this.enemyIdx = idx;
        this.encounter++;
        this.enemy = fighter(ENEMY_SPECIES[idx]);
        this.stage.setCreature('enemy', await this.model(this.enemy.sp));
        this.refresh(false);
        this.status(`野生的${this.enemy.sp.name}出现了！`);
        await this.stage.enter('enemy');
        this.setBusy(false);
    }

    private async onNext(): Promise<void> {
        if (!this.result.root.active) return;
        await this.result.hide();
        if (this.player.hp <= 0) {
            this.player = { ...fighter(PLAYER_SPECIES), pp: this.player.pp.map((_, i) => PLAYER_SPECIES.moves[i].pp) };
            this.stage.setCreature('player', await this.model(PLAYER_SPECIES));
            await this.stage.enter('player');
        }
        await this.nextEncounter();
    }

    private async showResult(kind: Outcome, gained: number): Promise<void> {
        const r = this.result, e = this.enemy.sp.name;
        const title = { win: '战斗胜利', catch: '捕获成功', lose: '战斗失败' }[kind];
        const sub = { win: `${e} 被击倒了`, catch: `${e} 成为了伙伴`, lose: `${this.player.sp.name} 倒下了` }[kind];
        r.setText('result_title', title);
        r.setText('result_sub', sub);
        r.setText('result_line_0', kind === 'lose' ? '下一战前体力完全恢复' : `获得经验 ${gained}`);
        r.setText('result_line_1', `队伍 ${this.party.length}/${PARTY_MAX}`);
        await wait(0.3);
        await r.show('result_dialog');
    }

    // ------------------------------------------------------------------ player actions
    private async onMove(i: number): Promise<void> {
        const p = this.player, m = p.sp.moves[i];
        if (this.busy) return;
        if (p.pp[i] <= 0) return this.status(`${m.name}的PP用尽了`);
        if (p.mp < m.mp) return this.status(`MP不足，无法使出${m.name}`);
        this.setBusy(true);
        p.pp[i]--;
        p.mp -= m.mp;
        this.refresh();
        this.status(`${p.sp.name}使出了${m.name}！`);
        await this.attackFx('player', m);
        const dmg = damage(m.power, p.sp.atk, this.enemy.sp.def, p.sp.lv, this.rng());
        this.enemy.hp = Math.max(0, this.enemy.hp - dmg);
        this.pop('enemy', dmg);
        this.refresh();
        this.status(`对${this.enemy.sp.name}造成了 ${dmg} 点伤害`);
        await wait(0.55);
        if (this.enemy.hp <= 0) return this.enemyDown();
        await this.enemyTurn();
    }

    private async enemyDown(): Promise<void> {
        await this.stage.faint('enemy');
        const gained = this.enemy.sp.lv * 2 + 4;
        this.exp += gained;
        this.status(`${this.enemy.sp.name}倒下了！获得经验 ${gained}`);
        await this.showResult('win', gained);
    }

    private async openBag(): Promise<void> {
        if (this.busy) return;
        this.refreshButtons();
        await this.bag.show('bag_dialog');
    }

    private async useItem(i: number): Promise<void> {
        if (this.busy || this.items[i] <= 0) return;
        const it = ITEMS[i], p = this.player;
        if ((it.heal && p.hp >= p.maxHp) || (!it.heal && it.mp && p.mp >= p.maxMp)) {
            this.status(it.heal ? 'HP 已满，不需要伤药' : 'MP 已满，不需要灵露');
            return;
        }
        this.setBusy(true);
        this.items[i]--;
        await this.bag.hide();
        const hp0 = p.hp, mp0 = p.mp;
        p.hp = Math.min(p.maxHp, p.hp + it.heal);
        p.mp = Math.min(p.maxMp, p.mp + it.mp);
        await this.stage.heal('player');
        this.refresh();
        this.status(it.heal ? `使用了${it.name}，HP 回复 ${p.hp - hp0}` : `使用了${it.name}，MP 回复 ${p.mp - mp0}`);
        await wait(0.6);
        await this.enemyTurn();
    }

    private async onCatch(): Promise<void> {
        if (this.busy) return;
        this.setBusy(true);
        const e = this.enemy;
        const chance = catchChance(e.hp, e.maxHp);
        const ok = this.rng() < chance;
        this.status(`投出了预告信！（成功率 ${Math.round(chance * 100)}%）`);
        await this.stage.catchSequence(ok);
        if (ok) {
            this.party.push(e.sp.name);
            const gained = e.sp.lv + 6;
            this.exp += gained;
            this.refresh();
            this.status(`捕获成功！${e.sp.name}成为了伙伴`);
            await this.showResult('catch', gained);
            return;
        }
        this.status(`${e.sp.name}挣脱了预告信！`);
        await wait(0.5);
        await this.enemyTurn();
    }

    private async onRun(): Promise<void> {
        if (this.busy) return;
        this.setBusy(true);
        this.status('成功逃跑了！');
        await this.stage.leave('enemy');
        await wait(0.3);
        await this.nextEncounter();
    }

    // ------------------------------------------------------------------ enemy turn
    private async enemyTurn(): Promise<void> {
        const e = this.enemy, p = this.player;
        const m = e.sp.moves[Math.floor(this.rng() * e.sp.moves.length)];
        this.status(`${e.sp.name}使出了${m.name}！`);
        await this.attackFx('enemy', m);
        const dmg = damage(m.power, e.sp.atk, p.sp.def, e.sp.lv, this.rng());
        p.hp = Math.max(0, p.hp - dmg);
        this.pop('player', dmg);
        this.refresh();
        this.status(`${p.sp.name}受到了 ${dmg} 点伤害`);
        await wait(0.5);
        if (p.hp <= 0) {
            await this.stage.faint('player');
            this.status(`${p.sp.name}倒下了……`);
            await this.showResult('lose', 0);
            return;
        }
        this.status('要怎么做？');
        this.setBusy(false);
    }

    // ------------------------------------------------------------------ effects
    private async attackFx(side: Side, m: MoveDef): Promise<void> {
        const target: Side = side === 'player' ? 'enemy' : 'player';
        const s = this.stage;
        switch (m.fx) {
            case 'claw':
                await s.lunge(side);
                void s.slash(target);
                await s.hit(target);
                break;
            case 'fire':
                await s.projectile(side, target);
                await s.hit(target);
                break;
            case 'howl':
                void s.ring(side, 2.4);
                await s.lunge(side);
                await s.hit(target);
                break;
            case 'big':
                await this.cutIn(m.name);
                void s.cameraPunch(target);
                await wait(0.3);
                await s.lunge(side, true);
                void s.slash(target);
                this.screenFlash();
                await s.hit(target, true);
                await wait(0.5);
                break;
            case 'pinch':
                await s.lunge(side);
                void s.slash(target);
                await s.hit(target);
                break;
            case 'stomp':
                await s.lunge(side, true);
                void s.ring(target, 2.8);
                await s.hit(target, true);
                break;
            default:
                await s.lunge(side);
                await s.hit(target);
        }
    }

    private async cutIn(name: string): Promise<void> {
        const node = this.hud.node('fx.CutIn');
        this.hud.setText('fx.CutIn/Text', `${name}！`);
        const y = node.position.y;
        const w = node.getComponent(UITransform)!.width;
        node.setPosition(-w, y, 0);
        node.active = true;
        await play(tween(node).to(0.16, { position: new Vec3(0, y, 0) }, { easing: easing.quadOut })
            .delay(0.45).to(0.14, { position: new Vec3(w, y, 0) }, { easing: easing.quadIn }));
        node.active = false;
        node.setPosition(0, y, 0);
    }

    private screenFlash(): void {
        const node = this.hud.node('fx.ScreenFlash');
        const op = node.getComponent(UIOpacity)!;
        node.active = true;
        op.opacity = 0;
        tween(op).to(0.05, { opacity: 210 }).to(0.3, { opacity: 0 }).call(() => { node.active = false; }).start();
    }

    /** Damage number over a creature: its FxPoint projected into the HUD's Fx layer. */
    private pop(side: Side, dmg: number): void {
        const node = this.hud.node(side === 'enemy' ? 'fx.PopEnemy' : 'fx.PopPlayer');
        const fx = this.hud.node('fx.ScreenFlash').parent!;
        const cam = this.stage.camera.getComponent(Camera)!;
        const at = new Vec3();
        cam.convertToUINode(this.stage.fxWorld(side), fx, at);
        node.getComponent(Label)!.string = `-${dmg}`;
        const op = node.getComponent(UIOpacity)!;
        node.setPosition(at.x, at.y + 40, 0);
        node.setScale(0.6, 0.6, 1);
        op.opacity = 255;
        node.active = true;
        tween(node).to(0.14, { scale: new Vec3(1.15, 1.15, 1) }, { easing: easing.backOut })
            .to(0.5, { position: new Vec3(at.x, at.y + 150, 0) }).call(() => { node.active = false; }).start();
        tween(op).delay(0.35).to(0.3, { opacity: 0 }).start();
    }

    // ------------------------------------------------------------------ test hooks
    private expose(): void {
        const w = window as any;
        w.__pp = {
            state: () => ({
                busy: this.busy, encounter: this.encounter, enemy: this.enemy?.sp.name, enemyHp: this.enemy?.hp,
                enemyMax: this.enemy?.maxHp, playerHp: this.player.hp, playerMp: this.player.mp, pp: [...this.player.pp],
                items: [...this.items], party: [...this.party], exp: this.exp,
                status: this.hud.label('status').string, bagOpen: this.bag.root.active, resultOpen: this.result.root.active,
                resultTitle: this.result.label('result_title').string, partyLabel: this.hud.label('party_count').string,
                enemyBarW: this.hud.barWidth('enemy_hp_track_fill'), playerBarW: this.hud.barWidth('player_hp_track_fill'),
            }),
            /** World-space centre of a part (UI world units = 720x1280 design px, origin bottom-left). */
            point: (ui: 'hud' | 'bag' | 'result', id: string) => {
                const v = { hud: this.hud, bag: this.bag, result: this.result }[ui];
                const r = v.node(id).getComponent(UITransform)!.getBoundingBoxToWorld();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            },
            log: () => [...this.log],
            fxActive: (name: string) => !!this.stage.root.getChildByPath(`Fx/${name}`)?.active,
        };
    }
}
