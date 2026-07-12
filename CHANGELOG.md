# Changelog

All notable changes to AnyBridge will be documented in this file.

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
