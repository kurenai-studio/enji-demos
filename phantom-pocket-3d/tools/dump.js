// Evaluated in the preview page (?prefab=...): walks the instantiated prefab and
// returns runtime component values. Adapted from enji docs/experiments/llm-writes-prefabs/scripts/dump.js.
(async () => {
    for (let i = 0; i < 120 && !window.__harness; i++) await new Promise((r) => setTimeout(r, 250));
    const h = window.__harness;
    if (!h || !h.ok) return { harness: h || null };
    await new Promise((r) => setTimeout(r, 1000));
    const root = window.__harnessRoot;
    const col = (c) => (c ? [c.r, c.g, c.b, c.a] : null);
    const v3 = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
    const pathOf = (n) => {
        const parts = [];
        while (n && n !== root) { parts.unshift(n.name); n = n.parent; }
        return n === root ? parts.join('/') : null;
    };
    const rows = [];
    const walk = (n) => {
        const q = n.rotation;
        const r = { path: pathOf(n), children: n.children.map((c) => c.name), pos: v3(n.position),
            quat: [q.x, q.y, q.z, q.w].map((x) => +x.toFixed(5)), euler: v3(n.eulerAngles), scale: v3(n.scale),
            layer: n.layer, active: n.active, comps: [] };
        for (const c of n.components) {
            const t = cc.js.getClassName(c);
            const o = { type: t };
            if (t === 'cc.UITransform') { r.ui = { w: c.contentSize.width, h: c.contentSize.height, ax: c.anchorX, ay: c.anchorY }; continue; }
            if (t === 'cc.Sprite') Object.assign(o, { frame: c.spriteFrame ? c.spriteFrame._uuid : null, spriteType: c.type,
                sizeMode: c.sizeMode, color: col(c.color), frameSize: c.spriteFrame ? [c.spriteFrame.rect.width, c.spriteFrame.rect.height] : null,
                border: c.spriteFrame ? [c.spriteFrame.insetLeft, c.spriteFrame.insetTop, c.spriteFrame.insetRight, c.spriteFrame.insetBottom] : null });
            else if (t === 'cc.Label') Object.assign(o, { string: c.string, fontSize: c.fontSize, lineHeight: c.lineHeight, color: col(c.color),
                bold: c.isBold, hAlign: c.horizontalAlign, vAlign: c.verticalAlign, overflow: c.overflow });
            else if (t === 'cc.Button') Object.assign(o, { target: c.target ? pathOf(c.target) : null, transition: c.transition,
                zoomScale: c.zoomScale, interactable: c.interactable });
            else if (t === 'cc.Widget') Object.assign(o, { alignFlags: c.alignFlags, top: c.top, bottom: c.bottom, left: c.left, right: c.right, alignMode: c.alignMode });
            else if (t === 'cc.UIOpacity') Object.assign(o, { opacity: c.opacity });
            else if (t === 'cc.DirectionalLight') Object.assign(o, { color: col(c.color), illuminanceHDR: c._illuminanceHDR, illuminance: c.illuminance, shadowEnabled: c.shadowEnabled });
            else if (t === 'cc.SphereLight' || t === 'cc.SpotLight') {
                Object.assign(o, { color: col(c.color), luminanceHDR: c._luminanceHDR, luminance: c.luminance, size: c.size, range: c.range });
                if (t === 'cc.SpotLight') o.spotAngle = c._spotAngle;
            } else if (t === 'cc.Camera') Object.assign(o, { projection: c.projection, fov: c.fov, fovAxis: c.fovAxis, near: c.near, far: c.far,
                clearFlags: c.clearFlags, clearColor: col(c.clearColor), priority: c.priority, visibility: c.visibility });
            else if (t === 'cc.MeshRenderer') {
                const mats = c.sharedMaterials.map((m) => m ? { uuid: m._uuid, effect: m.effectName, mainColor: (() => { try { return col(m.getProperty('mainColor')); } catch { return null; } })() } : null);
                const s = c.mesh ? c.mesh.struct : null;
                Object.assign(o, { mesh: c.mesh ? c.mesh._uuid : null, materials: mats,
                    meshBounds: s && s.minPosition ? [v3(s.minPosition), v3(s.maxPosition)] : null,
                    shadowCasting: c.shadowCastingMode, shadowReceiving: c.shadowReceivingMode });
            }
            r.comps.push(o);
        }
        rows.push(r);
        n.children.forEach(walk);
    };
    walk(root);
    return { harness: h, nodeCount: rows.length, rows };
})()
