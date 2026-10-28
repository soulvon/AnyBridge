---
编号: 2026-10-29-fix-stats-cpa-d31fea
标题: "fix(stats): 按上游标识去重——客户端经自己网关/CPA 转发的调用不再重复计入"
日期: 2026-10-29
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
提交: d31fea4acc922ecdf9718cb9e5980bdde8e05567
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `docs/subsystems/stats.md`
- `scripts/test-stats-render.mjs`
- `src-tauri/src/commands/usage_scan.rs`
- `ui/assets/scripts/67-stats.js`
- `ui/assets/styles/50-platforms.css`

## 现象

待补（自动采集自提交 `d31fea4acc922ecdf9718cb9e5980bdde8e05567`）。

## 根因

待补。

## 修复

见提交 `d31fea4acc922ecdf9718cb9e5980bdde8e05567`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
