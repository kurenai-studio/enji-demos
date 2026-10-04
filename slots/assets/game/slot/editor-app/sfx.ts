/**
 * sfx — 音效播放工具（多媒体特效的音频半边）。
 *
 * 全局懒建一个挂在场景根上的 AudioSource，用 playOneShot 播短音效：
 * 不打断、不排他、多个音效可叠放。sfxStep 把播放包成立即完成的 IAnim 步，
 * 与 spine/tween 用 par 并行即得「音画一体」的多媒体特效。
 */

import { AudioClip, AudioSource, Node, director } from 'cc';
import type { IAnim } from '../common/anim/IAnim.ts';
import { call } from '../common/anim/compose.ts';

let sharedSource: AudioSource | null = null;

function ensureSource(): AudioSource | null {
    if (sharedSource && sharedSource.isValid) return sharedSource;
    const scene = director.getScene();
    if (!scene) return null;
    const n = new Node('__sfx_source__');
    scene.addChild(n);
    sharedSource = n.addComponent(AudioSource);
    return sharedSource;
}

/** 播一次短音效；clip 为空静默跳过，播放失败只警告不抛错 */
export function playSfx(clip: AudioClip | null, volume = 1): void {
    if (!clip) return;
    try {
        ensureSource()?.playOneShot(clip, volume);
    } catch (e) {
        console.warn('[sfx] playOneShot failed', e);
    }
}

/** 音效 IAnim 步：触发即完成（不占时间轴），par 进任意演出即可 */
export function sfxStep(clip: AudioClip | null, volume = 1): IAnim {
    return call(() => playSfx(clip, volume));
}
