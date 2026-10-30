---
编号: 2026-10-30-fix-ui-loadinghtml-spinner-6e5976
标题: "fix(ui): 加载态统一由 loadingHtml 提供单一 spinner，清理自造双加载圈"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: draft
证据: 待补：复现步骤、测试或提交证据
可信度: 待核
前提: 待补：这条规则在什么条件下成立
不适用: 待补：什么情况下明确不适用
触发: [anybridge]
规则: "待补：这次修复暴露了什么规则"
该做:
  - 待补：以后应该做什么
不该做:
  - 待补：以后不应该做什么
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

待补（自动采集自提交 `6e5976a4aaf49d942cd348147832dc9a3f2d5f93`）。

## 根因

待补。

## 修复

见提交 `6e5976a4aaf49d942cd348147832dc9a3f2d5f93`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
