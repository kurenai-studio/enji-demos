// usage: node tools/slim-pack.mjs <CocosSlotsEditor checkout>
// Rebuilds assets/resources/spine-3.8/packs/power-of-thor2 from the CocosSlotsEditor pack, smaller:
// - The eight symbol skeletons share one atlas (same regions, same two pages); they go into one folder
//   with a single copy of the pages, and the two cell effects likewise share one page.
// - The pages are WebP in the source (Enji cannot import WebP), so they are re-encoded as palette PNG
//   (libimagequant) or mozjpeg instead of the lossless PNG / q95 JPEG used before.
// Also re-encodes the generated UI PNGs in assets/resources/ui as palette PNG.
// Needs sharp: SHARP=/path/to/node_modules/sharp, else `require('sharp')`. Run `enji import
// assets/resources` afterwards.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP ?? 'sharp');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const editor = process.argv[2];
if (!editor) throw new Error('usage: node tools/slim-pack.mjs <CocosSlotsEditor checkout>');
const src = join(editor, 'assets/resources/spine-3.8/packs/power-of-thor2');
const dst = join(project, 'assets/resources/spine-3.8/packs/power-of-thor2');
if (!existsSync(join(src, 'manifest.json'))) throw new Error(`no Thor 2 pack in ${src}`);

const PNG = { palette: true, quality: 90, effort: 10, compressionLevel: 9 };
const JPG = { quality: 88, mozjpeg: true };
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
let before = 0;
let after = 0;
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);

async function encode(from, to, fmt) {
    const img = sharp(from);
    await (fmt === 'png' ? img.png(PNG) : img.jpeg(JPG)).toFile(to);
    after += sizeOf(to);
}

/** Removes a folder's contents (files and their .meta), keeping the folder's own .meta. */
function clear(dir) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        before += statSync(p).isDirectory() ? 0 : sizeOf(p);
        for (const sub of statSync(p).isDirectory() ? readdirSync(p) : []) before += sizeOf(join(p, sub));
        rmSync(p, { recursive: true, force: true });
    }
}

const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));

// symbols: one folder, shared pages symbols.png + symbol.jpg
const symDir = join(dst, 'oriSymbols');
clear(symDir);
mkdirSync(symDir, { recursive: true });
let pagesDone = false;
for (const s of manifest.spines) {
    const name = s.file.replace(/\.json$/, '');
    const from = join(src, s.dir);
    const atlas = readFileSync(join(from, `${name}.atlas`), 'utf8');
    const pages = atlas.split('\n').filter((l, i, a) => /\.(png|jpg|webp)$/.test(l.trim()) && (i === 0 || a[i - 1].trim() === ''));
    if (pages.join() !== `${name}.png,symbol.jpg`) throw new Error(`${name}: unexpected pages ${pages}`);
    writeFileSync(join(symDir, `${name}.atlas`), atlas.replace(/^.*\.png$/m, 'symbols.png'));
    copyFileSync(join(from, `${name}.json`), join(symDir, `${name}.json`));
    after += sizeOf(join(symDir, `${name}.atlas`)) + sizeOf(join(symDir, `${name}.json`));
    if (!pagesDone) {
        await encode(join(from, `${name}.png`), join(symDir, 'symbols.png'), 'png');
        await encode(join(from, 'symbol.jpg'), join(symDir, 'symbol.jpg'), 'jpg');
        pagesDone = true;
    }
    s.dir = 'oriSymbols';
}

// effects: one folder, shared page light.jpg
const fxDir = join(dst, 'effects');
clear(fxDir);
mkdirSync(fxDir, { recursive: true });
let fxPage = null;
for (const f of manifest.effects) {
    const name = f.file.replace(/\.json$/, '');
    const from = join(src, f.dir);
    const atlas = readFileSync(join(from, `${name}.atlas`), 'utf8');
    const page = atlas.split('\n')[0].trim();
    const bytes = readFileSync(join(from, page));
    if (fxPage && !bytes.equals(fxPage)) throw new Error(`${name}: page differs from the first effect's`);
    if (!fxPage) await encode(join(from, page), join(fxDir, 'light.jpg'), 'jpg');
    fxPage = bytes;
    writeFileSync(join(fxDir, `${name}.atlas`), atlas.replace(/^.*$/m, 'light.jpg'));
    copyFileSync(join(from, `${name}.json`), join(fxDir, `${name}.json`));
    after += sizeOf(join(fxDir, `${name}.atlas`)) + sizeOf(join(fxDir, `${name}.json`));
    f.dir = 'effects';
}

// font: page font_symbolF.webp -> font_symbolF.png
const fontDir = join(dst, 'font/font_symbolF');
clear(fontDir);
mkdirSync(fontDir, { recursive: true });
const fntSrc = join(src, 'font/font_symbolF');
writeFileSync(join(fontDir, 'font_symbolF.fnt'), readFileSync(join(fntSrc, 'font_symbolF.fnt'), 'utf8').replace('font_symbolF.webp', 'font_symbolF.png'));
await encode(join(fntSrc, 'font_symbolF.webp'), join(fontDir, 'font_symbolF.png'), 'png');
after += sizeOf(join(fontDir, 'font_symbolF.fnt'));

// static symbol frames
const stillDir = join(dst, 'symbols');
clear(stillDir);
mkdirSync(stillDir, { recursive: true });
for (const s of manifest.symbols) await encode(join(src, s.textureFile), join(dst, s.textureFile), 'png');

writeFileSync(join(dst, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// generated UI art (keyed PNGs); bg.jpg stays as is
const uiDir = join(project, 'assets/resources/ui');
for (const f of readdirSync(uiDir).filter((f) => f.endsWith('.png'))) {
    const p = join(uiDir, f);
    before += sizeOf(p);
    const buf = await sharp(p).png(PNG).toBuffer();
    if (buf.length < sizeOf(p)) writeFileSync(p, buf);
    after += sizeOf(p);
}

console.log(`textures and pack files: ${kb(before)} -> ${kb(after)}`);
