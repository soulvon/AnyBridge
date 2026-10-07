<div align="center">

# 🚀 AnyBridge

### Connect every AI coding agent to your own model providers

**Open-source · Local-first · BYOK (Bring Your Own Key) workspace · Supporting 16+ agents (desktop IDEs / terminal CLIs / desktop apps)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24c8db.svg?logo=tauri)](https://tauri.app/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()
[![GitHub release](https://img.shields.io/github/v/release/soulvon/AnyBridge?include_prereleases&color=orange)](https://github.com/soulvon/AnyBridge/releases)

[English](README_en.md) • [简体中文](README.md)

[📥 Download](#-download--installation) •
[⚡ Problems Solved](#-what-it-solves) •
[🚀 Quick Start](#-quick-start-3-steps) •
[🔌 Three Modes](#-three-connection-modes) •
[🎯 Agent Matrix](#-full-agent-matrix) •
[✨ Key Features](#-key-features) •
[🔬 How It Works](#-how-it-works) •
[❓ FAQ](#-faq) •
[💬 Community](#-community--support)

<br>

**Stop hand-editing configs. Stop being locked to one vendor model.**

AnyBridge is a local **BYOK (Bring Your Own Key) model-connection and configuration client**. It wires third-party relays (OneAPI / NewAPI / CPA), self-hosted gateways, and models like DeepSeek, Claude, GPT, Gemini, GLM and Kimi into the AI coding agents you already use — desktop IDEs, terminal CLIs and desktop apps.

Everything happens in a GUI: **no JSON editing, no env vars, no binary patching**, with one-click restore to official defaults.

</div>

---

## 📥 Download & Installation

The desktop installer is self-contained — **no Node.js, Python or CLI setup required**:

👉 **[Download the latest AnyBridge release (GitHub Releases)](https://github.com/soulvon/AnyBridge/releases/latest)**

| OS | Recommended package | Notes |
| :--- | :--- | :--- |
| **🪟 Windows** | `.msi` or `Setup.exe` | Run the installer and follow the wizard |
| **🍏 macOS** | `.dmg` | Open the image and drag AnyBridge into Applications (Apple Silicon & Intel builds available) |
| **🐧 Linux** | `.AppImage` or `.deb` | Run directly (for AppImage: `chmod +x *.AppImage` first) |

---

## ⚡ What It Solves

| Problem | Default / manual approach | How AnyBridge handles it |
| :--- | :--- | :--- |
| **Agent has no custom API field** | Cursor, Windsurf and Devin expose no third-party API entry | **Local proxy takeover**: chat traffic is routed through your own channels and models |
| **Hand-writing config files** | Claude Code, Codex, Pi, Hermes need hidden JSON / YAML / TOML edits | **One-click config writing**: correct paths and formats, one-click restore anytime |
| **Typing long model IDs** | Manual entry; one wrong character breaks the request | **Online model fetch**: pull the model list and pick from a dropdown |
| **Repeating changes per tool** | Every agent needs its own edit when a relay moves | **Configure once, reuse everywhere**: channels managed centrally |
| **Text models can't read screenshots** | Sending an error screenshot to DeepSeek fails | **Vision fallback**: a lightweight vision model turns images into text descriptions |
| **External scripts can't reuse config** | Config only serves a single IDE | **Local gateway**: standard OpenAI-compatible endpoint at `http://localhost:7450/v1` |
| **Self-hosted gateway is a hassle** | Docker, env setup, manual maintenance | **Built-in extension hub**: install, start and stop a local CPA gateway in one click |
| **Switching between agents** | Fragmented, duplicated setups | **Unified console**: 16+ agents switchable in one place |
| **English-only UIs** | Antigravity and others are English-only | **One-click localization**: built-in engine with online dictionaries; code and reasoning chains are never translated |

---

## 🚀 Quick Start (3 Steps)

```
[Step 1: Add a provider] ──► [Step 2: Pick an agent & enable] ──► [Step 3: Open your tool & code]
```

### 1️⃣ Step 1: Add or import providers (with online model fetch)

Open the **Providers** page:

- **Add & fetch**: click "Add provider", enter the base URL and API key, then **fetch the model list online** and tick the models you want;
- **Import existing setups**: one-click import from **Cherry Studio**, **CC Switch** and **Cockpit Tools**, with a preview and automatic de-duplication;
- **One-click diagnostics**: run a test to check connectivity, model list, streaming, tool calling and vision support.

### 2️⃣ Step 2: Choose the agent to connect

Open the **Agents** page and pick your tool (Cursor, Windsurf, Devin, Claude Code, Codex, Pi, Hermes, DeepSeek Harness …):

- **Closed desktop IDEs (Cursor / Windsurf / Devin)**: click "Enable proxy takeover" — AnyBridge sets up the local proxy and certificates, then restart the IDE;
- **Config-based agents (Claude Code / Codex / OpenCode / Pi / Hermes / DeepSeek Harness / Grok / ZCode / CodeBuddy / WorkBuddy …)**: click "Switch to AnyBridge" and the config is written automatically.

### 3️⃣ Step 3: Open your tool and start coding

Use your IDE or CLI as usual — requests now flow to your own models.

> 💡 **One-click restore**: click "Restore original config" on any agent page to revert to official defaults instantly.

---

## 🖼️ UI Preview

![AnyBridge provider console](docs/assets/anybridge-provider-console.png)

![AnyBridge Devin agent console](docs/assets/anybridge-platform-devin.png)

![AnyBridge local proxy overview](docs/assets/anybridge-proxy-overview.png)

![AnyBridge model slot mapping](docs/assets/anybridge-slot-mapping.png)

![AnyBridge extension hub](docs/assets/anybridge-extension-center.png)

---

## 🔌 Three Connection Modes

| Mode | Agents | Must AnyBridge stay running? | Description |
| :--- | :--- | :--- | :--- |
| **Local proxy takeover** | Cursor, Windsurf, Devin | ✅ Yes | The UI is closed; a local proxy (`:7450`) translates chat traffic in real time and adds vision fallback, failover, retries and metrics |
| **Direct config writing** | Claude Code, Codex, OpenCode, Pi, Hermes, DeepSeek Harness, Grok, ZCode, CodeBuddy, WorkBuddy, Claude Desktop, Antigravity … | ❌ No | Native config files (JSON / YAML / TOML) are written for you; close AnyBridge afterwards — the tool talks to your relay directly |
| **Local API gateway** | Cline, Continue, Aider and any custom client | ✅ Yes | One OpenAI / Anthropic-compatible endpoint at `http://localhost:7450/v1` for every external tool |

> **Which to pick?** Single fixed relay → direct writing (shortest path). Need aggregation, fallback models, vision fallback and unified logs → proxy or gateway.

---

## 🎯 Full Agent Matrix

AnyBridge tailors the integration to each tool's architecture. **16 agents** are supported today, plus any external client via the local gateway:

| Category | Agent | Form factor | Mechanism & highlights | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Desktop IDEs** | **Cursor** | Desktop IDE | Transparent local proxy: chat RPC intercepted, completion & indexing stay native | ✅ Supported |
| | **Windsurf** | Desktop IDE | Transparent local proxy: Connect-RPC translation, freely remapped model slots | ✅ Supported |
| | **Devin** | Desktop IDE | Transparent local proxy: streaming session translation with vision fallback | ✅ Supported |
| | **Antigravity IDE** | VS Code-based editor | Native config writing + env sync, with one-click UI localization | ✅ Supported |
| **Desktop apps** | **Codex Desktop** | Desktop app | Runtime CDP injection: adds your models to the picker without patching binaries | ✅ Supported |
| | **Claude Desktop** | Desktop app | Native config writing with one-click switch and restore | ✅ Supported |
| | **Antigravity** | Standalone desktop agent | Endpoint patching + config writing dual channel, with one-click UI localization | ✅ Supported |
| **Terminal CLIs** | **Claude Code** | Terminal CLI | Safe native config writing: no manual JSON, Thinking params and dedicated unlock | ✅ Supported |
| | **Codex CLI** | Terminal CLI | Automatic config writing for relays and self-hosted endpoints | ✅ Supported |
| | **OpenCode** | Terminal CLI | Appends to config while keeping existing providers | ✅ Supported |
| | **Grok** | Terminal CLI | Native `config.toml` writing with one-click switch and restore | ✅ Supported |
| | **Pi** | Terminal CLI | Writes `models.json` providers, **grouped by vendor**, per-model toggle and one-click restore | ✅ Supported |
| | **Hermes** | Terminal CLI | Writes `config.yaml` custom_providers, **models and keys grouped per vendor**, original comments preserved | ✅ Supported |
| | **DeepSeek Harness** | Terminal CLI | Writes `settings.yaml` llm-pi-ai.providers (**grouped per vendor**), keys kept in `.credentials.yaml` | ✅ Supported |
| **Assistants & apps** | **CodeBuddy** | Desktop / extension | Native config writing with capability tags and automatic backup | ✅ Supported |
| | **WorkBuddy** | Desktop / extension | Native config writing with two-way sync with CodeBuddy | ✅ Supported |
| | **ZCode** | CLI / extension | Native nested config writing plus a JSON editor for import/export | ✅ Supported |
| **External ecosystem** | **Cline / Continue / Aider …** | Third-party plugins & scripts | Local reverse gateway: OpenAI / Anthropic-compatible endpoint at `http://localhost:7450/v1` | ✅ Supported |

---

## ✨ Key Features

- **🧭 Model slot mapping**: point hardcoded client slots (Cursor's `cursor-small`, Windsurf's `Claude Sonnet`) at any model you want.
- **🖼️ Vision fallback**: text-only models can still handle screenshots; assign a vision model globally or per provider (Mimo / MiniMax / Gemini Flash).
- **🔓 Dedicated unlock**: rebuilds official client fingerprints (`anthropic-beta` headers, Thinking params, session metadata) so any agent can use relay-only Claude Code / Codex lines without 503 / 400 errors.
- **💉 Codex Desktop enhancement**: injects your models into the picker through CDP at runtime — no binary modification.
- **🔁 Reliability**: automatic failover, 429 retry with backoff, concurrency limits, long-reasoning timeouts, proxy auto-restore on exit.
- **📊 Live metrics**: request trends, success/failure split, input/output token usage, per-channel latency and availability.
- **🧪 One-click diagnostics**: connectivity, model list, streaming SSE, tool calling and vision capability.
- **📐 Context presets**: recommended context windows for major models (Claude / GPT / DeepSeek / GLM / Qwen …) so long outputs aren't truncated.
- **🧩 CPA extension hub**: deploy and manage a local gateway suite (CLIProxyAPI + CPA Manager Plus + plugin store) in one click.
- **🔧 Custom headers**: add custom HTTP headers for corporate gateways, internal proxies or private auth.
- **📁 Session history protection**: session indexes are maintained across channel and login switches, so past chats never disappear.
- **🌐 One-click localization**: built-in engine with hot-updated dictionaries; code and reasoning chains are never translated.

---

## 🔬 How It Works

```
                           ┌───────────────────────────┐
                           │    AnyBridge desktop      │
                           │   (Tauri v2 + Rust)       │
                           └─────────────┬─────────────┘
                                         │ local control
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Local proxy service (:7450)                       │
│   ┌───────────────────────┐   ┌───────────────────────┐   ┌─────────────┐   │
│   │  Protocol translation │   │  Vision fallback      │   │ Failover &  │   │
│   │  (Connect-RPC / SSE)  │   │  (image → text)       │   │ rate retry  │   │
│   └───────────────────────┘   └───────────────────────┘   └─────────────┘   │
└───────────────▲───────────────────────────────▲──────────────────────▲──────┘
                │ local proxy                   │ CDP injection        │ config / gateway
    ┌───────────┴───────────┐       ┌───────────┴───────────┐  ┌───────┴────────────┐
    │ Cursor / Windsurf /   │       │  Codex Desktop        │  │ Claude Code / Pi /  │
    │ Devin (Connect-RPC)   │       │ (dynamic model list)  │  │ Hermes / DSH / more │
    └───────────────────────┘       └───────────────────────┘  └────────────────────┘
```

### Local proxy mode (Cursor / Windsurf / Devin)

```
Agent sends a request
    │
    ▼
[AnyBridge local proxy (127.0.0.1:7450)]
    ├─► 1. Classify: intercept chat sessions only (e.g. GetChatMessage)
    ├─► 2. Decode the conversation and forward it as standard OpenAI / Anthropic to your relay
    ├─► 3. Re-package the streaming response back into Connect-RPC for the UI
    │
    ▼
Non-chat traffic (completion, indexing, auth)
    └─► Passed through untouched — no added latency
```

- **No impact on daily use**: only chat prompts are translated; autocomplete and login keep using official routes;
- **Certificates generated locally**: created and trusted automatically on first run;
- **Cross-protocol translation**: Anthropic upstream ↔ OpenAI downstream (or vice versa) handled automatically.

### Direct config writing

For agents that support custom base URLs and keys, AnyBridge simply **locates the hidden config file and writes it correctly** (with an automatic backup first):

| Agent | Config file written |
| :--- | :--- |
| Claude Code | `~/.claude/settings.json` |
| Codex CLI | `~/.codex/config.toml` |
| OpenCode | `~/.config/opencode/opencode.json` |
| Pi | `~/.pi/agent/models.json` (default model in `settings.json`) |
| Hermes | `~/.hermes/config.yaml` (`%LOCALAPPDATA%\hermes\config.yaml` on Windows) |
| DeepSeek Harness | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` |
| Grok | `~/.grok/config.toml` |

Output is **grouped by vendor**: models sharing a vendor (name, endpoint, key) collapse into one provider entry and models are listed by ID instead of flooding the picker. Only AnyBridge-managed entries are touched — your own entries and file comments are preserved.

---

## ❓ FAQ

<details>
<summary><b>Q1: Will native code completion get slower?</b></summary>
<br>
<b>No.</b> AnyBridge only intercepts chat requests. Inline completion, symbol indexing and login traffic pass straight through the official route, keeping suggestions at millisecond speed.
</details>

<details>
<summary><b>Q2: Are my API keys, relay URLs and code safe?</b></summary>
<br>
<b>Yes.</b> AnyBridge is 100% local open-source software with no telemetry server. Keys, endpoints and conversations stay on your disk, and the source is fully auditable.
</details>

<details>
<summary><b>Q3: Which relays and self-hosted gateways are supported?</b></summary>
<br>
<b>Nearly all compatible services.</b> Anything speaking standard OpenAI (OneAPI, NewAPI, commercial relays) or Anthropic (Claude-specific relays) works — just fill in the base URL and key. A local CPA gateway can also be deployed from the extension hub.
</details>

<details>
<summary><b>Q4: Can this get my official account banned?</b></summary>
<br>
<b>No.</b> AnyBridge never patches agent binaries; it works as a loopback proxy locally and forwards authentication and telemetry unchanged.
</details>

<details>
<summary><b>Q5: How do I fully revert to official defaults?</b></summary>
<br>
<b>One click.</b> On the agent page click "Restore original config" — proxy rules are removed and configs reset. Closing the app also restores your network settings.
</details>

<details>
<summary><b>Q6: How can I verify the local proxy is running?</b></summary>
<br>
Open <code>http://localhost:7450/__byok/health</code>: <code>{"status":"ok"}</code> means it's healthy. <code>http://localhost:7450/__byok/stats</code> shows live aggregate statistics.
</details>

<details>
<summary><b>Q7: Where is my configuration stored? How do I migrate?</b></summary>
<br>
<ul>
  <li><b>Windows</b>: <code>%APPDATA%\anybridge\providers.json</code></li>
  <li><b>macOS</b>: <code>~/Library/Application Support/anybridge/providers.json</code></li>
  <li><b>Linux</b>: <code>~/.config/anybridge/providers.json</code></li>
</ul>
Copy that file to the matching folder on a new machine to restore everything.
</details>

<details>
<summary><b>Q8: How do I debug request errors?</b></summary>
<br>
Use <b>"Export logs"</b> in the settings menu to inspect live logs and error stacks, which makes upstream relay errors easy to spot. The client also checks for new releases automatically.
</details>

---

## ⚠️ Security & Privacy

- **Fully local**: no cloud backend collecting user data;
- **Credentials stay local**: API keys, relay URLs and chat context never leave your disk;
- **Disclaimer**: this is an independent open-source productivity tool with no affiliation or endorsement from Cursor, Windsurf, Devin, OpenAI, Anthropic or any other vendor.

---

## 💬 Community & Support

Join the group to share setup tips and tuning experience for each agent.

Special thanks to the [Linux.do](https://linux.do) community for feedback and support!

<div align="center">

| 💬 QQ Group (1075342078) | ☕ Sponsor |
| :---: | :---: |
| <img src="docs/qq-group-qrcode.png" width="180" alt="AnyBridge QQ group QR code"> | <img src="https://raw.githubusercontent.com/soulvon/windsurf-pool-releases/main/wechat-reward.webp" width="180" alt="WeChat sponsor QR code"> |
| Mention "AnyBridge" when joining | Thanks for the support! |

</div>

---

## 🛠️ Developer Guide

> 💡 End users should just download the installer; you can skip this section.

### 1. Prerequisites
- **Node.js** >= 20
- **Rust** toolchain (Tauri desktop build)
- **Python 3** (proxy packaging scripts)

### 2. Development run
```bash
git clone https://github.com/soulvon/AnyBridge.git
cd AnyBridge
npm install
cd sidecar && npm install && cd ..

# Build the sidecar binary (output to src-tauri/binaries/, git-ignored, required on first run)
python scripts/build/build_sidecar_plain.py
python scripts/build/build_cursor_core.py

# Start the desktop dev build
npm run tauri:dev
```

> ⚠️ `npm run tauri:dev` does not rebuild the sidecar. Re-run the scripts above after changing `sidecar/` or `cursor-core/`.

### 3. Build binaries
```bash
npm run tauri:build
```
Artifacts land in `src-tauri/target/release/bundle/`.

---

## 📄 License

[MIT](LICENSE) © 2026 [soulvon](https://github.com/soulvon)

---

<div align="center">

**AnyBridge · Break the lock-in, give the choice back to developers**

Keywords: BYOK · AI coding agents · local proxy · OpenAI-compatible API · model routing & aggregation · relay integration · Claude Code / Codex / Cursor / Pi / Hermes configuration management

</div>
