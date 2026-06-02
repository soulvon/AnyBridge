# Windsurf BYOK

一个基于 Tauri v2 + Rust 构建的桌面代理客户端。它可以将 Windsurf IDE 的 Cascade 聊天后端无缝替换为你自己的 Anthropic / OpenAI API 密钥，同时允许你继续使用 Codeium 免费账号自带的代码自动补全、代码库索引、登录认证以及其他所有原生功能。

项目通过在本地运行一个 MITM 代理，**仅拦截并中转 Cascade 聊天流量**；其余所有请求（如 IDE 登录、遥测数据、代码自动补全等）均直接原样转发给 Codeium 官方服务器。本应用不会以任何形式修改 Windsurf 安装目录下的任何文件，因此在 Windsurf IDE 升级后依然能够正常运行且无需重新配置。

**运行环境要求：** Windsurf 1.108.x · Windows 11 · Node.js 20+

---

## 🛠️ 工作原理

Windsurf 的后端服务通过两个主要的域名与 Codeium 进行通信：

- `api_server_url` → `server.self-serve.windsurf.com` (处理 Cascade 聊天、遥测、登录认证等)
- `inference_api_server_url` → `inference.codeium.com` (处理单行/多行代码编辑、自动补全等)

本应用在本地启动两个代理端口，默认为 `:7450` (用于拦截聊天) 和 `:7451` (用于原样透传补全)。当您将 Windsurf 的 `http.proxy` 设置为本地代理端口 `:7450` 后，本地代理会智能识别 `GetChatMessage` RPC 请求，将其解析并桥接到您自己配置的 AI 提供商，而将其他通信数据无损直连 Codeium：

```
Windsurf IDE ──(http.proxy = localhost:7450)──> BYOK 混合代理
                                                     ├── GetChatMessage → 转发至您自建的 API 密钥 ✦
                                                     ├── CONNECT 隧道    → 建立盲 TCP 管道 (登录、遥测)
                                                     └── 其他所有请求    → 直连 Codeium 官方服务 (免费账号)
```

本桌面应用主要负责代理服务的生命周期管理、本地配置的持久化存储、实时连接状态与日志的可视化展示，以及一键生成本地 MITM 解密证书。

---

## 🚀 快速上手

1. **配置 AI 供应商**：启动本应用并切换到 **供应商 (Providers)** 标签页，填入您的 Anthropic 或 OpenAI 的 API Host 与 API Key。点击 **测试连接** 按钮以验证配置。

2. **生成 MITM 证书**：切换到 **接入 (Access)** 标签页，点击 **生成 MITM 证书**。这将在本地生成代理拦截 TLS 连接所需的证书，并在系统信任列表生效。

3. **配置 Windsurf IDE**：打开 Windsurf IDE，使用快捷键 `Ctrl+Shift+P` 搜索并打开 `Preferences: Open User Settings (JSON)`，或者直接点击本应用底部的 **复制代理配置** 按钮。将以下配置项加入 Windsurf 的配置文件中：

   ```json
   {
     "http.proxy": "http://localhost:7450",
     "http.proxyStrictSSL": false
   }
   ```

4. **开启代理服务**：点击应用右上角状态栏的开关，启用代理。切换到 **日志 (Logs)** 标签页，此时应看到 `HYBRID PROXY on :7450` 的启动信息。

5. **体验全新 Cascade**：重启 Windsurf IDE，在 Cascade 中发送消息。此时，应用主页的仪表盘将实时更新连接请求次数、Token 消耗量、累计成本估算以及当前活跃的 AI 模型。

---

## 📋 功能模块

| 标签页 | 功能说明 |
| :--- | :--- |
| **仪表盘 Dashboard** | 实时请求总数、Token 流量计数、累计消费成本、错误计数统计（每日重置） |
| **供应商 Providers** | 自定义 API 接入地址和密钥，提供实时的连通性检测 |
| **模型映射 Model Map** | 将 Windsurf 的模型 ID（如 `claude-sonnet-4-6-thinking`）灵活映射为您指定的真实模型，支持单行启用/禁用 |
| **接入 Access** | 本地 MITM 证书一键生成、系统代理配置向导 |
| **日志 Logs** | 实时输出代理服务器的流量细节与连接日志，支持日志级别筛选与一键导出 |
| **设置 Settings** | 配置默认模型、最长 Token 限制、系统提示词覆盖、开机自启，以及**版本自动更新选项** |

- 配置文件保存在：`%APPDATA%\windsurf-byok\byok-config.json` 与 `.env`
- 本地 MITM 证书保存在：`%APPDATA%\windsurf-byok\certs\`

---

## 🏗️ 本地编译与打包

本项目分为 Node.js 代理端（Sidecar 独立执行文件）和 Tauri 桌面端两部分。

### 1. 编译 Node.js 代理端 (Sidecar)
```bash
cd sidecar
npm install
# 将 JS 代理编译为独立的免运行环境的 EXE 文件：
npx pkg proxy-entry.js --targets node22-win-x64 --output windsurf-byok-proxy.exe
# 拷贝到 Tauri 的 sidecar 目录并命名为匹配当前平台的目标名称：
cp windsurf-byok-proxy.exe ../src-tauri/binaries/windsurf-byok-proxy-x86_64-pc-windows-msvc.exe
```

### 2. 运行 Tauri 开发环境
```bash
cd ..
npx tauri dev
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

## 📝 开源协议

[MIT](LICENSE)
