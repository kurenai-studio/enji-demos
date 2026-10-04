# common/anim — 出处与版本

## 契约版本

```ts
import { ANIM_CONTRACT_VERSION } from "common/anim"; // = 1
```

与独立库 [shinjiyu/IAnim](https://github.com/shinjiyu/IAnim) 的 `@ianim/core` → `ANIM_CONTRACT_VERSION` **必须相等**。  
SE ↔ PA 经 `seRuntimeDirs` 同步 `assets/scripts/common` 时，两边应同为该版本。

## 出处

| 阶段 | 位置 |
|------|------|
| 最初实现 | GitLab `illyasviel`（`D:\UGit\illyasviel*` → `assets/scripts/common/anim`） |
| 独立库（分层真源） | [github.com/shinjiyu/IAnim](https://github.com/shinjiyu/IAnim)：`@ianim/core` → `@ianim/cocos` → `@ianim/cocos-slots` |
| 本工程 | **vendored 拷贝**（Cocos 一体：core + cocos builders 仍合在 `compose.ts`） |

当前本目录相对 IAnim：

- `IAnim.ts` 等契约文件：与库 **内容一致**（契约 v1）
- `Anim.ts` / `compose.ts`：仍是 **拆库前的 Cocos 合包形态**（含 `cc.tween` delay、`playSpine` 等）；语义对应 `@ianim/core` + `@ianim/cocos`，尚未改成 npm 依赖

## 对齐规则

1. 改契约语义 → 先改 [IAnim](https://github.com/shinjiyu/IAnim) 并 bump `ANIM_CONTRACT_VERSION`，再同步进 PA/SE  
2. 只改 Cocos 原语（Spine/粒子）→ 可只改本目录或 `@ianim/cocos`，**不必** bump（除非改了 cancel 语义）  
3. 不要把 SPIR / PlayArea 放进本目录或 IAnim 库  

## 相关文档

- IAnim：[vs GSAP / anime.js](https://github.com/shinjiyu/IAnim/blob/main/docs/compare-gsap-anime.md)
