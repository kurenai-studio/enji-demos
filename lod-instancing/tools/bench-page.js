// Benchmarks for the preview page: paste into the console (or Runtime.evaluate) once the
// forest is up, then e.g. `await __abba(0, [3, 2, 1, 0], 6)` or `await __fly(0, [3, 2], 900)`.
// Count index: 0 = 16K, 1 = 64K, 2 = 4K. Path: 0 nodes, 1 LODGroup, 2 merged, 3 GPU list.
// A frame is one director.tick(1/60) plus a 1-pixel readPixels, so the GPU has finished.
(() => {
    const env = () => {
        const cc = globalThis.cc;
        return {
            cc, v: globalThis.__lod, gl: cc.game.canvas.getContext('webgl2'), px: new Uint8Array(4),
            dev: cc.director.root.device, yieldNow: () => new Promise((r) => setTimeout(r, 0)),
        };
    };
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    const quantile = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };

    // Fixed camera at the forest's west edge looking east. All paths are built side by side
    // and shown one at a time, alternating over `rounds` so machine load hits each equally.
    globalThis.__abba = async (countIndex, paths, rounds) => {
        const { cc, v, gl, px, dev, yieldNow } = env();
        cc.game.pause();
        v.fly = false; v.spy = false; v.frozen = null; v.apply();
        v.orbit.setView(new cc.Vec3(-80, 24, 0), new cc.Vec3(60, 6, 0));
        v.countIndex = countIndex; v.pathIndex = paths[0];
        let t = performance.now();
        v.rebuild();
        const built = { [paths[0]]: v.path }, buildMs = { [paths[0]]: performance.now() - t };
        try {
            for (const p of paths.slice(1)) {
                v.path.setVisible(false);
                v.path = null;
                t = performance.now();
                v.setPath(p);
                buildMs[p] = performance.now() - t;
                built[p] = v.path;
            }
            const tick = async (n, rec) => {
                for (let i = 0; i < n; i++) {
                    const a = performance.now();
                    cc.director.tick(1 / 60);
                    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    if (rec) { rec.ft.push(performance.now() - a); rec.cpu.push(v.path.cpuMs); }
                    if (i % 15 === 14) await yieldNow();
                }
            };
            const show = (p) => { for (const q of paths) built[q].setVisible(q === p); v.path = built[p]; v.pathIndex = p; };
            const res = {};
            for (const p of paths) { res[p] = { frames: [], cpu: [] }; show(p); await tick(240); }
            for (let r = 0; r < rounds; r++) {
                for (const p of r % 2 ? [...paths].reverse() : paths) {
                    show(p);
                    await tick(20);
                    const rec = { ft: [], cpu: [] };
                    await tick(60, rec);
                    Object.assign(res[p], { draws: dev.numDrawCalls, tris: dev.numTris, inst: dev.numInstances, desc: v.path.describe() });
                    res[p].frames.push(median(rec.ft));
                    res[p].cpu.push(median(rec.cpu));
                }
            }
            return paths.map((p) => ({
                path: p, buildMs: Math.round(buildMs[p]), frameMs: +median(res[p].frames).toFixed(2),
                rounds: `${Math.min(...res[p].frames).toFixed(1)}–${Math.max(...res[p].frames).toFixed(1)}`,
                scriptMs: +median(res[p].cpu).toFixed(2), draws: res[p].draws, mtris: +(res[p].tris / 1e6).toFixed(3),
                instances: res[p].inst, desc: res[p].desc,
            }));
        } finally {
            const keep = paths[paths.length - 1];
            for (const p of paths) if (built[p] && p !== keep) built[p].destroy();
            v.path = built[keep] ?? v.path;
            v.path?.setVisible(true);
            v.pathIndex = keep;
        }
    };

    // The fly-over (7 m/s circle at canopy height) for `frames` frames per path.
    globalThis.__fly = async (countIndex, paths, frames) => {
        const { cc, v, gl, px, dev, yieldNow } = env();
        cc.game.pause();
        v.spy = false; v.frozen = null; v.countIndex = countIndex;
        const out = [];
        for (const p of paths) {
            v.pathIndex = p;
            if (p === paths[0]) v.rebuild(); else v.setPath(p);
            v.fly = true; v.flyAngle = 0.3;
            for (let i = 0; i < 60; i++) { cc.director.tick(1 / 60); if (i % 15 === 14) await yieldNow(); }
            const ft = [], cpu = [];
            let draws = 0, tris = 0;
            for (let i = 0; i < frames; i++) {
                const a = performance.now();
                cc.director.tick(1 / 60);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                ft.push(performance.now() - a);
                cpu.push(v.path.cpuMs);
                draws += dev.numDrawCalls; tris += dev.numTris;
                if (i % 15 === 14) await yieldNow();
            }
            out.push({
                path: p, medianMs: +quantile(ft, 0.5).toFixed(2), p95Ms: +quantile(ft, 0.95).toFixed(2), p99Ms: +quantile(ft, 0.99).toFixed(2),
                maxMs: +Math.max(...ft).toFixed(1), over16ms: ft.filter((x) => x > 1000 / 60).length,
                scriptMedianMs: +quantile(cpu, 0.5).toFixed(2), scriptMaxMs: +Math.max(...cpu).toFixed(2),
                draws: Math.round(draws / frames), mtris: +(tris / frames / 1e6).toFixed(2), desc: v.path.describe(),
            });
        }
        v.fly = false;
        return out;
    };
    return 'bench ready';
})();
