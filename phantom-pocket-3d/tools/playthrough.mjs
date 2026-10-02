// Headless playthrough with real mouse clicks (host must be running: `enji host start --project .`).
//   node tools/playthrough.mjs [seed]
// Moves until the enemy faints -> result -> next encounter -> bag + potion -> weaken + catch -> result
// -> next encounter -> run. Writes shots/*.jpg and tools/playthrough.result.json; exits 1 on any failed
// check or console error.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const shots = resolve(project, 'shots');
mkdirSync(shots, { recursive: true });
const seed = process.argv[2] ?? '7';
const status = JSON.parse(execFileSync('enji', ['host', 'status', '--project', project], { encoding: 'utf8' }));
if (!status.previewUrl) throw new Error('host not running');

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1.6 });
const errors = [];
page.on('console', (m) => {
    // the enji host serves no /favicon.ico; Chromium logs that 404 as a console error
    if (m.type() === 'error' && !(m.location().url || '').endsWith('/favicon.ico')) errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const steps = [];
const checks = [];
function check(name, ok, detail) {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
}
const st = () => page.evaluate(() => window.__pp.state());
async function until(fn, ms = 15000, what = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const s = await st();
        if (fn(s)) return s;
        await page.waitForTimeout(100);
    }
    throw new Error('timeout waiting for ' + what);
}
async function shot(name) {
    await page.screenshot({ path: `${shots}/${name}.jpg`, type: 'jpeg', quality: 88 });
    steps.push({ shot: `shots/${name}.jpg` });
    console.log('shot', name);
}
/** Real click at a UI part's centre: design px (origin bottom-left) -> canvas CSS px. */
async function click(ui, id) {
    const p = await page.evaluate(([u, i]) => window.__pp.point(u, i), [ui, id]);
    const r = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const b = c.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    const x = r.x + (p.x / 720) * r.w;
    const y = r.y + ((1280 - p.y) / 1280) * r.h;
    await page.mouse.click(x, y);
    steps.push({ click: `${ui}:${id}`, x: Math.round(x), y: Math.round(y) });
}
const idle = (s) => !s.busy && !s.bagOpen && !s.resultOpen;
/** Drink a potion when HP is low so long catch attempts don't end in a loss. */
async function healIfLow(s) {
    if (s.playerHp > 36 || s.items[0] <= 0 || s.resultOpen) return s;
    await click('hud', 'bag');
    await until((x) => x.bagOpen, 5000, 'bag open');
    await page.waitForTimeout(300);
    await click('bag', 'item_use_0');
    return until((x) => idle(x) || x.resultOpen, 15000, 'item turn end');
}
function bestMove(s, prefer = [0, 2, 1]) {
    const mp = [0, 6, 4, 12];
    return prefer.find((i) => s.pp[i] > 0 && s.playerMp >= mp[i]) ?? 0;
}

let failed = false;
try {
    await page.goto(status.previewUrl + '&seed=' + seed);
    await page.waitForFunction(() => window.__pp && !window.__pp.state().busy, null, { timeout: 30000 });
    let s = await st();
    check('battle starts', s.encounter === 1 && s.enemy && s.status.includes('出现'), { enemy: s.enemy, status: s.status });
    check('party count shown', s.partyLabel === '1/6', s.partyLabel);
    await page.waitForTimeout(400);
    await shot('01_battle_start');

    // ---- 1. big move with camera move, captured on the 3D hit
    const enemyHp0 = s.enemyHp;
    const barW0 = s.enemyBarW;
    await click('hud', 'move_3');
    await page.waitForFunction(() => window.__pp.fxActive('HitBurst'), null, { timeout: 8000, polling: 16 });
    await page.waitForTimeout(90);
    await shot('02_move_hit');
    s = await until((x) => idle(x) || x.resultOpen, 15000, 'turn end');
    check('move costs PP and MP', s.pp[3] === 4 && s.playerMp <= 30 - 12 + 0, { pp: s.pp, mp: s.playerMp });
    check('enemy took damage', s.enemyHp < enemyHp0, { from: enemyHp0, to: s.enemyHp });
    check('enemy HP bar shrank', s.enemyBarW < barW0, { from: barW0, to: s.enemyBarW });
    check('enemy AI acted', s.resultOpen || s.playerHp < 90, { playerHp: s.playerHp, status: s.status });

    // ---- 2. keep attacking until the enemy faints
    const firstEnemy = s.enemy;
    for (let turn = 0; turn < 20 && !s.resultOpen; turn++) {
        await click('hud', `move_${bestMove(s)}`);
        s = await until((x) => idle(x) || x.resultOpen, 15000, 'turn end');
    }
    await page.waitForTimeout(500);
    s = await st();
    check('result dialog after the enemy faints', s.resultOpen && s.resultTitle === '战斗胜利', { title: s.resultTitle, hp: s.enemyHp });
    await shot('05_result_dialog');

    // ---- 3. next encounter: a different species
    await click('result', 'result_next');
    s = await until((x) => idle(x) && x.encounter === 2, 15000, 'encounter 2');
    check('next encounter has a different enemy', s.enemy !== firstEnemy, { before: firstEnemy, now: s.enemy });

    // make sure the potion has something to heal
    for (let turn = 0; turn < 6 && s.playerHp >= 90; turn++) {
        await click('hud', 'move_0');
        s = await until((x) => idle(x) || x.resultOpen, 15000, 'turn end');
    }

    // ---- 4. bag + potion
    await click('hud', 'bag');
    s = await until((x) => x.bagOpen, 5000, 'bag open');
    await page.waitForTimeout(350);
    await shot('03_bag_open');
    const hpBefore = s.playerHp;
    await click('bag', 'item_use_0');
    s = await until((x) => idle(x) || x.resultOpen, 15000, 'item turn end');
    const log = await page.evaluate(() => window.__pp.log());
    const healLine = log.find((l) => l.startsWith('使用了伤药'));
    check('potion used and healed', s.items[0] === 2 && !!healLine, { items: s.items, hpBefore, hpAfter: s.playerHp, healLine });

    // ---- 5. weaken, then catch
    const target = s.enemy;
    for (let turn = 0; turn < 12 && s.enemyHp / s.enemyMax > 0.5 && !s.resultOpen; turn++) {
        s = await healIfLow(s);
        await click('hud', 'move_0');
        s = await until((x) => idle(x) || x.resultOpen, 15000, 'turn end');
    }
    check('enemy weakened before the catch', s.enemyHp / s.enemyMax <= 0.5 && !s.resultOpen, { hp: s.enemyHp, max: s.enemyMax });
    let caught = false;
    for (let attempt = 0; attempt < 6 && !caught && !s.resultOpen; attempt++) {
        if (attempt > 0) s = await healIfLow(s);
        await click('hud', 'catch');
        await page.waitForFunction(() => window.__pp.fxActive('CallingCard'), null, { timeout: 8000 });
        await page.waitForTimeout(attempt === 0 ? 700 : 300);
        if (attempt === 0) await shot('04_catch');
        s = await until((x) => idle(x) || x.resultOpen, 20000, 'catch end');
        caught = s.resultOpen && s.resultTitle === '捕获成功';
    }
    await page.waitForTimeout(400);
    s = await st();
    check('catch succeeded and joined the party', caught && s.party.length === 2 && s.party[1] === target && s.partyLabel === '2/6',
        { party: s.party, label: s.partyLabel, title: s.resultTitle });
    await shot('06_catch_result');

    // ---- 6. next encounter, then run
    await click('result', 'result_next');
    s = await until((x) => idle(x) && x.encounter === 3, 15000, 'encounter 3');
    const beforeRun = s.enemy;
    await click('hud', 'run');
    s = await until((x) => idle(x) && x.encounter === 4, 15000, 'encounter after run');
    check('run leaves the battle and starts a new encounter', s.encounter === 4, { ran_from: beforeRun, now: s.enemy });
    await shot('07_after_run');
    steps.push({ log: await page.evaluate(() => window.__pp.log()) });
} catch (e) {
    failed = true;
    console.log('ERROR', e.message);
    await shot('error').catch(() => {});
}
check('no console errors', errors.length === 0, errors);
failed = failed || checks.some((c) => !c.ok);
writeFileSync(resolve(here, 'playthrough.result.json'), JSON.stringify({ seed, ok: !failed, checks, errors, steps }, null, 1));
await browser.close();
console.log(failed ? 'PLAYTHROUGH FAILED' : 'PLAYTHROUGH OK');
process.exit(failed ? 1 : 0);
