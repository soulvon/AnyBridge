---
编号: 2026-10-26-fix-agents-grok-4-cli-ce1416
标题: "fix(agents): 逐平台审计——修正 grok 错包 + 4 个 CLI 补官方更新入口"
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
提交: ce1416589c8b0d0acc3facc8fe27f36829999250
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `src-tauri/src/commands/agent_spec.rs`
- `src-tauri/src/commands/platforms.rs`
- `ui/assets/scripts/55-platforms.js`

## 现象

待补（自动采集自提交 `ce1416589c8b0d0acc3facc8fe27f36829999250`）。

## 根因

待补。

## 修复

见提交 `ce1416589c8b0d0acc3facc8fe27f36829999250`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
