// usage: node tools/shot.mjs <out.jpg> [waitMs] [js-to-eval-before-shot]
// Screenshot of the running preview (host must be running). Logs console
// errors and lines tagged [slots].
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const [out, waitMs = '5000', js = ''] = process.argv.slice(2);
const status = JSON.parse(execFileSync('enji', ['host', 'status', '--project', project], { encoding: 'utf8' }));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=450,800'],
});
const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1.6 });
page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || m.text().includes('[slots]')) {
        console.log(m.type(), m.text().slice(0, 400));
    }
});
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('response', (r) => { if (r.status() >= 400) console.log('http', r.status(), r.url()); });
await page.goto(status.previewUrl);
await page.waitForTimeout(Number(waitMs));
if (js) console.log(await page.evaluate(js));
await page.screenshot({ path: out, type: 'jpeg', quality: 88 });
await browser.close();
