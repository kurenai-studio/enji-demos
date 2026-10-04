// usage: node tools/probe.mjs <outPrefix> <js> [shotEveryMs=400] [count=8] [query]
// Loads the preview, evaluates <js> once ready, then screenshots periodically.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const [prefix, js = '', every = '400', count = '8', query = ''] = process.argv.slice(2);
const status = JSON.parse(execFileSync('enji', ['host', 'status', '--project', project], { encoding: 'utf8' }));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    args: ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=450,800'],
});
const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1.6 });
page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('[slots]')) console.log(m.type(), m.text().slice(0, 400));
});
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('response', (r) => {
    if (r.status() >= 400) console.log('http', r.status(), r.url());
});
await page.goto(status.previewUrl + query);
await page.waitForFunction(() => !!globalThis.__slots, null, { timeout: 30000 });
await page.waitForTimeout(500);
if (js) console.log('eval:', await page.evaluate(js));
for (let i = 0; i < Number(count); i++) {
    await page.waitForTimeout(Number(every));
    await page.screenshot({ path: `${prefix}${String(i).padStart(2, '0')}.jpg`, type: 'jpeg', quality: 80 });
}
await browser.close();
