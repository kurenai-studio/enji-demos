# 任务：设计手游主界面「区域稿」SVG（区域语法 v2）

你是资深手游 UI 设计师兼 UI 架构师。**不给任何参考设计图**。请用 SVG 设计竖屏主界面的**区域稿**：
它表达**布局、结构和控制信息**——每个部件在哪、多大、什么形状、什么层级、什么色彩角色、如何渲染、如何生成材质、
如何挂载、运行时如何适配。

**所有视觉细节都不画**，写进 `data-desc`，之后由 AI 生图按你的几何生成真实材质再贴回。所以：

- 评比标准是**布局设计质量 + 控制信息质量**：信息层级、比例、留白、对齐、节奏、焦点、可用性，以及控制字段是否准确、合理、可被管线执行。
- 渲染出来应该像一张**扁平色块线框稿**。这是预期效果，不要用形状堆砌模拟质感。

## 游戏与美术方向

《怪谈口袋 3D Phantom Pocket 3D》，回合制捕捉对战。本界面是战斗中弹出的「道具袋」模态弹窗：竖屏，弹窗盖在实时 3D 战斗画面上（弹窗外的区域运行时是半透明黑色遮罩 + 3D 画面，区域稿里不画遮罩）。弹窗里列出可用道具（名称、效果、数量、使用键）和关闭键。

**美术方向**（写进 data-desc 用）：Persona 5 风格 UI——纯黑底、血红强调、高对比白字；尖锐对角切角与三角形装饰；漫画分镜框、斜纹警示带、漫画爆炸形按钮；不要圆角卡片堆叠，要有侵略性的几何节奏与戏剧性留白。

边缘以 `hard` / `bevel` 为主；高度以 `bevel` / `emboss` / `engrave` 为主。大量使用 `chamfer` 与尖锐 `polygon`；禁止柔边 `soft`/`brush`/`torn`。

## 画布与规范

- `<svg width="720" height="1280" viewBox="0 0 720 1280" data-style="persona3d_bag" data-light="-0.3,-0.8">`（`data-light` 为全局主光方向，可按风格调整）。
- 字体：`font-family="PingFang SC"`；所有文字 ≥ 11px；中文标签必须完整。
- 可点击元素最小边 ≥ 44；可点击元素之间不要部分重叠。
- 顶部 0–40 为刘海安全区，只放背景或装饰；底部 1240–1280 为手势安全区，同理。

## 区域语法（校验器强制）

**允许的元素**：`svg g rect circle ellipse polygon polyline line path text tspan desc title`。
**禁止**：`linearGradient radialGradient filter pattern mask clipPath image use style symbol marker`、
`opacity / fill-opacity / stroke-opacity` 属性、`style=` 内联样式、`<text>` 上的 `stroke`。

**颜色只能用下列调色板（色彩角色）**，`fill` / `stroke` 的值必须是其中之一或 `none`：

| 角色 | 色值 | 用途 |
|---|---|---|
| bg | `#0A0A0A` | 纯黑舞台底（仅 vector 背景用） |
| base | `#1A1A1A` | 主结构炭黑板 |
| base_dark | `#050505` | 更深凹陷槽 |
| base_light | `#2E2E2E` | 抬起边条/标签条 |
| panel | `#F5F0E8` | 米白漫画面板 |
| panel_ink | `#111111` | 面板上的墨线/黑条 |
| accent | `#E60012` | 血红主操作与关键数字 |
| accent_deep | `#8B0000` | 血红暗部 |
| hazard | `#F5D76E` | 斜纹警示黄 |
| glow | `#FF6B6B` | 选中/高能亮红 |
| text | `#FFFFFF` | 主文字（深底） |
| text_ink | `#111111` | 主文字（浅底面板） |
| text_dim | `#9A9A9A` | 次文字 |
| disabled | `#4A4A4A` | 禁用 |
| danger | `#FF2A2A` | 危险/濒死 |

`stroke` 只允许出现在 `program` / `vector` 部件里；贴图部件的形状一律无描边纯色填充。

## 主界面必须包含的信息

| data-role | 内容 | 示例数据 |
|---|---|---|
| `bag_title` | 弹窗标题 | 道具袋 |
| `bag_hint` | 弹窗副标题提示 | 选择要使用的道具 |
| `item_name_0` | 道具一名称 | 伤药 |
| `item_desc_0` | 道具一效果 | 回复 30 HP |
| `item_count_0` | 道具一数量 | ×3 |
| `item_use_0` | 道具一使用键 | 使用 |
| `item_name_1` | 道具二名称 | 灵露 |
| `item_desc_1` | 道具二效果 | 回复 10 MP |
| `item_count_1` | 道具二数量 | ×2 |
| `item_use_1` | 道具二使用键 | 使用 |
| `bag_close` | 关闭键 | 关闭 |

道具表：伤药 回复 30 HP ×3；灵露 回复 10 MP ×2。

**内容保真**：界面文字只能来自上表和产线数据；可以加简短的纯标签文字（如栏目名、“升级”“购买”），
但**禁止编造任何数值、数据或说明性长文案**。校验器会列出内容表之外出现的数字。
**禁止占位文字**（`—`、`--`、`TBD`、`???`、`…` 等）：没有数据的位置直接不放文字，校验器会把占位文字判为 error。
**文字对比度**：校验器把所有 `<text>` 去掉后渲染，取每段文字外框下的背景中位色，与文字颜色计算 WCAG 对比度，
低于 3.0 判为 error（报告会给出文字色角色和背景色）。修复方式：换文字的色彩角色，或换它下面区域的色彩角色。

## 风格强制规则

- 贴图部件中 `data-edge` 为 `hard` / `bevel` 的比例 ≥ 70%。
- 禁止使用 `data-shape`：`capsule`。
- 禁止使用 `data-height`：`dome`。
- 用对角切角、三角形角饰、斜纹条带制造 P5 漫画分镜感；面板可用米白 polygon，交互键用血红。

## 部件与字段

每个部件一个 `<g>`，属性写在 `<g>` 上。

### 基础字段（所有部件必填）
`id`、`data-role`（上表之一，或自定义如 `panel`/`tabbar`/`deco`/`bg`）、`data-type`（button/tab/frame/panel/plate/socket/icon/bar/text/deco）、
`data-render`、`data-x` `data-y` `data-w` `data-h`（外接框，装饰越界时外接框也要包含越界部分）、`data-z`。

`data-render`：
- `ring_mesh`：带边框的框体（边框沿区域轮廓走，轮廓可以是任意形状）。需 `data-shape`、`data-border`、`data-fill`（`hollow`/`solid`）；
  `chamfer`/`tabhex` 需 `data-cut`，`rrect` 需 `data-radius`。
- `nine_slice`：可拉伸的实心板。需 `data-shape`、`data-slice="l,t,r,b"`。
- `affine`：固定比例贴图（圆形底座、托架环、图标底座、装饰件）。需 `data-shape`。
- `program`：程序绘制（文字、数字、进度填充、弧、图标线条、光点），也用作分层按钮的外壳（见下）。
- `vector`：纯矢量背景/分隔线（不生成贴图），≤ 12 个。

选择规则：**尺寸会随内容或屏幕变化的**（面板、卡片、条、按钮）用 `ring_mesh` / `nine_slice`；**尺寸固定、比例不能变的**（圆形件、图标底座、装饰件）用 `affine`。

`data-shape`：`chamfer`（四角切角，切角 = `data-cut`）/ `rrect`（圆角 = `data-radius`）/ `circle` / `capsule` /
`tabhex`（仅上两角切角，切角 = `data-cut`）/ `polygon` / `path`
（`polygon`/`path` 用于异形：区域形状本身就是轮廓，管线按轮廓生成遮罩）。

部件可以嵌套：外层 `<g>` 的子 `<g>` 如果也带 `data-render`，就是独立部件；贴图部件的“唯一区域形状”只统计不属于子部件的形状。

**分层按钮约定**：按钮/卡片拆 rim + face 层时，用一个**不带 `data-layer` 的外壳 `<g>`**（通常 `data-render="program"`）
承载 `data-type="button"`、`data-role`、`data-states`、`data-state`、`data-bind`、`data-hit`，外接框 = 整个按钮；
rim 层、face 层、文字作为它的子部件。触控尺寸和重叠检查只针对外壳，带 `data-layer` 的层不参与。
外壳内的其它子部件（图标、文字、AD 角标、选中条等）**不要沿用交互 role**，改用 `label` / `icon` / `badge` / `deco` 等非交互 role。

### 贴图部件（ring_mesh / nine_slice / affine）必填
- `<g>` 内只放**一个**区域轮廓形状（`rect`/`circle`/`ellipse`/`polygon`/`path`），纯色填充 = `data-tone` 对应色。
- `data-tone`：色彩角色名。
- `data-texture`：纹理名，同款部件复用；去重后 **8–16 种**。
- `data-desc`：英文材质描述，所有视觉细节写这里。
- `data-family`：风格组名。同组纹理共享一个风格锚点一起生成，保证一致（如 `frame`、`button`、`hero`、`deco`）。**2–5 组**。
- `data-edge`：边缘类型 `hard`（硬切）/ `bevel`（倒角）/ `soft`（柔边）/ `brush`（笔刷）/ `torn`（撕边、不规则）。
- `data-height`：高度轮廓，驱动浮雕光照：`flat` / `bevel` / `dome` / `engrave`（凹刻）/ `emboss`（凸雕）。
  `bevel`/`engrave`/`emboss` 需 `data-height-w`（像素宽度）。
- `data-priority`：`hero`（重点，多候选高分辨率）/ `normal` / `minor`。全屏 `hero` ≤ 3 个。

### 贴图部件可选
- `data-bleed`：允许贴图溢出轮廓的像素数（墨迹晕开、藤蔓伸出）。`brush`/`torn` 边缘通常 > 0。
- `data-blend`：`normal`（默认）/ `multiply`（正片叠底，墨、印章）/ `screen` / `add`（发光）。
- `data-detail`：细节密度 `1`（朴素）/ `2` / `3`（精细）。
- `data-tile`：`x` / `y`（长条需无缝平铺的方向）。
- `data-layer="rim|face"`：按钮、卡片推荐拆成边框层 + 面板层（各自一个 `<g>`）。
- `data-states`：该部件支持的状态列表，取值 `normal pressed disabled selected cooldown`，逗号分隔，写在交互部件（或其外壳）上。
- `data-state`：**当前画面中**的状态（必须在 `data-states` 里）。例如买不起的购买钮写 `data-state="disabled"`。
  当前状态不是 normal 的部件，`data-tone` 可以用该状态的颜色（如 `disabled`），但 `data-texture` 仍写 normal 态的纹理名，
  管线会用 `data-derive` 从 normal 纹理派生。
- `data-derive`：状态派生方式，格式 `状态=方法[,状态=方法]`。方法：
  `relief_invert`（按下：浮雕反转+内阴影+下移）/ `darken` / `lighten` / `desaturate` / `steel`（去色映射到金属灰）/
  `glow`（外发光）/ `tint`（染色到当前 tone）。例：`pressed=relief_invert,disabled=steel,selected=glow`。

### 装饰区域（必须）
完整的设计离不开结构性装饰（支撑臂、警示条、角件、飘带、藤蔓、云纹、印章……）。生图只能给**已有区域**上材质，
**没有区域的装饰不会凭空出现**。因此：
- 至少 **4 个** `data-type="deco"` 的贴图部件（affine 或 ring_mesh）。
- 其中至少 **2 个**用 `data-attach="<目标部件id>:<锚点>"` 挂载到其它部件上，锚点取
  `tl tr bl br t b l r c`（左上/右上/左下/右下/上/下/左/右/中）。挂载件可以越出目标外接框（越界装饰）。

### 运行时字段
- `data-anchor`：**`<svg>` 根节点的直接子部件**（背景 `bg` 和 `vector` 除外）必填：`top` / `bottom` / `center` /
  `fill`（随屏幕高度伸缩的中间区）。建议把界面组织成若干顶层区块（顶栏、英雄区、广告条、列表、底栏……），其余部件嵌套在区块内。
- `data-stretch`：`x` / `y` / `xy` / `none`，可拉伸部件（面板、卡片、条）建议填写。
- `data-scroll="y"`：滚动容器（产线列表区）。
- `data-bind`：动态数据绑定，格式 `字段:格式`，格式取 `short`（5.39K）/ `int` / `rate`（+37.6/秒）/ `percent` /
  `ratio`（620K/1M）/ `time`（2:30）/ `text`。如 `dust:short`、`line.price:short`、`prestige:percent`。
  进度条、弧这类无文字部件也可以绑定（如 `line.progress:percent`）。
- `data-maxlen`：**含文字**的绑定部件填写：部件内字号最大那段文字的最长字符数（为本地化和大数字留余量），
  必须保证 maxlen 个字符放得下（数字按数字宽度、含中文按汉字宽度估算）。
- `data-hit="x,y,w,h"`：热区与视觉区不同时填写（如小图标按钮扩大热区）。
- `data-anim`：动画提示 `spin:<秒>` / `pulse:<秒>` / `float:<秒>` / `shimmer:<秒>`。

### 设计意图字段
- `data-importance`：1–5（5 最重要），`data-role` 为必需信息的部件必填（每个 role 至少一个部件带它）。
- `data-align`：对齐组名。同组部件应共享左边、右边或中线（校验器检查并打分）。

## 已定稿组件

主技能按钮：尖锐切角矩形，高:切角:边框 ≈ 72:14:6，rim 层（米白倒角边框，tone=panel，edge=hard，height=bevel）+ face 层（血红面板，tone=accent）。其它部件材质语言与它对齐。

## 交付物（写到你自己的目录）

1. `gen.py`（生成 `layout.svg`，便于迭代）和 `layout.svg`。
2. 第一步先运行 `date +%s > t_start`，全部完成后运行 `date +%s > t_end`。
3. 校验渲染：
   ```bash
   cd ui-kit-test/boundary-lab
   ../inc-orbit-ui/.venv/bin/python tools/validate.py <你的目录>
   ```
   生成 `preview.png`（区域稿）、`colorblock.png`（色块参考）、`wire.png`（贴图部件线框）、`report.json`。
   **error 必须修到 0**，warning 尽量消除。每跑一次 validate，校验器会自动在 `iterations.log` 记一行。
   设计质量由实验方离线评审，你拿不到分数，请按自己的专业判断做到最好。
4. **一次成稿协议**：只允许为修复校验 error 而修改；不要看 `preview.png` / `wire.png`，不要做设计迭代。
5. `NOTES.md`（≤ 30 行）：布局思路、视觉层级、纹理清单（纹理名 → 风格组 → 用在哪 → desc 要点）、装饰区域说明、自评不足。

## 禁止

- 不要看你目录以外的任何实验目录（其它模型或之前的作品）。不要修改 `grammar/`、`styles/`、`tools/`，
  不要阅读或运行 `tools/` 里除 `validate.py` 以外的脚本。
- 不要用 `<image>` 嵌位图；不要联网找图。不要改游戏仓库。

## 共享纹理词表（三个界面共用，保证材质一致）

本作有三张区域稿（战斗 HUD、道具袋弹窗、结算弹窗），材质语言必须一致。下列纹理用途相同时请**原样复用**
名称与字段（render / shape / cut / border / slice / tone / family / edge / height / height-w / desc）；
尺寸（data-w/h）按你的版面定。可以新增纹理（新增时 desc 以同一段风格前缀开头）。
**不要**做立绘框 / 空立绘槽 / 生物剪影（幻兽是 3D 模型）。

风格前缀（所有 desc 以此开头）：`Persona 5 graphic battle UI, flat ink print, razor chamfers, pure black ground, crimson and warm off-white, no blur, no soft plastic, no creature art; `

| 纹理 | family | render | shape / cut / border / slice | tone | edge / height | desc 尾段 |
|---|---|---|---|---|---|---|
| `comic_panel` | frame | nine_slice | polygon，slice `20,16,20,16` | panel | hard / bevel 4 | off-white manga panel, razor chamfer or slash edge, thin ink grime, clean center for type |
| `ink_plate` | frame | nine_slice | chamfer cut 10，slice `16,14,16,14` | base | hard / bevel 4 | charcoal black comic plate, razor chamfer, faint halftone dots, thin off-white keyline, clean center for white type |
| `lv_chip` | frame | nine_slice | chamfer cut 8，slice `8,8,8,8` | accent | hard / emboss 3 | small crimson level tag, sharp chamfer, flat ink, center clear for white level text |
| `skill_rim` | button | ring_mesh | chamfer cut 14 border 6 hollow，layer rim，derive `pressed=relief_invert,disabled=steel` | panel | hard / bevel 6 | off-white bevel rim of a skill key, sharp 14px chamfer, hard cut, printed manga outline |
| `skill_face` | button | nine_slice | chamfer cut 8，slice `12,10,12,10`，layer face，derive `pressed=darken,disabled=desaturate` | accent | hard / flat | flat crimson skill-key face, saturated red ink, sharp chamfer, clean center for white move name and PP |
| `util_rim` | button | ring_mesh | chamfer cut 10 border 5 hollow，layer rim，derive `pressed=relief_invert,disabled=steel` | accent | hard / bevel 5 | crimson hard rim around a secondary key, sharp chamfer, narrow printed border |
| `util_face` | button | nine_slice | chamfer cut 5，slice `12,10,12,10`，layer face，derive `pressed=darken,disabled=desaturate` | panel | hard / flat | off-white secondary key face, flat manga paper, sharp chamfer, clean center for black label |
| `bar_track` | meter | nine_slice | chamfer cut 3，slice `6,3,6,3` | base_dark | hard / engrave 3 | narrow engraved meter groove, matte charcoal, hard edges, inner lip, seamless along its length |
| `hazard_stripe` | deco | nine_slice | polygon，slice `8,2,8,2`，tile x | hazard | hard / emboss 2 | yellow diagonal hazard stripes, hard edges, scuffed print, seamless horizontal tile, no lettering |
| `spike_tri` | deco | affine | polygon（直角三角形） | accent | hard / emboss 3 | solid crimson right triangle ornament, razor points, flat ink, mounted on a panel corner |
| `slash_wedge` | deco | affine | polygon（斜平行四边形） | accent | hard / emboss 3 | long diagonal crimson wedge, sharp parallelogram slash, flat manga graphic, not organic |

导出约定（运行时 Cocos 节点树按这些字段生成，请保证准确）：
- 交互件一律用分层按钮外壳（`data-type="button"`、`data-render="program"`、`data-states`、`data-state`），rim/face/文字为子部件。
- 进度条：`bar_track` 槽 + 槽内一个 `data-type="bar"`、`data-render="program"` 的填充部件（内部一个纯色 rect；外接框 = 满值填充区域），运行时从左向右缩放宽度。数字放槽外。
- 动态文字都写 `data-bind` 与 `data-maxlen`，文字放在自己的面板上（不要直接压在 `bg` 背景上）。
- `role="bg"` 的 vector 背景只用于区域稿预览，**导出时丢弃**（运行时背后是 3D 画面或半透明遮罩）。

## 本界面专项：道具袋模态弹窗（必须遵守）

- 弹窗盖在实时 3D 战斗画面上。区域稿里只画弹窗本体；画布可以有一块 `role="bg"` 的 vector 背景（仅预览，导出丢弃）。不要画遮罩。
- 弹窗全部部件嵌套在**一个**顶层部件下：`<g id="bag_dialog" ... data-anchor="center">`，外接框约 x 60–660、y 300–1000（可微调，宽 ≥ 560）。
- 结构：标题区（`bag_title` 标题 + `bag_hint` 提示）；两行道具（每行：名称、效果、数量、`使用` 键；两行结构完全相同，行容器 role 用 `item_row`）；底部 `关闭` 键。
- `item_use_0`、`item_use_1`、`bag_close` 是交互件（分层按钮外壳）。
