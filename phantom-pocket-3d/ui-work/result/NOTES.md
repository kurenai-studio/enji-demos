# 结算弹窗 区域稿 NOTES

## 布局思路
- 单一顶层 `result_dialog`（anchor=center，60–660 × 360–940），自上而下四段：标题横幅 → 说明条 → 结算面板 → 下一战键。
- 标题横幅是向右上倾斜的血红平行四边形（360–480），越出炭黑主板顶边，制造 P5 式“爆出”冲击；右下挂一道斜楔延续斜线节奏。
- 说明条用更深的斜切黑条，与横幅同向倾斜；结算两行放在米白漫画分镜框里，左对齐（`lines_left` 组：结算标签 + 两行）。
- 下一战键居中、宽 380，最后一个大色块，底部左右两枚血红三角收束视线。
- 中轴 `center` 组：横幅 / 标题 / 说明 / 面板 / 按钮共享 x=360 中线。

## 视觉层级
1. 结果标题 64px 白字压血红横幅（importance 5）
2. 下一战键 血红面 + 米白倒角边（importance 5，pulse）
3. 结果说明 26px 白字（4）；4. 结算两行 30px 墨字在米白面板（3）

## 纹理清单（纹理 → 组 → 用处 → desc 要点）
- ink_plate → frame → 弹窗主板 → 炭黑漫画板、半调点、米白细边（共享词表原样）
- title_banner（新增）→ frame → 结果横幅 → 斜切血红平行四边形、内嵌墨线、两端半调，中央留白放巨字（hero）
- caption_bar（新增）→ frame → 说明条 → 深黑斜切凹槽、米白内唇
- comic_panel → frame → 结算面板 → 米白分镜框、斜切角、墨渍
- lv_chip → frame → “结算”小标签 → 血红切角小牌
- skill_rim / skill_face → button → 下一战键 rim / face（已定稿 72:14:6，face 为 hero）
- hazard_stripe → deco → 结算面板下沿警示条（tile x）
- spike_tri → deco → 主板左下 / 右下三角角饰
- slash_wedge → deco → 标题横幅右下斜楔

## 装饰区域
- 5 个 deco 贴图件，全部带 data-attach：title_slash→title_banner:br、lines_hazard→lines_panel:b、spike_bl/br→dialog_plate:bl/br。
- 面板内墨线分隔 `lines_rule` 为 program 色块，不生成贴图。

## 自评不足
- 未做经验进度条：内容表无经验总量/上限，画了会编造数值。
- 标题横幅宽度按 4 字设计；“胜利”“战败”两字时留白偏大，需要运行时字距/字号策略。
- 结算区只有两行，面板下半节奏略空；按钮两侧无次级操作（brief 未要求）。
