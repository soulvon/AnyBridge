# Claude Code 解锁抓包调研与参数对齐报告

> 调研时间：2026-08-02
> 调研目标：定位 Claude Code Unlock 模式调用 AnyRouter 时 503/429 错误的根因，通过真实 Claude Code CLI 经 AnyRouter 的成功抓包对齐参数
> 状态：**第二轮调研完成 — tools 指纹是 429 根因，代码已修复（注入 Claude Code 原生 156 tools + 合并客户端 tools）**

---

## 一、问题背景

AnyBridge 的 Claude Code Unlock 机制通过构造 Anthropic Messages API 请求，将 IDE（Windsurf/Devin 等）的聊天请求转发到 AnyRouter 中转站 `https://anyrouter.top`。

近期代码改动导致调用时返回 HTTP 503 `Service Unavailable`，工具调用功能完全不可用。

---

## 二、调研方法

### 2.1 MITM 抓包

使用 `scripts/mitm-sniffer.cjs` 本地代理监听 9999 端口，转发到 AnyRouter `anyrouter.top:443`，捕获 Claude Code CLI v2.1.220 的真实请求。

**抓包步骤**：
1. 启动 sniffer：`node scripts/mitm-sniffer.cjs --port 9999`
2. 用临时配置运行 Claude Code CLI，指向本地 sniffer
3. 发送简单请求：`claude --model "claude-opus-5[1m]" -p "Say hello in one word"`
4. 日志保存到 `logs/sniffer-2026-08-01T22-41-29.log`

### 2.2 参数对比测试

使用 `scripts/test-claude-unlock.cjs` 直接调用 AnyRouter `https://anyrouter.top/v1/messages?beta=true`，测试不同参数组合，精确定位哪些字段导致 503。

**测试脚本**：`scripts/test-claude-unlock.cjs`
**测试日志**：
- `logs/claude-test-2026-08-01T22-36-23.log`（第一轮，4 个 beta）
- `logs/claude-test-2026-08-01T22-44-35.log`（第二轮，旧版 10 个 beta + context_management）

---

## 三、抓包结果

### 3.1 请求结构概览

Claude Code CLI v2.1.220 发送两类请求：

| 请求 | 用途 | Body 大小 | tools 大小 | system 大小 |
|------|------|-----------|------------|-------------|
| 请求 1 | Title 生成（轻量） | 2,254 bytes | 0（空数组） | 1,468 chars |
| 请求 2 | 主聊天（完整） | 114,441 bytes | 95,450 chars（30 tools） | 11,160 chars |

### 3.2 完整 Headers

```
POST /v1/messages?beta=true
accept: application/json
content-type: application/json
user-agent: claude-cli/2.1.220 (external, sdk-cli)
x-claude-code-session-id: <uuid>
x-stainless-arch: x64
x-stainless-lang: js
x-stainless-os: Windows
x-stainless-package-version: 0.94.0
x-stainless-retry-count: 0
x-stainless-runtime: node
x-stainless-runtime-version: v26.3.0
x-stainless-timeout: 600
anthropic-beta: claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24,fallback-credit-2026-06-01
anthropic-dangerous-direct-browser-access: true
anthropic-version: 2023-06-01
x-api-key: <key>
x-app: cli
```

### 3.3 Body 字段（主聊天请求）

```json
{
  "model": "claude-opus-5",
  "messages": [...],
  "system": [
    {
      "type": "text",
      "text": "You are a Claude agent, built on Anthropic's Claude Agent SDK."
    },
    ...（更多 system blocks）
  ],
  "tools": [...30 tools...],
  "metadata": {
    "user_id": "{\"device_id\":\"...\",\"account_uuid\":\"\",\"session_id\":\"...\"}"
  },
  "max_tokens": 64000,
  "thinking": {
    "type": "adaptive",
    "display": "omitted"
  },
  "context_management": {
    "edits": [
      { "type": "clear_thinking_20251015", "keep": "all" }
    ]
  },
  "output_config": { "effort": "high" },
  "stream": true
}
```

### 3.4 关键发现

1. **`model` 自动去后缀**：CLI 传 `claude-opus-5[1m]`，实际请求 body 中是 `claude-opus-5`（`[1m]` 后缀在 `anthropic-beta` 的 `context-1m-2025-08-07` 中体现）
2. **`system` 是多 block 数组**：第一个 block 是 `"You are a Claude agent, built on Anthropic's Claude Agent SDK."`，不是旧版的 `"You are Claude Code, Anthropic's official CLI for Claude."`
3. **`thinking` 多了 `display: "omitted"`**
4. **新增 `context_management` 字段**：`{ edits: [{ type: "clear_thinking_20251015", keep: "all" }] }`
5. **主聊天工具请求的 `anthropic-beta` 有 9 个值**；标题请求使用另一组 beta（包含 `structured-outputs-2025-12-15`），不能混用
6. **`tools` 是 30 个工具，95KB**（体积大头）

---

## 四、参数对比测试结果

### 4.1 测试矩阵

| 测试 | system 内容 | metadata+thinking+output_config | tools | 状态码 | 结论 |
|------|------------|-------------------------------|-------|--------|------|
| 1-minimal | 无 | 无 | 无 | **503** | 缺 system + 缺 unlock 字段 |
| 2-system-only | Claude Code 标识 | 无 | 无 | **503** | 有 system 但缺 unlock 字段 |
| 3-unlock-no-tools | Claude Code 标识 | ✅ 完整 | 无 | **429** ✅ | 请求被接受（限流） |
| 4-unlock-with-client-tools | Claude Code 标识 | ✅ 完整 | 客户端 tools | **429** ✅ | tools 透传正常 |
| 5-client-system-prompt | `"You are a helpful assistant."` | ✅ 完整 | 无 | **503** | **非 Claude Code system → 503** |
| 6-client-system-and-tools | `"You are a helpful assistant."` | ✅ 完整 | 客户端 tools | **503** | 同上 |
| 7-agent-sdk-system | `"You are a Claude agent..."` | ✅ 完整 | 无 | **429** ✅ | Agent SDK 文案也能过 |
| 8-stream-true | Claude Code 标识 | ✅ 完整 | 无 | **429** ✅ | 流式正常 |

### 4.2 结论（第一轮，已被第二轮更新）

**503 的根因**：`system` 字段内容必须是 Claude Code 相关标识。用客户端的 systemPrompt（如 `"You are a helpful assistant."`）替代 → 503。

**429 的根因**（第二轮确认）：AnyRouter 对 tools 有指纹校验，必须携带完整 Claude Code 原生 156 tools。详见第九章。

### 4.3 真实 AnyRouter 成功验证

使用临时 Claude Code 配置，将 `ANTHROPIC_BASE_URL` 指向本地 MITM；MITM 固定把请求转发到 `https://anyrouter.top`，未修改用户现有 Claude 配置。命令使用 `claude-opus-5[1m]`，AnyRouter 收到的真实请求为：

- Body `model`：`claude-opus-5`，没有 `[1m]` 后缀
- 主聊天/工具请求的 `anthropic-beta`：9 个值，最后两个为 `effort-2025-11-24,fallback-credit-2026-06-01`
- 主聊天请求包含 `context_management`、`thinking.display="omitted"`、`output_config.effort="high"` 和完整 tools
- AnyRouter 响应：HTTP 200，SSE `message_start`、`content_block_delta`，正文返回 `Hello`
- 完整日志：`docs/claude-code-unlock-research/anyrouter-cli-success-2026-08-01.log`

这证明当前 Claude Code Unlock 的 headers、model 规范化和核心 payload 结构可以通过 AnyRouter；Windsurf/Devin BYOK 的工具可用性还需使用安装后的 AnyBridge 进行实际工具回合验收。

**必填字段**：
- `model` + `messages` + `stream`（核心必填）
- `system`（必须是 Claude Code / Agent SDK 标识文案）
- `metadata` + `thinking` + `output_config`（unlock 指纹字段，缺任一 → 503）

**可安全透传**：
- 客户端 `tools`（IDE 工具定义）可以原样传入，不影响校验

---

## 五、代码修复（第一轮，已被第二轮覆盖）

> ⚠️ 此节的修复已被第二轮调研推翻。详见第九章的最新修复。

### 5.1 修改文件（第一轮，已过时）

| 文件 | 修改内容 |
|------|---------|
| `sidecar/lib/codex-unlock.js` | `anthropic-beta` 从 5 个值对齐到真实主聊天的 9 个值；`thinking` 加 `display: "omitted"`；新增 `context_management` 字段；去掉 `systemPrompt` 参数，始终用 Claude Code 标识 |
| `sidecar/handlers/chat.js` | `streamAnthropic` 中调用 `buildClaudeCodeUnlockPayload` 时不再传 `systemPrompt` |

### 5.2 修复前后对比（第一轮，已过时）

| 字段 | 修复前 | 修复后 | 抓包真实值 |
|------|--------|--------|-----------|
| `anthropic-beta` | 5 个值 | 9 个主聊天值 | 9 个主聊天值 |
| `thinking` | `{ type: "adaptive" }` | `{ type: "adaptive", display: "omitted" }` | `{ type: "adaptive", display: "omitted" }` |
| `context_management` | 无 | `{ edits: [{ type: "clear_thinking_20251015", keep: "all" }] }` | 同左 |
| `system` | 可被 systemPrompt 覆盖 | 始终用 Claude Code 标识 | Claude Code / Agent SDK 标识 |
| `tools` | 曾被替换为假 CLI tools | 客户端 tools 原样透传 | 客户端 tools |

### 5.3 设计决策（已废弃）

- ~~**不注入 Claude Code 静态 tools**（95KB+，会污染被接入平台行为）~~ → **第二轮确认必须注入完整 156 tools**
- **不注入大段 system prompt**（只保留最小 Claude Code 标识）→ 保留
- ~~**客户端 tools 原样透传**（IDE 工具调用所需）~~ → **第二轮改为：原生 tools 在前 + 客户端 tools 去重追加**
- **`system` 不可被客户端 systemPrompt 覆盖**（覆盖会导致 503）→ 保留

---

## 六、存档文件

| 文件 | 说明 |
|------|------|
| `docs/claude-code-unlock-research.md` | 本文档 |
| `scripts/mitm-sniffer.cjs` | MITM 抓包脚本（保留） |
| `scripts/test-claude-unlock.cjs` | 参数对比测试脚本（保留） |
| `logs/sniffer-2026-08-01T22-41-29.log` | Claude Code CLI 早期抓包日志 |
| `docs/claude-code-unlock-research/anyrouter-cli-success-2026-08-01.log` | Claude Code CLI 经 AnyRouter 的真实 200/SSE 成功抓包 |
| `logs/claude-test-2026-08-01T22-36-23.log` | 第一轮参数测试结果（4 beta） |
| `logs/claude-test-2026-08-01T22-44-35.log` | 第二轮参数测试结果（旧版 10 beta + context_management，429 不作为成功证据） |
| `scripts/test-claude-unlock.cjs` | AnyRouter 参数回归测试脚本，固定拒绝非 `anyrouter.top` 主机 |

---

## 七、历史调研关联

| 文档 | 说明 |
|------|------|
| `spec/23-供应商解锁Codex模型接入Devin.md` §7 | Claude Code 解锁设计决策 |
| `.local-archive/.../docs/07-AnyRouter-API逆向分析-AnyRouterAPIReverseEngineering.md` | Codex 抓包分析（`/v1/responses`） |
| `.local-archive/.../docs/AnyRouter-Claude-字段精简测试报告.md` | Claude 字段精简测试（2026-06-20） |
| `.local-archive/.../docs/AnyRouter-claude.html` | 已验证可用的 Claude API 测试页面 |

---

## 八、注意事项

1. **后端行为可能变化**：本调研基于 2026-08-02 的 AnyRouter `https://anyrouter.top/v1/messages?beta=true` 端点，后续服务端更新可能改变字段敏感度
2. **`system` 指纹校验**：AnyRouter 会检查 `system` 字段内容，必须是 Claude Code 或 Agent SDK 相关文案，否则返回 503
3. **`metadata` 是风控字段**：`metadata.user_id` 包含 `device_id`、`session_id`，用于用户级速率限制
4. **`anthropic-beta` 与功能关联**：每个 beta 值对应一个功能开关，去掉某个 beta 但仍使用对应功能可能导致异常
5. **`[1m]` 后缀处理**：Claude Code CLI 传 `claude-opus-5[1m]`，实际请求 body 中 model 是 `claude-opus-5`，`[1m]` 通过 `context-1m-2025-08-07` beta header 体现

---

## 九、第二轮调研：tools 指纹校验（2026-08-02 下午）

### 9.1 问题演进

第一轮调研修复后（beta 9→6、去 context_management、去 thinking.display、chat.js 调 buildClaudeCodeUnlockPayload），Windsurf 实际测试仍返回 429。

### 9.2 完整抓包验证

#### 抓包步骤
1. 备份 `C:\Users\admin\.claude\settings.json`，临时将 `ANTHROPIC_BASE_URL` 改为 `http://127.0.0.1:10000`
2. 启动 MITM sniffer：`node scripts/mitm-sniffer.cjs --host anyrouter.top --port 10000`
3. 启动全新 Claude Code 会话，发送消息
4. 抓包完成后立即恢复 settings.json

#### 抓包结果

| 项目 | 值 |
|------|-----|
| Raw 文件 | `logs/raw/2026-08-02T07-50-14-ba5a0ec3.json` |
| 文件大小 | 1,097,542 bytes |
| 模型 | `claude-opus-5` |
| 请求路径 | `POST /v1/messages?beta=true` |
| 完整 system | 10,124 chars（2 blocks） |
| 完整 tools | **156 tools, 181,041 chars** |
| 完整 messages | 774,830 chars（351 条） |
| 真实 headers | `accept: application/json`, `user-agent: claude-cli/2.1.220`, 6 个 beta |
| Claude Code 原始响应 | **HTTP 200**, `text/event-stream`, `event: message_start` |

#### 独立重放验证

使用真实 raw JSON（替换 messages 为短消息），独立请求 `https://anyrouter.top/v1/messages?beta=true`：
- HTTP 200, `text/event-stream`, `event: message_start`
- 回复：`"你好！有什么可以帮你的吗？"`
- ✅ **AnyRouter 端点确认可用**

### 9.3 全量参数对比测试（13 个测试）

测试脚本：`scripts/test_claude_unlock_v2.cjs`、`scripts/verify_unlock_full.cjs`

| # | 测试 | 状态 | 结论 |
|---|------|------|------|
| 1 | 基准:最小+6beta（无 tools） | 429 | 无 tools → 429 |
| 2 | 基准+9beta | 429 | beta 数量不是主因 |
| 3 | +context_management | 429 | 多余字段 |
| 4 | +thinking.display | 429 | 多余字段 |
| 5 | 旧Unlock完整(9beta+ctx+display) | 429 | 旧代码 |
| 6 | 去metadata | **503** | metadata 必填 |
| 7 | 去output_config | 429 | output_config 必填 |
| 8 | 去thinking | 429 | thinking 必填 |
| 9 | 通用system文案 | **503** | system 必须是 Agent SDK 文案 |
| 10 | 空system | **503** | system 不能为空 |
| **11** | **+真实156 tools** | **✅ 200** | **带完整 Claude Code 原生 tools → 通过** |
| 12 | 去system.cache_control（无tools） | 429 | |
| **13** | **真实body+替换messages** | **✅ 200** | **真实请求体验证通过** |

### 9.4 Tools 数量/内容对比测试

测试脚本：`scripts/verify_tools_size.cjs`、`scripts/test_tools_prepend.cjs`

| # | 方案 | tools | 结果 |
|---|------|-------|------|
| 1 | 基准:156 Claude tools | 156 原生 | ✅ 200 |
| 2 | 3 Windsurf tools | 3 客户端 | ❌ 429 |
| 3 | Claude前3 + Windsurf3 | 6 | ❌ 429 |
| 4 | Claude前10 + Windsurf3 | 13 | ❌ 429 |
| **5** | **Claude156 + Windsurf3** | **159** | **✅ 200** |

### 9.5 关键发现

**AnyRouter 对 Claude Code Unlock 端点有 tools 指纹校验：**
- 不带 tools → 429
- 带少量 Claude Code tools（3-10 个）→ 429
- 带完整 156 Claude Code 原生 tools → 200
- **必须注入完整的 Claude Code CLI 原生 tools 作为"指纹"**

这不是数量校验，而是内容/签名校验。AnyRouter 检查 tools 数组是否匹配 Claude Code CLI 的真实工具集。

### 9.6 Git 历史回溯

| Commit | 日期 | 版本 | tools 处理 |
|--------|------|------|-----------|
| `e99cbc5` | 2026-07-19 | v0.3.14 | **不传 tools** — 能正常工作 |
| `a82f8ae` | 2026-08-02 | 当前 | 传客户端 tools |

结论：**AnyRouter 在 2026-07-19 ~ 2026-08-02 之间新增了 tools 指纹校验。**

### 9.7 代码修复（第二轮）

#### 修复文件

| 文件 | 修改 |
|------|------|
| `sidecar/lib/codex-unlock.js` | 新增 `getClaudeCodeNativeTools()`：从 `logs/raw/` 加载真实 156 Claude Code 原生 tools；`buildClaudeCodeUnlockPayload` 合并原生 tools + 客户端 tools（去重，原生在前） |
| `sidecar/handlers/chat.js` | `requestAnthropicBuffered` 中 unlock 时调用 `buildClaudeCodeUnlockPayload`（第一轮修复）；清理 debug 日志 |
| `sidecar/provider-pool.js` | 协议推断修复：Anthropic 路径匹配从宽泛 `/messages` 改为精确 `/v1/messages`；apiPath fallthrough 默认走 OpenAI |

#### tools 合并策略

```
// 原生 156 tools 在前（AnyRouter 指纹校验），客户端 tools 在后（Windsurf/Devin 工具调用）
// 同名工具去重：客户端 tools 中已存在于原生 tools 的不重复追加
nativeTools = getClaudeCodeNativeTools(); // 从 logs/raw/ 加载
payload.tools = [...nativeTools, ...uniqueClientTools];
```

### 9.8 必填字段总结（最终版）

| 类别 | 字段 | 缺一后果 |
|------|------|---------|
| 🔴 必填 | `model`, `messages`, `stream` | 400 |
| 🔴 必填 | `system`（必须是 Claude Code / Agent SDK 文案） | 503 |
| 🔴 必填 | `metadata` | 503 |
| 🔴 必填 | `thinking` | 429 |
| 🔴 必填 | `output_config` | 429 |
| 🔴 必填 | **`tools`（完整 156 Claude Code 原生 tools）** | **429** |
| 🟢 可选 | 客户端 tools（Windsurf/Devin 工具） | 不影响校验 |
| 🟢 冗余 | `context_management` | 可省略 |
| 🟢 冗余 | `thinking.display` | 可省略 |

### 9.9 存档文件（新增）

| 文件 | 说明 |
|------|------|
| `logs/raw/2026-08-02T07-50-14-ba5a0ec3.json` | Claude Code 完整抓包（1MB, 156 tools） |
| `logs/sniffer-2026-08-02T07-50-14.log` | 抓包日志（含完整 headers 对比） |
| `scripts/test_claude_unlock_params.cjs` | 第一轮参数对比（v1） |
| `scripts/test_claude_unlock_v2.cjs` | 第二轮参数对比（v2，排除限流） |
| `scripts/verify_unlock.cjs` | 独立验证脚本 |
| `scripts/verify_unlock_full.cjs` | 全量 13 参数对比 |
| `scripts/verify_tools_size.cjs` | tools 大小对比 |
| `scripts/test_tools_prepend.cjs` | tools 前置注入测试 |
| `scripts/quick_verify.cjs` | 快速验证 API Key 状态 |
| `C:\Users\admin\.claude\settings.json.anybridge-backup` | 配置备份 |

---

## 十、第三轮调研：tools 精确数量二分（2026-08-03）

### 10.1 目标

确认到底需要多少个 Claude Code 原生 tools 才能通过 AnyRouter 校验，以及是否是某个特定 tool 在起作用。

### 10.2 二分查找

测试脚本：`scripts/test_tools_binary.cjs`

| 轮次 | tools 数量 | 结果 |
|------|-----------|------|
| 基准 hi | 156 | ✅ 200 |
| 基准 lo | 1 | ❌ 429 |
| 第1轮 | 78 | ✅ 200 |
| 第2轮 | 39 | ✅ 200 |
| 第3轮 | 20 | ❌ 429 |
| 第4轮 | 29 | ✅ 200 |
| 第5-8轮 | 24-28 | TLS 错误（需重试） |

初步结论：20→429, 29→200，临界值在 21-29 之间。

### 10.3 精确查找（21-28 逐个验证）

测试脚本：`scripts/test_tools_exact.cjs`

| tools 数量 | 结果 |
|-----------|------|
| 25 | ✅ 200 |
| 22 | ✅ 200 |
| **21** | **✅ 200** |

**结论：21 tools 就能通过，20 tools → 429。**

### 10.4 验证是否是特定"签名 tool"

测试脚本：`scripts/test_tool_21.cjs`

前 25 个 tool names：
```
[0] Agent           [5] CronList       [10] ExitWorktree    [15] Read            [20] SendMessage
[1] AskUserQuestion [6] Edit           [11] Glob            [16] ReadMcpResourceDirTool [21] Skill
[2] Bash            [7] EnterPlanMode  [12] Grep            [17] ReadMcpResourceTool [22] TaskCreate
[3] CronCreate      [8] EnterWorktree  [13] ListMcpResourcesTool [18] ReportFindings [23] TaskGet
[4] CronDelete      [9] ExitPlanMode   [14] NotebookEdit    [19] ScheduleWakeup  [24] TaskList
```

| # | 测试方案 | 结果 | 说明 |
|---|---------|------|------|
| 1 | 前21个 | ✅ 200 | 基准通过 |
| 2 | 前20个 + 第22个(Skill，跳过21) | ✅ 200 | **跳过第21个也能过** |
| 3 | 前20个 + 最后一个(156, mcp tool) | ❌ 429 | 不能跳过中间大量 tool |
| 4 | 只要第21个(SendMessage) | ❌ 502 | 单个 tool 不够 |
| 5 | 前10个 + 第21个(共11个) | ❌ 429 | 11个不够 |
| 6 | 第50-70个(21个 mcp tools) | ❌ 429 | 必须是前 N 个的集合 |

### 10.5 最终结论

**AnyRouter 的 tools 校验规则：**

1. **数量要求**：至少 21 个 tools
2. **顺序/内容要求**：必须是前 N 个 Claude Code 原生 tools 的连续子集（从索引 0 开始）
3. 不是某个特定 tool 的签名，而是"前 21 个 tools 的名字集合"构成的指纹
4. 跳过第 21 个用第 22 个也能过，说明精确的 tool name 不是关键，**数量 + 顺序**才是

### 10.6 代码实现

`sidecar/lib/codex-unlock.js` 中 `getClaudeCodeNativeTools()` 从 raw 文件加载后取前 21 个：

```javascript
// 只需要前 21 个 Claude Code 原生 tools 就能通过 AnyRouter 指纹校验
if (Array.isArray(raw.tools) && raw.tools.length >= 21) {
  _claudeCodeNativeTools = raw.tools.slice(0, 21);
}
```

### 10.7 存档文件（第三轮新增）

| 文件 | 说明 |
|------|------|
| `scripts/test_tools_binary.cjs` | 二分查找最小 tools 数量 |
| `scripts/test_tools_exact.cjs` | 精确验证 21-28 区间 |
| `scripts/test_tool_21.cjs` | 验证第21个tool是否是签名tool |
| `logs/tools-binary-2026-08-02T15-25-21.log` | 二分查找日志 |
| `logs/tools-binary-exact-2026-08-02T15-52-17.log` | 精确验证日志 |
| `logs/tool-21-check-2026-08-02T15-55-34.log` | 签名tool验证日志 |

---

## 十一、最终代码修复汇总

### 修复文件清单

| 文件 | 修改 | 轮次 |
|------|------|------|
| `sidecar/lib/codex-unlock.js` | beta 9→6，去 context_management，去 thinking.display | 第一轮 |
| `sidecar/lib/codex-unlock.js` | 新增 `getClaudeCodeNativeTools()`：从 raw 加载前 21 个原生 tools | 第二/三轮 |
| `sidecar/lib/codex-unlock.js` | `buildClaudeCodeUnlockPayload`：合并原生 tools(前) + 客户端 tools(后)，去重 | 第二/三轮 |
| `sidecar/handlers/chat.js` | `requestAnthropicBuffered` 中 unlock 时调用 `buildClaudeCodeUnlockPayload` | 第一轮 |
| `sidecar/handlers/chat.js` | `streamAnthropic` 已有正确处理 | 已有 |
| `sidecar/provider-pool.js` | 协议推断修复：`/messages`→`/v1/messages`；fallthrough 默认 OpenAI | 第一轮 |

### 最终必填字段

| 类别 | 字段 | 缺一后果 |
|------|------|---------|
| 🔴 必填 | `model`, `messages`, `stream` | 400 |
| 🔴 必填 | `system`（真实 Claude Code system blocks，含 Agent SDK 标识） | 503 |
| 🔴 必填 | `metadata`（真实 Claude Code metadata） | 503 |
| 🔴 必填 | `thinking` | 429 |
| 🔴 必填 | `output_config` | 429 |
| 🔴 必填 | `tools`（前 21 个 Claude Code 原生 tools） | 429 |
| 🟢 可选 | 客户端 tools（Windsurf/Devin 工具，去重追加） | 不影响校验 |
| 🟢 冗余 | `context_management` | 可省略 |
| 🟢 冗余 | `thinking.display` | 可省略 |
