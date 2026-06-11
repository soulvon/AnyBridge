# 06-「更多平台」Tab 设计文档

> 设计时间：2026-06-11
> 设计师：CodeBuddy
> 状态：待用户拍板后进入开发

---

## 一、命名 & 定位

### 名称：「更多平台」

**为什么这个名字**：
- 跟现有「模型映射」「模型检测」等 tab 风格统一（简短，2-4 字）
- 暗示"除了 Windsurf/Devin 主代理之外的更多平台"
- 用户一眼能懂，不需要解释
- 跟"扩展性"语义一致（未来加 codebuddy / Aider / Continue 等都不用改名）

**英文/系统命名**：`page-more-platforms` / `tab-more-platforms`

### 定位

「更多平台」是 IDE BYOK 的**扩展功能 tab**，专门承载**通过修改 IDE 自身配置文件**（而不是劫持代理）来接管 API 端点的工具集。

与现有 tab 的关系：
| Tab | 接管方式 | 进程依赖 |
|-----|----------|----------|
| 仪表盘 | — | — |
| 供应商 | — | — |
| 模型映射 | — | — |
| 模型检测 | — | — |
| 日志 | — | — |
| 设置 | — | — |
| **更多平台**（新） | **改 IDE 配置文件** | **无（下次启动 IDE 生效）** |

### 涵盖工具（按优先级）

#### 第一批（建议 MVP 实现）
- **Claude Code**（Anthropic 官方 CLI）— `~/.claude/settings.json`
- **Codex**（OpenAI 官方 CLI）— `~/.codex/config.toml`

#### 第二批（待规划）
- **Aider**（开源 AI 编程助手）— `~/.aider.conf.yml` / `~/.aider.model.settings.yml`
- **Gemini CLI**（Google 官方）— `~/.gemini/settings.json`
- **Continue**（开源 AI 编程助手，VSCode 扩展 + CLI）— `~/.continue/config.json`

#### 远期（仅占位）
- **codebuddy**（字节 AI 编程 IDE）— 配置文件待调研
- **Cursor**（基于 VSCode）— `~/.cursor/settings.json`
- **Zed**（AI 优先编辑器）— `~/.config/zed/settings.json`

---

## 二、Tab 内部结构

### 2.1 顶级布局：卡片网格

```
┌─ 更多平台 ────────────────────────────────────────────────┐
│  通过修改 IDE 自身的配置文件来自定义 API 端点。           │
│  切换后下次启动对应工具即可生效，无需保持 IDE BYOK 运行。 │
│                                                           │
│  [检测到 2 个可用工具] [全部刷新]                         │
│                                                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ Claude Code  │ │ Codex        │ │ Aider        │       │
│  │              │ │              │ │              │       │
│  │ Anthropic    │ │ OpenAI       │ │ 开源         │       │
│  │              │ │              │ │              │       │
│  │ ✅ 黑与白    │ │ ⏸ 未配置    │ │ ⏸ 未检测    │       │
│  │              │ │              │ │              │       │
│  │   [管理]     │ │   [管理]     │ │  [规划中]    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ Gemini CLI   │ │ Continue     │ │ Cursor       │       │
│  │              │ │              │ │              │       │
│  │ Google       │ │ 开源         │ │ Anysphere    │       │
│  │              │ │              │ │              │       │
│  │ ⏸ 未检测    │ │ ⏸ 未检测    │ │ ⏸ 未检测    │       │
│  │              │ │              │ │              │       │
│  │  [规划中]    │ │  [规划中]    │ │  [规划中]    │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
└───────────────────────────────────────────────────────────┘
```

### 2.2 卡片字段定义

每张卡片包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| 工具 logo | 图标 | 圆角方形 logo（用 SVG 或 emoji） |
| 工具名称 | 文本 | 主标题（如 "Claude Code"） |
| 厂商 | 文本 | 副标题（如 "Anthropic" / "OpenAI"） |
| 状态 | 标签 | 见下方状态枚举 |
| 操作按钮 | 按钮 | [管理] / [配置] / [切换] / [规划中] |

**状态枚举**：
- `✅ <供应商名>` — 已激活，当前使用此供应商
- `⏸ 未配置` — 已检测到工具，但未设置
- `⏸ 未检测` — 未检测到工具，可能未安装
- `⚠ 配置文件读写失败` — 检测到但权限不足
- `🔜 规划中` — 尚未实现

### 2.3 卡片右上角徽章

- 已实现：纯色背景（蓝/绿）
- 规划中：灰底 + 「即将支持」标签
- 检测失败：红底 + ⚠ 图标

---

## 三、子页面：单个平台管理

### 3.1 路由结构

`page-more-platforms` 是顶级 tab，内部用 **sub-page** 切换不同工具：

```
更多平台
├── 概览（卡片网格，默认）
├── Claude Code（id: page-platform-claude-code）
├── Codex（id: page-platform-codex）
└── ... 其他
```

切换 sub-page 不影响顶部 tab 高亮（"更多平台" 始终高亮）。

### 3.2 Claude Code 子页面

```
┌─ ← 返回更多平台  Claude Code ──────────────────────────────┐
│  Anthropic 官方 CLI · 自定义 API 端点                       │
│                                                            │
│  ┌─ 当前状态 ────────────────────────────────────────┐    │
│  │  ✅ 已激活「黑与白」                                │    │
│  │  配置文件：C:\Users\xxx\.claude\settings.json      │    │
│  │  最后切换：2026-06-11 20:30                         │    │
│  │  备份文件：settings.json.byok.bak (2026-06-10 18:00) │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌─ 切换供应商 ──────────────────────────────────────┐    │
│  │  选择要应用到 Claude Code 的供应商：              │    │
│  │  ┌──────────────────────────────────────────┐    │    │
│  │  │ ● 黑与白 (Anthropic → 127.0.0.1:3100)  │    │    │
│  │  │ ○ OpenAI 官方 (OpenAI → 官方 API)        │    │    │
│  │  │ ○ 我的中转站 (OpenAI → 自定义)           │    │    │
│  │  └──────────────────────────────────────────┘    │    │
│  │                                                    │    │
│  │  [预览要写入的 settings.json 片段]                 │    │
│  │  ┌──────────────────────────────────────────┐    │    │
│  │  │ {                                        │    │    │
│  │  │   "env": {                               │    │    │
│  │  │     "ANTHROPIC_BASE_URL": "http://...",  │    │    │
│  │  │     "ANTHROPIC_AUTH_TOKEN": "sk-***"     │    │    │
│  │  │   }                                       │    │    │
│  │  │ }                                        │    │    │
│  │  └──────────────────────────────────────────┘    │    │
│  │                                                    │    │
│  │  [应用并切换] [恢复备份]                           │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ┌─ 操作 ────────────────────────────────────────────┐    │
│  │  [在文件管理器中打开] [复制配置文件路径]           │    │
│  └────────────────────────────────────────────────────┘    │
│                                                            │
│  ⚠ 切换后需要重启 Claude Code 才能生效                    │
└────────────────────────────────────────────────────────────┘
```

### 3.3 Codex 子页面

类似 Claude Code，关键差异：
- 配置文件：`~/.codex/config.toml`（TOML 格式）
- 字段结构：`model_provider` + `[model_providers.<id>]` 块
- API key 单独写到 `auth.json`（不直接写在 config.toml）
- wire_api 选项：Responses / Chat Completions
- 切换前可预览 TOML 片段

---

## 四、数据模型

### 4.1 平台配置存储

```ts
// 每个平台一个状态文件
interface PlatformState {
  platformId: 'claude-code' | 'codex' | 'aider' | ...;
  isActive: boolean;
  currentProviderId: string | null;     // 关联到 providerStore
  configFilePath: string;                // 实际配置文件路径
  backupFilePath: string | null;         // 备份文件路径
  lastSwitchedAt: string | null;         // ISO 8601
  detectedAt: string | null;             // 首次检测到工具的时间
  detectionError: string | null;         // 检测失败的错误信息
}
```

### 4.2 文件存储

- 持久化：每个平台单独存到 `~/.ide-byok/platforms/<platformId>.json`
- 或者合并到现有的 `providerStore.json` 里，加 `platforms: { ... }` 字段

**推荐：合并到 providerStore.json**，减少文件 IO 复杂度

### 4.3 工具检测逻辑

```js
// 检测 Claude Code 是否安装
async function detectClaudeCode() {
  // 1. 检查 ~/.claude/ 目录是否存在
  // 2. 检查 ~/.claude/settings.json 是否存在
  // 3. 读取并解析 settings.json
  // 返回 { installed, configPath, currentConfig }
}

// 检测 Codex 是否安装
async function detectCodex() {
  // 1. 检查 ~/.codex/ 目录
  // 2. 检查 ~/.codex/config.toml
  // 返回 { installed, configPath, currentConfig }
}
```

---

## 五、后端命令（Tauri Commands）

### 5.1 平台管理命令

```rust
// 检测平台是否安装 + 读取当前配置
#[tauri::command]
async fn detect_platform(platform: String) -> Result<PlatformInfo, String>

// 切换供应商 → 写入 IDE 配置文件
#[tauri::command]
async fn switch_platform(
    platform: String,
    provider_id: String,
) -> Result<SwitchResult, String>

// 备份并还原
#[tauri::command]
async fn backup_platform_config(platform: String) -> Result<String, String>
#[tauri::command]
async fn restore_platform_config(platform: String) -> Result<(), String>

// 读取当前 live 配置（用于显示状态）
#[tauri::command]
async fn read_platform_config(platform: String) -> Result<PlatformConfig, String>
```

### 5.2 平台实现 Trait 抽象

```rust
trait PlatformHandler {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn vendor(&self) -> &'static str;
    fn config_path(&self) -> PathBuf;
    fn backup_path(&self) -> PathBuf;
    fn detect(&self) -> Result<PlatformInfo, AppError>;
    fn read_config(&self) -> Result<PlatformConfig, AppError>;
    fn apply(&self, provider: &Provider) -> Result<PlatformConfig, AppError>;
    fn restore(&self) -> Result<(), AppError>;
}
```

每个具体平台（ClaudeCode、Codex、Aider...）实现这个 trait，注册到 `PlatformRegistry`。

---

## 六、前端实现

### 6.1 页面结构

```html
<!-- 顶级 page：更多平台 -->
<div class="page" id="page-more-platforms" role="tabpanel">
  <!-- 卡片网格（默认） -->
  <div id="platforms-grid">...</div>
  
  <!-- Claude Code 子页面 -->
  <div class="page" id="page-platform-claude-code">...</div>
  
  <!-- Codex 子页面 -->
  <div class="page" id="page-platform-codex">...</div>
</div>
```

### 6.2 路由切换

复用现有 `navigateTo()` 函数：
- `navigateTo('more-platforms')` — 显示卡片网格
- `navigateTo('platform-claude-code')` — 显示 Claude Code 子页

注意：`pages` 是 `document.querySelectorAll('.page')` 选中所有 `.page`，**所有平台 sub-page 都要在 `pages` 数组里**，否则切换不生效。

### 6.3 复用现有组件

- 「切换供应商」的下拉列表：复用 `providerStore.providers`
- 「预览配置片段」的代码高亮：可以用 `highlight.js` 或简单的 `<pre><code>` 样式
- 备份管理：复用现有的「备份」样式（在 `40-modals.css` 里）

---

## 七、UX 细节

### 7.1 安全机制

#### 切换前
- **强制备份**：每次切换前自动备份到 `<config>.byok.bak`
- **备份文件存在性检查**：如果已有备份，提示用户「将覆盖现有备份」
- **配置文件权限检查**：如果是只读文件，提示用户

#### 切换中
- **写文件失败回滚**：如果写一半失败，自动从备份还原
- **实时显示进度**：写文件 → 验证 → 完成，三步状态

#### 切换后
- **不重启 IDE**：只改配置文件，重启 IDE 时生效
- **提供测试按钮**（可选）：如果是 Claude Code，可以点「在终端测试」调一次 `claude --version` 验证

### 7.2 错误处理

| 错误场景 | UI 表现 |
|---------|---------|
| `~/.claude/` 目录不存在 | 卡片显示「⏸ 未检测」+ 提示「请先安装 Claude Code」 |
| `settings.json` 存在但解析失败 | 卡片显示「⚠ 配置文件解析失败」+ [查看原始文件] 按钮 |
| 写文件权限不足 | 弹窗提示 + 提供「以管理员身份重试」选项（Windows） |
| 用户取消了文件读写 | 不显示错误，状态保持不变 |

### 7.3 平台启用检测

**启动时自动检测**：
```js
// 90-init.js 或 20-runtime.js 里加
async function detectAllPlatforms() {
  await Promise.all([
    detectClaudeCode(),
    detectCodex(),
  ]);
}
```

**手动刷新**：
- 卡片网格顶部 [全部刷新] 按钮
- 单个卡片 [重新检测] 按钮（hover 时显示）

### 7.4 国际化（i18n）

文案先硬编码中文，未来加 i18n 时抽离：
- "通过修改 IDE 自身的配置文件..."
- "切换后下次启动..."
- "已激活「<供应商名>」"
- "未配置 / 未检测 / 切换失败 / 规划中"

---

## 八、关键文件改动清单

| 文件 | 改动 | 工作量 |
|------|------|--------|
| `ui/index.html` | 加 `page-more-platforms` + `page-platform-claude-code` + `page-platform-codex` 的 HTML 结构 | 1 天 |
| `ui/assets/styles/40-modals.css` 或新文件 | 卡片网格 + 子页面的样式 | 半天 |
| `ui/assets/scripts/40-model-picker.js` 或新文件 `ui/assets/scripts/60-platforms.js` | 平台检测 + 切换 + UI 渲染 | 1 天 |
| `src-tauri/src/commands/platforms.rs`（新文件） | PlatformHandler trait + ClaudeCode/Codex 实现 | 1.5 天 |
| `src-tauri/src/lib.rs` | 注册新命令 | 10 分钟 |
| `src-tauri/src/commands/system.rs` | 扩展 `detect_target_ide` 支持新平台 | 30 分钟 |
| `sidecar/` | （可选）增加 CLI 工具的协议转换支持 | 0-2 天 |

**总工作量（不含 sidecar 改动）**：4-5 天

---

## 九、风险与缓解

### 风险 1：误改用户配置导致 Claude Code 不可用
**缓解**：
- 强制备份到 `*.byok.bak`
- 写文件前给用户看 diff 预览
- 写文件后给用户显示「如需回滚，点这里」

### 风险 2：跨平台路径差异
**缓解**：
- 用 `dirs` crate（Rust 端）+ 用户主目录探测
- macOS 特别注意：`/Users/xxx/.claude/` vs `~/Library/Application Support/`
- 实测 Win/Mac/Linux 三平台

### 风险 3：与现有 Windsurf 代理逻辑冲突
**缓解**：
- 平台切换不依赖 sidecar（独立功能）
- 但需要 sidecar 时（如想走本地代理），明确告知用户"需要先启动 Windsurf 代理"
- 文档里写清楚两者的关系

### 风险 4：未来加新平台时工作量大
**缓解**：
- 用 PlatformHandler trait 抽象，每加一个平台只要实现 6-7 个方法
- UI 上加一个卡片 + 一个 sub-page 模板

---

## 十、开发计划

### MVP（建议先做）
- Day 1：PlatformHandler trait 设计 + Claude Code 实现
- Day 2：Codex 实现 + 后端命令注册
- Day 3：「更多平台」tab 顶级结构 + 卡片网格 UI
- Day 4：Claude Code / Codex 子页面 + 切换流程
- Day 5：联调 + 跨平台测试 + 文档

### 第二批（待规划）
- Aider / Gemini CLI / Continue

### 远期
- Cursor / Zed / codebuddy

---

## 十一、UX 参考截图（未来实现时可参考）

### cc-switch 卡片布局
- https://github.com/farion1231/cc-switch（参考其 provider card 样式）

### cockpit-tools 平台选择
- https://github.com/<cockpit-tools-repo>（参考其工具切换页布局）

---

## 十二、待用户决策项

1. **平台状态文件存储位置**：
   - A. 合并到现有 `providerStore.json`（推荐）
   - B. 单独存到 `platforms/` 目录
   
2. **sub-page 路由方式**：
   - A. 复用现有 `navigateTo('platform-claude-code')`（推荐）
   - B. 在 sub-page 内用 modal/抽屉打开（不离开卡片网格）

3. **是否在切换前提供 diff 预览**：
   - A. 必须显示 diff（推荐，安全第一）
   - B. 简化掉，直接切换

4. **Aider / Gemini CLI / Continue 优先级**：
   - 用户调研下你最想要哪个先做

---

**文档完成。兄弟你看下，有问题继续讨论。**
