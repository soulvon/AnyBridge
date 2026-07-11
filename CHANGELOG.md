# Changelog

All notable changes to AnyBridge will be documented in this file.

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
