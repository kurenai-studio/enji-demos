// usage: node tools/dump_prefabs.mjs <outDir> <prefabResPath>...
// Needs a running host (`enji host start --project .`). For every prefab: opens
// previewUrl&prefab=<path>, runs dump.js, saves <outDir>/<Name>.dump.json and a JPEG.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const [outDir, ...prefabs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const dump = readFileSync(resolve(here, 'dump.js'), 'utf8');
const status = JSON.parse(execFileSync('enji', ['host', 'status', '--project', project], { encoding: 'utf8' }));
const url = status.previewUrl;
if (!url) throw new Error('host not running: ' + JSON.stringify(status));

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const p of prefabs) {
    const page = await browser.newPage({ viewport: { width: 450, height: 800 }, deviceScaleFactor: 1.6 });
    const errors = [];
    // the enji host serves no /favicon.ico; Chromium logs that 404 as a console error
    page.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').endsWith('/favicon.ico')) errors.push(m.text().slice(0, 400)); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e.message).slice(0, 400)));
    page.on('response', (res) => { if (res.status() >= 400) errors.push(`http ${res.status()} ${res.url()}`); });
    await page.goto(url + '&prefab=' + encodeURIComponent(p));
    const r = await page.evaluate(dump).catch((e) => ({ err: String(e.message).slice(0, 400) }));
    await page.waitForTimeout(500);
    const name = p.split('/').pop();
    await page.screenshot({ path: `${outDir}/${name}.jpg`, type: 'jpeg', quality: 85 });
    r.errors = errors;
    writeFileSync(`${outDir}/${name}.dump.json`, JSON.stringify(r, null, 1));
    console.log(`${p}: ${JSON.stringify(r.harness ?? r.err)} nodes=${r.nodeCount ?? 0} errors=${errors.length}`);
    for (const e of errors) console.log('  ERR', e);
    await page.close();
}
await browser.close();
