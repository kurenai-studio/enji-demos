import { ARCHIVE_LAYOUT } from './archiveLayout';
import { GOTHIC_LAYOUT } from './sliceLayout';

export type LevelId = 'archive' | 'gothic';

export type LevelDef = {
    id: LevelId;
    /** Shown on the title buttons and the progress card. */
    title: string;
    hall: string;
    bay: string;
    /** Turn the authored bay so the open face looks into the room. */
    shelfFlip: boolean;
    layout: typeof ARCHIVE_LAYOUT | typeof GOTHIC_LAYOUT;
};

export const LEVELS: Record<LevelId, LevelDef> = {
    archive: {
        id: 'archive',
        title: '第一关 · 档案馆',
        hall: 'models/ArchiveHall',
        bay: 'models/ArchiveBay',
        // ArchiveBay opens on local -X; authored wall yaw already faces that into the room.
        shelfFlip: false,
        layout: ARCHIVE_LAYOUT,
    },
    gothic: {
        id: 'gothic',
        title: '第二关 · 哥特大厅',
        hall: 'models/Hall',
        bay: 'models/ShelfBay',
        shelfFlip: true,
        layout: GOTHIC_LAYOUT,
    },
};

export const LEVEL_ORDER: LevelId[] = ['archive', 'gothic'];
