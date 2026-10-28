---
编号: 2026-10-26-fix-platforms-grok-npm-1-0-30-1-0-70-4ee924
标题: "fix(platforms): grok 等自更新平台的「更新」按钮被 npm 能力位误拦（实测 1.0.30→1.0.70 只显示箭头）"
日期: 2026-10-26
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
提交: 4ee924a9b99dab68f970fd5ab5a205c81c84654f
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `src-tauri/src/commands/platforms.rs`
- `ui/assets/scripts/55-platforms.js`

## 现象

待补（自动采集自提交 `4ee924a9b99dab68f970fd5ab5a205c81c84654f`）。

## 根因

待补。

## 修复

见提交 `4ee924a9b99dab68f970fd5ab5a205c81c84654f`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
