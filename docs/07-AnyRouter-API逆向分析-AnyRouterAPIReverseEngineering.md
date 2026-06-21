# AnyRouter API 逆向分析

> 日期：2026-06-19
> 目标：逆向分析 AnyRouter (`anyrouter.top`) 的 API 校验机制，使项目可直接调用其接口，绕过 Codex Desktop。

---

## 1. 基本信息

| 项目 | 值 |
|------|-----|
| 目标地址 | `anyrouter.top:443` |
| API 端点 | `POST /v1/responses` |
| 协议格式 | Azure OpenAI Responses API（非 Chat Completions） |
| 响应格式 | SSE 流式 (`text/event-stream`) |
| 可用模型 | `gpt-5.5`（`gpt-5.4` 返回 404） |

---

## 2. 代理抓包

### 架构

```
Codex Desktop → localhost:9999 (proxy-sniffer.cjs) → anyrouter.top:443
```

### 代理脚本

`scripts/proxy-sniffer.cjs` — 本地 HTTP 代理，监听 9999 端口，转发到 `anyrouter.top:443`。

关键配置：
- `rejectUnauthorized: false` — 跳过 TLS 证书校验
- 覆盖 `host` 头为 `anyrouter.top`
- 删除 hop-by-hop 头（`connection`, `proxy-connection`, `transfer-encoding`）
- 日志写入 `logs/sniffer-YYYY-MM-DDTHH-mm-ss.log`

### 启动方式

```bash
node scripts/proxy-sniffer.cjs
```

---

## 3. 请求格式分析

### 3.1 Codex 成功请求的字段（13 个）

```
model, instructions, input, tools, tool_choice, parallel_tool_calls,
reasoning, store, stream, include, prompt_cache_key, text, client_metadata
```

### 3.2 请求体大小拆解

| 部分 | 大小 |
|------|------|
| `instructions`（系统提示词） | ~21KB |
| `tools`（19 个工具定义） | ~40KB |
| `input`（消息数组） | ~3KB（单轮） |
| 其他字段 | ~2KB |
| **总计** | **~66KB** |

### 3.3 关键字段说明

#### `prompt_cache_key`（校验开关）

**这是 AnyRouter 判断请求是否合法的核心字段。** 不加此字段直接返回 `"invalid codex request"`。

```json
"prompt_cache_key": "019ee051-74b7-7a52-88f1-d42eac7fc3f9"
```

值格式为 UUID，可复用 Codex 的值。

#### `client_metadata`（会话元数据）

```json
{
  "client_metadata": {
    "session_id": "...",
    "thread_id": "...",
    "turn_id": 1
  }
}
```

此字段在之前测试中被遗漏，是导致校验失败的原因之一。

#### `reasoning`（推理配置）

```json
"reasoning": { "effort": "medium" }
```

**注意：不要加 `context` 和 `summary` 字段**，否则上游返回 400。

#### `text`（输出格式）

```json
"text": { "verbosity": "low" }
```

**注意：不要加 `format` 字段**，否则上游返回 400。

#### `tools`（19 个工具定义）

Codex 定义的完整工具集，包括：
- `shell_command` / `shell_view`
- `apply_patch` / `view_image`
- `mcp__*` 系列
- `web_search` / `web_fetch`
- `update_plan` / `task`
- 等

---

## 4. 校验流程

```
请求到达 AnyRouter
  → 检查 prompt_cache_key 是否存在？
    → 否 → 返回 "invalid codex request"
    → 是 → 格式校验通过，转发到上游 Azure OpenAI
      → 上游返回 200 → 正常响应
      → 上游返回 400 → 字段格式不合法（如 reasoning 多了 context）
      → 上游返回 520 → 后端异常
```

---

## 5. 成功调用示例

### 5.1 使用 Codex 模板 Replay

```bash
node scripts/test-codex-replay.cjs
```

输出：
```
Payload size: 66038 bytes
Sending request...
Status: 200
=== SUCCESS ===
Hello
=== END ===
```

### 5.2 脚本逻辑

```javascript
const template = JSON.parse(fs.readFileSync('codex-template.json', 'utf-8'));

// 只替换用户消息，其余保持不变
template.input = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你的问题' }] }
];

// 直接 POST 到 anyrouter.top
https.request({
  hostname: 'anyrouter.top',
  path: '/v1/responses',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + KEY,
    'accept': 'text/event-stream',
    'user-agent': 'Codex Desktop/0.142.0-alpha.1',
    'originator': 'Codex Desktop',
  },
  rejectUnauthorized: false,
}, callback);
```

### 5.3 模板文件

`scripts/codex-template.json` — 从 Codex 真实请求提取的完整模板（66KB），可复用。

---

## 6. 踩坑记录

### 6.1 错误：`"invalid codex request"`

**原因**：缺少 `prompt_cache_key` 字段。

**修复**：添加 `prompt_cache_key`（UUID 格式）。

### 6.2 错误：`"当前 API 不支持所选模型"`

**原因**：使用了 `gpt-5.4` 模型。

**修复**：改用 `gpt-5.5`。

### 6.3 错误：`"bad response status code 400"`

**原因**：
- `reasoning` 多了 `context` 和 `summary` 字段
- `text` 多了 `format` 字段
- 请求体包含不应存在的字段（`temperature`, `top_p`, `safety_identifier`, `tool_usage` 等）

**修复**：严格匹配 Codex 的 13 个字段，不多不少。

### 6.4 错误：`"负载已达上限"`

**原因**：后端资源不足，与请求格式无关。

### 6.5 测试请求使用了 Chat Completions 格式

**原因**：误以为 AnyRouter 使用标准 `/v1/chat/completions`。

**修复**：使用 `/v1/responses` 端点 + Responses API 格式。

---

## 7. 相关文件

| 文件 | 说明 |
|------|------|
| `scripts/proxy-sniffer.cjs` | 本地代理抓包工具 |
| `scripts/codex-template.json` | Codex 请求模板（66KB） |
| `scripts/test-codex-replay.cjs` | 模板 replay 测试脚本 |
| `scripts/extract-template.cjs` | 从日志提取模板的工具 |
| `scripts/parse-sniffer-log.cjs` | 日志解析工具 |
| `scripts/test-bisect.cjs` | 二分法定位字段脚本 |
| `scripts/test-bisect-v2.cjs` | 流式模式二分法 |
| `scripts/test-pinpoint.cjs` | 精确定位关键字段 |
| `scripts/test-minimal.cjs` | 最小化请求测试 |
| `scripts/test-reverse-bisect.cjs` | 反向二分法 |
| `logs/` | 代理抓包日志目录 |