import { AudioClip, AudioSource, Node, resources } from 'cc';

export type SfxKey =
    | 'bgm'
    | 'click'
    | 'symbol_win'
    | 'symbol_vanish'
    | 'btm_fall_auto_1'
    | 'btm_fall_auto_2'
    | 'score_num'
    | 'multiplier_up_1'
    | 'multiplier_up_2'
    | 'multiplier_up_3'
    | 'cta_in';

const KEYS: SfxKey[] = [
    'bgm',
    'click',
    'symbol_win',
    'symbol_vanish',
    'btm_fall_auto_1',
    'btm_fall_auto_2',
    'score_num',
    'multiplier_up_1',
    'multiplier_up_2',
    'multiplier_up_3',
    'cta_in',
];

/** Key-based one-shots plus a looping BGM; the same key plays at most once per 90 ms. */
export class Sfx {
    private clips = new Map<SfxKey, AudioClip>();
    private fx: AudioSource;
    private music: AudioSource;
    private last = new Map<SfxKey, number>();
    private musicStarted = false;

    constructor(host: Node) {
        const n = new Node('sfx');
        host.addChild(n);
        this.fx = n.addComponent(AudioSource);
        this.music = n.addComponent(AudioSource);
        this.music.loop = true;
        this.music.volume = 0.45;
    }

    async load(): Promise<void> {
        await Promise.all(
            KEYS.map(
                (k) =>
                    new Promise<void>((res) =>
                        resources.load(`audio/${k}`, AudioClip, (e, clip) => {
                            if (!e) this.clips.set(k, clip);
                            res();
                        }),
                    ),
            ),
        );
    }

    play(key: SfxKey, volume = 1): void {
        const now = Date.now();
        if (now - (this.last.get(key) ?? 0) < 90) return;
        this.last.set(key, now);
        const clip = this.clips.get(key);
        if (clip) this.fx.playOneShot(clip, volume);
    }

    /** Browsers only start audio after a gesture; call from the first tap. */
    startMusic(): void {
        if (this.musicStarted) return;
        const clip = this.clips.get('bgm');
        if (!clip) return;
        this.musicStarted = true;
        this.music.clip = clip;
        this.music.play();
    }
}
