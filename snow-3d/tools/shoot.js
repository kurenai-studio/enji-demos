// Pasted into the preview page with CDP Runtime.evaluate: drives frames with cc.director.tick
// (the background tab is not animated) and returns the canvas as a JPEG data URL.
// globalThis.__shoot({ reset, settle, sweepFrames, view, yaw, pitch, distance })
globalThis.__shoot = (o = {}) => {
    const v = globalThis.__snowView;
    if (o.yaw !== undefined) v.yaw = o.yaw;
    if (o.pitch !== undefined) v.pitch = o.pitch;
    if (o.distance !== undefined) v.distance = o.distance;
    v.applyOrbit();
    v.paused = false;
    if (o.reset) v.reset();
    if (o.settle) for (let i = 0; i < 45; i++) cc.director.tick(1 / 60);
    if (o.sweepFrames !== undefined) {
        v.startSweep();
        for (let i = 0; i < o.sweepFrames; i++) cc.director.tick(1 / 60);
    }
    for (let i = 0; i < (o.frames || 0); i++) cc.director.tick(1 / 60);
    if (o.view !== undefined) { v.viewMode = o.view; v.applyViewMode(); }
    if (o.pause) v.paused = true;
    cc.director.tick(1 / 60);
    return document.querySelector('canvas').toDataURL('image/jpeg', 0.85);
};
'ok';
