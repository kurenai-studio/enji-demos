// Records the demo to an MP4 (host must be running: `enji host start --project .`).
//   cd tools && npm install && cd ..   (playwright-core, once)
//   node tools/record.mjs [out.mp4]
// The Lich King shot from start to hold, then the sandbox with a scripted sweep. Renders on the GPU
// (Metal ANGLE) in headless Chromium with the engine's own loop paused: every video frame is two
// fixed 1/60 s engine ticks followed by a canvas grab, so the video is a steady 30 fps at real speed
// however long a frame takes to render. Encodes with ffmpeg (FFMPEG env, else imageio-ffmpeg's
// binary, else `ffmpeg` on PATH).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(resolve(here, 'package.json'))('playwright-core');
const project = resolve(here, '..');
const out = resolve(process.argv[2] ?? resolve(project, 'video', 'snow-3d.mp4'));
const frames = resolve(project, 'video', '.frames');
const W = 1280, H = 720, FPS = 30;
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
    args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${W},${H}`],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
    if (m.type() === 'error' && !(m.location().url || '').endsWith('/favicon.ico')) errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

let count = 0;
/** Ticks the engine `ticks` times per frame and saves `n` canvas frames; `until` (page-side) can end early. */
async function capture(n, ticks = 60 / FPS, until = null) {
    const batch = 15;
    for (let done = 0; done < n;) {
        const r = await page.evaluate(([k, ticks, until]) => {
            const stop = until ? new Function('return ' + until) : () => false;
            const c = document.querySelector('canvas');
            const urls = [];
            for (let i = 0; i < k && !stop(); i++) {
                for (let j = 0; j < ticks; j++) cc.director.tick(1 / 60);
                urls.push(c.toDataURL('image/jpeg', 0.92));
            }
            return { urls, stopped: stop() };
        }, [Math.min(batch, n - done), ticks, until]);
        for (const u of r.urls) writeFileSync(`${frames}/${String(count++).padStart(6, '0')}.jpg`, Buffer.from(u.split(',')[1], 'base64'));
        done += r.urls.length;
        if (r.stopped || !r.urls.length) return;
    }
}
/** Loads a view and pauses the engine's own loop so only `capture` advances it. */
async function open(query, ready) {
    await page.goto(status.previewUrl + query);
    await page.waitForFunction(ready, null, { timeout: 60000 });
    await page.evaluate(() => cc.game.pause());
}

let failed = false;
try {
    await open('', () => globalThis.__shotView?.gauntlet);
    await page.evaluate(() => __shotView.replay());
    await capture(Math.round(10.5 * FPS));
    console.log('shot:', count, 'frames');

    await open('&view=sandbox', () => globalThis.__snowView?.gauntlet);
    await capture(Math.round(1.0 * FPS), 2, '__snowView.settleLeft === 0');
    await capture(Math.round(0.8 * FPS));
    await page.evaluate(() => __snowView.startSweep());
    await capture(Math.round(12 * FPS), 2, '__snowView.sweepTime < 0');
    await capture(Math.round(2.0 * FPS));
    console.log('total:', count, 'frames');
} catch (e) {
    failed = true;
    console.log('ERROR', e.message);
}
await browser.close();
if (errors.length) console.log('console errors:', errors);
if (count < 2) throw new Error('no frames captured');

mkdirSync(dirname(out), { recursive: true });
execFileSync(findFfmpeg(), [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${frames}/%06d.jpg`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
], { stdio: 'inherit' });
console.log(`${count} frames, ${(count / FPS).toFixed(1)} s, ${(statSync(out).size / 1e6).toFixed(1)} MB -> ${out}`);
if (existsSync(out)) rmSync(frames, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
