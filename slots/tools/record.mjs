// Records a paced demo session to an MP4 (host must be running: `enji host start --project .`).
//   node tools/record.mjs [seed=8397] [out.mp4]
// Seed 8397 (see tools/demo-seed.mjs): a cascade on spin 1, an orb win on spin 3, then SUPER free
// spins on spin 4. Renders on the GPU (Metal ANGLE), captures frames with CDP Page.startScreencast
// and encodes them at their real timestamps with ffmpeg (FFMPEG env, else imageio-ffmpeg's binary,
// else `ffmpeg` on PATH). A fake finger cursor with a tap ripple is overlaid so the taps are visible.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const seed = process.argv[2] ?? '8397';
const out = resolve(process.argv[3] ?? resolve(project, 'video', 'slots.mp4'));
const frames = resolve(project, 'video', '.frames');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

function findFfmpeg() {
    if (process.env.FFMPEG) return process.env.FFMPEG;
    try {
        return execFileSync('python3', ['-c', 'import imageio_ffmpeg as m; print(m.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
    } catch {
        return 'ffmpeg';
    }
}
const status = JSON.parse(execFileSync('enji', ['host', 'status', '--project', project], { encoding: 'utf8' }));
if (!status.previewUrl) throw new Error('host not running');

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    // the screencast captures the window, not the emulated viewport, so the two must match
    args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=450,800'],
});
const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1.6 });
const errors = [];
page.on('console', (m) => {
    if (m.type() === 'error' && !(m.location().url || '').endsWith('/favicon.ico')) errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
        const css = document.createElement('style');
        css.textContent = `
            #rec-cursor { position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
                border-radius: 50%; background: rgba(255,255,255,.55); border: 3px solid rgba(20,20,20,.85);
                box-shadow: 0 2px 6px rgba(0,0,0,.5); pointer-events: none; z-index: 99999; opacity: 0;
                transition: opacity .2s, transform .12s; }
            #rec-cursor.down { transform: scale(.75); background: rgba(255,230,0,.8); }
            .rec-ripple { position: fixed; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
                border: 4px solid #ffe600; pointer-events: none; z-index: 99998; animation: rec-rip .5s ease-out forwards; }
            @keyframes rec-rip { to { transform: scale(4); opacity: 0; } }`;
        document.head.appendChild(css);
        const c = document.createElement('div');
        c.id = 'rec-cursor';
        document.body.appendChild(c);
        addEventListener('mousemove', (e) => {
            c.style.left = e.clientX + 'px';
            c.style.top = e.clientY + 'px';
            c.style.opacity = '1';
        }, true);
        addEventListener('mousedown', (e) => {
            c.classList.add('down');
            const r = document.createElement('div');
            r.className = 'rec-ripple';
            r.style.left = e.clientX + 'px';
            r.style.top = e.clientY + 'px';
            document.body.appendChild(r);
            setTimeout(() => r.remove(), 600);
        }, true);
        addEventListener('mouseup', () => c.classList.remove('down'), true);
    });
});

const wait = (ms) => page.waitForTimeout(ms);
const idle = () => page.evaluate(() => !__slots.busy && __slots.fsLeft === 0);
async function untilIdle(ms = 180000) {
    const t0 = Date.now();
    let calm = 0;
    while (Date.now() - t0 < ms) {
        calm = (await idle()) ? calm + 1 : 0;
        if (calm >= 8) return;
        await wait(100);
    }
    throw new Error('timeout waiting for the spin to finish');
}
let cursor = { x: 225, y: 560 };
/** Glide the finger to a button's centre, then tap it. */
async function tap(name, dwell = 250) {
    const p = await page.evaluate((n) => __slots.point(n), name);
    const r = await page.evaluate(() => {
        const b = document.querySelector('canvas').getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
    });
    const x = r.x + (p.x / 720) * r.w;
    const y = r.y + ((1280 - p.y) / 1280) * r.h;
    const d = Math.hypot(x - cursor.x, y - cursor.y);
    await page.mouse.move(x, y, { steps: Math.max(8, Math.round(d / 12)) });
    cursor = { x, y };
    await wait(dwell);
    await page.mouse.down();
    await wait(90);
    await page.mouse.up();
}

await page.goto(status.previewUrl + '&seed=' + seed);
await page.waitForFunction(() => globalThis.__slots && !__slots.busy, null, { timeout: 30000 });
await wait(300);

const cdp = await page.context().newCDPSession(page);
const shots = [];
let writing = Promise.resolve();
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!shots.length && (metadata.deviceWidth !== 450 || metadata.deviceHeight !== 800))
        console.log('WARNING: screencast is', metadata.deviceWidth, 'x', metadata.deviceHeight, 'not 450 x 800');
    const file = `${frames}/${String(shots.length).padStart(6, '0')}.jpg`;
    shots.push({ file, t: metadata.timestamp });
    writing = writing.then(() => writeFileSync(file, Buffer.from(data, 'base64')));
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 720, maxHeight: 1280, everyNthFrame: 1 });

let failed = false;
try {
    await wait(1500);
    // show the bet stepper, then come back to bet 1 (the seed's spins assume it)
    await tap('plus', 400);
    await wait(500);
    await tap('minus', 300);
    await wait(700);
    for (let i = 0; i < 4; i++) {
        await tap('spin', i ? 300 : 450);
        await wait(400);
        await untilIdle();
        const s = await page.evaluate(() => ({ balance: __slots.balance, win: __slots.shownWin }));
        console.log(`spin ${i + 1}: balance ${s.balance}, win ${s.win}`);
        await wait(1100);
    }
    await wait(1500);
} catch (e) {
    failed = true;
    console.log('ERROR', e.message);
}
await cdp.send('Page.stopScreencast');
await wait(200);
await writing;
await browser.close();
if (errors.length) console.log('console errors:', errors);

if (shots.length < 2) throw new Error('no frames captured');
const lines = [];
for (let i = 0; i < shots.length; i++) {
    const dur = i + 1 < shots.length ? Math.max(0.001, shots[i + 1].t - shots[i].t) : 0.5;
    lines.push(`file '${shots[i].file}'`, `duration ${dur.toFixed(4)}`);
}
lines.push(`file '${shots[shots.length - 1].file}'`);
writeFileSync(`${frames}/list.txt`, lines.join('\n'));
mkdirSync(dirname(out), { recursive: true });
execFileSync(findFfmpeg(), [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${frames}/list.txt`,
    '-vf', 'scale=720:1280:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '25',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
], { stdio: 'inherit' });
const secs = shots[shots.length - 1].t - shots[0].t;
console.log(`frames ${shots.length}, ${secs.toFixed(1)} s, avg ${(shots.length / secs).toFixed(1)} fps -> ${out}`);
if (existsSync(out)) rmSync(frames, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
