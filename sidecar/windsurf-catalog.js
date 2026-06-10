// windsurf-catalog.js — Windsurf 模型全量目录
// 数据源: scripts/inst4_models_full.json + 本地 windsurfAuthStatus 增量抓取
// 最终 129 条
//
// 字段:
//   label          Windsurf 显示名 (GetUserStatus.field1)
//   modelUid       Windsurf 内部 ID (GetUserStatus.field22)，注入项直接用
//   apiId          BYOK 供应商端实际 API ID (无 apiId 时退化用 modelUid)
//   contextWindow  上下文 token 数
//   supportsImages 是否支持图片输入 (proto3 field5)
//   tag            分类 (chat/codex/swe) — 用于 GUI 分组显示
//
// 一一对应原则: 注入项的 modelUid 必须 == Windsurf 真实 ID，禁止共用骨架

export const WINDSURF_CATALOG = [
  {
    "label": "Claude 5 Fable Medium",
    "modelUid": "claude-5-fable-medium",
    "apiId": "claude-5-fable",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Haiku 4.5",
    "modelUid": "MODEL_PRIVATE_11",
    "apiId": null,
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.5",
    "modelUid": "MODEL_CLAUDE_4_5_OPUS",
    "apiId": "claude-opus-4.5",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.5 Thinking",
    "modelUid": "MODEL_CLAUDE_4_5_OPUS_THINKING",
    "apiId": "claude-opus-4.5",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.6",
    "modelUid": "claude-opus-4-6",
    "apiId": "claude-opus-4-6",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.6 Thinking",
    "modelUid": "claude-opus-4-6-thinking",
    "apiId": "claude-opus-4-6-thinking",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 High",
    "modelUid": "claude-opus-4-7-high",
    "apiId": "claude-opus-4-7-high",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 High Fast",
    "modelUid": "claude-opus-4-7-high-fast",
    "apiId": "claude-opus-4-7-high-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 Low",
    "modelUid": "claude-opus-4-7-low",
    "apiId": "claude-opus-4-7-low",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 Low Fast",
    "modelUid": "claude-opus-4-7-low-fast",
    "apiId": "claude-opus-4-7-low-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 Max",
    "modelUid": "claude-opus-4-7-max",
    "apiId": "claude-opus-4-7-max",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 Max Fast",
    "modelUid": "claude-opus-4-7-max-fast",
    "apiId": "claude-opus-4-7-max-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 Medium",
    "modelUid": "claude-opus-4-7-medium",
    "apiId": "claude-opus-4-7-medium",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 Medium Fast",
    "modelUid": "claude-opus-4-7-medium-fast",
    "apiId": "claude-opus-4-7-medium-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 XHigh",
    "modelUid": "claude-opus-4-7-xhigh",
    "apiId": "claude-opus-4-7-xhigh",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.7 XHigh Fast",
    "modelUid": "claude-opus-4-7-xhigh-fast",
    "apiId": "claude-opus-4-7-xhigh-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 High",
    "modelUid": "claude-opus-4-8-high",
    "apiId": "claude-opus-4-8-high",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 High Fast",
    "modelUid": "claude-opus-4-8-high-fast",
    "apiId": "claude-opus-4-8-high-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 Low",
    "modelUid": "claude-opus-4-8-low",
    "apiId": "claude-opus-4-8-low",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 Low Fast",
    "modelUid": "claude-opus-4-8-low-fast",
    "apiId": "claude-opus-4-8-low-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 Max",
    "modelUid": "claude-opus-4-8-max",
    "apiId": "claude-opus-4-8-max",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 Max Fast",
    "modelUid": "claude-opus-4-8-max-fast",
    "apiId": "claude-opus-4-8-max-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 Medium",
    "modelUid": "claude-opus-4-8-medium",
    "apiId": "claude-opus-4-8-medium",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 Medium Fast",
    "modelUid": "claude-opus-4-8-medium-fast",
    "apiId": "claude-opus-4-8-medium-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 XHigh",
    "modelUid": "claude-opus-4-8-xhigh",
    "apiId": "claude-opus-4-8-xhigh",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Opus 4.8 XHigh Fast",
    "modelUid": "claude-opus-4-8-xhigh-fast",
    "apiId": "claude-opus-4-8-xhigh-fast",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Sonnet 4.5",
    "modelUid": "MODEL_PRIVATE_2",
    "apiId": "claude-sonnet-4.5",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Sonnet 4.5 Thinking",
    "modelUid": "MODEL_PRIVATE_3",
    "apiId": "claude-sonnet-4.5",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Sonnet 4.6",
    "modelUid": "claude-sonnet-4-6",
    "apiId": "claude-sonnet-4-6",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Sonnet 4.6 1M",
    "modelUid": "claude-sonnet-4-6-1m",
    "apiId": "claude-sonnet-4-6-1m",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Sonnet 4.6 Thinking",
    "modelUid": "claude-sonnet-4-6-thinking",
    "apiId": "claude-sonnet-4-6-thinking",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Claude Sonnet 4.6 Thinking 1M",
    "modelUid": "claude-sonnet-4-6-thinking-1m",
    "apiId": "claude-sonnet-4-6-thinking-1m",
    "contextWindow": 1000000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "DeepSeek V4 Pro",
    "modelUid": "deepseek-v4",
    "apiId": "deepseek-v4",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 2.5 Pro",
    "modelUid": "MODEL_GOOGLE_GEMINI_2_5_PRO",
    "apiId": null,
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": "gemini-..."
  },
  {
    "label": "Gemini 3 Flash High",
    "modelUid": "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
    "apiId": "gemini-3.0-flash",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3 Flash Low",
    "modelUid": "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
    "apiId": "gemini-3.0-flash",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3 Flash Medium",
    "modelUid": "MODEL_GOOGLE_GEMINI_3_0_FLASH_MEDIUM",
    "apiId": "gemini-3.0-flash",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3 Flash Minimal",
    "modelUid": "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
    "apiId": "gemini-3.0-flash",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3.1 Pro High Thinking",
    "modelUid": "gemini-3-1-pro-high",
    "apiId": "gemini-3-1-pro-high",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3.1 Pro Low Thinking",
    "modelUid": "gemini-3-1-pro-low",
    "apiId": "gemini-3-1-pro-low",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3.5 Flash High",
    "modelUid": "gemini-3-5-flash-high",
    "apiId": "gemini-3-5-flash-high",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3.5 Flash Low",
    "modelUid": "gemini-3-5-flash-low",
    "apiId": "gemini-3-5-flash-low",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3.5 Flash Medium",
    "modelUid": "gemini-3-5-flash-medium",
    "apiId": "gemini-3-5-flash-medium",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Gemini 3.5 Flash Minimal",
    "modelUid": "gemini-3-5-flash-minimal",
    "apiId": "gemini-3-5-flash-minimal",
    "contextWindow": 1048576,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GLM-5.1",
    "modelUid": "glm-5-1",
    "apiId": "glm-5-1",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-4.1",
    "modelUid": "MODEL_CHAT_GPT_4_1_2025_04_14",
    "apiId": null,
    "contextWindow": 1047576,
    "supportsImages": true,
    "noApiIdHint": "gpt-... (gpt-4o, gpt-5, gpt-5.1, gpt-5.2...)"
  },
  {
    "label": "GPT-4o",
    "modelUid": "MODEL_CHAT_GPT_4O_2024_08_06",
    "apiId": null,
    "contextWindow": 128000,
    "supportsImages": true,
    "noApiIdHint": "gpt-... (gpt-4o, gpt-5, gpt-5.1, gpt-5.2...)"
  },
  {
    "label": "GPT-5 High Thinking",
    "modelUid": "MODEL_PRIVATE_8",
    "apiId": null,
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5 Low Thinking",
    "modelUid": "MODEL_PRIVATE_6",
    "apiId": null,
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5 Medium Thinking",
    "modelUid": "MODEL_PRIVATE_7",
    "apiId": null,
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5-Codex",
    "modelUid": "MODEL_CHAT_GPT_5_CODEX",
    "apiId": null,
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": "gpt-... (gpt-4o, gpt-5, gpt-5.1, gpt-5.2...)"
  },
  {
    "label": "GPT-5.1 High Thinking",
    "modelUid": "MODEL_PRIVATE_15",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 High Thinking Fast",
    "modelUid": "MODEL_PRIVATE_23",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 Low Thinking",
    "modelUid": "MODEL_PRIVATE_13",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 Low Thinking Fast",
    "modelUid": "MODEL_PRIVATE_21",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 Medium Thinking",
    "modelUid": "MODEL_PRIVATE_14",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 Medium Thinking Fast",
    "modelUid": "MODEL_PRIVATE_22",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 No Thinking",
    "modelUid": "MODEL_PRIVATE_12",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1 No Thinking Fast",
    "modelUid": "MODEL_PRIVATE_20",
    "apiId": "gpt-5.1",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex Low",
    "modelUid": "MODEL_GPT_5_1_CODEX_LOW",
    "apiId": "gpt-5.1-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex Max High",
    "modelUid": "MODEL_GPT_5_1_CODEX_MAX_HIGH",
    "apiId": "gpt-5.1-codex-max",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex Max Low",
    "modelUid": "MODEL_GPT_5_1_CODEX_MAX_LOW",
    "apiId": "gpt-5.1-codex-max",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex Max Medium",
    "modelUid": "MODEL_GPT_5_1_CODEX_MAX_MEDIUM",
    "apiId": "gpt-5.1-codex-max",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex Medium",
    "modelUid": "MODEL_PRIVATE_9",
    "apiId": null,
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex-Mini",
    "modelUid": "MODEL_PRIVATE_19",
    "apiId": null,
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.1-Codex-Mini Low",
    "modelUid": "MODEL_GPT_5_1_CODEX_MINI_LOW",
    "apiId": "gpt-5.1-codex-mini",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 High Thinking",
    "modelUid": "MODEL_GPT_5_2_HIGH",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 High Thinking Fast",
    "modelUid": "MODEL_GPT_5_2_HIGH_PRIORITY",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 Low Thinking",
    "modelUid": "MODEL_GPT_5_2_LOW",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 Low Thinking Fast",
    "modelUid": "MODEL_GPT_5_2_LOW_PRIORITY",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 Medium Thinking",
    "modelUid": "MODEL_GPT_5_2_MEDIUM",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 Medium Thinking Fast",
    "modelUid": "MODEL_GPT_5_2_MEDIUM_PRIORITY",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 No Thinking",
    "modelUid": "MODEL_GPT_5_2_NONE",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 No Thinking Fast",
    "modelUid": "MODEL_GPT_5_2_NONE_PRIORITY",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 XHigh Thinking",
    "modelUid": "MODEL_GPT_5_2_XHIGH",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2 XHigh Thinking Fast",
    "modelUid": "MODEL_GPT_5_2_XHIGH_PRIORITY",
    "apiId": "gpt-5.2",
    "contextWindow": 384000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex High",
    "modelUid": "MODEL_GPT_5_2_CODEX_HIGH",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex High Fast",
    "modelUid": "MODEL_GPT_5_2_CODEX_HIGH_PRIORITY",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex Low",
    "modelUid": "MODEL_GPT_5_2_CODEX_LOW",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex Low Fast",
    "modelUid": "MODEL_GPT_5_2_CODEX_LOW_PRIORITY",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex Medium",
    "modelUid": "MODEL_GPT_5_2_CODEX_MEDIUM",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex Medium Fast",
    "modelUid": "MODEL_GPT_5_2_CODEX_MEDIUM_PRIORITY",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex XHigh",
    "modelUid": "MODEL_GPT_5_2_CODEX_XHIGH",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.2-Codex XHigh Fast",
    "modelUid": "MODEL_GPT_5_2_CODEX_XHIGH_PRIORITY",
    "apiId": "gpt-5.2-codex",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex High",
    "modelUid": "gpt-5-3-codex-high",
    "apiId": "gpt-5-3-codex-high",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex High Fast",
    "modelUid": "gpt-5-3-codex-high-priority",
    "apiId": "gpt-5-3-codex-high-priority",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex Low",
    "modelUid": "gpt-5-3-codex-low",
    "apiId": "gpt-5-3-codex-low",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex Low Fast",
    "modelUid": "gpt-5-3-codex-low-priority",
    "apiId": "gpt-5-3-codex-low-priority",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex Medium",
    "modelUid": "gpt-5-3-codex-medium",
    "apiId": "gpt-5-3-codex-medium",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex Medium Fast",
    "modelUid": "gpt-5-3-codex-medium-priority",
    "apiId": "gpt-5-3-codex-medium-priority",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex X-High",
    "modelUid": "gpt-5-3-codex-xhigh",
    "apiId": "gpt-5-3-codex-xhigh",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.3-Codex XHigh Fast",
    "modelUid": "gpt-5-3-codex-xhigh-priority",
    "apiId": "gpt-5-3-codex-xhigh-priority",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 High Thinking",
    "modelUid": "gpt-5-4-high",
    "apiId": "gpt-5-4-high",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 High Thinking Fast",
    "modelUid": "gpt-5-4-high-priority",
    "apiId": "gpt-5-4-high-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Low Thinking",
    "modelUid": "gpt-5-4-low",
    "apiId": "gpt-5-4-low",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Low Thinking Fast",
    "modelUid": "gpt-5-4-low-priority",
    "apiId": "gpt-5-4-low-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Medium Thinking",
    "modelUid": "gpt-5-4-medium",
    "apiId": "gpt-5-4-medium",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Medium Thinking Fast",
    "modelUid": "gpt-5-4-medium-priority",
    "apiId": "gpt-5-4-medium-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Mini High Thinking",
    "modelUid": "gpt-5-4-mini-high",
    "apiId": "gpt-5-4-mini-high",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Mini Low Thinking",
    "modelUid": "gpt-5-4-mini-low",
    "apiId": "gpt-5-4-mini-low",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Mini Medium Thinking",
    "modelUid": "gpt-5-4-mini-medium",
    "apiId": "gpt-5-4-mini-medium",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 Mini XHigh Thinking",
    "modelUid": "gpt-5-4-mini-xhigh",
    "apiId": "gpt-5-4-mini-xhigh",
    "contextWindow": 400000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 No Thinking",
    "modelUid": "gpt-5-4-none",
    "apiId": "gpt-5-4-none",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 No Thinking Fast",
    "modelUid": "gpt-5-4-none-priority",
    "apiId": "gpt-5-4-none-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 XHigh Thinking",
    "modelUid": "gpt-5-4-xhigh",
    "apiId": "gpt-5-4-xhigh",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.4 XHigh Thinking Fast",
    "modelUid": "gpt-5-4-xhigh-priority",
    "apiId": "gpt-5-4-xhigh-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 High Thinking",
    "modelUid": "gpt-5-5-high",
    "apiId": "gpt-5-5-high",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 High Thinking Fast",
    "modelUid": "gpt-5-5-high-priority",
    "apiId": "gpt-5-5-high-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 Low Thinking",
    "modelUid": "gpt-5-5-low",
    "apiId": "gpt-5-5-low",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 Low Thinking Fast",
    "modelUid": "gpt-5-5-low-priority",
    "apiId": "gpt-5-5-low-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 Medium Thinking",
    "modelUid": "gpt-5-5-medium",
    "apiId": "gpt-5-5-medium",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 Medium Thinking Fast",
    "modelUid": "gpt-5-5-medium-priority",
    "apiId": "gpt-5-5-medium-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 No Thinking",
    "modelUid": "gpt-5-5-none",
    "apiId": "gpt-5-5-none",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 No Thinking Fast",
    "modelUid": "gpt-5-5-none-priority",
    "apiId": "gpt-5-5-none-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 XHigh Thinking",
    "modelUid": "gpt-5-5-xhigh",
    "apiId": "gpt-5-5-xhigh",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-5.5 XHigh Thinking Fast",
    "modelUid": "gpt-5-5-xhigh-priority",
    "apiId": "gpt-5-5-xhigh-priority",
    "contextWindow": 272000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "GPT-OSS 120B Medium Thinking",
    "modelUid": "MODEL_GPT_OSS_120B",
    "apiId": null,
    "contextWindow": 128000,
    "supportsImages": true,
    "noApiIdHint": "gpt-... (gpt-4o, gpt-5, gpt-5.1, gpt-5.2...)"
  },
  {
    "label": "Grok Code Fast 1",
    "modelUid": "MODEL_PRIVATE_4",
    "apiId": null,
    "contextWindow": 256000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Kimi K2.5",
    "modelUid": "kimi-k2-5",
    "apiId": "kimi-k2-5",
    "contextWindow": 262144,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Kimi K2.6",
    "modelUid": "kimi-k2-6",
    "apiId": "kimi-k2-6",
    "contextWindow": 262144,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "Minimax M2.5",
    "modelUid": "minimax-m2-5",
    "apiId": "minimax-m2-5",
    "contextWindow": 204800,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "o3",
    "modelUid": "MODEL_CHAT_O3",
    "apiId": "o3",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "o3 High Reasoning",
    "modelUid": "MODEL_CHAT_O3_HIGH",
    "apiId": "o3",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "SWE-1.5",
    "modelUid": "MODEL_SWE_1_5_SLOW",
    "apiId": "swe-1p5",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "SWE-1.5 Fast",
    "modelUid": "MODEL_SWE_1_5",
    "apiId": "swe-1p5",
    "contextWindow": 128000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "SWE-1.6",
    "modelUid": "swe-1-6",
    "apiId": "swe-1-6",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "SWE-1.6 Fast",
    "modelUid": "swe-1-6-fast",
    "apiId": "swe-1-6-fast",
    "contextWindow": 200000,
    "supportsImages": true,
    "noApiIdHint": null
  },
  {
    "label": "xAI Grok-3",
    "modelUid": "MODEL_XAI_GROK_3",
    "apiId": null,
    "contextWindow": 131072,
    "supportsImages": false,
    "noApiIdHint": "grok-3 / grok-3-mini"
  },
  {
    "label": "xAI Grok-3 mini Thinking",
    "modelUid": "MODEL_XAI_GROK_3_MINI_REASONING",
    "apiId": null,
    "contextWindow": 131072,
    "supportsImages": false,
    "noApiIdHint": "grok-3 / grok-3-mini"
  }
];

// 辅助: 分类 (用于 GUI 渲染)
export function catalogTag(m) {
  const uid = String(m.modelUid || '');
  if (/CODEX|codex/i.test(uid) || /codex/i.test(m.label)) return 'codex';
  if (/SWE|swe/i.test(uid) || /SWE/i.test(m.label)) return 'swe';
  return 'chat';
}
