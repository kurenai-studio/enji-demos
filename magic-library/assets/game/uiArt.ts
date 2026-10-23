import { resources, SpriteFrame } from 'cc';

/** Load a resources image as a SpriteFrame (`path` without extension). */
export function loadFrame(path: string): Promise<SpriteFrame> {
    return new Promise((resolve, reject) => {
        resources.load(`${path}/spriteFrame`, SpriteFrame, (err, frame) => {
            if (!err && frame) {
                resolve(frame);
                return;
            }
            resources.load(path, SpriteFrame, (err2, frame2) => {
                if (err2 || !frame2) reject(err2 ?? err ?? new Error(path));
                else resolve(frame2);
            });
        });
    });
}

export type UiPack = {
    titleCartouche: SpriteFrame;
    titleCrest: SpriteFrame;
    titleRibbon: SpriteFrame;
    titleDivider: SpriteFrame;
    titleCorner: SpriteFrame;
    titleCornerFlip: SpriteFrame;
    btnRimWide: SpriteFrame;
    btnFaceVelvet: SpriteFrame;
    btnRim: SpriteFrame;
    btnFaceEmerald: SpriteFrame;
    panelFrame: SpriteFrame;
    panelInset: SpriteFrame;
    hudFrame: SpriteFrame;
    hudDivider: SpriteFrame;
    hudCorner: SpriteFrame;
    hudCornerFlip: SpriteFrame;
    hudSocket: SpriteFrame;
    hudSocketSelected: SpriteFrame;
    hudSocketDisabled: SpriteFrame;
    hudBtnRim: SpriteFrame;
    hudBtnFace: SpriteFrame;
    hudBar: SpriteFrame;
    hudRow: SpriteFrame;
    hudRibbon: SpriteFrame;
    hudPrimarySocket: SpriteFrame;
    curtainPanel: SpriteFrame;
    titleBackdrop: SpriteFrame;
};

const T = 'image/ui/title';
const H = 'image/ui/hud';

/** Walnut / brass Route C art used by the title and the in-play HUD. */
export async function loadUiPack(): Promise<UiPack> {
    const [
        titleCartouche, titleCrest, titleRibbon, titleDivider, titleCorner, titleCornerFlip,
        btnRimWide, btnFaceVelvet, btnRim, btnFaceEmerald,
        panelFrame, panelInset,
        hudFrame, hudDivider, hudCorner, hudCornerFlip,
        hudSocket, hudSocketSelected, hudSocketDisabled,
        hudBtnRim, hudBtnFace, hudBar, hudRow, hudRibbon, hudPrimarySocket,
        curtainPanel, titleBackdrop,
    ] = await Promise.all([
        loadFrame(`${T}/title_cartouche__1080x360__normal`),
        loadFrame(`${T}/crest_medallion__152x152__normal`),
        loadFrame(`${T}/ribbon__720x96__normal`),
        loadFrame(`${T}/divider_flourish__480x28__normal`),
        loadFrame(`${T}/corner_filigree__104x104__normal`),
        loadFrame(`${T}/corner_filigree__104x104_fx_fy__normal`),
        loadFrame(`${T}/btn_rim__840x136__normal`),
        loadFrame(`${T}/btn_face_velvet__816x112__normal`),
        loadFrame(`${T}/btn_rim__404x112__normal`),
        loadFrame(`${T}/btn_face_emerald__384x92__normal`),
        loadFrame(`${T}/panel_frame__840x744__normal`),
        loadFrame(`${T}/panel_inset__744x324__normal`),
        loadFrame(`${H}/panel_frame__580x352__normal`),
        loadFrame(`${H}/divider_flourish__492x20__normal`),
        loadFrame(`${H}/corner_filigree__80x80__normal`),
        loadFrame(`${H}/corner_filigree__80x80_fx_fy__normal`),
        loadFrame(`${H}/round_socket__116x116__normal`),
        loadFrame(`${H}/round_socket__116x116__selected`),
        loadFrame(`${H}/round_socket__116x116__disabled`),
        loadFrame(`${H}/btn_rim__192x88__normal`),
        loadFrame(`${H}/btn_face_emerald__172x68__normal`),
        loadFrame(`${H}/bar_groove__492x24__normal`),
        loadFrame(`${T}/row_card__744x128__normal`),
        loadFrame(`${H}/ribbon__920x96__normal`),
        loadFrame(`${H}/round_socket__184x184__normal`),
        loadFrame(`${T}/curtain_panel`),
        loadFrame(`${T}/title_backdrop`),
    ]);
    return {
        titleCartouche, titleCrest, titleRibbon, titleDivider, titleCorner, titleCornerFlip,
        btnRimWide, btnFaceVelvet, btnRim, btnFaceEmerald,
        panelFrame, panelInset,
        hudFrame, hudDivider, hudCorner, hudCornerFlip,
        hudSocket, hudSocketSelected, hudSocketDisabled,
        hudBtnRim, hudBtnFace, hudBar, hudRow, hudRibbon, hudPrimarySocket,
        curtainPanel, titleBackdrop,
    };
}
