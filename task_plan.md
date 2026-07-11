# UI HTML 模块化重构

## Goal
将 `ui/index.html`（~6000 行）拆为可维护 partials，引入轻量构建拼装，**保证拼装产物与原 HTML 语义/DOM 一致，不影响原有功能**。

## Constraints
- 不改业务 JS/CSS 行为（P0/P1）
- P2：内联事件迁移为 data-action，行为保持等价
- Tauri 仍加载静态产物
- 构建后必须通过一致性校验 + `check:ui`

## Phases
| # | Phase | Status | Notes |
|---|-------|--------|-------|
| 1 | 规划与边界提取 | complete | |
| 2 | build-ui 拼装器 + 一致性校验 | complete | EXACT MATCH baseline |
| 3 | 自动切片生成 ui-src partials | complete | 22 pages + modals |
| 4 | 接线 package.json / 文档 / check:ui | complete | beforeDev/BuildCommand |
| 5 | 验证 build 产物 ≡ 原文件 | complete | check:ui 22 pages pass |
| 6 | 审查 + 拆 body-tail 弹窗 | complete | 16 modals + extensions 独立 |
| 7 | P2 内联事件 → data-action | in_progress | 447 handlers |

## Key Decisions
1. **源码**: `ui-src/`（HTML partials + shell）
2. **产物**: 仍输出 `ui/index.html`，`frontendDist` 保持 `../ui`
3. **include 语法**: `<!-- @include relative/path.html -->`
4. **零回归**: P0/P1 规范化换行后与 baseline 完全一致
5. **P2 策略**: 中央 action bus（`05-actions.js`）+ 自动迁移静态 HTML；复杂表达式用 data-* 语义编码，不 eval
6. **弹窗**: `partials/modals/*.html`

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| PowerShell 吃掉 node -e 正则 | 1 | 改为 .mjs 脚本文件 |
| extensions include 被放到 `</main>` 后 | 1 | 改到 eval-history 后、proxy 前 |
| 产物末尾多一空行 | 1 | 修剪 shell/extensions 尾部空白 |
