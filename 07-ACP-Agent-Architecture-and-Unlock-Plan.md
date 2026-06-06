# ACP Agent 架构与解锁方案调研

> 调研日期：2026-06-06  
> 目标：分析 Devin Desktop 的 ACP Agent 系统架构，明确 agent 数据来源、运行机制，评估解锁完整 agent 列表的可行方案

---

## 1. ACP 架构总览

### 1.1 什么是 ACP

Agent Client Protocol (ACP) 是一个开源协议，标准化了 IDE 与 AI coding agent 之间的通信。由 Cognition (Devin) 主导，已被 JetBrains、Google、GitHub、Zed 等采用。

- 官网：https://agentclientprotocol.com
- GitHub：https://github.com/agentclientprotocol/agent-client-protocol
- Registry 仓库：https://github.com/agentclientprotocol/registry

### 1.2 Devin Desktop 中的 ACP 架构

```
Devin Desktop (Electron / VS Code fork)
  │
  ├── Devin Local (内置 agent, Rust 重写, 替代 Cascade)
  │     └── 本地进程, 调用 Devin 服务器 API
  │
  ├── Devin Cloud (远程 agent)
  │     └── 通过 ACP proxy 连接 Devin 云端, 需要 Devin 账号
  │
  └── 第三方 ACP Agents (本地进程)
        ├── Claude Agent   → npx @agentclientprotocol/claude-agent-acp → 调用 Anthropic API
        ├── Codex CLI      → binary / npx @zed-industries/codex-acp    → 调用 OpenAI API
        ├── Cline          → npx cline --acp                           → 调用用户配置的 LLM
        ├── Auggie CLI     → npx @augmentcode/auggie --acp             → 调用 Augment API
        ├── Gemini CLI     → npx @google/gemini-cli --acp              → 调用 Google API
        ├── OpenCode       → 本地进程                                   → 调用用户配置的 LLM
        └── 自定义 agent   → 用户自行注册                                → 调用任意 API
```

**核心结论：第三方 ACP agent 完全本地运行，不经过 Devin 服务器中转，API Key 由用户自己提供。**

---

## 2. Agent 数据来源分析

### 2.1 双数据源架构

Devin Desktop 的 agent 列表来自两个 `Registry` 类，在 `extension.js` 中并行加载：

```js
// extension.js 初始化代码
d = new c.AcpRegistry,    // 服务端 registry
h = new c.LocalRegistry,  // 本地 registry
await Promise.all([d.load(), h.load()])
```

#### AcpRegistry（服务端）

```js
// extension.js ~662300
e.AcpRegistry = class extends R {
  async fetch() {
    try {
      const A = B.MetadataProvider.getInstance();
      if (!A.isUserLoggedIn())
        return u.acpOutputChannel.appendLine("Skipping registry fetch: user not logged in yet"),
               { version: "1.0.0", agents: [] };
      const e = C.LanguageServerClient.getInstance();
      await e.waitForReady();
      const t = e.client, i = A.getMetadata();
      const n = await t.getAllAcpRegistries({ metadata: i });
      return JSON.parse(n.registryJson || "{}");
    } catch (A) {
      u.acpOutputChannel.appendLine(`Error fetching registry from server: ${String(A)}`);
    }
    return { version: "1.0.0", agents: [] };
  }
}
```

- 通过 protobuf 调用 `getAllAcpRegistries` 从 Devin 服务器获取
- **未登录时返回空列表**
- 返回的 `registryJson` 是标准 ACP registry 格式

#### LocalRegistry（本地文件）

```js
// extension.js
e.LocalRegistry = class extends R {
  constructor() {
    super();
    this.filePath = a.join((0, Q.getWindsurfConfigDirectory)(), "acp", "registry.json");
  }
  async fetch() {
    try {
      const A = await s.workspace.fs.readFile(s.Uri.file(this.filePath));
      const e = (new TextDecoder).decode(A);
      const t = [];
      const i = (0, r.parse)(e, t, { allowTrailingComma: true, disallowComments: false });
      if (t.length > 0) throw new Error(`Invalid JSONC: ${JSON.stringify(t)}`);
      return i;
    } catch (A) {
      return u.acpOutputChannel.appendLine(`Error loading local registry: ${String(A)}`),
             { version: "1.0.0", agents: [] };
    }
  }
}
```

- 读取本地 `~/.windsurf/acp/registry.json`（Windows: `%APPDATA%\devin\acp\registry.json`）
- 支持 JSONC 格式（允许注释和尾逗号）
- 文件不存在时返回空列表（不报错）

### 2.2 合并与过滤流程

```
AcpRegistry.fetch() ──→ 服务端 agent 列表
                              │
LocalRegistry.fetch() ──→ 本地 agent 列表
                              │
                    ┌─────────┴──────────┐
                    │   parseRegistry()   │
                    │   合并为统一列表     │
                    └─────────┬──────────┘
                              │
                    ┌─────────┴──────────┐
                    │   register() 逐个  │
                    │   注册 agent       │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        isFirstPartyAgent?  custom + flag?   hidden?
        (devin-cloud/       isCustomAcp     cognition.ai/
         devin-cli)         AgentUnleash    hidden=true
              │               │               │
          直接注册        检查 flag       跳过注册
```

### 2.3 load() 核心逻辑

```js
// extension.js - 基类 R 的 load() 方法
async load() {
  try {
    const A = await this.fetch();
    if (this._disposed) return;
    const e = (0, I.parseRegistry)(A);
    if (!e) return void u.acpOutputChannel.appendLine("Failed to parse registry");
    for (const A of e.agents)
      this.register(A, true === A["cognition.ai/hidden"]);
  } catch (A) {
    u.acpOutputChannel.appendLine(`Error loading registry: ${String(A)}`);
  }
}
```

---

## 3. 限制机制分析

### 3.1 限制一：Feature Flag — `acp-custom-enabled`

**位置**：`extension.js` ~652728

```js
function l() {
  const A = B.UnleashProvider.getInstance();
  return (0, C.isWindsurfInsiders)() 
      || (0, C.isWindsurfNext)() 
      || (0, I.hasDevExtension)() 
      || (0, E.isDevelopment)() 
      || A.isEnabled("acp-custom-enabled");
}
```

**影响**：
- 只有 Insiders / Next / Dev 构建或 Unleash flag 开启时，第三方 agent 才会被注册
- 普通稳定版用户即使服务端返回了完整列表，第三方 agent 也会被跳过

**注册时的过滤**（~657383）：

```js
register(A, e) {
  if (!e && "custom" === D(A.id) && !w())
    return void u.acpOutputChannel.info(
      `Skipping custom agent "${A.id}" — acp-custom-enabled is disabled`
    );
  // ... 正常注册
}
```

### 3.2 限制二：Agent Family 分类与启用检查

**位置**：`extension.js` ~656100

```js
function D(A) {
  return "devin-cloud" === A ? "devin-cloud"
       : "devin-cli" === A   ? "devin-terminal"
       : "custom";
}

function p(A) { return "custom" !== D(A); }  // isFirstPartyAgent

function m(A, e) {  // isAgentEnabled
  if ("custom" === D(A) && !w()) return false;
  const t = (0, E.getWindsurfOrDevinConfiguration)("acp.enabledAgents");
  const i = s.workspace.isTrusted ? t.get(A) : t.inspect(A)?.globalValue;
  return "custom" !== D(A) ? void 0 === i || i
       : true === i || void 0 === i && true === e["cognition.ai/bundled"];
}
```

**分类规则**：
| Agent ID | Family | 行为 |
|----------|--------|------|
| `devin-cloud` | `devin-cloud` | 第一方，默认启用 |
| `devin-cli` | `devin-terminal` | 第一方，默认启用 |
| 其他所有 | `custom` | 需 feature flag + 用户手动启用 |

### 3.3 限制三：登录检查

**位置**：`extension.js` ~662355

```js
if (!A.isUserLoggedIn())
  return u.acpOutputChannel.appendLine("Skipping registry fetch: user not logged in yet"),
         { version: "1.0.0", agents: [] };
```

- 未登录时服务端返回空列表
- 但本地 `registry.json` 不受此限制

### 3.4 限制四：Team Config 控制

从 protobuf `TeamConfig` 中提取的相关字段：

```
acpRegistryConfig: string          // ACP registry 配置
devinTerminalAcpEnabled: bool      // Devin Local (Terminal) 开关
devinCloudAcpEnabled: bool         // Devin Cloud 开关
allowMcpServers: bool              // MCP 服务器开关
mcpRegistryUrls: string[]          // MCP registry URL 列表
enforceMcpRegistry: bool           // 是否强制使用 team registry
```

这些由 Team 管理员在 https://windsurf.com/team/settings 配置。

---

## 4. ACP 官方公开 Registry

### 4.1 CDN 地址

```
https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

**任何人都可以直接访问，无需认证。**

### 4.2 已收录的 Agent 列表（截至 2026-06-06）

| Agent ID | 名称 | 版本 | 分发方式 | 许可证 |
|----------|------|------|----------|--------|
| `agoragentic-acp` | Agoragentic | 1.3.0 | npx | MIT |
| `amp-acp` | Amp | 0.8.1 | binary | Apache-2.0 |
| `auggie` | Auggie CLI | 0.29.0 | npx | proprietary |
| `autohand` | Autohand Code | 0.2.1 | npx | Apache-2.0 |
| `claude-acp` | Claude Agent | 0.42.0 | npx | proprietary |
| `cline` | Cline | 3.0.20 | npx | Apache-2.0 |
| `codebuddy-code` | Codebuddy Code | 2.103.1 | npx | Proprietary |
| `codex-acp` | Codex CLI | 0.15.0 | binary + npx | Apache-2.0 |
| `cortex-code` | Cortex Code | 1.0.73 | binary | proprietary |
| `corust-agent` | Corust Agent | 0.6.0 | binary | GPL-3.0 |
| `crow-cli` | crow-cli | 0.1.24 | binary | Apache-2.0 |
| `cursor` | Cursor | 2026.05.28 | binary | proprietary |
| ... | ... | ... | ... | ... |

### 4.3 Registry Schema

参考 `extension.js` 内嵌的 `acp_registry.schema.json`：

```json
{
  "version": "string (semver)",
  "agents": [{
    "id": "string (^[a-z][a-z0-9-]*$)",
    "name": "string",
    "version": "string (semver)",
    "description": "string",
    "repository": "string (URL)",
    "authors": ["string"],
    "license": "string (SPDX)",
    "icon": "string (URL or path)",
    "distribution": {
      "binary": {
        "<os>-<arch>": {
          "archive": "string (URL)",
          "cmd": "string",
          "args": ["string"],
          "env": { "KEY": "VALUE" }
        }
      },
      "npx": {
        "package": "string",
        "args": ["string"],
        "env": { "KEY": "VALUE" }
      },
      "uvx": {
        "package": "string",
        "args": ["string"],
        "env": { "KEY": "VALUE" }
      }
    },
    "cognition.ai/hidden": false,
    "cognition.ai/featured": false,
    "cognition.ai/bundled": false,
    "cognition.ai/promoLabel": "string",
    "cognition.ai/promoTooltip": "string"
  }],
  "extensions": []
}
```

---

## 5. 解锁方案

### 方案 A：Patch extension.js（最直接）

**目标文件**：`E:\Program\devin\resources\app\extensions\windsurf\dist\extension.js`

需要修改 3 处：

#### Patch 1：解锁 custom agent feature flag

```
位置: ~652728
旧: function l(){const A=B.UnleashProvider.getInstance();return(0,C.isWindsurfInsiders)()||(0,C.isWindsurfNext)()||(0,I.hasDevExtension)()||(0,E.isDevelopment)()||A.isEnabled("acp-custom-enabled")}
新: function l(){return!0}
```

#### Patch 2：绕过 register 中的 custom agent 跳过

```
位置: ~657383
旧: if(!e&&"custom"===D(A.id)&&!w())return void u.acpOutputChannel.info(`Skipping custom agent "${A.id}" — acp-custom-enabled is disabled`);
新: if(!1)return void u.acpOutputChannel.info(`Skipping custom agent "${A.id}" — acp-custom-enabled is disabled`);
```

#### Patch 3：绕过 isAgentEnabled 中的 custom 检查

```
位置: ~656119
旧: function m(A,e){if("custom"===D(A)&&!w())return!1;
新: function m(A,e){if(!1)return!1;
```

**优点**：简单直接，3 处替换即可  
**缺点**：每次 Devin 更新后需重新 patch

### 方案 B：本地 registry.json（无需 patch）

**文件路径**：`%APPDATA%\devin\acp\registry.json`

将 ACP CDN 的完整 registry.json 下载到此路径：

```bash
mkdir %APPDATA%\devin\acp
curl -o %APPDATA%\devin\acp\registry.json https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
```

**问题**：单独使用此方案只能补充 agent 元数据，但 feature flag 仍会阻止注册。**需配合方案 A 的 Patch 1。**

### 方案 C：MITM 劫持 getAllAcpRegistries 响应

**原理**：拦截 protobuf 响应，替换 `registryJson` 字段为完整 agent 列表。

**不推荐**：因为 ACP CDN 的 registry 是公开的，没必要劫持。除非需要替换 Devin 服务器返回的**被裁剪过的**列表。

### 推荐方案：A + B 组合

1. **Patch `extension.js`** 解锁 feature flag（3 处替换）
2. **创建本地 `registry.json`** 从 ACP CDN 获取完整 agent 元数据
3. 重启 Devin Desktop

这样即使 Devin 服务端返回空列表（未登录场景），本地 registry 也能提供完整的 agent 列表。

---

## 6. Devin Desktop 中 ACP 相关文件清单

| 路径 | 说明 |
|------|------|
| `resources/app/extensions/windsurf/dist/extension.js` | 主扩展，包含 AcpRegistry / LocalRegistry / 所有过滤逻辑 |
| `resources/app/extensions/windsurf/dist/acp/AGENTS.md` | ACP connector 文档，描述 capabilities 协商 |
| `resources/app/extensions/windsurf/schemas/acp_registry.schema.json` | Registry JSON schema |
| `resources/app/extensions/windsurf/schemas/mcp_config.schema.json` | MCP 配置 schema |
| `resources/app/extensions/windsurf/devin/` | Devin CLI 内嵌二进制 |
| `resources/app/out/vs/workbench/workbench.desktop.main.js` | Workbench 主 JS，包含 ACP UI 组件（Enable ACP 开关、agent 列表渲染） |
| `%APPDATA%/devin/acp/registry.json` | 用户本地 registry（默认不存在） |
| `%APPDATA%/devin/logs/*/exthost/codeium.windsurf/Devin ACP*.log` | ACP 运行日志 |

---

## 7. ACP Custom Agent 注册流程（官方文档）

### 7.1 用户自定义 agent

1. 创建 `~/.windsurf/acp/registry.json`
2. 添加 agent 条目，指定 `distribution`（binary / npx / uvx）
3. 在 Devin Desktop 中打开 Settings → Agents → 启用
4. 或通过 Command Palette: `Open Local ACP Registry Config`

### 7.2 Team 管理员配置

1. 在 https://windsurf.com/team/settings 配置 team registry
2. 所有团队成员自动获得 approved agent 列表
3. `enforceMcpRegistry` 可强制只使用 team approved 的 agent

### 7.3 Devin Desktop 不自动下载 agent

官方文档明确说明：

> *"For security reasons, Devin Desktop does not currently download agent distributions directly from the registry. The agent binary is expected to already be present on the user's machine."*

即：`distribution.binary.archive` URL 仅作为元数据记录，Devin 不会自动下载。用户需要自行安装 agent（通过 npx 自动拉取或手动下载 binary）。

---

## 8. 对 IDE-BYOK 项目的启示

### 8.1 ACP 是开放协议

ACP registry 是公开 CDN，任何人可获取完整 agent 列表。第三方 agent 完全本地运行，不依赖 Devin 服务器。这意味着：

- **IDE-BYOK 可以直接使用 ACP CDN 的 registry 数据**
- 不需要逆向 Devin 的 protobuf 接口来获取 agent 列表
- 只需实现 ACP client 协议即可支持所有第三方 agent

### 8.2 最小实现路径

1. 从 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` 获取 agent 元数据
2. 实现本地 `registry.json` 读取逻辑（已有 schema 参考）
3. 实现 ACP client：启动 agent 子进程（npx / binary），通过 stdin/stdout JSON-RPC 通信
4. 不需要 feature flag 限制（IDE-BYOK 不是 Devin，没有商业限制）

### 8.3 Devin Cloud 的特殊性

Devin Cloud 是唯一需要 Devin 服务器认证的 agent。它通过 ACP proxy 连接远程 Devin 实例。如果 IDE-BYOK 要支持 Devin Cloud，需要：

- 有效的 Devin 账号 token
- 实现 `cognition.ai/` 前缀的 custom capabilities（见 AGENTS.md）
- 处理 `lazyEditorFiles`、`toolCallQuestions` 等扩展协议

---

## 附录：ACP 官方资源

- 协议规范：https://agentclientprotocol.com/protocol/v1/overview
- Registry 规范：https://agentclientprotocol.com/rfds/acp-agent-registry
- Registry CDN：https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- Registry GitHub：https://github.com/agentclientprotocol/registry
- Devin ACP 文档：https://docs.devin.ai/desktop/acp
- 自定义 Agent 文档：https://docs.devin.ai/desktop/acp-custom
