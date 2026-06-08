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
  field 33 → repeated ModelConfig  // 嵌套在 field 1 下
}

message ModelConfig {
  string label = 1;              // "Claude Opus 4.8 Medium"
  message model_or_alias = 2;    // 嵌套，含 model_enum (varint)
  float credit_multiplier = 3;   // ⚠️ 不是 api_id！是 float
  bool disabled = 4;            // 是否禁用
  bool supports_images = 5;
  enum provider = 10;            // 供应商
  int32 max_tokens = 18;         // context window
  string model_uid = 22;        // ★ 主 ID（新模型=API级ID，旧模型=MODEL_*枚举）
  message model_info = 23;      // ★ 隐藏 API ID 在这里！
  enum model_cost_tier = 24;
  message model_family_metadata = 30;
  repeated model_dimensions = 32;
}

message ModelInfo {  // field 23 的子消息
  string tokenizer = 5;          // "LLAMA_WITH_SPECIAL" / "CL100K_WITH_SPECIAL"
  string model_uid = 17;         // 重复 modelUid
  string server_url = 18;        // "https://server.codeium.com"
  string swe_api_id = 20;        // SWE 模型的 API ID（如 "swe-1p5"）
  string api_id = 23;            // ★ 隐藏的 API 级 ID（如 "claude-opus-4.5"、"o3"、"gpt-5.2"）
}
```

**关键发现**：
1. Claude 4.6/4.7/4.8 不使用 `MODEL_PRIVATE_*` 枚举，field 22 (modelUid) 直接就是 API 级 ID
2. **旧模型（MODEL_* 枚举）的 API ID 藏在 field 23 → sub-field 23**！如 `MODEL_CLAUDE_4_5_OPUS` → `claude-opus-4.5`，`MODEL_CHAT_O3` → `o3`
3. SWE 模型的 API ID 在 field 23 → sub-field 20，如 `MODEL_SWE_1_5_SLOW` → `swe-1p5`
4. field 3 是 `credit_multiplier`（float），**不是 api_id**，之前的解码结论有误

### 3.4 解码技巧

1. **提取 label + modelUid 配对**：遍历 proto 的 field 33 → field 1 子消息，找 field 1 (label string) 和 field 22 (modelUid string)
2. **提取隐藏 API ID**：对 MODEL_* 枚举的模型，解析 field 23 → sub-field 23（api_id）或 sub-field 20（swe_api_id）
3. **提取 MODEL_PRIVATE_* 枚举**：解析 field 2 → sub-field 1 (varint)，范围 100-499
4. **Hex dump 定位**：对不确定的结构，直接 hex dump 原始字节观察

### 3.5 完整提取结果（2026-06-06 重新提取）

从实例4 (`aade59d2ad77e57e`, `forbidut28@gmail.com`) 提取：

- **132 个模型**，**114 个有 API ID**（86%）
- 71 个新模型：field 22 直接就是 API 级 ID（如 `claude-opus-4-8-max`）
- 43 个旧模型：通过隐藏的 f23.f23/f23.f20 获取 API ID
- 18 个没有 API ID：4 个 BYOK（跳过）+ 14 个旧模型（GPT-4o, Grok-3 等，需手动映射）

完整数据导出：`scripts/inst4_models_full.json`

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

| 系列 | 变体数 | modelUid 格式 | 隐藏 API ID (f23.f23) |
|------|--------|---------------|----------------------|
| GPT-5.2 | 14 | `MODEL_GPT_5_2_*` | `gpt-5.2` |
| GPT-5.3-Codex | 8 | `gpt-5-3-codex-{level}[-fast]` | (field 22 即 API ID) |
| GPT-5.4 | 14 | `gpt-5-4-{level}[-priority]` | (field 22 即 API ID) |
| GPT-5.4 Mini | 4 | `gpt-5-4-mini-{level}` | (field 22 即 API ID) |
| GPT-5.5 | 10 | `gpt-5-5-{level}[-priority]` | (field 22 即 API ID) |

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

| Enum | UID | Label | 隐藏 API ID (f23.f23) |
|------|-----|-------|----------------------|
| 220 | MODEL_PRIVATE_2 | Claude Sonnet 4.5 | `claude-sonnet-4.5` |
| 221 | MODEL_PRIVATE_3 | Claude Sonnet 4.5 Thinking | `claude-sonnet-4.5` |
| 222 | MODEL_PRIVATE_4 | Grok Code Fast 1 | (无) |
| 314 | MODEL_PRIVATE_6 | GPT-5 Low Thinking | (无) |
| 315 | MODEL_PRIVATE_7 | GPT-5 Medium Thinking | (无) |
| 316 | MODEL_PRIVATE_8 | GPT-5 High Thinking | (无) |
| 317 | MODEL_PRIVATE_9 | GPT-5.1-Codex Medium | (无) |
| 347 | MODEL_PRIVATE_11 | Claude Haiku 4.5 | (无) |
| 348 | MODEL_PRIVATE_12 | GPT-5.1 No Thinking | `gpt-5.1` |
| 349 | MODEL_PRIVATE_13 | GPT-5.1 Low Thinking | `gpt-5.1` |
| 350 | MODEL_PRIVATE_14 | GPT-5.1 Medium Thinking | `gpt-5.1` |
| 351 | MODEL_PRIVATE_15 | GPT-5.1 High Thinking | `gpt-5.1` |
| 366 | MODEL_PRIVATE_19 | GPT-5.1-Codex-Mini | (无) |
| 367 | MODEL_PRIVATE_20 | GPT-5.1 No Thinking Fast | `gpt-5.1` |
| 372 | MODEL_PRIVATE_21 | GPT-5.1 Low Thinking Fast | `gpt-5.1` |
| 373 | MODEL_PRIVATE_22 | GPT-5.1 Medium Thinking Fast | `gpt-5.1` |
| 374 | MODEL_PRIVATE_23 | GPT-5.1 High Thinking Fast | `gpt-5.1` |

缺失的 13 个（1, 5, 10, 16-18, 24-30）：当前账户无权限访问，本地缓存中不存在。

### 其他 MODEL_* 枚举的隐藏 API ID

| modelUid | Label | 隐藏 API ID (f23.f23) |
|----------|-------|----------------------|
| MODEL_CLAUDE_4_5_OPUS | Claude Opus 4.5 | `claude-opus-4.5` |
| MODEL_CLAUDE_4_5_OPUS_THINKING | Claude Opus 4.5 Thinking | `claude-opus-4.5` |
| MODEL_CHAT_O3 | o3 | `o3` |
| MODEL_CHAT_O3_HIGH | o3 High Reasoning | `o3` |
| MODEL_GPT_5_2_HIGH | GPT-5.2 High Thinking | `gpt-5.2` |
| MODEL_GPT_5_2_* (14个) | GPT-5.2 系列 | `gpt-5.2` |
| MODEL_SWE_1_5_SLOW | SWE-1.5 | `swe-1p5` (f23.f20) |
| MODEL_SWE_1_5 | SWE-1.5 Fast | `swe-1p5` (f23.f20) |

⚠️ 注意：同族模型（如 GPT-5.2 的 14 个 effort 变体）共享同一个基础 API ID `gpt-5.2`，effort 级别由 Windsurf 服务端根据 modelUid 区分。

---

## 六、架构变化总结

### 旧模式（Claude 4.5 及之前）
- 使用 `MODEL_PRIVATE_*` 或 `MODEL_*` 枚举编号（Windsurf 内部 ID）作为 field 22 (modelUid)
- Thinking 是独立模型（`MODEL_PRIVATE_2` vs `MODEL_PRIVATE_3`）
- 通过 `allowedCommandModelConfigs` 的 8 个快捷条目引用
- **隐藏 API ID 在 field 23 → sub-field 23**，但不是所有旧模型都有

### 新模式（Claude 4.6/4.7/4.8）
- field 22 (modelUid) 直接使用 API 级 ID（如 `claude-opus-4-8-max`）
- Effort Level 模式：同一基础模型有 Low/Medium/High/XHigh/Max 五档
- Fast 变体（`-fast` 后缀）对应 priority 模式
- 不再使用 `MODEL_PRIVATE_*` 枚举
- field 23 → sub-field 23 仍然存在，但与 field 22 值相同（冗余）

---

## 七、踩坑记录

1. **vscdb 是 SQLite**：不是 LevelDB，需要用 `sqlite3` 读取 `ItemTable`
2. **Proto 嵌套深**：`userStatus` 的模型配置在 field 33 的二级嵌套中
3. **varint 误判**：`0x08` + varint 可能是 context window 大小（128000）而非模型枚举，需要范围过滤
4. **LevelDB 数据污染**：`model-price-cache` 的 JSON 被二进制噪声穿插，无法直接 JSON.parse
5. **CacheStorage 是前端 JS**：里面的 "Opus 4.6" 实际是 windsurf-pool 插件的硬编码默认值
6. **sidebar webviewState 不含模型列表**：5MB+ 的状态数据中搜索不到模型配置
7. **实例4 数据最完整**：其他实例的 proto 数据较小或缺少新模型
8. **field 3 不是 api_id**：之前误判 field 3 为 api_id，实际是 `credit_multiplier`（float 类型）。真正的 modelUid 在 field 22，隐藏的 API ID 在 field 23 → sub-field 23
9. **field 33 的嵌套结构**：field 33 不是直接包含 ModelConfig 列表，而是 field 33 → field 1 → ModelConfig。field 33 下还有 field 2（分组元数据：Recommended/Provider/Cost）和 field 3（额外配置）

---

## 八、代码变更

- `src-tauri/src/commands/ide_models.rs`：`builtin_models()` 新增 80+ 模型条目
- `ide-models.json`：缓存更新至 182 个模型
- 后续重命名：`windsurf_models.rs` → `ide_models.rs`，`WindsurfModel` → `IdeModel`，`windsurf-models.json` → `ide-models.json`

## 九、2026-06-06 重新提取（修正版）

之前的提取有误：field 3 被误认为 api_id，实际是 credit_multiplier (float)。
重新提取后：

- **132 个模型**，**114 个有 API ID**
- 新模型（71个）：field 22 直接就是 API 级 ID
- 旧模型（43个）：通过 field 23 → sub-field 23/20 获取隐藏 API ID
- 18 个无 API ID：4 BYOK + 14 旧模型（需手动映射）
- 完整数据：`scripts/inst4_models_full.json`
