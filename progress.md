# Progress

## Session 2026-07-11
- 确认 index.html 为手写源文件
- 确定长期方案：轻量 HTML 构建 + 分阶段模块化
- P0 落地：
  - `ui-src/` pages + shell + build-ui
  - package.json / tauri beforeDev/Build
  - check:ui 增强
  - Baseline EXACT MATCH
- 审查：无 Critical；Important 为 body-tail 过大、extensions 混在 eval-history
- P1 落地：
  - 拆 16 个 modal partials
  - 提取 `pages/extensions.html`
  - shell-close / scripts-i18n / scripts-app
  - 再次 Baseline EXACT MATCH + check:ui 通过
- 提交：`4765f60 feat(ui): introduce lightweight HTML build and split index into partials`
- P2 进行中：内联事件 → data-action 事件委托
  - 统计：onclick 342 / onchange 64 / oninput 37 / onkeydown 4（共 447）
  - 简单可自动迁移约 359；含 this/event/多语句约 88
