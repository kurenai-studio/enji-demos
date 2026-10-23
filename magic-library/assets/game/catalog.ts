/** Names from the original catalog. Subject is the cover colour, emblem the mark. */

export const SUBJECTS = [
    { name: '火焰咒法', color: [0.95, 0.38, 0.32] },
    { name: '炼金术', color: [1, 0.62, 0.3] },
    { name: '星象学', color: [1, 0.86, 0.4] },
    { name: '草药学', color: [0.5, 0.85, 0.42] },
    { name: '潮汐学', color: [0.4, 0.85, 0.85] },
    { name: '占卜学', color: [0.45, 0.62, 1] },
    { name: '幻术', color: [0.75, 0.52, 1] },
    { name: '魔法生物', color: [1, 0.55, 0.78] },
] as const;

const TITLES = [
    ['点火不烧眉毛', '流星火雨入门', '月下篝火守则', '三角火阵与邻里纠纷', '菱形火苗的一百种用途', '如何温暖一颗冰冷的心'],
    ['锅底永远是黑的', '把星尘炼成糖', '月光蒸馏法', '三角瓶为何总是倒', '贤者之石（盗版）', '恋爱药水的副作用'],
    ['抬头看的学问', '星星不会迟到', '月亮今天请假', '三角星座考', '菱形彗星观测日志', '心宿二的心事'],
    ['别对曼德拉草唱歌', '星形苔藓栽培', '月见草与失眠', '三叶草不止三片', '菱叶藤的脾气', '会心跳的蘑菇'],
    ['潮汐的循环', '海星为什么是星', '月亮拽着海走', '三角浪的形成', '菱形漩涡导航', '人鱼的心事'],
    ['茶叶渣说了什么', '星盘占卜速成', '月相与运势', '三角牌阵', '菱形水晶球保养', '读心不读信'],
    ['看不见的圆圈', '满天假星星', '把月亮藏进口袋', '不可能的三角', '镜中菱宫', '心碎幻象修复手册'],
    ['猫头鹰的一百种叫法', '星鼠饲养指南', '月狼的作息', '三角龙不是龙', '菱鳞蜥的蜕皮季', '独角兽心理学'],
];

const VOLUMES = ['卷一', '卷二', '卷三'];

export function subjectName(subject: number): string {
    return SUBJECTS[subject]?.name ?? `学科${subject}`;
}

export function subjectColor(subject: number): readonly [number, number, number] {
    return SUBJECTS[subject]?.color ?? [1, 1, 1];
}

export function bookTitle(subject: number, emblem: number): string {
    return TITLES[subject]?.[emblem] ?? '无名之书';
}

export function volumeName(volume: number): string {
    return VOLUMES[volume - 1] ?? `第${volume}卷`;
}

/** 《月相与运势》卷二 */
export function bookLabel(book: { subject: number; emblem: number; volume: number }): string {
    return `《${bookTitle(book.subject, book.emblem)}》${volumeName(book.volume)}`;
}
