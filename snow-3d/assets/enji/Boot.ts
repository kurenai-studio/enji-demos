import { _decorator, Component } from 'cc';
import { MainView } from '../game/MainView';
import { ShotView } from '../game/ShotView';

const { ccclass } = _decorator;

/**
 * Enji entry point. main.scene references this script by uuid, so keep the
 * file name, the .meta file and the class name unchanged.
 * Plays the Lich King shot; `?view=sandbox` opens the free-play tray instead.
 */
@ccclass('EnjiBoot')
export class EnjiBoot extends Component {
    start() {
        const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
        if (/[?&]view=sandbox\b/.test(search)) this.node.addComponent(MainView).bind(this.node);
        else this.node.addComponent(ShotView).bind(this.node);
    }
}
