# Windsurf 模型缓存 Protobuf 解码复盘

调查时间：2026-06-06

---

## 一、背景

用户断网打开 Windsurf 实例4时，看到了完整的模型列表（含 Claude Opus 4.6/4.7/4.8 等未公开模型），但联网后列表刷新消失。需要从本地缓存中提取这些模型的完整信息（label + API ID）。

**核心问题**：Windsurf 的模型列表存储在哪里？如何解码？

---

## 二、存储位置

### 2.1 主要缓存：globalStorage/state.vscdb

路径：`{instance}/User/globalStorage/state.vscdb`（SQLite 数据库）

| Key | 内容 | 格式 |
|-----|------|------|
| `windsurfAuthStatus` | 账号状态 + 完整模型列表 | JSON（内含 Base64 protobuf） |
| `chat.modelsControl` | Free/Paid 模型快捷列表 | JSON |
| `codeium.windsurf` | 用户偏好（含上次选择的模型） | JSON |
| `windsurfConfigurations` | 配置信息 | JSON |

### 2.2 其他缓存

| 位置 | 内容 |
|------|------|
| `Local Storage/leveldb/*.ldb` | `model-price-cache`（定价信息）、会话记录 |
| `WebStorage/CacheStorage/` | windsurf-pool 插件前端 JS（含硬编码 modelPriority） |
| `workspaceStorage/{id}/state.vscdb` | sidebar webviewState（5MB+，不含模型列表） |

### 2.3 实例路径

| 实例 | 路径 | 数据完整度 |
|------|------|-----------|
| 实例4 | `.windsurf-pool/instances/aade59d2ad77e57e` | ★★★ 最完整 |
| 实例3 | `.antigravity_cockpit/instances/windsurf/eccbc87e4b5ce2fe` | ★☆☆ |
| 实例2 | `.antigravity_cockpit/instances/windsurf/c81e728d9d4c2f63` | ★★☆ |
| 默认 | `Windsurf/` | ★☆☆ |

---

## 三、Protobuf 解码过程

### 3.1 windsurfAuthStatus 结构

```json
{
  "allowedCommandModelConfigsProtoBinaryBase64": ["Base64...", "Base64...", ...],
  "userStatusProtoBinaryBase64": "Base64...",
  "userStatusProtoBinaryBase64Backup": "Base64...",
  ...
}
```

### 3.2 allowedCommandModelConfigs（快捷模型列表）

8 个 Base64 条目，每条是独立的 protobuf 消息：

```
message CommandModelConfig {
  string label = 1;           // "Claude 4.5 Sonnet"
  CommandModel model = 2;     // 嵌套消息
}

message CommandModel {
  int32 model_enum = 1;       // 220 = MODEL_PRIVATE_2
}
```

解码方式：直接解析 field 1 (string) + field 2.1 (varint)。

### 3.3 userStatusProtoBinaryBase64（完整模型列表）

68KB 的 protobuf，包含所有模型的完整信息。结构：

```
message UserStatus {
  ... (其他字段)
  repeated ModelConfig model_configs = 33;  // field 33
}

message ModelConfig {
  string label = 1;           // "Claude Opus 4.8 Medium"
  string api_id = 3;          // "claude-opus-4-8-medium"
  int32 context_window = 5;   // 128000
  ... (pricing, effort level 等)
}
```

**关键发现**：Claude 4.6/4.7/4.8 不使用 `MODEL_PRIVATE_*` 枚举，而是使用 API 级 ID（如 `claude-opus-4-8-max`）。

### 3.4 解码技巧

1. **提取 label + apiId 配对**：遍历 proto 的 field 33 → 子消息，找 field 1 (string) 和 field 3 (string) 的配对
2. **提取 MODEL_PRIVATE_* 枚举**：搜索 `0x08` tag + varint，范围 100-499，然后向前找 `0x0A` tag 的 label string
3. **Hex dump 定位**：对不确定的结构，直接 hex dump 原始字节观察

---

## 四、发现的新模型

### 4.1 Claude 4.6

| Label | API ID |
|-------|--------|
| Claude Opus 4.6 | `claude-opus-4-6` |
| Claude Opus 4.6 Thinking | `claude-opus-4-6-thinking` |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` |
| Claude Sonnet 4.6 Thinking | `claude-sonnet-4-6-thinking` |
| Claude Sonnet 4.6 1M | `claude-sonnet-4-6-1m` |
| Claude Sonnet 4.6 Thinking 1M | `claude-sonnet-4-6-thinking-1m` |

### 4.2 Claude 4.7（Effort Level 模式）

| Label | API ID |
|-------|--------|
| Claude Opus 4.7 Low | `claude-opus-4-7-low` |
| Claude Opus 4.7 Medium | `claude-opus-4-7-medium` |
| Claude Opus 4.7 High | `claude-opus-4-7-high` |
| Claude Opus 4.7 XHigh | `claude-opus-4-7-xhigh` |
| Claude Opus 4.7 Max | `claude-opus-4-7-max` |
| Claude Opus 4.7 Low Fast | `claude-opus-4-7-low-fast` |
| Claude Opus 4.7 Medium Fast | `claude-opus-4-7-medium-fast` |
| Claude Opus 4.7 High Fast | `claude-opus-4-7-high-fast` |
| Claude Opus 4.7 XHigh Fast | `claude-opus-4-7-xhigh-fast` |
| Claude Opus 4.7 Max Fast | `claude-opus-4-7-max-fast` |

### 4.3 Claude 4.8（同 4.7 Effort Level 模式）

10 个变体，API ID 格式：`claude-opus-4-8-{level}[-fast]`

### 4.4 GPT 系列

| 系列 | 变体数 | API ID 格式 |
|------|--------|-------------|
| GPT-5.2 | 14 | `MODEL_GPT_5_2_*` |
| GPT-5.3-Codex | 8 | `gpt-5-3-codex-{level}[-priority]` |
| GPT-5.4 | 14 | `gpt-5-4-{level}[-priority]` |
| GPT-5.4 Mini | 4 | `gpt-5-4-mini-{level}` |
| GPT-5.5 | 10 | `gpt-5-5-{level}[-priority]` |

### 4.5 其他新模型

| Label | API ID |
|-------|--------|
| Gemini 3.1 Pro Low/High Thinking | `gemini-3-1-pro-{level}` |
| Gemini 3.5 Flash Minimal/Low/Medium/High | `gemini-3-5-flash-{level}` |
| Kimi K2.5 | `kimi-k2-5` |
| Kimi K2.6 | `kimi-k2-6` |
| MiniMax M2.5 | `minimax-m2-5` |
| GLM-5.1 | `glm-5-1` |
| DeepSeek V4 Pro | `deepseek-v4` |
| SWE-1.6 / SWE-1.6 Fast | `swe-1-6[-fast]` |

---

## 五、MODEL_PRIVATE_* 枚举完整映射

从 proto 中提取的确认映射（17个）：

| Enum | UID | Label |
|------|-----|-------|
| 220 | MODEL_PRIVATE_2 | Claude Sonnet 4.5 |
| 221 | MODEL_PRIVATE_3 | Claude Sonnet 4.5 Thinking |
| 222 | MODEL_PRIVATE_4 | Grok Code Fast 1 |
| 314 | MODEL_PRIVATE_6 | GPT-5 Low Thinking |
| 315 | MODEL_PRIVATE_7 | GPT-5 Medium Thinking |
| 316 | MODEL_PRIVATE_8 | GPT-5 High Thinking |
| 317 | MODEL_PRIVATE_9 | GPT-5.1-Codex Medium |
| 347 | MODEL_PRIVATE_11 | Claude Haiku 4.5 |
| 348 | MODEL_PRIVATE_12 | GPT-5.1 No Thinking |
| 349 | MODEL_PRIVATE_13 | GPT-5.1 Low Thinking |
| 350 | MODEL_PRIVATE_14 | GPT-5.1 Medium Thinking |
| 351 | MODEL_PRIVATE_15 | GPT-5.1 High Thinking |
| 366 | MODEL_PRIVATE_19 | GPT-5.1-Codex-Mini |
| 367 | MODEL_PRIVATE_20 | GPT-5.1 No Thinking Fast |
| 372 | MODEL_PRIVATE_21 | GPT-5.1 Low Thinking Fast |
| 373 | MODEL_PRIVATE_22 | GPT-5.1 Medium Thinking Fast |
| 374 | MODEL_PRIVATE_23 | GPT-5.1 High Thinking Fast |

缺失的 13 个（1, 5, 10, 16-18, 24-30）：当前账户无权限访问，本地缓存中不存在。

---

## 六、架构变化总结

### 旧模式（Claude 4.5 及之前）
- 使用 `MODEL_PRIVATE_*` 枚举编号（Windsurf 内部 ID）
- Thinking 是独立模型（`MODEL_PRIVATE_2` vs `MODEL_PRIVATE_3`）
- 通过 `allowedCommandModelConfigs` 的 8 个快捷条目引用

### 新模式（Claude 4.7/4.8）
- 使用 API 级 ID（如 `claude-opus-4-8-max`）
- Effort Level 模式：同一基础模型有 Low/Medium/High/XHigh/Max 五档
- Fast 变体（`-fast` 后缀）对应 priority 模式
- 不再使用 `MODEL_PRIVATE_*` 枚举

---

## 七、踩坑记录

1. **vscdb 是 SQLite**：不是 LevelDB，需要用 `sqlite3` 读取 `ItemTable`
2. **Proto 嵌套深**：`userStatus` 的模型配置在 field 33 的二级嵌套中
3. **varint 误判**：`0x08` + varint 可能是 context window 大小（128000）而非模型枚举，需要范围过滤
4. **LevelDB 数据污染**：`model-price-cache` 的 JSON 被二进制噪声穿插，无法直接 JSON.parse
5. **CacheStorage 是前端 JS**：里面的 "Opus 4.6" 实际是 windsurf-pool 插件的硬编码默认值
6. **sidebar webviewState 不含模型列表**：5MB+ 的状态数据中搜索不到模型配置
7. **实例4 数据最完整**：其他实例的 proto 数据较小或缺少新模型

---

## 八、代码变更

- `src-tauri/src/commands/ide_models.rs`：`builtin_models()` 新增 80+ 模型条目
- `ide-models.json`：缓存更新至 182 个模型
- 后续重命名：`windsurf_models.rs` → `ide_models.rs`，`WindsurfModel` → `IdeModel`，`windsurf-models.json` → `ide-models.json`
