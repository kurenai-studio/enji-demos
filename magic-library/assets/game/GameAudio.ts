import { AudioClip, AudioSource, Node, resources, sys } from 'cc';

/** One-shots plus one looping BGM track chosen in settings. */
const SFX = [
    'book_pick', 'book_shelve', 'book_setdown', 'book_throw', 'book_land',
    'books_shove', 'footstep_a', 'footstep_b', 'footstep_c', 'footstep_d', 'wrong_place', 'set_done', 'row_done',
    'unlock', 'win_fanfare', 'ui_click',
    'skill_insight', 'skill_guide', 'skill_sort', 'skill_summon', 'skill_shelve',
] as const;

export const TRACKS = [
    { path: 'audio/music/bgm_old_tower_inn', title: '旧塔旅店' },
    { path: 'audio/music/bgm_calm_town', title: '宁静小镇' },
    { path: 'audio/music/bgm_field_of_dreams', title: '梦之原野' },
    { path: 'audio/music/bgm_town_theme', title: '小镇主题' },
    { path: 'audio/music/library_theme', title: '藏书阁' },
] as const;

const POOL = 8;
const MUSIC_GAIN = 0.42;
const STORE = 'enji.library.audio';

type SfxName = (typeof SFX)[number];

function loadClip(path: string): Promise<AudioClip | null> {
    return new Promise((resolve) => {
        resources.load(path, AudioClip, (err, clip) => {
            if (err || !clip) resolve(null);
            else resolve(clip);
        });
    });
}

export class GameAudio {
    private readonly root: Node;
    private readonly music: AudioSource;
    private readonly pool: AudioSource[] = [];
    private next = 0;
    private readonly clips = new Map<string, AudioClip>();
    private readonly lastPlay = new Map<string, number>();
    private clock = 0;
    private step = 0;
    private track = 0;
    private musicRetry = 0;
    private ready = false;
    private musicOn = true;
    private sfxOn = true;

    constructor(parent: Node) {
        this.root = new Node('GameAudio');
        parent.addChild(this.root);
        this.music = this.root.addComponent(AudioSource);
        this.music.loop = true;
        this.music.volume = MUSIC_GAIN;
        const saved = readSaved();
        this.musicOn = saved.music;
        this.sfxOn = saved.sfx;
        this.track = saved.track % TRACKS.length;
        for (let i = 0; i < POOL; i++) {
            const src = this.root.addComponent(AudioSource);
            src.loop = false;
            this.pool.push(src);
        }
    }

    async load(): Promise<void> {
        const jobs: Promise<void>[] = [];
        for (const name of SFX) {
            jobs.push(loadClip(`audio/sfx/${name}`).then((clip) => {
                if (clip) this.clips.set(name, clip);
            }));
        }
        for (const track of TRACKS) {
            jobs.push(loadClip(track.path).then((clip) => {
                if (clip) this.clips.set(track.path, clip);
            }));
        }
        await Promise.all(jobs);
        this.ready = true;
        this.playCurrent();
    }

    get musicEnabled(): boolean { return this.musicOn; }
    get sfxEnabled(): boolean { return this.sfxOn; }
    get trackIndex(): number { return this.track; }
    get trackTitle(): string { return TRACKS[this.track]?.title ?? ''; }

    setMusicEnabled(on: boolean): void {
        this.musicOn = on;
        this.save();
        if (on) this.playCurrent();
        else this.music.stop();
    }

    setSfxEnabled(on: boolean): void {
        this.sfxOn = on;
        this.save();
    }

    /** Switch the looping track. Index wraps. */
    setTrack(index: number): void {
        const count = TRACKS.length;
        this.track = ((index % count) + count) % count;
        this.save();
        this.playCurrent();
    }

    /** Left/right wood steps, cycled so a walk isn't one repeated click. */
    playStep(gain = 0.32): void {
        const names = ['footstep_a', 'footstep_b', 'footstep_c', 'footstep_d'] as const;
        const name = names[this.step % names.length];
        this.step += 1;
        const vol = gain * (0.86 + Math.random() * 0.22);
        this.play(name, vol, 0, 0.05);
    }

    play(name: SfxName | string, gain = 1, pitch = 0, gap = 0.04): void {
        if (!this.ready || !this.sfxOn) return;
        const last = this.lastPlay.get(name) ?? -999;
        if (this.clock - last < gap) return;
        const clip = this.clips.get(name);
        if (!clip) return;
        this.lastPlay.set(name, this.clock);
        let src: AudioSource | null = null;
        for (let k = 0; k < POOL; k++) {
            const c = this.pool[(this.next + k) % POOL];
            if (!c.playing) {
                src = c;
                this.next = (this.next + k + 1) % POOL;
                break;
            }
        }
        if (!src) {
            src = this.pool[this.next];
            this.next = (this.next + 1) % POOL;
            src.stop();
        }
        src.clip = clip;
        src.volume = Math.max(0, Math.min(1, gain));
        // Cocos AudioSource has no pitch; vary volume slightly instead when pitch asked.
        if (pitch > 0) src.volume *= 0.9 + Math.random() * 0.2;
        src.play();
    }

    update(dt: number): void {
        if (!this.ready) return;
        this.clock += dt;
        if (!this.musicOn || this.music.playing) {
            this.musicRetry = 0;
            return;
        }
        this.musicRetry += dt;
        if (this.musicRetry > 0.4) {
            this.musicRetry = 0;
            this.playCurrent();
        }
    }

    dispose(): void {
        this.music.stop();
        for (const src of this.pool) src.stop();
        if (this.root.isValid) this.root.destroy();
    }

    private playCurrent(): void {
        if (!this.ready || !this.musicOn) return;
        const spec = TRACKS[this.track];
        const clip = spec ? this.clips.get(spec.path) : undefined;
        if (!clip) return;
        if (this.music.playing && this.music.clip === clip) return;
        this.music.stop();
        this.music.clip = clip;
        this.music.loop = true;
        this.music.volume = MUSIC_GAIN;
        this.music.play();
    }

    private save(): void {
        try {
            sys.localStorage.setItem(STORE, JSON.stringify({
                music: this.musicOn,
                sfx: this.sfxOn,
                track: this.track,
            }));
        } catch {
            // Private mode can reject storage; the session still keeps the choice.
        }
    }
}

function readSaved(): { music: boolean; sfx: boolean; track: number } {
    try {
        const raw = sys.localStorage.getItem(STORE);
        if (!raw) return { music: true, sfx: true, track: 0 };
        const parsed = JSON.parse(raw) as { music?: boolean; sfx?: boolean; track?: number };
        const track = Math.floor(Number(parsed.track) || 0);
        return {
            music: parsed.music !== false,
            sfx: parsed.sfx !== false,
            track: track >= 0 ? track : 0,
        };
    } catch {
        return { music: true, sfx: true, track: 0 };
    }
}
