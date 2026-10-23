import { _decorator, Component } from 'cc';
import { MainView } from '../game/MainView';

const { ccclass } = _decorator;

/**
 * Enji entry point. main.scene references this script by uuid, so keep the
 * file name, the .meta file and the class name unchanged.
 */
@ccclass('EnjiBoot')
export class EnjiBoot extends Component {
    start() {
        this.node.addComponent(MainView).bind(this.node);
    }
}
