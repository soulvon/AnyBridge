---
编号: 2026-10-26-fix-localization-273356
标题: "fix(localization): 语言包生效判据不再限定官方包——完整第三方中文包同样算数（误报修复）"
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
提交: 273356d29f3bb7197de520f0665b243fd1cd20a1
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `docs/pitfalls.json`
- `scripts/check-key-features.mjs`
- `src-tauri/src/commands/app_localization.rs`
- `src-tauri/src/commands/version_probe.rs`

## 现象

待补（自动采集自提交 `273356d29f3bb7197de520f0665b243fd1cd20a1`）。

## 根因

待补。

## 修复

见提交 `273356d29f3bb7197de520f0665b243fd1cd20a1`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
