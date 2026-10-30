---
编号: 2026-10-30-fix-antigravity-hub-p0-marker-asar-232d61
标题: "fix(antigravity): Hub 汉化三处 P0——marker 同源、备份版本防护、asar 写入加锁"
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
提交: 232d613e6458cdb7edf42ee2e1476b7b3ceb92c8
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `src-tauri/src/commands/antigravity_loc_payload.rs`
- `src-tauri/src/commands/antigravity_localization.rs`
- `src-tauri/src/commands/app_localization.rs`
- `src-tauri/src/commands/platforms.rs`

## 现象

待补（自动采集自提交 `232d613e6458cdb7edf42ee2e1476b7b3ceb92c8`）。

## 根因

待补。

## 修复

见提交 `232d613e6458cdb7edf42ee2e1476b7b3ceb92c8`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
