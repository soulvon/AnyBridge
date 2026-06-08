# Vision 能力探测误判与自定义模型稳定性复盘

> 项目：IDE-BYOK | 时间：2026-06-08

---

## 一、问题现象

使用自定义模型劫持 Windsurf 模型后，图片理解功能出现不稳定：

| 场景 | 表现 |
|------|------|
| 连接测试 | 小图探测失败，Vision 被判断为不支持 |
| 后续真实请求 | 即使正常大小图片能被上游识别，代理仍可能跳过该供应商 |
| 修改配置后 | IDE 仍可能拿到旧的模型能力，图片没有作为 image block 进入 GetChatMessage |

排查时还发现一个容易误判的现象：MITM 日志里出现 `base64` 不代表用户上传了图片。代码片段、工具输出、历史日志文本里也可能包含 `data:image` 或 `base64_data` 字符串，必须检查 OpenAI `image_url` / Responses `input_image` / Anthropic `image.source` 这些标准图片块。

---

## 二、根因分析

### 2.1 1x1 小图不能作为 Vision 否定证据

旧的连接测试使用 1x1 透明 PNG 探测 Vision。

部分上游或中转站会拒绝极小图片、空白透明图片，或者不把它送入真实视觉链路。这会导致：

1. 真实正常尺寸图片可以识别。
2. 连接测试的小图失败。
3. `caps.vision` 返回 false。
4. 如果 false 被持久化，后续图片请求会被代理层跳过。

结论：Vision 探测失败只能表示“本次探测失败”，不能表示“模型不支持图片”。

### 2.2 provider 级 `capabilities.vision=false` 不应硬拦截

Vision / tools 是模型级能力。供应商级 `vision=false` 很可能来自探测误判或旧配置残留。

错误策略：

```text
provider.capabilities.vision=false => 图片请求直接跳过该 provider
```

正确策略：

```text
优先使用 modelCaps[model].vision=true 排序；
没有明确正向标记时仍尝试上游；
不要因 provider 级 false 永久拦截图片请求。
```

### 2.3 GetUserStatus 改写缓存必须感知配置变化

Windsurf 是否把图片发进 GetChatMessage，取决于客户端看到的模型能力字段，例如 `supports_images`。

如果代理缓存了 GetUserStatus 的改写结果，但缓存 key 只看上游响应 body，不看本地配置文件变化，则 UI 中修改 `model-map.json` / `providers.json` 后，客户端可能继续拿到旧能力，表现为：

- IDE 里模型显示已改。
- 代理配置也看起来正确。
- 但用户发送图片后，GetChatMessage 里没有图片字段。

缓存 key 应包含配置文件签名，例如 `model-map.json`、`providers.json`、`ide-models.json` 的 mtime/size。

---

## 三、修复方案

### 3.1 Vision 探测图换成正常尺寸

将连接测试的 1x1 透明 PNG 替换为 128x128 正常 PNG，避免上游因图片过小/透明而误拒绝。

### 3.2 只保存正向能力，不保存 false

UI 探测结果只应自动写入：

```json
{ "vision": true, "tools": true }
```

失败结果不得覆盖已有能力，不得写入：

```json
{ "vision": false }
```

### 3.3 图片请求不因未标记 Vision 被跳过

有图片请求时，代理仍可优先排序 Vision=true 的目标，但不能因为目标未标记 Vision 或历史 false 就直接跳过。真实请求应交给上游判断。

### 3.4 GetUserStatus 缓存加入配置签名

缓存复用必须同时满足：

1. 上游 GetUserStatus 响应 body 没变。
2. `model-map.json` 没变。
3. `providers.json` 没变。
4. `ide-models.json` 没变。

任一配置变化都要重新改写模型能力。

---

## 四、验证方法

### 4.1 直连上游验证

用正常尺寸 PNG 直连供应商的 `/v1/chat/completions`：

- 如果模型能描述图片，说明上游 Vision 可用。
- 如果 IDE 内仍不识图，重点查 GetUserStatus / GetChatMessage 的图片字段链路。

### 4.2 MITM 日志判断真实图片请求

正确判断：

| API 格式 | 图片字段 |
|----------|----------|
| OpenAI Chat Completions | `messages[].content[].type == "image_url"` |
| OpenAI Responses | `input[].content[].type == "input_image"` |
| Anthropic | `messages[].content[].type == "image"` 且有 `source.data` |

错误判断：

```text
body.includes("base64")
body.includes("data:image")
```

这些只能作为粗筛，不能作为“真实上传图片”的结论。

---

## 五、自定义模型稳定性补充

### 5.1 慢响应与重试

自定义模型常见链路更长：Windsurf → 本地代理 → 中转站 → 上游模型。中转站在高峰期容易出现：

- 首包慢。
- 429 / 5xx。
- socket hang up / ECONNRESET。
- Cloudflare 或上游临时断流。

如果代理只做“换下一个 target”，而不对同一个 target 进行可重试错误的指数退避，单供应商配置就会表现为“失败了不会重试”。

慢响应还可能来自代理自身：

| 来源 | 影响 | 处理 |
|------|------|------|
| 每次请求新建 TLS | 多一次握手，首包更慢 | 上游请求使用 keep-alive Agent |
| MITM 全量同步日志 | 图片/大文件 body 写盘阻塞主链路 | 默认截断 body，并改为异步写日志 |
| 临时图片 debug dump | 每次图片请求落盘 raw body | 默认关闭，仅 `BYOK_DEBUG_IMAGES=true` 时开启 |
| Responses API 默认 high reasoning | 模型先思考更久，首包慢 | 默认不强制 reasoning，需要时再设置 `BYOK_REASONING_EFFORT=high` |

修复原则：

1. 仅在还没向 IDE 写响应头之前重试，避免重复执行已经流了一半的工具调用。
2. 只重试可恢复错误：408、425、429、5xx、网络错误、DNS 临时错误、上游超时。
3. 不重试普通 4xx、客户端断开、已经开始向 IDE 流式输出后的中途失败。
4. 支持 `Retry-After`，并提供最大重试次数、退避基准、退避上限、整体重试时长配置。
5. 客户端断开时必须取消待执行的重试定时器，否则可能在 IDE 已关闭请求后又发起新的上游请求。
6. `Retry-After` 既可能是秒数，也可能是 HTTP-date，两个格式都要识别。

当前实现参数：

| 配置 | 默认值 | 作用 |
|------|--------|------|
| `BYOK_RETRY` | `true` | 是否启用同目标重试 |
| `BYOK_RETRY_MAX` | `5` | 单个目标最多重试次数 |
| `BYOK_RETRY_BASE_MS` | `600` | 指数退避基础延迟 |
| `BYOK_RETRY_CAP_MS` | `8000` | 单次退避延迟上限 |
| `BYOK_RETRY_TOTAL_MS` | `60000` | 单个目标整体重试时间窗口 |
| `UPSTREAM_TIMEOUT_MS` / `API_TIMEOUT_MS` | `300000` | 上游请求空闲超时 |
| `BYOK_MITM_LOG` | `true` | 是否写 MITM 日志 |
| `BYOK_MITM_FULL_LOG` | `false` | 是否写完整请求/响应 body |
| `BYOK_MITM_MAX_BODY_BYTES` | `8192` | 默认日志 body 截断大小 |
| `BYOK_DEBUG_IMAGES` | `false` | 是否开启图片 raw dump / 解析诊断 |
| `BYOK_REASONING_EFFORT` | 空 | OpenAI Responses reasoning 强度；空表示不强制 |
| `BYOK_MAX_SOCKETS` | `64` | 上游供应商连接池最大 socket 数 |

### 5.2 大文件写入失败率高

大文件写入通常由模型发起工具调用，工具参数里包含大段 patch / file content。失败率高的常见原因：

| 原因 | 表现 | 处理 |
|------|------|------|
| 输出 token 不够 | 工具参数被截断 | 调高 `MAX_TOKENS`，或让模型拆小文件/分段写 |
| 流式中途断开 | IDE 收到半截工具调用 | 已开始流式输出后不能安全重试，只能报错 |
| 工具参数 JSON 不完整 | IDE 执行写文件失败 | 代理应丢弃 invalid JSON tool call，不把半截参数交给 IDE |
| 上游首包慢 | 代理 120s 超时断开 | 上游超时改为可配置，默认放宽 |

关键经验：半截 tool call 比没有 tool call 更危险。没有 tool call 至少不会写坏文件；半截 tool call 可能让 IDE 尝试执行不完整的大文件写入。

实现细节：

1. Anthropic 使用 `max_tokens`。
2. OpenAI Responses API 使用 `max_output_tokens`。
3. OpenAI Chat Completions 使用 `max_tokens`。
4. 如果 invalid JSON tool call 被丢弃且没有剩余有效 tool call，stop reason 应按 `MAX_TOKENS` 处理，不能继续返回 `FUNCTION_CALL`。

---

## 六、经验原则

1. 能力探测只能自动写正向结果，不能把失败永久化。
2. Vision / tools 这种能力应尽量落在模型级 `modelCaps`，provider 级只能作为 UI 提示或排序参考。
3. 图片请求应“乐观转发”，不要在代理层过早拦截。
4. 缓存 GetUserStatus 改写结果时，必须把本地配置文件纳入缓存签名。
5. 诊断图片链路时，要检查标准图片 block，而不是搜索 base64 字符串。
6. 聊天主链路必须接入重试配置；有 UI 开关但链路未使用，等于没有重试。
7. 大文件写入要防止 invalid JSON tool call 进入 IDE。
8. UI 暴露的 `MAX_TOKENS` 必须传到所有上游格式，不只传 Anthropic。
9. 自定义模型的图片能力要同时看两层：BYOK 目标模型是否支持 Vision，以及 Windsurf 原生槽位是否真的会上传图片。

### 6.1 槽位能力不能只看 `supportsImages`

这次验证发现，`MODEL_XAI_GROK_3` / `MODEL_XAI_GROK_3_MINI_REASONING` 即使被改名并声明 `supportsImages=true`，Windsurf 实际请求里仍可能不带图片 block。也就是说，`supportsImages` 可以影响下拉列表展示，但不一定能改变客户端对某个原生槽位的真实多模态发送逻辑。

UI 和改写层需要把这类槽位标记为“慎用图片 / 需换视觉槽”，不能继续显示成安全的 Vision 映射。给视觉 BYOK 模型做映射时，优先使用已实测会上传图片的原生视觉槽位，例如 `MODEL_CHAT_GPT_4O_2024_08_06`、`MODEL_PRIVATE_11` 或其他 catalog 中明确支持图片的槽位。
