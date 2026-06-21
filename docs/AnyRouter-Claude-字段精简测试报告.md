# AnyRouter Claude API 字段精简测试报告

> 测试时间：2026-06-20
> 测试端点：`anyrouter.top/v1/messages?beta=true`
> 测试模型：`claude-opus-4-8`
> 参考客户端：AnyRouter-claude.html（已验证可用）+ 抓包日志

---

## 0. 2026-06-20 实现修正

后续重新对比 `docs/AnyRouter-claude.html` 与成功抓包日志 `logs/sniffer-2026-06-19T18-08-49.log` 后，确认本文早期结论有两处需要修正：

- `AnyRouter-claude.html` 是已验证可用的小模板，但它省略了真实 Claude Code 抓包里的大字段，尤其是 `tools`。成功抓包 Body 约 106KB-155KB，其中 `tools` 单独约 90KB-135KB。
- 成功抓包里的 `output_config.effort` 是 `"high"`，不是 `"xhigh"`。`xhigh` 来自 HTML 验证模板，不能代表真实 Claude Code 客户端唯一取值。

当前 AnyBridge Claude Code 解锁采用中等小模板：保留 `metadata`、`max_tokens`、`thinking`、`output_config`、`stream`、一个最小 Claude Code `system` 标识字段与 Claude Code 小型 headers；不注入 Claude Code 静态 `tools`，避免污染被接入平台自身行为并控制请求体体积。

2026-06-20 复测确认：当前 AnyRouter 对 Claude Code 请求缺少 `system` 字段时返回 HTTP 503；加入最小 `system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }]` 后，同一请求变为 HTTP 429 `Service Unavailable`，符合该端点当前限流/不可用时的正常错误形态。因此最小 `system` 字段是当前解锁请求的必要指纹字段。

---

## 1. 模板概况

`AnyRouter-claude.html` 验证模板共 **8 个 Body 字段** + **7 个 Header**；成功抓包中的真实 Claude Code 请求在此基础上还包含 `tools` 与更多 SDK headers。

### Body 字段

```
model, max_tokens, stream, thinking, output_config, metadata, system, messages
```

| 字段 | 值 | 说明 |
|------|----|------|
| `model` | `claude-opus-4-8` | 模型标识 |
| `max_tokens` | `64000` | 最大输出 token |
| `stream` | `true` | 流式响应 |
| `thinking` | `{ type: "adaptive" }` | 思维链模式 |
| `output_config` | `{ effort: "high" }` | 成功抓包值；HTML 验证模板使用过 `xhigh` |
| `metadata` | `{ user_id: "..." }` | 用户/设备/会话标识 |
| `system` | `[{ type: "text", text: "...", cache_control: {...} }]` | 系统提示词 |
| `messages` | `[{ role: "user", content: [...] }]` | 对话消息 |

### Header 字段

```
Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-app, anthropic-dangerous-direct-browser-access
```

### anthropic-beta 值

```
claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24
```

> 抓包日志中真实客户端还多了 `mid-conversation-system-2026-04-07`，但测试中使用 4 个 beta 也可正常工作。

---

## 2. 测试方法

```
1. 单字段删除 → 逐个删除每个 Body 字段，观察是否 200
2. 单 Header 删除 → 逐个删除可选 Header，观察是否 200
3. anthropic-beta 精简 → 分别测试仅保留单个 beta 值
4. 组合删除 → 逐步收敛，逼近最小集
```

每个测试间隔 3 秒，使用独立 `device_id` + `session_id` 避免缓存交叉污染。

---

## 3. 最终结论

### 🔴 必填字段（不能删）

| 字段 | 说明 |
|:-----|------|
| `model` | 核心必填 |
| `messages` | 核心必填 |
| `stream` | 核心必填（非流式在 Claude Messages API 中行为不同） |

### 🟡 建议保留（可删但影响质量/风控）

| 字段 | 可删？ | 风险说明 |
|------|--------|----------|
| `thinking` | ✅ 可删 | 去掉后无思维链，回复质量下降 |
| `output_config` | ✅ 可删 | 去掉后默认 effort 不一定等同成功抓包配置，质量可能下降 |
| `max_tokens` | ✅ 可删 | 无显式 token 上限，可能被默认截断 |
| `metadata` | ✅ 可删 | 真实客户端必带，删了可能触发频率限制 |
| `system` | ❌ 当前不可删 | 当前复测中删掉会从 HTTP 429 变为 HTTP 503；保留最小 Claude Code 标识 |

### 🟢 可安全删除（Header）

| Header | 测试结果 | 说明 |
|--------|----------|------|
| `x-app` | ✅ 200 | 客户端标识，API 不校验 |
| `anthropic-dangerous-direct-browser-access` | ✅ 200 | 浏览器直连才需要，后端不走浏览器 |

### ⚠️ anthropic-beta 精简

| 精简方案 | 测试结果 | 说明 |
|----------|----------|------|
| 仅 `claude-code-20250219` | ✅ 200 | 标识 Claude Code |
| 仅 `context-1m-2025-08-07` | ✅ 200 | 1M 上下文窗口 |
| 仅 `effort-2025-11-24` | ✅ 200 | output_config.effort 支持 |
| 全 4 个（原始） | ✅ 200 | 最安全 |

---

## 4. 推荐方案

### 🟢 安全精简版（推荐）

```
删除: x-app, anthropic-dangerous-direct-browser-access
保留: 所有 Body 字段 + 其余 Header
省: ~50B
风险: 无
```

**实现修正**：AnyBridge 解锁到其他平台时保留最小 Claude Code `system` 标识字段，但不注入 Claude Code 静态 `tools`；`tools` 是真实抓包的体积大头，也最容易污染被接入平台自身行为。保留 `thinking`, `output_config`, `metadata`, `max_tokens`, `stream` 与小型 headers。

### 🟡 技术精简版（可做但不必）

在安全版基础上再删 `thinking` + `output_config` + `max_tokens`：

```
删除: x-app, dangerous-direct-browser-access, thinking, output_config, max_tokens
保留: model, messages, stream, metadata, system + 认证/版本 Header
省: ~150B
风险: 低（功能正常，但行为特征不完全匹配真实客户端）
```

### 🔴 极致精简版（不推荐）

```
仅保留: model, messages, stream
省: ~500B
风险: 高（明显不像正常客户端，metadata/system 全丢）
```

---

## 5. 与 GPT-5.5 的对比

| 维度 | GPT-5.5 (Codex) | Claude (Messages) |
|------|-----------------|-------------------|
| 原始字段数 | 13 个 Body | 8 个 Body + 7 个 Header |
| 最大可省 | 99.6%（65KB→241B） | ~90%（~2KB→~200B） |
| 精简空间 | 极大（instructions+tools 占 98%） | 极小（字段本身都很小） |
| 检测风险 | 低（后端不校验 instructions/tools） | 中等（metadata 是用户标识） |
| 建议 | 大胆删 | 保守保留 |

**核心差异**：GPT-5.5 的 `instructions`（21.6KB）和 `tools`（43.3KB）是巨大的纯文本 payload，删掉后明显减轻负担。Claude 的每个字段都很小（几十到几百字节），精简收益微乎其微，但删掉 `metadata` 等字段会暴露非标准客户端特征。

---

## 6. 详细测试日志

### 对照组

| 测试 | Status | Response | Size |
|------|--------|----------|------|
| 完整模板(对照组) | ✅ 200 | "你好" | ~2KB |

### 单字段删除（Body）

| 测试 | Status | 说明 |
|------|--------|------|
| 去掉 `max_tokens` | ✅ 200 | |
| 去掉 `thinking` | ✅ 200 | |
| 去掉 `output_config` | ✅ 200 | |
| 去掉 `metadata` | ✅ 200 | |
| 去掉 `system` | ✅ 200 | |

### 单 Header 删除

| 测试 | Status | 说明 |
|------|--------|------|
| 去掉 `anthropic-beta` | ✅ 200 | |
| 去掉 `x-app` | ✅ 200 | |
| 去掉 `anthropic-dangerous-direct-browser-access` | ✅ 200 | |

### anthropic-beta 精简

| 测试 | Status | 说明 |
|------|--------|------|
| 仅 `claude-code-20250219` | ✅ 200 | |
| 仅 `context-1m-2025-08-07` | ✅ 200 | |
| 仅 `effort-2025-11-24` | ✅ 200 | |

### 组合删除

| 测试 | Status | 说明 |
|------|--------|------|
| 去掉 thinking+output_config | ✅ 200 | |
| 去掉 thinking+output_config+metadata | ✅ 200 | |
| 最精简: model+messages+stream（3字段） | ✅ 200 | 仅 3 字段 |
| 最精简 + 去掉所有可选 Header | ✅ 200 | |

---

## 7. 风险提示

1. **`metadata` 是关键风控字段**：`metadata.user_id` 包含 `device_id`、`account_uuid`、`session_id`，这是 Anthropic 用于用户级速率限制和统计的标识。删除后你可能会与其他用户的请求混入同一速率限制桶。

2. **`system` 是客户端指纹字段**：真实 Claude Code 会带 `system`。当前 AnyRouter 缺少该字段会返回 503，因此 AnyBridge 保留一个最小 Claude Code 标识，不带大段平台提示词。

3. **`effort` 取值以成功抓包为准**：成功抓包使用 `"high"`；HTML 验证模板使用过 `"xhigh"`，不能据此判断 `high` 不可用。

4. **`anthropic-beta` 与功能关联**：
   - `context-1m-2025-08-07`：启用 1M 上下文窗口
   - `interleaved-thinking-2025-05-14`：启用流式思维链
   - `effort-2025-11-24`：启用 `output_config.effort`
   - `claude-code-20250219`：标识 Claude Code 客户端
   - 如果去掉某个 beta 但仍使用对应功能（如不用 `context-1m` 但请求 1M 上下文），可能导致异常。

5. **后端行为可能变化**：本测试基于 2026-06-20 的 AnyRouter Claude 端点，后续服务端更新可能改变字段敏感度。
