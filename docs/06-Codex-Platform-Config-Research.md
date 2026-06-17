# Codex 平台配置调研与实施记录

## 背景

AnyBridge 的「更多平台」能力通过写入目标工具的原生配置文件，让 Claude Code、Codex、CodeBuddy、OpenCode、WorkBuddy、ZCode 等工具直接使用用户在 AnyBridge 中维护的供应商配置。

本次 Codex 调研来自三类输入：

- 官方 Codex 配置说明。
- 竞品 `cockpit-tools` 与 `cc-switch` 的 Codex 支持方式。
- 本机正在使用的 Cockpit Tools + Codex 配置状态。

本阶段目标是增强 Codex 的原生配置接管能力，不做本地代理路由转换。

## 当前结论

Codex 官方配置支持在 `~/.codex/config.toml` 中声明当前模型与模型供应商：

```toml
model = "gpt-5.5"
model_provider = "custom_provider"

[model_providers.custom_provider]
name = "Custom Provider"
base_url = "https://example.com/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "sk-..."
```

Codex 当前推荐使用 `wire_api = "responses"`。Chat Completions 仍可能在部分兼容服务中出现，但官方文档已经不建议作为新配置路径，后续也存在被移除的风险。

AnyBridge 当前的 Codex 写入方式总体方向正确：

- 使用 `toml_edit` 做保留式编辑，不重写整个 `config.toml`。
- 写入 `model`、`model_provider` 和 `[model_providers.byok]`。
- 使用 `wire_api = "responses"`。
- 使用 provider-scoped 的 `experimental_bearer_token`，不改 `~/.codex/auth.json`。

需要补强的是检测与展示：当前 UI 的「已接管」状态主要来自 AnyBridge 自己的 `providers.json` 记录，而不是从真实 `~/.codex/config.toml` 反查当前 Codex 正在使用的 provider。

## 本机 Cockpit Tools 诊断

当前本机 Codex 配置中：

```toml
model_provider = "codex_local_access"

[model_providers.codex_local_access]
base_url = "https://anyrouter.top/v1"
wire_api = "responses"
supports_websockets = false
```

Cockpit Tools 的本地访问配置显示：

- `enabled = false`
- `port = 49540`

本机未检测到 `49540`、`15721`、`15722` 等本地代理端口监听。

因此当前链路不是 Cockpit 本地服务代理转换，而是：

```text
Codex -> https://anyrouter.top/v1
```

Cockpit Tools 中也保存了部分 `chat_completions + gateway` 的 provider，这类配置才更接近需要本地或网关层做协议转换；但当前实际启用的 AnyRouter 是 `responses + direct`。

## 竞品可借鉴点

### cockpit-tools

- 把 Codex provider 分为 direct 与 gateway 两种启用偏好。
- provider preset 中带有 `wireApi`、`baseUrl`、`apiKeyUrl`、模型能力等元信息。
- 对 Responses-native provider 和 Chat Completions-only provider 做显式区分。

### cc-switch

- 强调保留官方 `~/.codex/auth.json`，第三方 API key 写入 `config.toml` provider-scoped token。
- 读取当前 `model_provider` 后，只解析匹配的 `[model_providers.<id>]`，避免把历史残留 provider 当成当前状态。
- 把 Codex 通用配置和 provider-specific 配置分开处理，降低覆盖 MCP、插件、桌面配置的风险。

## 本阶段实施范围

本阶段只做直连 Codex 配置增强：

1. 把 `OpenAI 官方配置` 和 `第三方供应商` 分成两个明确通道。
2. 官方配置使用 Codex 内置 OpenAI 通道和 `auth.json` 登录态，不写第三方地址或 token。
3. 第三方供应商继续使用 `~/.codex/config.toml` 的原生 provider 配置。
4. 第三方供应商继续写入 `[model_providers.byok]`。
5. 第三方供应商继续要求所选供应商支持 OpenAI Responses API。
6. 不启动本地服务。
7. 不做 Chat Completions 到 Responses 的协议转换。
8. 不改 `~/.codex/auth.json`。

## 官方配置与第三方供应商

Codex 的官方登录态和模型请求配置需要分开理解：

- `~/.codex/auth.json` 保存官方 ChatGPT / Codex 登录缓存。
- `~/.codex/config.toml` 保存当前模型、当前 provider、第三方 base URL 和 provider-scoped token。

因此 AnyBridge 的 Codex 页面必须提供两个独立动作：

- `切回官方配置`：清除 active 第三方 provider 指针和 AnyBridge 的 `byok` 配置片段，让 Codex 回到内置 OpenAI 官方通道；该动作不依赖 `.byok-bak`，也不修改 `auth.json`。
- `应用第三方`：把 AnyBridge 供应商写入 `[model_providers.byok]`，并把 `model_provider` 指向 `byok`。

`.byok-bak` 的语义只保留为“还原 AnyBridge 首次接管前的文件”，不再承担“回官方”的含义。

## 暂不实施的能力

本地代理路由转换暂缓，后续作为跨平台共享能力统一设计。该能力不仅 Codex 会需要，其他 IDE/CLI 工具也可能需要，所以不适合在 Codex 平台接管里单点实现。

后续独立方案需要覆盖：

- 本地监听端口与生命周期管理。
- Chat Completions、Responses、Anthropic Messages 等协议之间的转换边界。
- 流式响应、tool call、reasoning、vision、web search 等能力映射。
- 日志脱敏与错误回放。
- 多平台共享的路由规则、模型别名和 fallback 策略。

## 第一阶段开发计划

### 1. 后端检测真实 Codex 状态

新增 Codex 配置读取逻辑，从 `~/.codex/config.toml` 中读取：

- `model`
- `model_provider`
- 当前 provider 的 `name`
- 当前 provider 的 `base_url`
- 当前 provider 的 `wire_api`
- 是否包含 `experimental_bearer_token`
- 是否由 AnyBridge 管理

检测规则：

- 先读取顶层 `model_provider`。
- 只解析 `[model_providers.<model_provider>]`。
- `model_provider == "byok"` 时视为 AnyBridge 当前接管。
- 配置解析失败时不阻断其他平台检测，但要把错误返回给 UI。

### 2. 后端写入行为保持保守

继续使用 `toml_edit` 保留式编辑，只改以下字段：

- 顶层 `model`
- 顶层 `model_provider`
- `[model_providers.byok]` 下的 `name`
- `[model_providers.byok]` 下的 `base_url`
- `[model_providers.byok]` 下的 `wire_api`
- `[model_providers.byok]` 下的 `requires_openai_auth`
- `[model_providers.byok]` 下的 `experimental_bearer_token`

不删除其他 provider，不删除 MCP、projects、desktop 等配置。

### 3. UI 展示真实 Codex 状态

Codex 平台卡片和详情页增加真实配置摘要：

- 当前 Codex provider id。
- 当前 Codex model。
- 当前 Codex base_url。
- 当前 Codex wire_api。
- 当前是否为 AnyBridge 接管。

如果当前 Codex 使用的是外部 provider，例如 Cockpit 写入的 `codex_local_access`，UI 应展示真实 provider，而不是只显示 AnyBridge 内部记录。

### 4. 测试与校验

重点验证：

- `apply_codex()` 保留无关 TOML 区块。
- 真实 Codex 状态读取只解析当前 active provider。
- `auth.json` 不参与 Codex 写入。
- UI 脚本语法检查通过。
- Rust 检查通过。

## 风险

- Codex 的 `experimental_bearer_token` 命名带有 experimental，后续官方可能调整。
- 第三方 provider 标称 OpenAI 兼容，但不一定完整支持 Responses API。
- 用户可能同时使用 Cockpit Tools、cc-switch、手写配置和 AnyBridge，状态展示必须以真实 `config.toml` 为准，AnyBridge 的接管记录只能作为辅助信息。

## 验收标准

- 用户能在 AnyBridge 中看到 Codex 当前真实 provider，不再只依赖 AnyBridge 自己的历史记录。
- 应用 AnyBridge provider 后，Codex 配置仍保留原有 MCP、projects、desktop 等内容。
- 非 AnyBridge 写入的 Codex provider 不会被误报成 AnyBridge 接管。
- 不引入本地代理服务或协议转换逻辑。
