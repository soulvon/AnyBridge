# AnyRouter GPT-5.5 字段精简测试报告

> 测试时间：2026-06-20
> 测试端点：`anyrouter.top/v1/responses`
> 测试模型：`gpt-5.5` (Codex)

---

## 1. 模板概况

Codex 原始请求模板共 **13 个字段**，Payload 约 **66,038 字节**：

```
model, instructions, input, tools, tool_choice, parallel_tool_calls,
reasoning, store, stream, include, prompt_cache_key, text, client_metadata
```

其中 `instructions` 约 21.6KB（Codex 人格提示词），`tools` 约 43.3KB（19 个工具定义），两者合计占 Payload 的 **98%**。

---

## 2. 测试方法

```
1. 单字段删除 → 逐个删除每个字段，观察是否 400
2. 组合删除 → 逐步收敛，逼近最小集
3. 边界测试 → null/空数组/空对象/FALSE 等边界值
4. 复测确认 → 对模糊结果（500）重复 3 次独立测试
```

每个测试间隔 3 秒，使用独立 `prompt_cache_key` 避免缓存交叉污染。

---

## 3. 最终结论

### 🔴 必填字段（删除返回 400/404）

| 字段 | 报错码 | 说明 |
|------|--------|------|
| `model` | 404 | 删除或置空都报 "API 不支持所选模型" |
| `input` | 400 | 删除报 `invalid codex request` |
| `include` | 400 | **必须原样保留原始数组**，`[]` / `null` 都 400 |
| `prompt_cache_key` | 400 | 删除报 `invalid codex request` |

### 🟡 建议保留

| 字段 | 说明 |
|------|------|
| `stream` | 可删，但响应无 SSE 流（非流式返回），建议保留 `true` |

### 🟢 可安全删除

| 字段 | 省字节 | 备注 |
|------|--------|------|
| `instructions` | ~21,647 | Codex 人格指令 |
| `tools` | ~43,301 | 19 个工具定义 |
| `tool_choice` | ~21 | |
| `parallel_tool_calls` | ~26 | |
| `reasoning` | ~31 | |
| `store` | ~14 | |
| `text` | ~27 | 3 次复测全 200，此前一次 500 为服务器超载巧合 |
| `client_metadata` | ~728 | 跟踪/会话元数据 |

### 关键验证

- `text` 字段：首次测试返回 500 "负载达上限"，**重复 3 次独立测试全部 200**，确认为可选字段
- `include` 字段：空数组 `[]` → 400，`null` → 400，**必须原值保留**
- `instructions` + `tools` 同时删除：Payload 从 66KB 骤降至 1090B，仍然 200 正常响应

---

## 4. 最小可行 Payload

```json
{
  "model": "gpt-5.5",
  "input": [...],
  "stream": true,
  "include": [...],
  "prompt_cache_key": "<uuidv7>"
}
```

**5 字段，241 字节**，比原始模板精简 **99.6%**。

不带 `stream` 也可工作（4 字段 227 字节），但无流式输出。

---

## 5. Devin 接入方案

三个 Devin 格式测试全部通过：

| 方案 | Payload | 结果 |
|------|---------|------|
| 替换 instructions 为 Devin 提示词 | 44,491B | ✅ 200 |
| 替换 instructions + 空 tools `[]` | 1,157B | ✅ 200 |
| **删 instructions + 删 tools（干净）** | **1,090B** | ✅ 200 |

**推荐方案**：

```
保留：model、input、stream、include、prompt_cache_key（5 个必填/建议字段）
删除：instructions、tools、tool_choice、parallel_tool_calls、
      reasoning、store、text、client_metadata（8 个可选字段）
```

该方案下 AnyRouter 不会注入 Codex 人格指令，Devin 行为完全由自身系统提示词控制，不受干扰。

---

## 6. 详细测试日志

### 单字段删除

| 测试 | Status | Response | Size |
|------|--------|----------|------|
| 完整模板(对照组) | ✅ 200 | "Hello" | 66,038B |
| 去掉 instructions | ✅ 200 | "Hello" | 44,391B |
| 去掉 tools | ✅ 200 | "Hello" | 22,737B |
| 去掉 tool_choice | ✅ 200 | "Hello" | 66,017B |
| 去掉 parallel_tool_calls | ✅ 200 | "Hello" | 66,011B |
| 去掉 reasoning | ✅ 200 | "Hello" | 66,006B |
| 去掉 store | ✅ 200 | "Hello" | 66,024B |
| 去掉 stream | ✅ 200 | (空) | 66,024B |
| 去掉 include | ❌ 400 | invalid codex request | 65,996B |
| 去掉 prompt_cache_key | ❌ 400 | invalid codex request | 65,980B |
| 去掉 text | ✅ 200 | "Hello" | 66,011B |
| 去掉 client_metadata | ✅ 200 | "Hello" | 65,310B |

### 组合删除

| 测试 | Status | Response | Size |
|------|--------|----------|------|
| 去 instructions+tools | ✅ 200 | "Hello" | 1,090B |
| 去 instructions+tools+tool_choice | ✅ 200 | "Hello" | 1,069B |
| 去 store+include+client_metadata | ❌ 400 | invalid codex request | — |
| 去 reasoning+text+parallel_tool_calls | ✅ 200 | "Hello" | 65,952B |
| 精简版(model+input+stream+cache) | ❌ 400 | invalid codex request | — |
| 精简版+include | ✅ 200 | "Hello" | 241B |
| 精简版+text | ❌ 400 | invalid codex request | — |

### 边界测试

| 测试 | Status | 说明 |
|------|--------|------|
| include=[] | ❌ 400 | 空数组不行 |
| include=null | ❌ 400 | null 不行 |
| stream=false | ✅ 200 | 非流式可行，响应体空 |
| parallel_tool_calls=false | ✅ 200 | |
| client_metadata={} | ✅ 200 | 空对象可行 |
| reasoning={} | ✅ 200 | 空对象可行 |

### text 字段 500 复测

| 测试 | Status | 说明 |
|------|--------|------|
| 重测1: 去掉text | ✅ 200 | "Hello" |
| 重测2: 去掉text | ✅ 200 | "Hello" |
| 重测3: 去掉text | ✅ 200 | "Hello" |

> 确认：`text` 为可选字段，首次 500 为服务器瞬时超载。

### model/input 必填验证

| 测试 | Status | 说明 |
|------|--------|------|
| 去掉 model | ❌ 404 | API 不支持所选模型 |
| model="" | ❌ 404 | API 不支持所选模型 |
| 去掉 input | ❌ 400 | invalid codex request |

---

## 7. 风险提示

1. **`include` 字段内容固定**：当前测试使用的 `include` 来自 Codex 模板，更换内容可能触发 400。如果后续 API 更新，此字段逻辑可能变化。
2. **后端行为可能变化**：本测试基于 2026-06-20 的 AnyRouter GPT-5.5 端点，后续服务端更新可能改变字段要求。
3. **`stream` 建议保留**：虽然技术上可删，但无流式响应的用户体验较差（空白响应体），建议始终设为 `true`。
