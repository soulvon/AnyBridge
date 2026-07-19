# Changelog

All notable changes to AnyBridge will be documented in this file.

## v0.3.14 - 2026-07-19

- Responses API 上游强制 `store: false`：`local-proxy` 在 extras 合并后硬写，`applyCodexUnlockRequiredFields` 同步强制，避免 `preserveExtraParams`/客户端把 `store: true` 透传到三方网关落盘。
- 补充回归测试：Codex unlock 与 `preserveExtraParams` 路径均断言 `store: false`。
- MITM 证书校验增强：证书/私钥匹配、有效期、CA 标志与 SAN 检查；启动前 `ensure_proxy_mitm_ready`，失败时明确 503 而非静默隧道。
- 代理健康检查：`/__byok/stats` 上报 MITM 状态，新增 `/__byok/mitm-health` 与 CONNECT/TLS 实链路探测；MITM 失败可自动重生证书并仅重试启动一次。
- Codex 桌面：`preserveOfficialAuth` 与 `injectModels` 互斥（preserve 优先），前后端 CDP watcher/restart 逻辑对齐。
- 模型映射 UI：展示 IDE 模型清单来源（captured/api/builtin）徽章与提示，降低「刷新 API 仍不等于 IDE 下拉」的误解。

## v0.3.13 - 2026-07-19

- CPA 套件更新健壮化：下载超时 15s→300s，增加停滞检测与文件大小校验。
- 下载镜像每源重试 2 次（指数退避 4s→8s），避免偶发网络抖动导致整源放弃。
- 服务停止改为两阶段：先优雅关闭（WM_CLOSE/SIGTERM），等 2s 后才强制 kill。
- 健康检查改为指数退避（1s→2s→4s→8s→cap 10s），CPA 重试 30 次、CPAMP 20 次。
- 端口释放等待 10→20s，解压前清理目标目录残留。
- 证书生成命令 `generate_certs` 增加 60s 超时保护，避免 UI 阻塞。
- 证书安装优先 CurrentUser\Root 静默安装，失败回退 LocalMachine\Root。

## v0.3.12 - 2026-07-19

- 证书生成命令 `generate_certs` 增加 60s 超时保护，避免 UI 阻塞与 "Step is still running"。
- 证书安装优先使用 CurrentUser\Root 静默安装（无需 UAC），失败时回退 LocalMachine\Root 并提示管理员权限。
- 清理遗留证书与过期指纹，避免冲突。
- 健壮化首次安装 / 多用户 / 路径探测逻辑。
- UI 样式与健康检查流程优化。

## v0.3.10 - 2026-07-18

- CPA 套件支持出站代理配置：跟随系统代理 / 自定义 URL / 直连。
- 扩展设置面板可查看生效代理，并支持保存或保存并重启 CPA。
- 启动与写入 `config.yaml` 时自动同步 `proxy-url`。

## v0.3.9 - 2026-07-18

- 修复新机切换 Codex 供应商失败：`models_cache.json` 缺失时回退到内嵌 `gpt-5.5` 完整模型模板。
- `read_codex_model_template` / `generate_model_catalog_json` / `write_models_cache` 统一缓存优先、bundled 兜底，不再要求先启动 Codex CLI。

## v0.3.8 - 2026-07-18

- 修复 WorkBuddy / CodeBuddy 自定义模型展示名：`name` 改为供应商名（如 `CPA`），不再与 `id`（模型 ID）重复；客户端并排展示为 `CPA · grok-4.5`。
- 修复新版 WorkBuddy / CodeBuddy 自定义模型识别：`vendor` 固定写为 `user`（此前写成供应商名会被归到第三方模型并可能覆盖官方同名模型）；加载/保存时自动迁移历史配置。
- 同步调整 Rust `buddy_display_name` 与前端 `cbBuildModelEntry` 的生成逻辑。

## v0.3.7 - 2026-07-16

- 新增 per-provider 上游并发闸门（`providerInflightGate`）：按 `provider|host|model` 限制 inflight 请求（默认 8，`BYOK_MAX_INFLIGHT=0` 关闭）。
- Chat 全路径接入：buffered 走 `run()`，streaming 走 `acquire()` + 幂等 `freeOnce()`，并在 end/close/error/重试前释放槽位。
- local-proxy 同步接入并发闸门与 `attachUpstreamWatchdog`，流式槽位保持到响应体结束，避免长流打爆上游。
- 统一上游超时策略（TTFB / idle / hard），替换原先单一 `setTimeout`。
- 修复 WorkBuddy 模型 id/展示名与 `useCustomProtocol` 同步逻辑，避免 `model=byok-xxx` 与路径拼接错误。

## v0.3.6 - 2026-07-15

- 修复 Codex 三方供应商 auth 模式冲突：`requires_openai_auth` 与 `experimental_bearer_token` / `env_key` / `auth` 互斥写入，避免残留 OAuth 导致 bearer 无效。
- 新增 `apply_codex_provider_auth`，统一 `apply_codex` / `apply_codex_official` 的 auth 写入与清理逻辑，并补齐回归测试。
- 修复 Codex 历史会话可见性：同步修复 rollout / archived_sessions 与 official state sqlite 中的 `model_provider`，避免重启后索引回滚。
- 平台页增加「修复会话历史」操作与切换提示，说明统一会话历史与索引修复行为。
- 修复 Devin/Windsurf BYOK 上游失败时错误 HTML/原始 body 被当作 assistant 正文写入会话上下文的问题。
- 恢复默认使用 Connect-RPC 原生流错误帧（`BYOK_NATIVE_ERRORS=true`），避免错误进入聊天上下文与会话标题。
- 清洗 Cloudflare/HTML 错误页：只提取短可读摘要，不再透传整页 HTML。
- 增强扩展中心 CPA Suite 更新稳定性：GitHub Release 获取重试、更新失败回滚旧服务。

## v0.3.3 - 2026-07-14

- 统一 Codex 路径解析：移除脚本与错误消息中的机器相关硬编码路径，改为优先读取 `CODEX_HOME`，否则回退到 `~/.codex`。
- 新增 sidecar 共享模块 `codex-home.js`，对齐 Rust `codex_home()`，供 catalog 读写、auth.json 定位与 CDP 注入复用。
- 修复 `gen-catalog`、`platforms`、`codex_desktop` 与 sidecar 注入逻辑在非默认 Codex 目录下的路径解析问题。
- 错误提示改为展示实际解析路径，便于排查缺失的 `models_cache.json` / `anybridge-model-catalog.json`。

## v0.3.2 - 2026-07-13

- 修复 CPA Manager Plus 登录失败问题：确保 `secrets.json` 中的 `admin_key` 与 CPAMP 数据库密钥同步。
- 新增 `reset_cpamp_admin_key` 函数，在启动/部署/更新/切换版本前自动执行 `reset-admin-key` 同步数据库密钥。
- 修复每次更新 CPA Suite 时密钥丢失的问题：部署前检查 `secrets.json` 是否已存在，存在则复用旧密钥。
- 修复 CPAMP 内部数据（反代凭据、面板历史、OAuth token、usage.sqlite、data.key 等）在更新或切换版本时丢失的问题。
- 新增共享数据目录 `cpamp-data/`，将 `dataDir` 从版本目录内的 `./data` 改为 CPA Suite 根目录下的共享路径。
- 新增 `migrate_cpamp_data` 函数，首次使用共享目录时自动从旧版本 `data/` 迁移全部文件。
- 通过环境变量 `USAGE_DATA_DIR`、`USAGE_DB_PATH`、`CPA_MANAGER_DATA_KEY_PATH` 确保所有路径一致。
- 优化模型映射编辑器 UI：将"映射自定义显示名"和"上下文窗口"配置区从底部移到右列顶部，简化为一行布局。
- 精简上下文窗口预设按钮：仅保留推荐、200K、1M，移除 32K/128K/清除。
- Windows 平台调用子进程时加入 `CREATE_NO_WINDOW` 标志防止黑窗。

## v0.3.1 - 2026-07-12

- 修复 CPA Manager Plus 1.10+ 登录失败：`admin_key` 在首次启动后被持久化到 SQLite，后续启动不再读取环境变量，新增 `reset_cpamp_admin_key` 函数在启动前同步密钥。
- 部署时复用已有 `secrets.json` 避免每次更新生成新密钥。

## v0.3.0 - 2026-07-11

- 重构前端架构：将 `index.html` 拆分为 partials 模板，引入轻量 HTML 构建流程（`scripts/build-ui.mjs`）。
- 迁移内联事件处理器为 `data-action` 事件总线模式，前端脚本改为 ES Module 加载（`main.js`）。
- 提取共享 API/UI/State 模块（P4 架构 slice），改善代码组织与可维护性。
- 新增 model-context-presets 模型上下文预设功能，支持自定义模型上下文窗口配置。
- 增强 Rust 后端命令模块：codex_desktop、platforms、extensions、system 命令全面升级。
- 优化 local-proxy 代理逻辑，提升请求转发稳定性。
- 更新平台页面与弹窗模板（CodeBuddy/Codex/Proxy/WorkBuddy/ZCode），改进 UI 交互体验。
- 增强前端脚本：platforms、extensions、shell、runtime、providers-eval 等模块功能扩展。
- 更新页面、弹窗、平台样式，优化视觉一致性。
- 更新 gen-catalog 目录生成脚本，扩展目录构建能力。
- 重构 CPA 凭证面板：将 CPA API（API Key、API 地址）与 CPA 管理面板（管理面板、管理密钥、面板地址）分区显示，新增 API 地址行，提升可读性。
- 更换模型筛选「推理」Tab 图标为大脑（brain）图标，更贴合思考/推理语义。
- 优化平台页面样式与代理页面交互细节。
- 引入按钮颜色变体系统（accent/secondary/danger/success/warn），统一全站按钮视觉语义。

## v0.2.8 - 2026-07-09

- 新增扩展中心（Extensions Center）UI：统一浏览、检测、更新 CPA Suite 等本地 AI Gateway 组件状态。
- 后端新增 `extensions` 命令集与相关依赖，支持本地套件版本检测、端口健康探测与 GitHub Release 元数据查询。
- 同步前端样式与交互资源，改进 UI 细节与扩展页面体验。

## v0.2.7 - 2026-06-30

- 修复 Windows 自动更新安装时可能被后台代理进程占用，导致无法覆盖安装的问题。
- 更新安装前会自动暂停本地代理服务，减少需要手动退出或结束进程的情况。
- 优化安装包升级流程，提升从旧版本升级到新版时的稳定性。

## v0.2.6 - 2026-06-30

- 完善项目说明与截图展示，帮助新用户更快了解 AnyBridge 的使用场景和主要能力。
- 补充 Kite 插件介绍，支持配合 Devin / Windsurf 使用，提供号池、界面汉化和体验增强等扩展能力。
- 优化多平台安装包发布信息，Windows、macOS、Linux 用户可通过自动更新或下载页获取新版。
- 改进更新弹窗展示文案，公开更新说明仅保留面向用户的功能变化。

## v0.2.5 - 2026-06-30

- Synchronized release version across npm, sidecar, Cargo and Tauri metadata from `0.2.4` to `0.2.5`.

## v0.2.4 - 2026-06-30

- Synchronized release version across npm, sidecar, Cargo and Tauri metadata from `0.2.3` to `0.2.4`.

## v0.2.3 - 2026-06-30

- Prepared a new packaged build and synchronized the release version across npm, sidecar, Cargo and Tauri metadata from `0.2.1` to `0.2.3`.

## v0.2.1 - 2026-06-29

- Fixed third-party image understanding being bypassed under the Codex/Responses protocol so the Codex desktop, Codex CLI, OpenAI Chat, Anthropic and Cursor/Windsurf paths now all reach the image-understanding provider as expected.
- Added an upstream self-heal retry module (`sidecar/lib/self-heal.js`) with three rectifiers (thinking signature, thinking budget, unsupported image), wired behind the existing `local-proxy` execution path; aligned with the cc-switch rectifier behavior.
- Added an experimental Cursor MITM proxy (`sidecar/cursor-proxy.js`) plus `cursor_auth` state backup / restore (`src-tauri/src/commands/cursor_auth.rs`) to support the Cursor BYOK flow.
- Added regression tests for `codex-unlock`, `config-cache` and `self-heal`, and a `scripts/check-cursor-proxy.mjs` diagnostic for the new Cursor handler.
- Bumped the synchronized version (`package.json`, `package-lock.json`, `sidecar/package.json`, `sidecar/package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`) from `0.2.0` to `0.2.1`.

## v0.2.0 - 2026-06-28

- Added Codex desktop integration: CDP-based unlock, local proxy routes, Chat mode support, and custom model entry through the new `codex-desktop` command family.
- Refactored the proxy routing layer to a platform-driven architecture, with `proxy_routes` / `platforms` / `model_map` command modules and per-platform model picking.
- Improved platform submenu and shell layout behavior; cleaned up the legacy `99-handle-tuner.js` script.
- Strengthened configuration and IDE configuration flows, including platform raw config editors, custom model mapping UI, and provider evaluation reports.
- Added new script tooling: `check-providers`, `check-opencode`, `check-cursor-proxy`, `find-codex-format`, `show-codex-configs`, `list-providers`, `test-upstream`, `check-mitm-logs`, and `add-opencode-codex-config` for the open-source baseline.
- Hardened the release flow with the protected sidecar builder, MITM log checks, self-heal module, and `codex-unlock` regression tests.
- Fixed legacy version-line migration so the open-source `0.x` line can replace the historical `1.x` line through the updater.

## v0.1.6 - 2026-06-25

- Fixed vision capability evaluation falsely reporting "unsupported" for reasoning vision models (e.g. GLM-4.5V) by increasing `max_tokens` from 64 to 1024 in the eval test request, allowing reasoning models to complete their chain-of-thought before producing the actual answer.

## v0.1.5 - 2026-06-24

- Changed Devin/Windsurf stream failures to surface upstream error text by default instead of relying on IDE-native generic provider error UI.
- Reclassified upstream load-limit and `get_channel_failed` responses as rate-limit errors for OpenAI/Anthropic-compatible local proxy calls while preserving the original upstream body.

## v0.1.4 - 2026-06-23

- Fixed upstream proxy handling on Windows so AnyBridge follows the live system proxy switch instead of a stale startup snapshot.
- Added loopback proxy compatibility for local proxy cores that listen on IPv6 `::1` while Windows stores `127.0.0.1`.

## v0.1.3 - 2026-06-23

- Fixed provider sorting controls on CodeBuddy, WorkBuddy, and ZCode add-model pages.
- Improved provider routing, unlock compatibility, cache usage reporting, and certificate setup flows.

## v0.1.0 - 2026-06-21

- Reset the open-source project line to `0.1.0`.
- Cleaned historical notes, private diagnostics, temporary probes, screenshots, and legacy brand files out of the public tree.
- Added standard open-source project files, GitHub templates, CI, security policy, and public documentation.
