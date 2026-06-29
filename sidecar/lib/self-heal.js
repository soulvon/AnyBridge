// self-heal.js — 智能重试（Self-Heal Retry）
//
// 错误驱动的请求自愈：上游返回特定错误时，先修复请求体再重试，而不是原样重发。
// 三个整流器：签名（thinking signature）、预算（thinking budget）、媒体（unsupported image）。
// 逻辑 1:1 对齐 cc-switch 的 thinking_rectifier / thinking_budget_rectifier / media_sanitizer。
//
// 设计原则：
// - 仅在「上游已报错」后触发（错误驱动），不做发送前预测式降级。
// - 整流未生效（无可整流内容）时不重试，照常暴露错误。
// - 每个整流器在一次请求生命周期内最多触发一次，防止无限循环。

export const UNSUPPORTED_IMAGE_MARKER = '[Unsupported Image]';
export const MAX_THINKING_BUDGET = 32000;
export const MAX_TOKENS_VALUE = 64000;
// max_tokens 必须大于 budget_tokens
const MIN_MAX_TOKENS_FOR_BUDGET = MAX_THINKING_BUDGET + 1;

// 默认全开；可通过 model-map.json enhancement.selfHeal 覆盖
export const DEFAULT_SELF_HEAL_CONFIG = Object.freeze({
  enabled: true,
  signature: true,
  budget: true,
  media: true,
});

// ==================== 错误检测 ====================

/// 检测是否需要触发 thinking 签名整流器
///
/// 匹配 7 类上游错误（大小写不敏感 substring）。传原始响应文本即可，
/// 内部不截断，天然兼容嵌套 JSON 错误消息。
export function shouldHealThinkingSignature(errorText, cfg) {
  if (!cfg?.enabled) return false;
  if (!cfg.signature) return false;

  if (!errorText) return false;
  const lower = String(errorText).toLowerCase();

  // 场景1: thinking block 中的签名无效
  // "Invalid 'signature' in 'thinking' block"
  if (lower.includes('invalid')
    && lower.includes('signature')
    && lower.includes('thinking')
    && lower.includes('block')) {
    return true;
  }

  // 场景1b: Gemini/第三方渠道 "Thought signature is not valid"
  if (lower.includes('thought signature')
    && (lower.includes('not valid') || lower.includes('invalid'))) {
    return true;
  }

  // 场景2: assistant 消息必须以 thinking block 开头
  if (lower.includes('must start with a thinking block')) {
    return true;
  }

  // 场景3: expected thinking or redacted_thinking, found tool_use
  // 要求明确包含 tool_use，避免过宽匹配
  if (lower.includes('expected')
    && (lower.includes('thinking') || lower.includes('redacted_thinking'))
    && lower.includes('found')
    && lower.includes('tool_use')) {
    return true;
  }

  // 场景4: signature 字段必需但缺失
  if (lower.includes('signature') && lower.includes('field required')) {
    return true;
  }

  // 场景5: signature 字段不被接受（第三方渠道）
  if (lower.includes('signature')
    && (lower.includes('extra inputs are not permitted')
      || lower.includes('extra inputs not permitted'))) {
    return true;
  }

  // 场景6: thinking/redacted_thinking 块被修改
  if ((lower.includes('thinking') || lower.includes('redacted_thinking'))
    && lower.includes('cannot be modified')) {
    return true;
  }

  // 场景7: 非法请求（统一兜底，与 CCH 对齐）
  if (lower.includes('非法请求')
    || lower.includes('illegal request')
    || lower.includes('invalid request')) {
    return true;
  }

  return false;
}

/// 检测是否需要触发 thinking budget 整流器
///
/// 检测条件：error message 同时包含 budget_tokens + thinking + 1024 约束
export function shouldHealThinkingBudget(errorText, cfg) {
  if (!cfg?.enabled) return false;
  if (!cfg.budget) return false;

  if (!errorText) return false;
  const lower = String(errorText).toLowerCase();

  const hasBudgetTokensReference =
    lower.includes('budget_tokens') || lower.includes('budget tokens');
  const hasThinkingReference = lower.includes('thinking');
  const has1024Constraint =
    lower.includes('greater than or equal to 1024')
    || lower.includes('>= 1024')
    || (lower.includes('1024') && lower.includes('input should be'));

  return hasBudgetTokensReference && hasThinkingReference && has1024Constraint;
}

/// 检测上游错误是否为「不支持图片输入」
///
/// status ∈ {400,415,422,501} 且 message 含图片相关关键词 + 不支持提示
export function isUnsupportedImageError(statusCode, errorText) {
  const status = Number(statusCode) || 0;
  if (![400, 415, 422, 501].includes(status)) return false;

  const message = extractErrorText(errorText).toLowerCase();

  const mentionsImage =
    message.includes('image')
    || message.includes('vision')
    || message.includes('multimodal')
    || message.includes('multi-modal')
    || message.includes('modality')
    || message.includes('modalities')
    || message.includes('media')
    || message.includes('attachment');

  if (!mentionsImage) return false;

  const unsupportedHints = [
    'unsupported',
    'not supported',
    'does not support',
    "doesn't support",
    'do not support',
    "don't support",
    'only supports text',
    'text only',
    'text-only',
    'invalid content type',
    'invalid message content',
    'unknown variant',
    'unknown content type',
    'unrecognized content type',
    'cannot process',
    'cannot handle',
    "can't process",
    "can't handle",
    'unable to process',
  ];

  return unsupportedHints.some(hint => message.includes(hint));
}

// ==================== 整流动作 ====================

/// 签名整流：对 Anthropic 请求体做最小侵入修复
///
/// - 移除 messages[*].content 中的 thinking/redacted_thinking block
/// - 移除非 thinking block 上遗留的 signature 字段
/// - 特定条件下删除顶层 thinking 字段
///
/// 原地修改 body 对象，返回整流统计。
export function healThinkingSignature(body) {
  const result = {
    applied: false,
    removedThinkingBlocks: 0,
    removedRedactedThinkingBlocks: 0,
    removedSignatureFields: 0,
  };

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages) return result;

  for (const msg of messages) {
    const content = Array.isArray(msg?.content) ? msg.content : null;
    if (!content) continue;

    const newContent = [];
    let contentModified = false;

    for (const block of content) {
      const blockType = block?.type;

      if (blockType === 'thinking') {
        result.removedThinkingBlocks += 1;
        contentModified = true;
        continue;
      }
      if (blockType === 'redacted_thinking') {
        result.removedRedactedThinkingBlocks += 1;
        contentModified = true;
        continue;
      }

      // 移除非 thinking block 上的 signature 字段
      if (block && typeof block === 'object' && Object.prototype.hasOwnProperty.call(block, 'signature')) {
        const cloned = { ...block };
        delete cloned.signature;
        result.removedSignatureFields += 1;
        contentModified = true;
        newContent.push(cloned);
        continue;
      }

      newContent.push(block);
    }

    if (contentModified) {
      result.applied = true;
      msg.content = newContent;
    }
  }

  // 兜底：thinking 启用 + 工具调用链路中最后一条 assistant 消息未以 thinking 开头
  if (shouldRemoveTopLevelThinking(body, messages)) {
    delete body.thinking;
    result.applied = true;
  }

  return result;
}

/// 预算整流：调整 thinking budget 参数
///
/// - adaptive 请求不改写（直接返回 applied=false）
/// - 否则设 thinking.type=enabled, budget_tokens=32000
/// - max_tokens 缺失或 < 32001 时设为 64000
///
/// 原地修改 body 对象，返回整流前后快照。
export function healThinkingBudget(body) {
  const before = snapshotBudget(body);

  // adaptive 请求不改写
  if (before.thinkingType === 'adaptive') {
    return { applied: false, before, after: before };
  }

  // 缺少/非法 thinking 时自动创建后再整流
  if (!body.thinking || typeof body.thinking !== 'object' || Array.isArray(body.thinking)) {
    body.thinking = {};
  }

  const thinking = body.thinking;
  thinking.type = 'enabled';
  thinking.budget_tokens = MAX_THINKING_BUDGET;

  if (before.maxTokens === null || before.maxTokens < MIN_MAX_TOKENS_FOR_BUDGET) {
    body.max_tokens = MAX_TOKENS_VALUE;
  }

  const after = snapshotBudget(body);
  return { applied: !budgetSnapshotEqual(before, after), before, after };
}

/// 媒体整流：把请求体里的图片块替换为文本标记
///
/// 处理 messages[].content 和 input[] 两种结构，递归替换嵌套图片块。
/// 保留原 cache_control 字段（避免断掉 prompt cache）。
/// 返回替换的图片块数量。
export function healImageBlocks(body) {
  let count = 0;

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (messages) {
    for (const msg of messages) {
      if (msg && Array.isArray(msg.content)) {
        count += replaceImagesInContent(msg.content, 'text');
      }
    }
  }

  if (body && body.input !== undefined) {
    count += replaceImagesInResponsesInput(body.input);
  }

  return count;
}

/// 判断请求体是否包含图片块（供测试和条件判断）
export function containsImageBlocks(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (messages && messages.some(m => contentHasImageBlocks(m?.content))) {
    return true;
  }
  return responsesInputHasImageBlocks(body?.input);
}

// ==================== 编排器 ====================

/// 按签名→预算→媒体顺序尝试整流，各只触发一次
///
/// state 对象由调用方持有，跨重试传递，防止无限循环：
///   { signatureHealed, budgetHealed, mediaHealed }
///
/// 返回 { healed: bool, kind: 'signature'|'budget'|'media'|null, result }
/// healed=true 表示已修复 payload，应重试；false 表示无可整流内容，照常暴露错误。
export function tryHeal(payload, statusCode, errorText, cfg, state) {
  if (!cfg?.enabled) return { healed: false, kind: null };

  // 1. 签名整流（未触发过时尝试）
  if (!state.signatureHealed && shouldHealThinkingSignature(errorText, cfg)) {
    const result = healThinkingSignature(payload);
    if (result.applied) {
      state.signatureHealed = true;
      return { healed: true, kind: 'signature', result };
    }
    // applied=false：签名整流器触发但无可整流内容，继续检查 budget（不短路）
  }

  // 2. 预算整流
  if (!state.budgetHealed && shouldHealThinkingBudget(errorText, cfg)) {
    const result = healThinkingBudget(payload);
    if (result.applied) {
      state.budgetHealed = true;
      return { healed: true, kind: 'budget', result };
    }
  }

  // 3. 媒体整流
  if (!state.mediaHealed && cfg.media && isUnsupportedImageError(statusCode, errorText)) {
    const replacedImages = healImageBlocks(payload);
    if (replacedImages > 0) {
      state.mediaHealed = true;
      return { healed: true, kind: 'media', result: { applied: true, replacedImages } };
    }
  }

  return { healed: false, kind: null };
}

// ==================== 内部辅助 ====================

/// 判断是否需要删除顶层 thinking 字段
///
/// 条件：thinking.type=enabled 且最后一条 assistant 消息首块非 thinking/redacted_thinking
/// 且该消息含 tool_use block（工具调用链路中 thinking 前缀缺失）。
function shouldRemoveTopLevelThinking(body, messages) {
  const thinkingType = body?.thinking?.type;
  // 仅 type=enabled 视为开启
  if (thinkingType !== 'enabled') return false;

  // 找最后一条 assistant 消息
  let lastAssistant = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = messages[i];
      break;
    }
  }

  const lastAssistantContent = Array.isArray(lastAssistant?.content) ? lastAssistant.content : null;
  if (!lastAssistantContent || lastAssistantContent.length === 0) return false;

  // 检查首块是否为 thinking/redacted_thinking
  const firstBlockType = lastAssistantContent[0]?.type;
  const missingThinkingPrefix =
    firstBlockType !== 'thinking' && firstBlockType !== 'redacted_thinking';
  if (!missingThinkingPrefix) return false;

  // 检查是否存在 tool_use
  return lastAssistantContent.some(b => b?.type === 'tool_use');
}

function snapshotBudget(body) {
  const thinking = body?.thinking;
  return {
    maxTokens: typeof body?.max_tokens === 'number' ? body.max_tokens : null,
    thinkingType: typeof thinking?.type === 'string' ? thinking.type : null,
    thinkingBudgetTokens: typeof thinking?.budget_tokens === 'number' ? thinking.budget_tokens : null,
  };
}

function budgetSnapshotEqual(a, b) {
  return a.maxTokens === b.maxTokens
    && a.thinkingType === b.thinkingType
    && a.thinkingBudgetTokens === b.thinkingBudgetTokens;
}

// ── media 替换 ──

function isImageBlockType(blockType) {
  return blockType === 'image' || blockType === 'image_url' || blockType === 'input_image';
}

function replaceImageBlockWithTextMarker(block, textType) {
  const cacheControl = block?.cache_control;
  // 原地清空再重设，保留同一对象引用
  for (const key of Object.keys(block)) delete block[key];
  block.type = textType;
  block.text = UNSUPPORTED_IMAGE_MARKER;
  if (cacheControl !== undefined) block.cache_control = cacheControl;
}

function replaceImagesInContent(content, textType) {
  if (!Array.isArray(content)) return 0;

  let replaced = 0;
  for (const block of content) {
    if (isImageBlockType(block?.type)) {
      replaceImageBlockWithTextMarker(block, textType);
      replaced += 1;
      continue;
    }
    // 递归处理嵌套 content（如 tool_result 里的图片）
    if (block && Array.isArray(block.content)) {
      replaced += replaceImagesInContent(block.content, textType);
    }
  }
  return replaced;
}

function replaceImagesInResponsesInput(input) {
  if (Array.isArray(input)) {
    let replaced = 0;
    for (const item of input) replaced += replaceImagesInResponsesInputItem(item);
    return replaced;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return replaceImagesInResponsesInputItem(input);
  }
  return 0;
}

function replaceImagesInResponsesInputItem(item) {
  if (!item || typeof item !== 'object') return 0;
  let replaced = 0;

  if (item.type === 'input_image') {
    replaceImageBlockWithTextMarker(item, 'input_text');
    replaced += 1;
  }

  if (Array.isArray(item.content)) {
    replaced += replaceImagesInContent(item.content, 'input_text');
  }

  return replaced;
}

function contentHasImageBlocks(content) {
  if (!Array.isArray(content)) return false;
  return content.some(block =>
    isImageBlockType(block?.type)
    || (block && Array.isArray(block.content) && contentHasImageBlocks(block.content))
  );
}

function responsesInputHasImageBlocks(input) {
  if (Array.isArray(input)) {
    return input.some(item => responsesInputItemHasImageBlocks(item));
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return responsesInputItemHasImageBlocks(input);
  }
  return false;
}

function responsesInputItemHasImageBlocks(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.type === 'input_image') return true;
  return contentHasImageBlocks(item.content);
}

// ── 错误文本提取 ──

/// 从上游响应体提取错误消息文本
///
/// 尝试 JSON 解析，依次查找 error.message / message / detail / error 字段。
/// 找不到则返回紧凑 JSON 或原始文本。对齐 cc-switch media_sanitizer::extract_error_text。
function extractErrorText(errorText) {
  const raw = String(errorText || '');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (value && typeof value === 'object') {
    const candidates = [
      value?.error?.message,
      value?.message,
      value?.detail,
      value?.error,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') return candidate;
    }
    // 找不到字符串字段，返回紧凑 JSON
    try {
      return JSON.stringify(value);
    } catch {
      return raw;
    }
  }

  return raw;
}
