# 架构设计

[English](ARCHITECTURE.md) • [简体中文](ARCHITECTURE_zh.md)

AnyBridge 由四个紧密协同的模块组成：

- `src-tauri/` 中的 Tauri 桌面后端（Rust）
- `cursor-core/` 中的独立协议与本地接管引擎（Rust）
- `ui-src/` 与 `ui/` 中的模块化静态前端（ES Modules + HTML partials）
- `sidecar/` 中的 Node.js 本地网关与多协议转换服务

```text
AI 编程工具 / IDE
  -> 本地网关或由 Rust 接管生成的配置
  -> AnyBridge sidecar (HTTP/SSE 多协议转换) / cursor-core (HTTP/2 Connect)
  -> 已配置的主供应商 API

AnyBridge 桌面端 (src-tauri)
  -> 平台检测与 agent_spec 唯一声明表
  -> 主供应商单一真源 (SSOT) 与跨平台配置投影
  -> store_io 跨进程文件锁事务 + write_atomic 原子写盘
  -> 默认启用的 jsonc_edit 保形写入与 field_restore 字段级还原
  -> 证书管理、Sidecar 生命周期与非阻塞热重载通知
```

## 桌面后端 (`src-tauri/`)

Tauri 桌面端负责原生系统集成、唯一配置真源持久化与跨端接管，严禁外部进程直接竞态改写核心配置：

- **统一存储锁事务与原子写 (`commands/store_io.rs`)**：通过规范化路径的进程内 `Mutex` + 同目录 `.lock` 文件锁串行化 `providers.json`、`proxy-routes.json` 与 `codex-proxy-routes.json` 的 Read-Modify-Write 事务；`write_atomic`（PID + 纳秒时间戳 + 原子序数唯一临时文件 + 重试 rename）同时覆盖配置文件与大体积 `app.asar` 补丁写入，并在 `cursor-core/src/fs_atomic.rs` 保持对称封装。
- **主供应商 SSOT 与全平台实时解析 (`commands/config/conversions.rs`)**：所有平台配置（Antigravity、Codex、Claude Code、OpenCode、Grok、Claude Desktop）绑定 `sourceProviderId` 时统一经 `resolve_provider` 与 `validate_active_source` 实时继承连接字段、完整 `apiKeys` 密钥池与启用状态，并在 Claude Code / OpenCode 中覆盖历史 `settingsConfig` 静态快照；源供应商缺失或禁用时显式阻断。
- **保形写入与字段级还原 (`commands/jsonc_edit/`, `commands/field_restore.rs`, `commands/agent_stash.rs`)**：均默认开启（仅环境变量显式设为关闭时退回旧路径），`jsonc_edit` 支持标量与嵌套 `Object`/`Array` 缩进对齐替换，`field_restore` 基于 `serde_json::Value` 语义比较精确还原并在完成后清理 `.byok-bak` 及伴生状态文件。
- **异步命令与声明注册 (`commands/agent_spec/`, `commands/platforms/`)**：所有核心配置读写与探测 `#[tauri::command]` 均通过 `async fn` + `spawn_blocking` 执行（写盘后异步通知 Sidecar 重载），桌面/CLI 平台元数据以 `agent_spec::AGENTS` 为唯一真源。

## 前端 (`ui-src/` & `ui/`)

UI 采用构建期拼装（`scripts/build-ui.mjs` 将 `ui-src/partials/` 组装为 `ui/index.html`）+ ES Module 分层加载（`ui/assets/scripts/main.js`）：

- **集中式状态与事务持久化中心 (`ui/assets/scripts/state/provider-store.js`)**：统一托管 `providerStore` 状态、`resolveBoundProviderView` 实时绑定视图、虚拟内置供应商过滤与 `persistProviders` / `mutateProviderStore` 串行事务队列（写入失败 100% 自动回滚内存快照并提示）。
- **平台共享抽象 (`ui/assets/scripts/platforms/shared_config_editor.js`, `managed_models.js`, `models_table_factory.js`)**：四大配置式编辑器共用防竞态拉取、实时绑定保存与刷新对账；Pi / Hermes / DeepSeek Harness 与 CodeBuddy / WorkBuddy / ZCode 收口于统一受管模型表格工厂。
- **事件委派与静态门禁 (`05-actions.js`)**：全局 `data-action` 总线要求 100% 静态可达（`KNOWN_MISSING` 为 0 项），耗时按钮强制经 `ui/feedback.js` 的 `loadingHtml` / `setLoading` 与 `try/finally` 恢复。提交前端变更前需通过：

```bash
npm run check:ui && npm run check:i18n
```

## Sidecar 网关 (`sidecar/`)

Sidecar 是一个 Node.js 独立进程，只读消费配置目录并承载多协议转换与智能重试路由：

- **只读配置缓存 (`sidecar/config-cache.js`, `sidecar/provider-pool.js`)**：按 mtime + TTL 缓存 `providers.json`、`model-map.json`、`proxy-routes.json` 与 `codex-proxy-routes.json`；解析损坏时保留上次健康快照不毒化缓存，且实时合并 `codexConfigs` 等带 `sourceProviderId` 项（含 `apiKeys` 与源禁用状态）；`provider-pool.js` 仅做只读解析与内存能力标记，绝不回写磁盘。
- **标准 SSE 与统一编解码注册表 (`sidecar/lib/sse-parser.js`, `sidecar/lib/codec-registry.js`, `sidecar/lib/upstream-decoder.js`)**：基于 `StringDecoder('utf8')` 的增量 SSE 解析配合四上游（OpenAI Chat / Responses / Anthropic / Gemini）到五下游（含 Antigravity）的统一转换管线；同源 `gemini -> gemini` 保留无损透传快路径，跨协议流式由 `runStreamPipeline` 统一绑定下游断连中止并在 `try/finally` 销毁上游、释放 `providerInflightGate` 槽位。
- **韧性与真实账本结算 (`sidecar/system-proxy.js`, `sidecar/lib/http-retry.js`, `sidecar/request-tracker.js`)**：共享 `SHARED_HTTPS_AGENT` / `SHARED_HTTP_AGENT` 与系统代理死端口探测降级直连；在 `!res.headersSent` 前支持同目标 401/429 `apiKeys` 轮换与 `<2s` `Retry-After` 微退避；流式请求的 `tracker.finish()` 严格后置至流真实终结时传入真实 `usage` 落入 `usage-ledger.js`（异常或提前 EOF 绝不记为 `ok`）。

开发期间可独立运行 Sidecar：

```bash
npm run start
```

发布构建时，Sidecar 与 `cursor-core` 会分别打包为对应目标平台的独立二进制由 Tauri 托管调度。

## 本地数据 (`Local Data`)

运行时配置与账本存储在用户的应用数据目录（`AppData` / `.config`）中，不在代码仓库内。请勿将令牌、供应商密钥、证书以及抓取的网络流量提交到 Git。
