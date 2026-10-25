# AnyBridge 核心能力与权威实现清单 (Authoritative Capabilities)

> **原则**：以下能力在本项目中有且仅有一处权威实现。**严禁另起炉灶或凭空重写更差的备选**；新增需求必须扩展现有模块。

| 业务领域 / 能力 | 权威源文件 / 符号 | 约束与禁止行为 |
|---|---|---|
| **JSONC 解析** | `src-tauri/src/commands/app_localization.rs` (`parse_jsonc`) | 禁裸用 `serde_json::from_str` 解析带注释文件（如 argv.json）；解析失败严禁覆盖原文件。 |
| **文件原子替换** | `src-tauri/src/commands/mod.rs` (`write_atomic`) | 禁裸用 `fs::write` / `fs::rename` 直接覆盖核心配置；必须同目录临时文件 + rename + 重试 3 次。 |
| **Windows 无窗子进程** | `src-tauri/src/commands/system.rs` / `cursor_core.rs` (`CREATE_NO_WINDOW`) | GUI 下 spawn 任何命令行工具必须带 `0x0800_0000` 标志，禁弹出黑框。 |
| **进程查询与终止** | `src-tauri/src/commands/platforms.rs` (`Toolhelp32` / `kill_antigravity_language_server`) | 严禁使用 PowerShell `Get-CimInstance Win32_Process` 查询进程（卡顿 1-3 秒）；杀进程必须保留路径白名单。 |
| **Workbench 完整性判定** | `src-tauri/src/commands/app_localization.rs` (`is_valid_workbench`) | 严禁以体积大小（如 >50KB）判定 workbench 损坏；必须以闭合 `</body>` 结构完整性为准。 |
| **内联脚本注入** | `src-tauri/src/commands/app_localization.rs` (`extract_csp_nonce`) | 原厂 CSP 含 nonce 时注入脚本必须带提取的同名 nonce，否则 `'unsafe-inline'` 被静默忽略。 |
| **BYOK 注入与剥离** | `src-tauri/src/commands/workbench_inject.rs` (`strip_byok_block`) | 还原操作必须是剥离式（只删自己的块），严禁整体备份覆盖（会抹掉汉化块）。 |
| **语言包完整生效链** | `src-tauri/src/commands/app_localization.rs` | 判定生效必须同时满足四条件：目录存在 + 未被 `.obsolete` 标记 + `languagepacks.json` 注册 + `argv.json` 指向。 |
| **本地代理模型暴露查找** | `sidecar/local-proxy.js` (`buildExposedIdLookup`) | 两段式构建：字面 ID 优先，渲染别名冲突让位并告警；严禁单条别名冲突抛错毒化全局。 |
| **Responses 假流式输出** | `sidecar/local-proxy.js` (`sendOpenAIResponses`) | `output` 项必须按顺序发 `response.output_item.added/done`，`output_index` 从 1 起，禁漏工具事件。 |
| **上游长连接探活** | `sidecar/local-proxy.js` (`upstreamTransport` / HTTP/2 ping) | 统一走 netproxy 探活通道；遇静默连接自动重拨，禁在业务层加无脑轮询重试。 |
| **平台接入与还原对称** | `src-tauri/src/commands/platforms.rs` | `apply_x` 与 `restore_x` 的异步化、杀进程实现必须完全成对一致，禁只改一侧。 |
