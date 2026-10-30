---
编号: 2026-10-30-fix-codex-cdp-cli-c690d8
标题: "fix(codex): CDP 注入前置检查代理可用性，进程判定排除 CLI，新版目标识别与错误主句契约"
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
提交: c690d8a891071de8b8dd60c1119e481483a3f7e1
---

## 来源

自动兜底采集：提交未写 `经验:`，需要人工补规则与根因。

## 本次改动文件

- `CHANGELOG.md`
- `docs/capabilities.md`
- `scripts/check-codex-detect.mjs`
- `scripts/check-key-features.mjs`
- `sidecar/lib/codex-desktop-cdp.js`
- `sidecar/lib/codex-desktop-cdp.test.js`
- `src-tauri/src/commands/codex_desktop.rs`
- `src-tauri/src/commands/codex_session_visibility.rs`
- `src-tauri/src/commands/cursor_core.rs`
- `src-tauri/src/commands/proxy.rs`
- `ui/assets/scripts/55-platforms.js`

## 现象

待补（自动采集自提交 `c690d8a891071de8b8dd60c1119e481483a3f7e1`）。

## 根因

待补。

## 修复

见提交 `c690d8a891071de8b8dd60c1119e481483a3f7e1`。

## 代价

待补。

## 复盘

补完根因、代价和 check 后，把 `status` 改为 `active`。
