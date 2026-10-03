import { _decorator, Camera, Color, Component, director, geometry, KeyCode, Layers, Material, MeshRenderer, Node, Vec2, Vec3 } from 'cc';
import type { IView } from '../enji/IView';
import { ensureCanvas, loadEffect } from '../enji/helpers';
import { CrowdView, mapMesh, type Overlay, type SearchView } from './CrowdView';
import { Hud } from './Hud';
import { Interaction } from './Interaction';
import { mazeMap, type NavMap, roomsMap } from './nav/Grid';
import { AStar, expandJumps, Jps } from './nav/Search';
import { polylineLength, smoothPath } from './nav/Smooth';
import { type Pathing, type Scenario, Swarm } from './nav/Swarm';
import { OrbitCamera } from './OrbitCamera';

const { ccclass } = _decorator;

const COUNTS = [400, 800, 150];
const MAX_AGENTS = 800;
const PATHINGS: Pathing[] = ['flow', 'astar', 'jps'];
const PATHING_NAMES: Record<Pathing, string> = { flow: 'Flow field', astar: 'A* paths', jps: 'JPS paths' };
const OVERLAYS: Overlay[] = ['none', 'flow', 'paths', 'search'];
const OVERLAY_NAMES: Record<Overlay, string> = { none: 'Overlay off', flow: 'Flow', paths: 'Paths', search: 'Search' };
const MAPS: { make: () => NavMap; scenario: Scenario }[] = [
    { make: () => roomsMap(), scenario: 'swap' },
    { make: () => mazeMap(), scenario: 'stream' },
];
const CONGESTION = 2;

interface Probe extends SearchView {
    astarNodes: number;
    jpsNodes: number;
    astarMs: number;
    jpsMs: number;
    gridLength: number;
    smoothLength: number;
}

/**
 * Grid pathfinding and a crowd: A* and jump point search, string-pulled
 * paths, flow fields with a congestion term, and ORCA local avoidance for
 * hundreds of agents walking between two targets.
 */
@ccclass('MainView')
export class MainView extends Component implements IView {
    private orbit: OrbitCamera | null = null;
    private hud: Hud | null = null;
    private interaction: Interaction | null = null;
    private camera: Camera | null = null;
    private world: Node | null = null;
    private material: Material | null = null;
    private mapRenderer: MeshRenderer | null = null;
    private view: CrowdView | null = null;
    swarm: Swarm | null = null;
    private probe: Probe | null = null;
    private mapIndex = 0;
    private countIndex = 0;
    private pathingIndex = 0;
    private overlayIndex = 0;
    private scenario: Scenario = 'swap';
    private avoidance = true;
    private congestion = true;
    private paused = false;
    private overlayAge = 0;
    private frames = 0;
    private frameTime = 0;
    private simTime = 0;
    private simMs = 0;
    private arrivalsAt: [number, number][] = [];

    bind(root: Node): void {
        const scene = director.getScene()!;
        // The template Canvas camera draws only the UI, on top of the 3D camera. Its
        // default visibility also includes DEFAULT, which would draw the world twice.
        for (const cam of scene.getComponentsInChildren(Camera)) {
            cam.clearFlags = Camera.ClearFlag.DEPTH_ONLY;
            cam.priority = 1 << 30;
            cam.visibility = Layers.Enum.UI_2D;
        }
        const world = new Node('World');
        scene.addChild(world);
        this.world = world;
        const cameraNode = new Node('MainCamera');
        world.addChild(cameraNode);
        const camera = cameraNode.addComponent(Camera);
        camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        camera.clearColor = new Color(10, 12, 18, 255);
        camera.visibility = Layers.Enum.DEFAULT;
        camera.priority = 0;
        camera.near = 0.5;
        camera.far = 300;
        this.camera = camera;
        const eye = new Vec3(0, 88, 60);
        this.orbit = new OrbitCamera(camera, eye);
        this.orbit.setView(eye, new Vec3(0, 0, 2));
        this.orbit.minDistance = 8;
        this.orbit.maxDistance = 140;

        const actions = {
            path: () => { this.pathingIndex = (this.pathingIndex + 1) % PATHINGS.length; this.swarm?.setPathing(PATHINGS[this.pathingIndex]); this.apply(); },
            orca: () => { this.avoidance = !this.avoidance; this.apply(); },
            crowding: () => { this.congestion = !this.congestion; this.apply(); },
            agents: () => { this.countIndex = (this.countIndex + 1) % COUNTS.length; this.restart(); },
            map: () => { this.mapIndex = (this.mapIndex + 1) % MAPS.length; this.scenario = MAPS[this.mapIndex].scenario; this.loadMap(); },
            scene: () => { this.scenario = this.scenario === 'swap' ? 'stream' : 'swap'; this.restart(); },
            overlay: () => { this.overlayIndex = (this.overlayIndex + 1) % OVERLAYS.length; this.overlayAge = Infinity; this.apply(); },
            pause: () => { this.paused = !this.paused; this.apply(); },
        };
        const ids = Object.keys(actions) as (keyof typeof actions)[];
        this.hud = new Hud(ensureCanvas(root).node, ids.map((id) => ({ id, onTap: actions[id] })));
        this.interaction = new Interaction(this.orbit, (x, y) => this.hud?.contains(x, y) ?? false, [
            [KeyCode.KEY_P, actions.path], [KeyCode.KEY_O, actions.orca], [KeyCode.KEY_C, actions.crowding],
            [KeyCode.KEY_N, actions.agents], [KeyCode.KEY_M, actions.map], [KeyCode.KEY_S, actions.scene],
            [KeyCode.KEY_V, actions.overlay], [KeyCode.SPACE, actions.pause],
        ], (p) => this.tap(p));
        this.interaction.enable();

        void loadEffect('effects/pc-flat').then((effectAsset) => {
            const m = new Material();
            m.initialize({ effectAsset });
            this.material = m;
            this.loadMap();
        });
        (globalThis as { __pc?: MainView }).__pc = this;
    }

    onDestroy(): void {
        this.interaction?.disable();
        this.hud?.destroy();
    }

    private loadMap(): void {
        const world = this.world, material = this.material;
        if (!world || !material) return;
        const map = MAPS[this.mapIndex].make();
        if (!this.mapRenderer) {
            const node = new Node('Map');
            world.addChild(node);
            this.mapRenderer = node.addComponent(MeshRenderer);
            this.mapRenderer.shadowCastingMode = MeshRenderer.ShadowCastingMode.OFF;
            this.mapRenderer.receiveShadow = MeshRenderer.ShadowReceivingMode.OFF;
        }
        this.mapRenderer.mesh = mapMesh(map.grid);
        this.mapRenderer.setSharedMaterial(material, 0);
        if (!this.view) this.view = new CrowdView(world, material, map.grid, MAX_AGENTS);
        this.swarm = new Swarm(map, MAX_AGENTS);
        this.restart();
    }

    private restart(): void {
        const s = this.swarm;
        if (!s) return;
        s.scenario = this.scenario;
        s.pathing = PATHINGS[this.pathingIndex];
        s.spawn(COUNTS[this.countIndex]);
        this.arrivalsAt = [];
        this.simTime = 0;
        this.runProbe();
        this.apply();
    }

    /** Taps on the ground move target 1 (the destination in both scenarios). */
    private tap(screen: Vec2): void {
        const cam = this.camera, s = this.swarm;
        if (!cam || !s) return;
        const ray = new geometry.Ray();
        cam.screenPointToRay(screen.x, screen.y, ray);
        if (Math.abs(ray.d.y) < 1e-6) return;
        const t = -ray.o.y / ray.d.y;
        if (t <= 0) return;
        const gx = ray.o.x + ray.d.x * t + s.map.grid.w / 2, gy = ray.o.z + ray.d.z * t + s.map.grid.h / 2;
        if (gx < 0 || gy < 0 || gx >= s.map.grid.w || gy >= s.map.grid.h) return;
        s.setTarget(1, gx, gy);
        this.runProbe();
        this.overlayAge = Infinity;
    }

    /** A* and JPS between the two targets: nodes expanded, time, and the smoothed path. */
    private runProbe(): void {
        const s = this.swarm;
        if (!s) return;
        const grid = s.map.grid;
        const cellOf = ([x, y]: [number, number]): number => grid.nearestFree(x, y);
        const start = cellOf(s.targets[0]), goal = cellOf(s.targets[1]);
        const astar = new AStar(grid), jps = new Jps(grid);
        const time = (f: () => void): number => {
            const t0 = performance.now();
            for (let k = 0; k < 10; k++) f();
            return (performance.now() - t0) / 10;
        };
        const astarMs = time(() => astar.find(start, goal));
        const jpsMs = time(() => jps.find(start, goal));
        astar.record = jps.record = true;
        const a = astar.find(start, goal), j = jps.find(start, goal);
        if (!a || !j) { this.probe = null; return; }
        const path = smoothPath(grid, expandJumps(grid, j.cells), s.targets[0], s.targets[1], s.crowd.params.radius);
        this.probe = {
            astarCells: [...astar.expandedCells], jpsCells: [...jps.expandedCells], path,
            astarNodes: a.expanded, jpsNodes: j.expanded, astarMs, jpsMs, gridLength: a.cost, smoothLength: polylineLength(path),
        };
    }

    update(dt: number): void {
        this.orbit?.update(dt);
        const s = this.swarm, view = this.view;
        if (!s || !view) return;
        s.crowd.avoidance = this.avoidance;
        s.congestionWeight = this.congestion ? CONGESTION : 0;
        if (!this.paused) {
            const t0 = performance.now();
            s.update(Math.min(dt, 1 / 30));
            this.simMs += performance.now() - t0;
            this.simTime += Math.min(dt, 1 / 30);
            this.arrivalsAt.push([this.simTime, s.arrivals]);
            while (this.arrivalsAt.length > 2 && this.arrivalsAt[0][0] < this.simTime - 30) this.arrivalsAt.shift();
        }
        view.updateAgents(s);
        this.updateOverlay(dt);
        this.updateHud(dt);
    }

    private updateOverlay(dt: number): void {
        const s = this.swarm!, view = this.view!;
        const overlay = OVERLAYS[this.overlayIndex];
        this.overlayAge += dt;
        if (overlay === 'paths') { view.drawPaths(s); return; }
        if (this.overlayAge < 0.25) return;
        this.overlayAge = 0;
        if (overlay === 'flow') {
            if (this.congestion) s.splatOpposing(1);
            view.drawFlow(s, 1, this.congestion ? s.density : null);
        }
        else if (overlay === 'search' && this.probe) view.drawSearch(s.map.grid, this.probe);
        else view.clearOverlay();
    }

    private apply(): void {
        const hud = this.hud;
        if (!hud) return;
        hud.setButton('path', PATHING_NAMES[PATHINGS[this.pathingIndex]]);
        hud.setButton('orca', this.avoidance ? 'ORCA on' : 'ORCA off', this.avoidance);
        hud.setButton('crowding', this.congestion ? 'Crowding on' : 'Crowding off', this.congestion);
        hud.setButton('agents', `${COUNTS[this.countIndex]} agents`);
        hud.setButton('map', this.swarm?.map.name ?? 'Map');
        hud.setButton('scene', this.scenario === 'swap' ? 'Swap' : 'Stream');
        hud.setButton('overlay', OVERLAY_NAMES[OVERLAYS[this.overlayIndex]], this.overlayIndex > 0);
        hud.setButton('pause', this.paused ? 'Resume' : 'Pause', this.paused);
    }

    private updateHud(dt: number): void {
        this.frames++;
        this.frameTime += dt;
        if (this.frameTime < 0.5 || !this.hud || !this.swarm) return;
        const s = this.swarm;
        const p = this.probe;
        const pathing = PATHINGS[this.pathingIndex];
        const first = this.arrivalsAt[0], last = this.arrivalsAt[this.arrivalsAt.length - 1];
        const rate = first && last && last[0] > first[0] + 1 ? ((last[1] - first[1]) / (last[0] - first[0])) * 60 : 0;
        const navLine = pathing === 'flow'
            ? `Flow fields: ${s.fieldMs[0].toFixed(1)} + ${s.fieldMs[1].toFixed(1)} ms per build${this.congestion ? ', rebuilt with crowding every 0.5 s' : ''}`
            : `Path queue ${s.queue.length} · ${s.lastSearches} searched last frame in ${s.lastSearchMs.toFixed(1)} ms (budget ${s.searchBudgetMs} ms)`;
        this.hud.setStatus([
            `FPS ${(this.frames / this.frameTime).toFixed(0)} · frame ${((this.frameTime / this.frames) * 1000).toFixed(1)} ms · crowd ${(this.simMs / this.frames).toFixed(2)} ms`,
            `${s.crowd.count} agents · ${s.map.name} · ${this.scenario} · ${PATHING_NAMES[pathing]} · ORCA ${this.avoidance ? 'on' : 'off'}`,
            navLine,
            p ? `A* ${p.astarNodes} nodes ${p.astarMs.toFixed(2)} ms · JPS ${p.jpsNodes} nodes ${p.jpsMs.toFixed(2)} ms · ${p.gridLength.toFixed(1)} → ${p.smoothLength.toFixed(1)} m` : '-',
            `Arrivals ${s.arrivals} (${rate.toFixed(0)}/min) · tap the ground to move the goal`,
        ]);
        this.frames = 0;
        this.frameTime = 0;
        this.simMs = 0;
    }
}
