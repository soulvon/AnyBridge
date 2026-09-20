<div align="center">

# 🚀 AnyBridge

### Connect Third-Party Relays & Custom Models to Any AI Coding Tool
**All-in-One BYOK (Bring Your Own Key) Desktop Bridge · Supporting 12+ Desktop IDEs & CLI Tools**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-24c8db.svg?logo=tauri)](https://tauri.app/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()
[![GitHub release](https://img.shields.io/github/v/release/soulvon/AnyBridge?include_prereleases&color=orange)](https://github.com/soulvon/AnyBridge/releases)

[English](README_en.md) • [简体中文](README.md)

[📥 Download](#-download--installation) •
[⚡ Problem & Solution](#-common-problems--solutions) •
[🚀 Quick Start](#-quick-start-3-simple-steps) •
[🔬 How It Works](#-how-it-works--technical-implementation) •
[🎯 Full Supported Tools](#-full-supported-tools-matrix) •
[❓ FAQ](#-faq) •
[💬 Community](#-community--sponsor)

<br>

**Code with whichever IDE feels best!**  
AnyBridge is an intuitive open-source **BYOK (Bring Your Own Key) proxy & model management client** that connects third-party relays (OneAPI, NewAPI, CPA, etc.), self-hosted gateways, and any custom AI models (DeepSeek, Claude, GPT) into your preferred desktop IDEs and terminal CLI tools. No manual JSON editing, no complex setup—just simple, visual management.

</div>

---

<!-- ========================================== -->
<!-- Section 1: End-User Guide (Download & Fast Setup) -->
<!-- ========================================== -->

## 📥 Download & Installation

Download the prebuilt installer directly from the GitHub Releases page. **No Node.js, Python, or command-line setup required**:

👉 **[Download AnyBridge Latest Releases (GitHub)](https://github.com/soulvon/AnyBridge/releases)**

| OS | Recommended Package | Installation Guide |
| :--- | :--- | :--- |
| **🪟 Windows** | `.msi` or Setup `.exe` | Run installer and follow prompts |
| **🍏 macOS** | `.dmg` | Open disk image and drag AnyBridge to Applications folder |
| **🐧 Linux** | `.AppImage` or `.deb` | Make executable (`chmod +x *.AppImage`) and double-click to run |

---

## ⚡ Common Problems & Solutions

Developers working across multiple tools often run into **locked models, scattered configurations, and syntax errors from manual JSON edits**. Here is how AnyBridge handles each:

| Problem Encountered | Default Behavior / Manual Way | AnyBridge Approach |
| :--- | :--- | :--- |
| **IDE Lacks Custom Endpoints** | Devin, Windsurf, and Cursor interfaces offer no place to input custom APIs | **Local Loopback Proxy**: Intercepts chat sessions cleanly to connect your own relays |
| **Tedious Manual JSON Edits** | Codex, CodeBuddy, and Claude Code require hunting down hidden directories | **Direct GUI Writing**: Select provider and model in the UI to write configs directly—instant rollback |
| **Typing Model Names by Hand** | Manually typing long model IDs risks typos and unexpected 404 errors | **Online Model Fetching**: Query available models directly from the provider and pick from a dropdown |
| **Reconfiguring Every IDE** | Updating an endpoint means editing files across every single IDE one by one | **Configure Once, Use Everywhere**: Centralized hub automatically syncs credentials across all IDEs |
| **Text-Only Models Reject Images** | Pasting error screenshots into DeepSeek crashes with "unsupported image" | **Vision Fallback**: Lightweight visual model translates screenshots into clear text descriptions |
| **Cannot Share with External Tools** | Limited to specific IDEs; external scripts or other extensions cannot share the pool | **Local Reverse Proxy Gateway**: Exposes a standard OpenAI endpoint (`:7450/v1`) for any client/script |
| **Deploying Local Gateways** | Setting up local AI aggregators requires pulling Docker containers manually | **CPA Extension Hub**: One-click deployment, lifecycle control, and plugin management for CPA suite |
| **Multiple IDEs in Rotation** | Using different editors for different tasks means fragmented setups | **Unified Management**: Supports 12+ mainstream tools; use whichever IDE fits your mood |

---

## 🚀 Quick Start (3 Simple Steps)

Launch AnyBridge and get up and running in under a minute:

```
[Step 1: Add/Import Providers] ──► [Step 2: Choose Platform & Enable] ──► [Step 3: Open IDE & Code!]
```

### 1️⃣ Step 1: Add or Import Providers (with Online Model Fetching)
Go to the **"Providers"** page:
- **Direct Setup & Fetching**: Click "Add Provider", enter your Base URL and API key, and **fetch available models online** to select them from a clean dropdown.
- **One-Click Import**: Automatically scans and imports existing configurations from **Cherry Studio**, **CC Switch**, and **Cockpit Tools** with candidate preview and deduplication.

### 2️⃣ Step 2: Choose Your Target Tool (Zero Manual Config)
Go to the **"Platforms"** page and find your editor:
- **Closed Desktop IDEs (Windsurf / Devin / Cursor)**: Click "Enable Proxy Takeover". AnyBridge sets up the local loopback proxy and certificates automatically.
- **Config-based Tools (Codex / CodeBuddy / Claude Code)**: Click "Switch to AnyBridge" to automatically write configurations without editing JSON files.

### 3️⃣ Step 3: Open Your Editor & Start Coding!
Launch your IDE as usual. In chat, your prompts now route seamlessly through your configured relay or custom models!

> 💡 **Instant Rollback**: Click "Restore Original Config" in the Platform tab at any time to return to official defaults.

---

## 🖼️ UI Preview

Clean, visual desktop console covering **Provider Management**, **Model Slot Mapping**, **Vision Fallback**, **One-Click Takeover**, and the **Extension Hub**:

![AnyBridge Devin Platform Console](docs/assets/anybridge-platform-devin.png)

![AnyBridge Provider Console](docs/assets/anybridge-provider-console.png)

---

<!-- ========================================== -->
<!-- Section 2: Technical Deep Dive & Architecture -->
<!-- ========================================== -->

## 🔬 How It Works & Technical Implementation

This section briefly explains how AnyBridge connects different editors and models under the hood:

```
                           ┌───────────────────────────┐
                           │    AnyBridge Desktop App  │
                           │   (Tauri v2 + Rust Core)  │
                           └─────────────┬─────────────┘
                                         │ Local IPC
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Local Proxy Service (:7450)                      │
│                                                                             │
│   ┌───────────────────────┐   ┌───────────────────────┐   ┌─────────────┐   │
│   │   Protocol Converter  │   │  Vision Fallback Hub  │   │ Upstream LB │   │
│   │  (Connect-RPC / SSE)  │   │ (Multimodal Transform)│   │  & Retry    │   │
│   └───────────────────────┘   └───────────────────────┘   └─────────────┘   │
└───────────────▲───────────────────────────────▲──────────────────────▲──────┘
                │ Local Proxy                   │ Debug Port (CDP)     │ Local Proxy
    ┌───────────┴───────────┐       ┌───────────┴───────────┐          │
    │  Windsurf / Devin IDE │       │  Codex Desktop App    │          │
    │  (Connect-RPC Protocol)       │  (Dynamic Model Inject│          │
    └───────────────────────┘       └───────────────────────┘          │
                                                            ┌──────────┴──────────┐
                                                            │ Claude Code / Other │
                                                            │ (Config / Local API)│
                                                            └─────────────────────┘
```

---

### 1. 🔌 How Devin / Windsurf Connect (Local Proxy + Protocol Translation)

Devin and Windsurf desktop applications communicate with remote servers using the Connect-RPC protocol (an HTTP/2-based format) without exposing any UI inputs for custom endpoints.

**How AnyBridge handles it:**

```
IDE Request Sent
    │
    ▼
[AnyBridge Local Proxy (127.0.0.1:7450)]
    │
    ├─► 1. Identify Request Type: Specifically intercepts chat sessions (e.g. GetChatMessage)
    ├─► 2. Decode chat context, convert to standard OpenAI or Anthropic payload for your provider
    ├─► 3. On receiving streaming tokens, repackage into Connect-RPC format and push back to IDE
    │
    ▼
Non-chat traffic (inline autocomplete, symbols, workspace indexing, account authentication)
    │
    └─► Passes through untouched over official native network paths with zero added latency
```

- **Zero Impact on Everyday Work**: Only chat sessions are proxied; code completions and login flows remain entirely on the official fast path;
- **Automatic Certificate Setup**: Automatically generates and trusts local root certificates upon initial startup;
- **Bi-Directional Protocol Transpilation**: Seamlessly converts between OpenAI Chat Completions and Anthropic Messages formats and SSE stream chunks automatically.

---

### 2. 🖼️ How Third-Party Image Understanding (Vision Fallback) Works

Many powerful reasoning models (such as DeepSeek) are text-only, meaning sending screenshots directly leads to errors.

**How AnyBridge handles it:**

```
You send a message with an image in the IDE chat
                │
                ▼
AnyBridge checks whether the target model supports images
                │
       ┌────────┴────────┐
       ▼ [Supported]     ▼ [Not Supported (Text-Only)]
  Forward directly       Extract image bytes and send to a lightweight visual model (e.g. Mimo / MiniMax)
                         │
                         ▼
                       Visual model returns concise textual description:
                       "Console error at line 42: NullPointerException, user is null..."
                         │
                         ▼
                       AnyBridge automatically replaces the image with the text description
                         │
                         ▼
                       Target text-only model receives clean text prompt and writes the fix
```

This whole process occurs automatically in the background without manual model switching.
- **Configurable Per Provider**: Set a global fallback model, or configure customized vision fallback models individually per provider.

| Recommended Vision Models | Practical Use Case |
|---|---|
| **Mimo 2.5 Vision** | Ultra-fast and cost-effective, ideal for daily error screenshots |
| **MiniMax M3 Vision** | Accurate spatial understanding, suitable for complex diagrams |
| **Gemini Flash** | Blazing fast, nearly zero cost, outstanding multimodal comprehension |

![Provider Editor & Vision Fallback](docs/assets/anybridge-provider-edit.png)

---

### 3. 🖥️ How Codex Desktop Displays Custom Models (CDP Runtime Injection)

Codex Desktop hardcodes its model dropdown in the client, making custom configurations invisible in the UI.

**How AnyBridge handles it:**
1. Launches Codex with remote debugging flags attached;
2. Connects to the Codex interface using Chrome DevTools Protocol (CDP);
3. Injects a small script that dynamically adds your AnyBridge models into the dropdown;
4. Automatically maintains session indices and clears expired tokens to avoid history loss.

This approach **does not modify any local application binaries**. Closing AnyBridge restores Codex to its default state.

![Codex Platform Console](docs/assets/anybridge-platform-codex.png)

---

### 4. 🔐 What Is the "Unlock" Feature & What Problem Does It Solve?

Many developers using third-party relays (such as AnyRouter) notice dedicated **"Claude Code Dedicated Relays"** or **"Codex Dedicated Endpoints"** offering low costs and high concurrency.

However, upstream relays enforce strict client fingerprint checks:
- Standard IDE requests lack specific `anthropic-beta` headers, CLI metadata, thinking parameters, and native tool signatures, **causing relays to return HTTP 503 Service Unavailable or 400 Bad Request**.

**How AnyBridge Unlock solves this:**
1. **Automated Official Fingerprint Emulation**: When marking a channel as `Claude Code Unlock` or `Codex Unlock`, AnyBridge automatically reconstructs the exact headers, thinking parameters, and tool signatures required by official tools;
2. **Access Exclusive Relays in Any IDE**: Use low-cost dedicated endpoints inside Windsurf or Devin without being rejected by 503 errors;
3. **Strict Scope Isolation**: Standard requests remain clean and unaffected by custom headers, preventing unintended protocol pollution.

```
Your Everyday IDE (Windsurf / Devin, etc.)
                │
                ▼
   AnyBridge Local Proxy Intercept
                │
   Is Unlock channel matching active?
                │
       ┌────────┴────────┐
       ▼ [Yes (e.g. Claude Code Dedicated)]   ▼ [No (Standard Route)]
Emulate official Beta headers & fingerprints     Pass clean standard schema
                │
                ▼
Upstream relay accepts request (No more 503 errors!)
```

---

### 5. 💡 Direct Config Mode vs Local Proxy Mode: Key Differences

- **Direct Config Mode (Claude Code / Codex CLI / CodeBuddy)**:
  - Writes verified endpoints and keys directly into tool configuration files.
  - **You can close the AnyBridge desktop app after switching**. Tools communicate directly with your upstream provider.
- **Local Proxy Mode (Windsurf / Devin / Cursor)**:
  - Closed IDEs provide no custom API inputs. AnyBridge runs a local loopback proxy (`127.0.0.1:7450`) to dynamically convert protocols.
  - **Keep AnyBridge running while using these IDEs** to enjoy Vision Fallback and automatic retry features.

---

### 6. 📁 Session History Protection: Why Past Chats Never Disappear

Switching providers in tools like Codex Desktop often hides past chats from the sidebar.

AnyBridge maintains automatic **session state synchronization**:
- Automatically maintains `rollout JSONL` session indices across switching events;
- Ensures previous session histories remain intact and browsable;
- Offers a one-click "Repair Session History" button on the Codex platform page.

---

### 7. ⚡ Reliability & Stability Safeguards

- **Automatic Failover**: Automatically retries the next available channel upon 5xx errors or network timeouts;
- **Rate-Limit Retry**: Automatically waits 1–2 seconds and retries when encountering temporary 429 limits;
- **Concurrency Throttling**: Restricts concurrent in-flight requests per model to avoid triggering upstream limits;
- **Deep-Thinking Timeout Protection**: Separate timeout handling for long-form reasoning models prevents prematurely aborting responses;
- **Automatic Proxy Cleanup**: Automatically restores system proxy settings when closing the app to avoid breaking your internet connection.

![Local Proxy Overview](docs/assets/anybridge-proxy-overview.png)

---

### 8. 🌐 Local Reverse Proxy Gateway (Extending External Tools)

AnyBridge functions as a standard local reverse proxy (default: `http://localhost:7450/v1`):
- Exposes standard OpenAI / Anthropic endpoints;
- Any client supporting custom endpoints (Cline, Continue, Aider, CLI scripts) can connect directly to share the unified model pool.

### 9. 🧩 CPA Extension Hub: Visual Local Gateway
Deploy, launch, and stop local CPA suites (CLIProxyAPI) directly in the UI to manage and aggregate upstream channels:

![Extension Hub](docs/assets/anybridge-extension-center.png)

### 10. 🔄 Override Locked Model Slots
Easily redirect preset slot names in Cursor or Windsurf (like `cursor-small` or `Claude Sonnet`) to any real upstream model (such as DeepSeek-V4-Pro or GPT-5.5):

![Model Slot Mapping](docs/assets/anybridge-slot-mapping.png)

### 11. 🧪 Test Before You Code: One-Click Capability Diagnostics
No need to guess whether your API works by typing prompts inside your IDE. Click "Test" in the provider editor to automatically verify:
- API endpoint reachability;
- Model list retrieval;
- Streaming SSE response delivery;
- Tool calling (Function Calling) capability;
- Multimodal visual understanding.

### 12. 📊 Real-Time Metrics & Token Tracking
A built-in monitoring dashboard provides clean visibility into proxy activity:
- **Request Flow**: Real-time request volume graphs and error distributions;
- **Token Accounting**: Prompt and completion token breakdowns per model;
- **Latency Tracking**: Average response times and uptime statistics.

### 13. 📐 Built-In Model Context Presets
Different models have varying context window limits, and checking official docs for each can be tedious. AnyBridge bundles recommended context presets for popular model families (Claude, GPT, DeepSeek, GLM, Qwen):
- Automatically suggests appropriate max input and output token boundaries;
- Prevents premature answer truncation, while allowing manual overrides anytime.

### 14. 🔧 Custom HTTP Headers Support
For enterprise gateways, intranet proxies, or private relays requiring specialized authorization tokens, easily add custom request headers per provider.

---

## 🪁 Kite Companion Plugin

If you regularly use **Devin** or **Windsurf**, we recommend pairing AnyBridge with [Kite](https://github.com/soulvon/Kite):
- **Account Pool**: Manage and switch multiple accounts effortlessly.
- **Localization**: UI enhancements and translation for smoother everyday use.
- **AnyBridge Integration**: One-click launcher and installer built right into the platform page.

---

<!-- ========================================== -->
<!-- Section 3: Supported Matrix & FAQ -->
<!-- ========================================== -->

## 🎯 Full Supported Tools Matrix

AnyBridge applies tailored integration mechanisms based on each tool's underlying architecture. Below is the complete matrix of 12+ supported editors and extensions:

| Category | Tool | Form Factor | Integration Mechanism & Highlights | Status |
|:---|:---|:---|:---|:---:|
| **Desktop IDEs** | **Cursor** | Desktop IDE | Local Transparent Proxy: Intercepts chat RPCs; completions/indexing pass natively | ✅ Supported |
| | **Windsurf** | Desktop IDE | Local Transparent Proxy: Connect-RPC transpilation; custom model slot mapping | ✅ Supported |
| | **Devin** | Desktop IDE | Local Transparent Proxy: Streaming session translation with Vision Fallback | ✅ Supported |
| | **Codex Desktop** | Desktop Client | Runtime CDP Injection: Dynamic model dropdown mounting without binary patches | ✅ Supported |
| | **Claude Desktop** | Desktop App | Direct Config Writing: Safely writes configs with instant one-click rollback | ✅ Supported |
| **Terminal CLI** | **Claude Code** | Terminal CLI | Direct Config Writing: No manual JSON hacking; supports Thinking / Beta headers | ✅ Supported |
| | **Codex CLI** | Terminal CLI | Automatic configuration generation for custom relays and self-hosted endpoints | ✅ Supported |
| | **OpenCode** | Terminal CLI | Direct configuration setup, eliminating manual environment variable edits | ✅ Supported |
| **Assistants & Ext** | **CodeBuddy** | Desktop / Ext | Direct config writing without manual JSON configuration | ✅ Supported |
| | **WorkBuddy** | Desktop / Ext | Direct configuration integration for custom models and team gateways | ✅ Supported |
| | **Grok / ZCode** | Various Ext | Rapid custom endpoint setup with instant reset support | ✅ Supported |
| | **Antigravity** | AI Dev Tool | Dual support for direct config writing and local proxy connection | ✅ Supported |
| **Universal Ecosystem**| **Cline / Continue / Aider** | External Plugins | Local Reverse Proxy: Universal `:7450/v1` OpenAI / Anthropic compatible endpoint | ✅ Compatible |

---

## ❓ FAQ

<details>
<summary><b>Q1: Does AnyBridge affect the speed of IDE inline autocomplete?</b></summary>
<br>
<b>Not at all.</b> AnyBridge inspects request signatures and specifically intercepts conversational chat RPCs. Inline code suggestions (Tab completions), workspace indexing, and account logins remain 100% on the official native route with zero added latency.
</details>

<details>
<summary><b>Q2: Are my API keys and code secure?</b></summary>
<br>
<b>100% Secure.</b> AnyBridge is a purely local desktop tool with no telemetry or remote backend. All credentials and chat traffic stay strictly on your local disk and network loopback.
</details>

<details>
<summary><b>Q3: What relays and providers are supported?</b></summary>
<br>
Any endpoint adhering to standard OpenAI or Anthropic specifications (OneAPI, NewAPI, CPA, private commercial relays, or official direct keys).
</details>

<details>
<summary><b>Q4: Will using this risk account suspension?</b></summary>
<br>
<b>No.</b> AnyBridge does not crack or tamper with IDE application binaries. It operates strictly via standard local proxy loopback and native configuration files.
</details>

<details>
<summary><b>Q5: How do I revert to official defaults?</b></summary>
<br>
Go to the "Platforms" page and click "Restore Original Config". AnyBridge instantly clears proxy rules and resets settings to default.
</details>

<details>
<summary><b>Q6: How can I verify that the local proxy is running?</b></summary>
<br>
Visit <code>http://localhost:7450/__byok/health</code> in your browser or terminal; a <code>{"status":"ok"}</code> response indicates the service is running normally. Visit <code>http://localhost:7450/__byok/stats</code> to inspect aggregated live statistics.
</details>

<details>
<summary><b>Q7: Where is the configuration stored? How do I backup or migrate?</b></summary>
<br>
All provider credentials and routing settings are stored in local JSON files:
<ul>
  <li><b>Windows</b>: <code>%APPDATA%\anybridge\providers.json</code></li>
  <li><b>macOS</b>: <code>~/Library/Application Support/anybridge/providers.json</code></li>
  <li><b>Linux</b>: <code>~/.config/anybridge/providers.json</code></li>
</ul>
Simply copy this file to migrate your settings to another device.
</details>

<details>
<summary><b>Q8: How do I debug or report errors?</b></summary>
<br>
Click <b>"Export Logs"</b> in the settings menu to inspect live runtime logs and stack traces. AnyBridge also features automatic update checks to notify you when new releases are available.
</details>

---

<!-- ========================================== -->
<!-- Section 4: Security, Community & Developer -->
<!-- ========================================== -->

## ⚠️ Security & Privacy

- **100% Local**: AnyBridge runs exclusively on your local machine with zero telemetry or remote servers.
- **Protected Credentials**: API keys, relay tokens, and conversational context remain strictly on your local disk.
- **Disclaimer**: AnyBridge is an independent open-source tool and is not affiliated with or endorsed by Windsurf, Devin, OpenAI, or Anthropic.

---

## 💬 Community & Sponsor

If AnyBridge has saved you time and effort, feel free to buy the author a coffee or join our community group!

Special thanks to the [Linux.do](https://linux.do) community for their continuous feedback and support.

<div align="center">

| 💬 QQ Group (1075342078) | ☕ Sponsor / Buy Me a Coffee |
| :---: | :---: |
| <img src="docs/qq-group-qrcode.png" width="180" alt="QQ Group QR Code"> | <img src="https://raw.githubusercontent.com/soulvon/windsurf-pool-releases/main/wechat-reward.webp" width="180" alt="WeChat Reward"> |
| Note "AnyBridge" when joining | Support ongoing maintenance |

</div>

---

## 🛠️ Developer Guide

> 💡 Regular users should simply download the prebuilt binary from [Releases](https://github.com/soulvon/AnyBridge/releases).

If you wish to contribute to AnyBridge or compile the project from source:

### Prerequisites
- **Node.js** >= 20
- **Rust** toolchain (for Tauri desktop compilation)
- **Python 3** (for packaging scripts)

### Development Run
```bash
# Clone repo & install dependencies
git clone https://github.com/soulvon/AnyBridge.git
cd AnyBridge
npm install
cd sidecar && npm install && cd ..

# Build sidecar binaries (output to src-tauri/binaries/, gitignored, required on first run)
python scripts/build/build_sidecar_plain.py
python scripts/build/build_cursor_core.py

# Launch in desktop dev mode
npm run tauri:dev
```

> ⚠️ `npm run tauri:dev` does not rebuild the sidecars. Re-run the matching script after changing `sidecar/` or `cursor-core/` code.

### Build Binary
```bash
# Compile desktop release installer (output in src-tauri/target/release/bundle/)
# Requires the sidecar binaries from the previous step (anybridge-proxy is not built automatically)
npm run tauri:build
```

---

## 📄 License

[MIT](LICENSE) © 2026 [soulvon](https://github.com/soulvon)
