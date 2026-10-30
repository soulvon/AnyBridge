---
编号: 2026-10-30-fix-ui-loadinghtml-spinner-6e5976
标题: "fix(ui): 加载态统一由 loadingHtml 提供单一 spinner，清理自造双加载圈"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: ui-loading-spinner.test.mjs + 门控 loading-spinner-double。
可信度: 高（当日实测与单测）
前提: loadingHtml 是唯一被认可的加载指示实现。
不适用: 无 loadingHtml 的独立组件（需自带 spinner 时不得与容器叠加）。
触发: [anybridge]
规则: 加载态指示单一来源：统一由 loadingHtml 提供，任何位置禁止自造第二个圈；toast 标题只负责收尾切文案。
该做:
  - 新增加载态用 loadingHtml；由 ui-loading-spinner.test.mjs 与 check-key-features 门控拦截 btn-spinner 等类名。
不该做:
  - 不要在已有 spinner 的容器里再插 loadingHtml 或自造 CSS 圈。
检查: "advisory"
提交: 6e5976a4aaf49d942cd348147832dc9a3f2d5f93
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `scripts/ui-loading-spinner.test.mjs`
- `ui-src/partials/modals/notification-center-modal.html`
- `ui/assets/scripts/65-extensions.js`
- `ui/assets/scripts/66-plugins.js`
- `ui/assets/styles/30-pages.css`
- `ui/assets/styles/40-modals.css`

## 现象

扩展中心 CPA「更新中…」出现两个加载圈叠加；多处加载态存在自造 spinner。

（自动采集自提交 `6e5976a4aaf49d942cd348147832dc9a3f2d5f93`）。

## 根因

loadingHtml 自带 spinner，各处又在按钮/标题里追加 btn-spinner 等自造圈，两者叠加。

## 修复

见提交 `6e5976a4aaf49d942cd348147832dc9a3f2d5f93`。

## 代价

无。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
