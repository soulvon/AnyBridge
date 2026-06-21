# AnyBridge

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-v2-24c8db.svg)](https://tauri.app/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-43853d.svg)](https://nodejs.org/)

AnyBridge 是一个开源桌面 BYOK (Bring Your Own Key) 桥接客户端，用于把 AI 编程工具的聊天请求路由到用户自己配置的 Anthropic / OpenAI 兼容供应商。

当前版本：`v0.1.0`。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

AnyBridge 的目标是提供一个本地、可观察、可回滚的配置和代理管理层。它尽量保留目标工具原有登录、补全、代码库索引和配置体验，只接管已配置的聊天与模型路由流量。

> AnyBridge is not affiliated with Windsurf, Devin, OpenAI, Anthropic, or any other third-party tool or provider.

## Features

- 多供应商配置：Anthropic、OpenAI 兼容 API、自建或第三方兼容服务。
- 多平台接入：Windsurf、Devin、Codex、Claude Code、CodeBuddy、OpenCode，Cursor 暂作占位。
- 本地代理模式：为代理型平台提供本地 MITM / CONNECT 代理、证书管理、日志和运行状态。
- 配置切换模式：为 CLI / IDE 类工具生成和写入目标配置。
- 模型映射：将目标工具中的模型槽位映射到用户配置的真实模型。
- 连通性检测：检查供应商 API、模型列表、流式响应、工具调用和视觉能力。
- 本地可观察性：桌面仪表盘展示请求量、Token、错误、成本估算和活动模型。

## Status

This repository is being prepared as a clean open-source project. The first public-ready version starts from `0.1.0`.

Supported and tested first:

- Windows 11
- Node.js 20+
- Tauri v2
- Windsurf 1.108.x / Devin compatible proxy mode

macOS and Linux packaging are wired in CI, but should be treated as early support until verified on real machines.

## Safety And Scope

AnyBridge modifies local tool configuration and can run a local MITM proxy for explicitly selected platforms. Use it only with accounts, API keys, tools, and networks you are authorized to use.

- Do not commit API keys, session tokens, certificates, signing keys, or captured traffic.
- Keep `tauri-sign.key`, `.env`, logs, captures, and local archives outside Git.
- Review target tool terms and your organization policy before enabling proxy mode.
- Report security issues through [SECURITY.md](SECURITY.md), not public issues.

## Quick Start

Install dependencies:

```bash
npm install
cd sidecar
npm install
cd ..
```

Run the Node sidecar only:

```bash
npm run start
```

Run the Tauri desktop app:

```bash
npm run tauri:dev
```

Check the split UI files and JavaScript syntax:

```bash
npm run check:ui
```

## Build

Build the current platform sidecar:

```bash
python scripts/build/build_sidecar_plain.py
```

Build a local Tauri package without updater artifacts:

```bash
npm run tauri:build:local
```

Build a release package with updater artifacts:

```bash
npm run tauri:build
```

Release signing requires GitHub Secrets described in [docs/RELEASE.md](docs/RELEASE.md).

## Repository Layout

```text
.
├─ .github/                 GitHub workflows and community templates
├─ docs/                    Public project documentation
├─ scripts/                 Build, release, and validation scripts
├─ sidecar/                 Node.js local proxy sidecar
├─ src-tauri/               Tauri / Rust desktop app
├─ ui/                      Static frontend
├─ CHANGELOG.md             Release notes
├─ CONTRIBUTING.md          Contribution guide
├─ SECURITY.md              Security policy
└─ README.md
```

Historical notes, private research, temporary scripts, old screenshots, and legacy brand assets are kept locally under `.local-archive/` and are intentionally ignored by Git.

## Documentation

- [Development](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Release](docs/RELEASE.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)

## License

MIT. See [LICENSE](LICENSE).
