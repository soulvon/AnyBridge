---
编号: 2026-10-30-fix-codex-cdp-cli-c690d8
标题: "fix(codex): CDP 注入前置检查代理可用性，进程判定排除 CLI，新版目标识别与错误主句契约"
日期: 2026-10-30
范围: [anybridge]
严重度: medium
状态: active
证据: issue #38 已关闭；codex_desktop.rs 内多个行为测试（真实 socket）+ 门控三条。
可信度: 高（当日实测与单测）
前提: Windows 双栈回环；新版 Codex Desktop 已改用 app:// 页面。
不适用: 单一回环栈或无 CLI 共存的环境。
触发: [anybridge]
规则: 外部依赖（本地代理服务）未就绪时必须在动用户客户端之前失败；多地址探测的失败原因必须逐条保留；CDP 注入前必须自证目标身份。
该做:
  - 依赖探测统一走 proxy::ensure_proxy_service_ready 单一入口；错误聚合逐条保留；目标识别用 URL+标题双特征并排除 CLI 目录。
不该做:
  - 不要把「环境未就绪」的失败做成「先破坏现场再报错」；不要用最后一个错误覆盖前面的。
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

issue #38（AnyBridge 1.0.3 / Windows 11 / Codex）：启动 Codex 报错，客户端被白重启一遍，模型仍未解锁；且报错只见 [::1] 的失败原因。

（自动采集自提交 `c690d8a891071de8b8dd60c1119e481483a3f7e1`）。

## 根因

三处叠加：代理服务未运行时注入流程先 kill 客户端再失败；本机回环探测只保留最后一个地址（[::1]）的失败原因，盖掉真实的 IPv4 拒因；CDP 目标识别未覆盖新版 Codex Desktop（app://-/、标题 ChatGPT）且未排除 npm CLI 的 codex.exe。

## 修复

见提交 `c690d8a891071de8b8dd60c1119e481483a3f7e1`。

## 代价

注入路径多一次前置探测；错误文本契约需收录 i18n。

## 复盘

已于当日补齐根因/规则/该做/不该做并转 active。
