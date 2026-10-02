# 道具袋弹窗 区域稿 NOTES

## 布局思路
- 单一顶层 `bag_dialog`（anchor=center，60–660 × 300–940），内含炭黑 `dlg_body`（ink_plate，72–648 × 320–908）。
- 结构自上而下：标题区（米白斜切漫画框 + 血红斜楔垫底）→ 提示 → 黄色斜纹警示带分隔 → 两行道具 → 底部居中 `关闭`。
- 道具行：左侧米白斜切漫画面板（右缘斜切）承载名称/数量/效果，`使用` 键放在面板外的黑底上，红键压黑底对比最强，也避免米白 rim 与米白面板糊在一起。
- 左对齐组 `col_left`（x=120）：标题、提示、名称、效果；`col_use`：两个使用键同列；两行结构完全相同，行容器 role=`item_row`。

## 视觉层级
1. `使用` 键（skill_rim + skill_face，72 高、14 切角、6 边框，同已定稿主技能键）——主操作。
2. 标题「道具袋」44px 墨字 + 血红斜楔。
3. 道具名 30px 粗体 + 血红数量签（lv_chip）。
4. 效果 22px、提示 20px 灰字；`关闭` 用次级键（红 rim + 米白 face）降一级。

## 纹理清单（全部沿用共享词表，未新增）
- comic_panel → frame → title_panel、item_row_*_panel → 米白漫画框，斜切边，中心留白给字
- ink_plate → frame → dlg_body → 炭黑漫画板，半调网点，米白细描边
- lv_chip → frame → item_count_*_chip → 小血红签，白字数量
- skill_rim / skill_face → button → item_use_* → 米白倒角边框 + 血红面
- util_rim / util_face → button → bag_close → 红窄边框 + 米白面
- hazard_stripe → deco → hazard_band → 黄色斜纹，横向平铺
- spike_tri → deco → spike_tl / spike_br → 血红直角三角角饰
- slash_wedge → deco → title_wedge → 血红斜平行四边形

## 装饰区域
- spike_tl → `dlg_body:tl`，spike_br → `dlg_body:br`（越出弹窗本体角，制造侵略性切角）。
- title_wedge → `title_panel:br`（从标题框下/右露出的红斜楔）。
- hazard_band：标题区与列表之间的斜纹分隔带（未挂载）。

## 自评不足
- 弹窗下半部（关闭键与本体底边之间）留白偏多，两行道具时略空；道具多时需要改为滚动列表（当前未设 data-scroll）。
- 无道具图标（brief 未要求，也避免画生物/物件插画）；行内信息密度偏低。
- 外接框 y 到 940，比 brief 建议的 1000 短，按内容收紧。
