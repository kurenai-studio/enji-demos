// usage: node tools/key_art.mjs <generated-art-dir>
// Keys the magenta-background art (logo, board frame, UI sheet) with the
// auto-ui-pipeline keyer, trims/slices it and writes assets/resources/ui/.
// Needs a sibling checkout of auto-ui-pipeline with `npm ci` done
// (AUTO_UI_PIPELINE overrides the path).
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const pipeline = process.env.AUTO_UI_PIPELINE ?? resolve(project, '../../../auto-ui-pipeline');
const imp = (p) => import(pathToFileURL(join(pipeline, p)).href);
const { imread, imwrite, crop } = await imp('src/img.mjs');
const { loadCv, resize } = await imp('src/cv.mjs');
const { chroma_key } = await imp('src/route_stylized/keying.mjs');
await loadCv();

const src = resolve(process.argv[2] ?? '.');
const out = join(project, 'assets/resources/ui');
mkdirSync(out, { recursive: true });

function key(file, opts) {
    return chroma_key(imread(join(src, file)), opts).rgba;
}

function bbox(rgba, x0 = 0, y0 = 0, x1 = rgba.width, y1 = rgba.height, thr = 8) {
    let minX = x1, minY = y1, maxX = x0 - 1, maxY = y0 - 1;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            if (rgba.data[(y * rgba.width + x) * 4 + 3] > thr) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    return [minX, minY, maxX + 1, maxY + 1];
}

/** Opaque blobs (8-connected, alpha > thr) larger than minArea, as bboxes. */
function blobs(rgba, minArea = 1500, thr = 64) {
    const { width: W, height: H } = rgba;
    const seen = new Uint8Array(W * H);
    const found = [];
    const stack = [];
    for (let i = 0; i < W * H; i++) {
        if (seen[i] || rgba.data[i * 4 + 3] <= thr) continue;
        let minX = W, minY = H, maxX = -1, maxY = -1, area = 0;
        stack.push(i);
        seen[i] = 1;
        while (stack.length) {
            const j = stack.pop();
            const x = j % W, y = (j / W) | 0;
            area++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    const k = ny * W + nx;
                    if (!seen[k] && rgba.data[k * 4 + 3] > thr) {
                        seen[k] = 1;
                        stack.push(k);
                    }
                }
            }
        }
        if (area >= minArea) found.push([minX, minY, maxX + 1, maxY + 1]);
    }
    return found;
}

function save(rgba, box, name, width, pad = 4) {
    const [x0, y0, x1, y1] = box;
    let img = crop(rgba, Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(rgba.width, x1 + pad), Math.min(rgba.height, y1 + pad));
    if (width && img.width !== width) {
        const h = Math.round((img.height * width) / img.width);
        img = resize(img, [width, h], 'area');
    }
    imwrite(join(out, `${name}.png`), img);
    console.log(name, `${img.width}x${img.height}`);
}

const soft = { hue_window: 25, edge_hue_window: 45 };

const logo = key('thor_logo.jpg', soft);
save(logo, bbox(logo), 'logo', 620);

const frame = key('thor_frame.jpg', soft);
save(frame, bbox(frame), 'frame', 1000, 0);

const sheet = key('thor_ui_sheet.jpg', soft);
const parts = blobs(sheet).sort((a, b) => (Math.abs(a[1] - b[1]) > 120 ? a[1] - b[1] : a[0] - b[0]));
const names = ['btn_spin', 'btn_minus', 'btn_plus', 'btn_auto', 'bar', 'panel'];
const widths = [240, 110, 110, 110, 460, 420];
if (parts.length !== names.length) throw new Error(`expected ${names.length} UI parts, found ${parts.length}: ${JSON.stringify(parts)}`);
parts.forEach((b, i) => save(sheet, b, names[i], widths[i]));

copyFileSync(join(src, 'thor_bg.jpg'), join(out, 'bg.jpg'));
console.log('bg copied');
