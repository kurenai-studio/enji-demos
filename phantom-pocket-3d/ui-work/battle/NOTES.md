# battle — 区域稿说明（oneshot，首次 validate 即 0 error / 0 warning）

## 布局思路
- 三段式：top_block(40–300, anchor top) / stage_view(0,300,720,460, anchor fill, 仅 fill=none 框) / bottom_block(760–1240, anchor bottom)。舞台内零部件，所有装饰都止于 y≤292 或 y≥772。
- 上区：黑色 ink_plate 标题条(怪谈口袋) + 右侧 108×56 菜单键；下方黄斜纹；米白 comic_panel 敌方面板（左上斜切、右下切角），名字 34px 墨字 + 红 Lv 标签，右上大号红色 62%，下方 HP 槽 + 42 / 68。
- 下区自上而下：黑色 ink_plate 我方面板（与敌方米白面板形成黑白反转对位，名/Lv/大号 87% 同一节奏），HP 槽 + MP 槽（黄填充），数字在槽外右侧 → 米白斜切状态条 → 2×2 技能键(336×72) → 道具/逃跑/队伍/捕捉一行 → 底部斜纹。
- 左列 x=16、右列 x=704 贯通全屏；技能键左列/右列分 align 组。

## 视觉层级
1. 技能四键（血红面 + 米白倒角 rim，按定稿 72:14:6）与捕捉（同套 skill 纹理，232 宽，最醒目次级键）。
2. 敌/我 HP 百分比（40/34px 红/亮红）与名字。
3. 状态条、HP/MP 数值。4. 道具/逃跑/队伍（红 rim + 米白面，墨字），菜单键。

## 纹理清单（全部原样复用共享词表，11 种，4 组）
- comic_panel → frame → 敌方面板、状态条 → 米白漫画面板，斜切边，中心留白
- ink_plate → frame → 标题条、我方面板 → 炭黑板，半调点，米白细描边
- lv_chip → frame → 敌/我等级标签 → 红色小切角标签
- skill_rim / skill_face → button → 四技能键 + 捕捉键 → 米白倒角 rim / 平涂血红面
- util_rim / util_face → button → 菜单、道具、逃跑、队伍 → 红窄 rim / 米白纸面
- bar_track → meter → 敌 HP、我 HP、我 MP 槽 → 凹刻炭黑槽，可横向平铺
- hazard_stripe → deco → 标题条下、按钮行下 → 黄斜纹，tile x
- spike_tri → deco → 敌方面板右上、怪谈斩键右上 → 红直角三角
- slash_wedge → deco → 敌方面板左下（越出面板）、状态条左端 → 红斜平行四边形

## 装饰区域
6 个 deco 贴图件全部带 data-attach：hazard_top→titlebar:b，enemy_spike→enemy_panel:tr，enemy_slash→enemy_panel:bl（越界到 292，不进舞台），status_slash→status_bar:l，ult_spike→move_3:tr（标记大招），hazard_bottom→util_row:b。

## 自评不足
- 技能键内没有属性图标（火/暗/普通），只能靠 desc 外的运行时补；大招仅靠三角角饰区分，力度偏弱。
- 黑白反转对位依赖米白面板，P5 的“漫画爆炸形按钮”只用切角近似，没有星爆异形（为保持词表一致未新增纹理）。
- 我方面板 112 高相对拥挤，MP 行与面板底边间距仅 10px。
