# AnyBridge

一个基于 Tauri v2 + Rust 构建的多平台 BYOK 桥接客户端。它可以将 Windsurf / Devin IDE 的 Cascade 聊天后端无缝替换为你自己的 Anthropic / OpenAI API 密钥，也可以把 Codex、Claude Code、CodeBuddy、OpenCode 等工具切换到你配置的供应商，同时保留原生登录、补全、代码库索引和工具自身配置。

当前版本：`v1.2.18`。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

项目通过在本地运行一个 MITM 代理，优先接管 Cascade 聊天 RPC，并按配置改写模型列表、模型状态和部分限流/能力探测请求；登录、补全、代码库索引等非目标流量保持直连或透传。代理启动时会按需对 IDE 的 `workbench.html` 做可还原的前端注入，用于增强模型卡片展示；停止代理、退出应用或触发防误杀恢复逻辑时会自动还原。

**运行环境要求：** Windsurf 1.108.x / Devin · Windows 11 · Node.js 20+

---

## 🛠️ 工作原理

Windsurf 的后端服务通过两个主要的域名与 Codeium 进行通信：

- `api_server_url` → `server.self-serve.windsurf.com` (处理 Cascade 聊天、遥测、登录认证等)
- `inference_api_server_url` → `inference.codeium.com` (处理单行/多行代码编辑、自动补全等)

本应用在本地启动两个代理端口，默认为 `:7450` (混合 MITM 代理) 和 `:7451` (推理/补全透传入口)。当您将 Windsurf / Devin 的 `http.proxy` 设置为本地代理端口 `:7450` 后，本地代理会智能识别 `GetChatMessage` RPC 请求，将其解析并桥接到您自己配置的 AI 提供商，同时处理模型列表、模型状态与部分能力探测请求；不属于接管范围的通信会直连 Codeium：

```
Windsurf / Devin IDE ──(http.proxy = localhost:7450)──> AnyBridge 混合代理
                                                     ├── GetChatMessage → 转发至您自建的 API 密钥 ✦
                                                     ├── 模型/能力请求   → 按本地配置改写或放行
                                                     ├── CONNECT 隧道    → 建立盲 TCP 管道 (登录、索引等)
                                                     └── 其他所有请求    → 直连 Codeium 官方服务 (免费账号)
```

本桌面应用主要负责平台接入管理、本地配置的持久化存储、实时连接状态与日志的可视化展示、一键生成本地 MITM 解密证书，以及代理型平台启动/停止时的 IDE 注入与还原。

> [!NOTE]
> MITM 请求/响应体日志默认开启（截断到 8192 字节）。需要关闭时设置 `BYOK_MITM_LOG=false`，需要完整 body 时设置 `BYOK_MITM_FULL_LOG=true`。

---

## 🚀 快速上手

1. **配置 AI 供应商**：启动 AnyBridge 并切换到 **供应商 (Providers)** 标签页，填入 Anthropic / OpenAI 兼容 API Host 与 API Key。点击 **测试连接** 按钮以验证配置。

2. **选择平台**：切换到顶部 **平台**，在第二列选择 Windsurf、Devin、Codex、Claude Code、CodeBuddy、OpenCode 等目标工具。

3. **代理型平台**：选择 Windsurf 或 Devin 后，在平台控制台运行环境检测、生成 MITM 证书，并点击 **启动代理**。AnyBridge 会自动写入 IDE 的代理配置：

   ```json
   {
     "http.proxy": "http://localhost:7450",
     "http.proxyStrictSSL": false
   }
   ```

4. **配置切换型平台**：选择 Codex、Claude Code、CodeBuddy 或 OpenCode 后，选择要写入的供应商，查看配置预览，然后点击 **应用并切换**。

5. **体验平台接入**：代理型平台需重启 IDE 后生效；配置切换型平台需重启对应工具后生效。仪表盘会实时展示请求数、Token 消耗、错误数和当前活跃模型。

---

## 📋 功能模块

| 标签页 | 功能说明 |
| :--- | :--- |
| **仪表盘 Dashboard** | 实时请求总数、Token 流量计数、累计消费成本、错误计数统计（每日重置） |
| **供应商 Providers** | 自定义 API 接入地址和密钥，提供实时的连通性检测；支持 Gemini 等非标准 API 的工具 Schema 兼容自动探测与修复 |
| **平台 Platforms** | 第二列管理 Windsurf、Devin、Codex、Claude Code、CodeBuddy、OpenCode；Cursor 暂作占位 |
| **模型映射 Model Map** | 位于 Windsurf / Devin 平台控制台下，将 IDE 的模型 ID 灵活映射为指定真实模型 |
| **平台日志 Logs** | 位于 Windsurf / Devin 平台控制台下，实时输出代理服务器流量细节与连接日志 |
| **模型检测 Eval** | 对供应商连通性、格式兼容、工具调用、视觉能力与流式响应进行快速体检 |
| **设置 Settings** | 仅保留通用设置：模型默认值、自动重试、系统提示词、安全和版本更新 |

- 配置文件保存在：`%APPDATA%\anybridge\byok-config.json` 与 `.env`
- 本地 MITM 证书保存在：`%APPDATA%\anybridge\certs\`

---

## 🏗️ 本地编译与打包

本项目分为 Node.js 代理端（Sidecar 独立执行文件）和 Tauri 桌面端两部分。

后续打包与发布按固定指南执行：[`docs/03-打包与更新发布指南-PackagingAndUpdateGuide.md`](docs/03-打包与更新发布指南-PackagingAndUpdateGuide.md)。指南区分了本地打包测试、正式云端发布、防篡改发布规划，以及私有仓库编译后同步到公开 Release 仓库的更新流程。

### 1. 编译 Node.js 代理端 (Sidecar)
```bash
cd sidecar
npm install
# 将 JS 代理编译为独立的免运行环境的 EXE 文件：
npx pkg proxy-entry.js --targets node22-win-x64 --output anybridge-proxy.exe
# 拷贝到 Tauri 的 sidecar 目录并命名为匹配当前平台的目标名称：
cp anybridge-proxy.exe ../src-tauri/binaries/anybridge-proxy-x86_64-pc-windows-msvc.exe
```

### 2. 运行 Tauri 开发环境
```bash
cd ..
npm install
npx tauri dev
```

仅运行 Node 代理端时可使用：

```bash
npm run start
```

检查 UI 拆分文件、脚本加载顺序和 JS 语法：

```bash
npm run check:ui
```

### 3. 构建发布安装包 (MSI / NSIS)
```bash
npx tauri build
```

> [!NOTE]
> 如果你在 Windows 下使用安全软件，它的防退与防护机制可能会拦截/锁定 Rust 编译生成的 `target` 临时目录，并导致文件占用报错（如 `os error 5/32`）。建议在打包前将 `src-tauri/target` 目录添加到信任名单或临时关闭防退保护。

---

## 🔄 自动化发版流程 (GitHub Actions)

项目内置了完整的发布工作流 `.github/workflows/release.yml`，在推送版本 Tag 时可实现自动构建和部署：
1. **自动编译**：每当向 GitHub 仓库推送符合 `v*` 格式的 tag（例如 `v1.0.2`），工作流会自动拉起 Windows-latest 构建环境编译出客户端资产。
2. **签名与元数据合并**：利用打包出来的 `.zip` 更新分发包与 Minisign `.sig` 签名文件，由 Node.js 脚本全自动拼装出符合 Tauri 更新机制的 `latest.json` 自动更新配置文件。
3. **闭环推送**：将 `latest.json` 附带上传到您的 GitHub Release 中，并将 Release 状态修正为正式发布，使客户端可以直接触发就地/静默自动更新。

---

## 🧠 工具 Schema 自动探测与修复

当第三方供应商（如 Gemini OpenAI 兼容层）不支持 Windsurf 发送的工具参数 JSON Schema 中的某些字段（如 `exclusiveMinimum`、`propertyNames` 等）时，上游会返回 `HTTP 400`。本应用内置了自动探测与修复机制：

1. **自动识别**：检测到 400 响应中包含 Schema 不兼容特征时，自动判定为工具参数兼容性问题
2. **同请求重试**：立即以 Gemini 兼容模式重新发送请求（递归剔除不支持的 Schema 字段），用户无感知
3. **持久化记忆**：将兼容模式写入供应商配置（`capabilities.toolSchemaCompat = 'gemini'`），后续同供应商请求直接走兼容路径，无需再次触发 400
4. **界面可见**：供应商能力标签会显示 `Schema兼容` 标记，标识已自动学习

---

## 📝 开源协议

[MIT](LICENSE)
