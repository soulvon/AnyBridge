# 05-AnyBridge-支持 Claude Code 和 Codex 自定义 API 调研报告

> 调研时间：2026-06-11
> 调研人：CodeBuddy（用户授权深度调研 + 报告输出）
> 结论摘要：**难度大但可做**，**强烈推荐分步实施**，与现有"反向代理"模式并存不冲突。

---

## 一、调研背景

### 现有 AnyBridge 能力
当前 AnyBridge 仅支持 **Windsurf** 和 **Devin** 两个 IDE 端，采用的方案是：
- **反向代理** + **`http.proxy` 劫持** 模式
- 启动本地代理（sidecar），把 IDE 的 `http.proxy` 改成 `http://127.0.0.1:<port>`
- 所有 IDE 出口请求被劫持到 sidecar，sidecar 再按 `providerStore` 里的配置转发到中转站
- **不**直接修改 IDE 的 API 接入设置

**优点**：零侵入、跨 IDE 通用、不需要 IDE 重启
**缺点**：依赖 proxy 进程常驻；只能劫持 HTTP/HTTPS 流量

### 用户新需求
用户希望 AnyBridge 也能像 **cc-switch**（Claude Code 专用）和 **cockpit-tools**（Codex 专用）那样：
- **直接接管** Claude Code 和 Codex 的 API 端点
- 支持用户在 AnyBridge 里配置 Claude Code / Codex 用的中转站
- 用户在 Claude Code / Codex 里调用时自动走中转站

---

## 二、参考项目核心实现

### 2.1 cc-switch（Claude Code 专用切换器）

#### 配置文件路径
- **主配置**：`~/.claude/settings.json`（macOS/Linux：`~/.claude/settings.json`；Windows：`C:\Users\<user>\.claude\settings.json`）
- **兼容旧版**：`~/.claude/claude.json`（v3.10.3 之前的命名）
- **数据库**：`~/.cc-switch/cc-switch.db`（SQLite，存供应商列表 + 当前激活的供应商 ID）

#### 写入 `settings.json` 的字段结构
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://router.shengsuanyun.com/api",
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "anthropic/claude-sonnet-4.6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "anthropic/claude-opus-4.8"
  }
}
```

关键点：
- **API key** 用 `ANTHROPIC_AUTH_TOKEN`（中转站）或 `ANTHROPIC_API_KEY`（Anthropic 官方）— 由预设的 `apiKeyField` 字段决定
- **base URL** 走 `ANTHROPIC_BASE_URL`
- **模型名** 走 `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `SONNET_MODEL` / `OPUS_MODEL`（不同任务用不同模型）
- **不**重启 Claude Code — Claude Code 每次启动时读 `settings.json`，切换供应商后**下次启动生效**

#### 切换流程（`switch_normal`）
1. 备份当前 live settings（防止误改）
2. 把当前 live 里的"通用配置"（如 mcpServers、permissions）回填给原供应商
3. 写入新供应商的 `env` 到 `~/.claude/settings.json`
4. 更新数据库 is_current 字段

#### 高级特性
- **预设市场**：内置 50+ 国内外 Claude 中转站（Shengsuanyun、PatewayAI、火山 AgentPlan 等）
- **API 格式转换**：支持 anthropic 原生 / openai_chat / openai_responses / gemini_native 四种格式（claude-switch 内置协议转换层）
- **测速**：批量 ping 各预设的 base URL
- **导入**：从 Claude Code、Cursor、Codex 等多源导入现有配置

---

### 2.2 cockpit-tools（Codex 专用增强工具）

#### 配置文件路径
- **主配置**：`~/.codex/config.toml`（TOML 格式）
- **认证信息**：`~/.codex/.cockpit_codex_auth.json`（JSON，cockpit 自己管理的 token 状态）；macOS 走 Keychain
- **数据库**：cockpit 自己的 SQLite

#### 写入 `config.toml` 的字段结构
```toml
# 顶层
model_provider = "my-custom"

# 自定义 provider 块
[model_providers.my-custom]
base_url = "https://api.example.com/v1"
wire_api = "responses"  # 或 "chat"
experimental_bearer_token = "sk-xxx"
model = "gpt-5"
model_context_window = 200000
model_auto_compact_token_limit = 180000

# 顶层
model_context_window = 200000
model_auto_compact_token_limit = 180000
```

关键点：
- **API key** 单独存（`auth.json` 或 keychain），不直接写在 `config.toml` 里
- **wire_api**：`responses`（OpenAI 官方新协议）或 `chat`（Chat Completions 兼容）
- **base_url** 不强制带 `/v1`（cockpit 会自动归一化）
- **不**重启 Codex — 同 cc-switch，下次启动生效

#### 关键抽象
- `CodexApiProviderMode`：`Official` / `Custom` / `Packycode` 等多种模式
- `ApiProviderConfig { mode, base_url, provider_id, provider_name }` — 抽象 provider 概念
- 支持 **OAuth 登录**（走 `codex_oauth` 反代模式）和 **API Key 登录** 两种认证

---

## 三、AnyBridge 接入 Claude Code / Codex 的方案

### 3.1 两种模式对比

| 维度 | 现有「http.proxy 反向代理」模式 | 新的「直接接管 settings.json / config.toml」模式 |
|------|------|------|
| 原理 | 改 `http.proxy` 把 IDE 流量劫持到本地 sidecar | 直接改 IDE 的 API 配置（base URL + API key） |
| 适用范围 | Windsurf / Devin（VSCode 衍生）| Claude Code / Codex（独立 CLI）|
| 进程依赖 | sidecar 必须常驻 | 切换后无需任何常驻进程 |
| 多模型支持 | ✅ 强大（按 IDE 模型槽位映射中转站模型） | ⚠️ 较弱（Claude Code 只能按 haiku/sonnet/opus 切；Codex 只能设单一 model_provider） |
| 故障转移 | ✅ 自动 fallback | ❌ 没有 |
| 视觉一致性 | ✅ 完整支持 UI 自定义 | ❌ 看 IDE 自身 |
| 部署复杂度 | 中（要带 sidecar） | 低（改两个文件） |
| 用户感知 | 「我在用 AnyBridge 的代理」 | 「我在用 cc-switch 改 Claude Code」 |

### 3.2 关键差异（必须面对的难点）

#### 难点 1：API 协议不一致
- Claude Code 原生只支持 Anthropic Messages API
- 中转站可能给的是 OpenAI Chat Completions / OpenAI Responses / Gemini Native
- **cc-switch 解法**：内置一个**本地协议转换代理**（类似我们 AnyBridge 的 sidecar）
- **对 AnyBridge 的影响**：可复用现有 sidecar 的转换能力

#### 难点 2：Codex OAuth 认证
- OpenAI 官方 Codex 走 ChatGPT 账号 OAuth 登录
- 用户「自定义 API」需要完全绕过 OAuth，只用 API Key
- **cc-switch 实现了 OAuth 反代**（`codex_oauth` provider type）— 这是另一个独立大功能
- **对 AnyBridge 的影响**：建议**先不做** OAuth 反代，只做"用户自己有 API Key"的纯自定义场景

#### 难点 3：配置文件路径的平台差异
- Windows / macOS / Linux 三套路径
- 用户家目录可能因 `HOME` 环境变量错乱
- **cc-switch 解法**：用 `dirs` crate + 兼容回退
- **对 AnyBridge 的影响**：可参考 cc-switch 的实现

#### 难点 4：现有 sidecar 的职责
- 现有 sidecar 是"代理 + 协议转换 + 故障转移"一体
- 如果做 Claude Code 接入，会和现有 Windsurf 代理逻辑混在一起
- **建议**：sidecar 拆成两个模块 — `proxy-core`（代理 + 协议转换）+ `claude-code-handler`（新）

#### 难点 5：UI 复杂度爆炸
- 现在供应商配置页面要支持 4 种 IDE 端（Windsurf / Devin / Claude Code / Codex）
- 每种 IDE 端的字段不一样（base URL / API key 形式不同、额外字段如 `model_providers` 块）
- **建议**：复用现有「供应商」实体，加 `targetIde: ["windsurf", "claude-code", "codex"]` 字段，按 targetIde 渲染不同的字段表单

---

### 3.3 实施难度评估

| 子任务 | 难度 | 工作量 | 风险 |
|--------|------|--------|------|
| 数据模型扩展（targetIde 字段） | ⭐ 低 | 1-2 小时 | 低 |
| Claude Code 切换 UI（settings.json 读写） | ⭐⭐ 中 | 4-6 小时 | 中（路径权限） |
| Codex 切换 UI（config.toml 读写） | ⭐⭐⭐ 中高 | 6-8 小时 | 中（TOML 序列化） |
| Claude Code 协议转换（用现有 sidecar） | ⭐⭐⭐ 中高 | 6-8 小时 | 中 |
| Codex OAuth 反代 | ⭐⭐⭐⭐ 高 | 2-3 天 | 高 |
| 测试多平台（Win/Mac/Linux） | ⭐⭐ 中 | 4-6 小时 | 中 |
| 文档 + 兼容旧版本 | ⭐ 低 | 2-3 小时 | 低 |

**总工作量**：
- **MVP（不含 OAuth 反代）**：3-5 天
- **完整（含 OAuth 反代）**：1.5-2 周

**风险点**：
1. **破坏现有 Windsurf 代理功能** — 必须严格保持向后兼容
2. **误改用户 Claude Code / Codex 的现有配置** — 切换前必须备份
3. **多 IDE 端共享一个供应商时的冲突** — 需要明确策略

---

## 四、推荐实施路径

### Phase 1：MVP（3-5 天）
> 目标：**Claude Code + Codex 纯 API Key 模式**直接接管，不做 OAuth

#### 1.1 数据模型扩展
- `Provider` 加 `targetIde: String`（单选："windsurf" | "devin" | "claude-code" | "codex"）
- `Provider` 加 `claudeSettings: { env: Record<string, string> }`（Claude Code 专用字段）
- `Provider` 加 `codexProviderConfig: { base_url, wire_api, model, model_providers_id }`（Codex 专用字段）
- 老供应商默认 `targetIde = "windsurf"`，行为完全不变

#### 1.2 后端新增命令
```rust
#[tauri::command]
async fn switch_claude_code(provider_id: String) -> Result<SwitchResult, String>

#[tauri::command]
async fn switch_codex(provider_id: String) -> Result<SwitchResult, String>

#[tauri::command]
async fn read_claude_settings() -> Result<ClaudeSettings, String>

#[tauri::command]
async fn read_codex_config() -> Result<CodexConfig, String>
```

#### 1.3 UI 改造
- 「新增/编辑供应商」表单加 `targetIde` 单选下拉
- 根据 targetIde 切换显示不同字段
- 「代理启动/停止」按钮旁加 「Claude Code 切换」/「Codex 切换」独立按钮

#### 1.4 切换实现
- **Claude Code**：
  1. 备份 `~/.claude/settings.json` → `settings.json.byok.bak`
  2. 读取现有 mcpServers / permissions
  3. 写入新供应商的 env 字段
  4. 提示用户「下次启动 Claude Code 生效」
- **Codex**：
  1. 备份 `~/.codex/config.toml` → `config.toml.byok.bak`
  2. 读取现有 mcpServers 等
  3. 序列化新供应商的 model_providers 块
  4. 写 API key 到 `auth.json`（或 keychain）
  5. 提示用户「下次启动 Codex 生效」

#### 1.5 协议转换
- Claude Code 走 Anthropic 协议，中转站给 OpenAI 协议时 — 复用现有 sidecar 的 `streamAnthropic` ↔ `streamOpenAI` 转换
- 但**不是**在 Claude Code 端改 base URL 到中转站 — 而是在 `ANTHROPIC_BASE_URL` 改成**本地 sidecar 地址**，sidecar 再转发到中转站
- **这其实和现有 Windsurf 模式完全一样！** Windsurf 改 `http.proxy` 劫持流量；Claude Code 改 `ANTHROPIC_BASE_URL` 到 `http://127.0.0.1:<sidecar-port>` 也劫持流量
- **优势**：sidecar 统一接管所有 IDE 端，故障转移、限流、统计全都有

### Phase 2：Codex OAuth 反代（2-3 天，可选）
> 参考 cc-switch 的 `codex_oauth` provider type，但实现复杂

---

## 五、关键技术决策点（需用户拍板）

### 决策 1：协议转换走哪种模式？
- **A. 走本地 sidecar**（推荐）：`ANTHROPIC_BASE_URL` 改为 `http://127.0.0.1:<port>`，sidecar 统一处理协议转换 + 故障转移
- **B. 客户端原生**：中转站必须原生支持 Anthropic 协议，否则不接

**推荐 A**：与现有 Windsurf 架构统一，复用 sidecar 能力

### 决策 2：Codex 的 wire_api 默认值？
- `responses`（OpenAI 新协议）
- `chat`（Chat Completions，兼容老中转站）
- **建议**：自动检测（同 Windsurf 现有的 fetch_models 双协议 fallback 逻辑）

### 决策 3：Claude Code 的模型字段？
- `ANTHROPIC_MODEL`（单一模型）
- `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `SONNET_MODEL` / `OPUS_MODEL`（三档）
- **建议**：三档（与 cc-switch 一致），用户在中转站只配一个模型就复制到三档

### 决策 4：切换前是否自动备份？
- **强烈建议**：每次切换前**强制**备份到 `*.byok.bak`，用户可手动回滚

### 决策 5：UI 上 Claude Code / Codex 切换放在哪？
- **A. 「代理启动/停止」按钮旁**（与现有 Windsurf 代理并列）— 用户感知一致
- **B. 「设置 > IDE 接入」独立子页** — 隔离更清晰
- **推荐 A**：与现有交互对齐

---

## 六、风险与回退

### 风险 1：破坏现有 Windsurf/Devin 代理
- **缓解**：MVP 阶段所有改动都用 feature flag（`ENABLE_CLAUDE_CODE_PROVIDER` / `ENABLE_CODEX_PROVIDER`），默认关闭
- **回退**：用户可手动关闭 feature，回归到只有 Windsurf 模式

### 风险 2：误改用户现有 Claude Code 配置
- **缓解**：切换前显示 diff 预览 + 强制备份
- **回退**：备份文件 `*.byok.bak` 用户可手动恢复

### 风险 3：sidecar 启动失败导致 Claude Code 不可用
- **缓解**：sidecar 启动失败时**不**写入 IDE 配置，提示用户先启动 sidecar
- **回退**：恢复原 settings.json

---

## 七、最终建议

### 给用户的建议
1. **建议先做 Claude Code**（市场需求更大、cc-switch 已验证可行性）
2. **Codex 先做纯 API Key 模式**，OAuth 反代作为 Phase 2
3. **复用现有 sidecar**（协议转换 + 故障转移），不要新建独立代理
4. **切换前强制备份**，UI 上展示 diff 预览

### 不建议的方案
- ❌ **完全照搬 cc-switch**：cc-switch 的协议转换层写得较浅，无法直接复用
- ❌ **完全照搬 cockpit-tools**：cockpit 是 Tauri 2 + Rust 纯原生，与 AnyBridge 架构差异大
- ❌ **做 OAuth 反代**（Phase 2 再说）：复杂度高、需求不确定

### 投入产出比
- **MVP（Phase 1）**：投入 3-5 天，覆盖 90% 用户场景，**强烈推荐**做
- **完整方案（含 OAuth）**：再投入 1.5 周，覆盖 99% 场景，**视需求决定**

---

## 八、参考代码片段

### 8.1 cc-switch 的 settings.json 写入核心
```rust
// src-tauri/src/services/provider/mod.rs:1643-1730
pub fn switch_normal(...) -> Result<SwitchResult, AppError> {
    // 1. 备份当前 live settings
    // 2. 回填通用配置（mcpServers 等）到原供应商
    // 3. 写入新供应商的 env 到 settings.json
    // 4. 更新数据库 is_current
    write_live_with_common_config(state.db.as_ref(), &app_type, provider)?;
}
```

### 8.2 cockpit-tools 的 Codex config.toml 序列化
```rust
// crates/cockpit-core/src/modules/codex_account.rs
const CODEX_CONFIG_MODEL_PROVIDER_KEY: &str = "model_provider";
const CODEX_CONFIG_MODEL_PROVIDERS_KEY: &str = "model_providers";

struct ApiProviderConfig {
    mode: CodexApiProviderMode,
    base_url: Option<String>,
    provider_id: Option<String>,
    provider_name: Option<String>,
}
```

### 8.3 AnyBridge 现有的 http.proxy 反向代理（参考用）
```rust
// src-tauri/src/commands/proxy.rs:551-650
// 1. 找到 IDE 的 settings.json
// 2. 改写 http.proxy 字段为本地 sidecar 地址
// 3. 备份原文件
// 4. 启动 sidecar
// 5. 停止时还原
```

---

## 九、下一步行动

### 立即可做（不需要写代码）
1. **下载安装 Claude Code**（`npm install -g @anthropic-ai/claude-code`）实测一下，看 `settings.json` 写完是否真的下次启动生效
2. **下载安装 Codex**（`npm install -g @openai/codex`）同上实测
3. **熟悉两个工具的配置文件格式**（如果还没的话）

### Phase 1 启动条件
- 用户确认走「sidecar 反向劫持」方案（决策 1 选 A）
- 用户确认三档模型（决策 3 选三档）
- 用户确认 UI 布局（决策 5 选 A）

### Phase 1 第一周开发计划
- Day 1：数据模型扩展 + 数据库迁移
- Day 2：Claude Code 切换后端命令（读写 settings.json）
- Day 3：Codex 切换后端命令（读写 config.toml）
- Day 4：UI 表单（targetIde 选择 + 字段渲染）
- Day 5：联调 + 多平台测试 + 文档

---

## 附录：参考项目源码位置

| 项目 | 关键文件 | 行数 |
|------|---------|------|
| cc-switch | `src-tauri/src/config.rs` | 70-150（路径处理）|
| cc-switch | `src-tauri/src/services/provider/mod.rs` | 1643-1730（switch_normal）|
| cc-switch | `src/config/claudeProviderPresets.ts` | 25-150（预设 schema）|
| cockpit-tools | `crates/cockpit-core/src/modules/codex_account.rs` | 25-110, 176-230（Codex 字段定义）|
| cockpit-tools | `crates/cockpit-core/src/modules/codex_account.rs` | 555-860（config.toml 序列化）|

---

**报告完成。兄弟晚安，明天起来再决定要不要推进 Phase 1。**
