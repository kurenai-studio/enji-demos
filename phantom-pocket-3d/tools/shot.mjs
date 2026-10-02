// usage: node tools/shot.mjs <out.jpg> [query] [waitMs] [js-to-eval-before-shot]
// Quick screenshot of the running preview (host must be running).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const [out, query = '', waitMs = '4000', js = ''] = process.argv.slice(2);
const status = JSON.parse(execFileSync('enji', ['host', 'status', '--project', project], { encoding: 'utf8' }));
const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1.6 });
page.on('console', (m) => {
    if (m.type() === 'error' || m.text().includes('[PhantomPocket3D]')) console.log(m.type(), m.text().slice(0, 300), m.type() === 'error' ? JSON.stringify(m.location()) : '');
});
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('response', (r) => { if (r.status() >= 400) console.log('http', r.status(), r.url()); });
await page.goto(status.previewUrl + query);
await page.waitForTimeout(Number(waitMs));
if (js) console.log(await page.evaluate(js));
await page.screenshot({ path: out, type: 'jpeg', quality: 85 });
await browser.close();
