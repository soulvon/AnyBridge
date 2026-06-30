// vision-fallback.js — user-configured third-party image understanding.
//
// This module is intentionally independent from provider apiFormat. Some older
// imported providers have stale protocol metadata, so vision calls probe common
// compatible protocols in order and use the first useful description.

import crypto from 'node:crypto';
import https from 'node:https';
import { httpsAgentFor } from './system-proxy.js';
import { recordVisionFallback } from './stats.js';

const VISION_TIMEOUT_MS = parseInt(process.env.BYOK_VISION_FALLBACK_TIMEOUT_MS || '120000', 10);
const DEFAULT_VISION_MAX_TOKENS = parseInt(process.env.BYOK_VISION_FALLBACK_MAX_TOKENS || '2048', 10);
const DEFAULT_VISION_CONTEXT_MAX_CHARS = parseInt(process.env.BYOK_VISION_CONTEXT_MAX_CHARS || '8000', 10);
const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 16,
  maxFreeSockets: 8,
});

const imageDescriptionCache = new Map();
const IMAGE_CACHE_MAX = parseInt(process.env.BYOK_VISION_FALLBACK_CACHE_SIZE || '200', 10);
const IMAGE_CACHE_TTL_MS = parseInt(process.env.BYOK_VISION_FALLBACK_CACHE_TTL || '3600000', 10);

function imageHash(data) {
  return crypto.createHash('sha256').update(data || '').digest('hex').slice(0, 40);
}

function base64DecodedBytes(data) {
  try {
    return Buffer.from(data || '', 'base64').length;
  } catch {
    return Math.floor(String(data || '').length * 0.75);
  }
}

function imageMeta(image) {
  const data = image?.data || '';
  return {
    imageHash: imageHash(data),
    imageBytes: base64DecodedBytes(data),
    base64Length: String(data).length,
    mimeType: image?.mimeType || 'image/png',
  };
}

function textPreview(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function positiveInt(value, fallback, min = 1) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function normalizeVisionOptions(options = {}) {
  const contextMode = ['current', 'summary', 'full'].includes(String(options.contextMode || ''))
    ? String(options.contextMode)
    : 'current';
  const multiImageMode = ['single', 'batch', 'chunk'].includes(String(options.multiImageMode || ''))
    ? String(options.multiImageMode)
    : 'single';
  return {
    maxTokens: positiveInt(options.maxTokens, DEFAULT_VISION_MAX_TOKENS, 64),
    contextMode,
    multiImageMode,
    batchSize: positiveInt(options.batchSize, 3, 1),
    contextMaxChars: positiveInt(options.contextMaxChars, DEFAULT_VISION_CONTEXT_MAX_CHARS, 500),
  };
}

function cacheKey(target, data, prompt = '', options = {}) {
  return crypto
    .createHash('sha256')
    .update(`${target.providerId || ''}|${target.model || ''}|${options.maxTokens || ''}|`)
    .update(prompt || '')
    .update('|')
    .update(data || '')
    .digest('hex')
    .slice(0, 40);
}

function batchCacheKey(target, images, prompt, options) {
  const hash = crypto
    .createHash('sha256')
    .update(`${target.providerId || ''}|${target.model || ''}|batch|${options.maxTokens || ''}|`)
    .update(prompt || '');
  for (const image of images || []) {
    hash.update('|');
    hash.update(image?.data || '');
  }
  return hash.digest('hex').slice(0, 40);
}

function cacheGet(key) {
  const entry = imageDescriptionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > IMAGE_CACHE_TTL_MS) {
    imageDescriptionCache.delete(key);
    return null;
  }
  return entry.text;
}

function cacheSet(key, text) {
  if (imageDescriptionCache.size >= IMAGE_CACHE_MAX) {
    const first = imageDescriptionCache.keys().next().value;
    if (first) imageDescriptionCache.delete(first);
  }
  imageDescriptionCache.set(key, { text, ts: Date.now() });
}

function cleanApiPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function providerEndpoint(provider) {
  const raw = String(provider?.apiHost || '').trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const basePath = url.pathname && url.pathname !== '/' ? cleanApiPath(url.pathname) : '';
  return {
    origin: `${url.protocol}//${url.host}`,
    basePath,
  };
}

function configuredPath(provider, target) {
  return cleanApiPath(target?.apiPath || target?.api_path || provider?.apiPath || provider?.api_path || '');
}

function openAIChatPath(provider, target) {
  const { basePath } = providerEndpoint(provider);
  const path = configuredPath(provider, target) || basePath;
  const lower = path.toLowerCase();
  if (!path) return '/v1/chat/completions';
  if (lower.endsWith('/chat/completions')) return path;
  if (lower.endsWith('/responses')) return path.replace(/\/responses$/i, '/chat/completions');
  if (lower.endsWith('/v1')) return `${path}/chat/completions`;
  return path;
}

function openAIResponsesPath(provider, target) {
  const { basePath } = providerEndpoint(provider);
  const path = configuredPath(provider, target) || basePath;
  const lower = path.toLowerCase();
  if (!path) return '/v1/responses';
  if (lower.endsWith('/responses')) return path;
  if (lower.endsWith('/chat/completions')) return path.replace(/\/chat\/completions$/i, '/responses');
  if (lower.endsWith('/v1')) return `${path}/responses`;
  return '/v1/responses';
}

function anthropicPath(provider, target) {
  const { basePath } = providerEndpoint(provider);
  const path = configuredPath(provider, target) || basePath;
  const lower = path.toLowerCase();
  if (!path) return '/v1/messages';
  if (lower.endsWith('/messages')) return path;
  if (lower.endsWith('/v1')) return `${path}/messages`;
  return `${path}/v1/messages`;
}

function fullUrl(provider, path) {
  const { origin } = providerEndpoint(provider);
  return `${origin}${path}`;
}

function requestJson(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const bodyText = JSON.stringify(body);
    const req = https.request({
      agent: httpsAgentFor(HTTPS_AGENT),
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyText),
        ...headers,
      },
      timeout: VISION_TIMEOUT_MS,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* raw text is kept for diagnostics */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('vision fallback timeout'));
    });
    req.end(bodyText);
  });
}

function extractText(json) {
  if (!json) return '';
  if (typeof json.output_text === 'string') return json.output_text.trim();
  const chatContent = json?.choices?.[0]?.message?.content;
  if (typeof chatContent === 'string') return chatContent.trim();
  if (Array.isArray(chatContent)) {
    return chatContent
      .map(part => part?.text || part?.content || part?.text?.value || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (Array.isArray(json.output)) {
    return json.output
      .flatMap(item => Array.isArray(item?.content) ? item.content : [])
      .map(part => part?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (Array.isArray(json.content)) {
    return json.content
      .map(part => part?.text || '')
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function looksLikeMissingImage(text) {
  const s = String(text || '').toLowerCase();
  return /image_missing|can't see|cannot see|unable to see|no image|without an image/.test(s)
    || /不能看到图片|看不到|没看到|没有看到|未提供图片|没有提供图片|没有收到图片|无法查看|无法看到/.test(text);
}

function usefulDescription(text) {
  const s = String(text || '').trim();
  return s.length >= 12 && !looksLikeMissingImage(s);
}

function clipContextText(text, maxChars, labelMaxChars = maxChars) {
  const value = String(text || '').trim();
  if (maxChars <= 0) return '';
  if (!value || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[上下文已按 visionContextMaxChars=${labelMaxChars} 截断]`;
}

function roleLabel(role) {
  if (role === 'assistant') return '助手';
  if (role === 'system') return '系统';
  return '用户';
}

function buildPriorContext(messages, messageIndex, mode, maxChars) {
  if (mode === 'current') return '';
  const rows = [];
  const source = Array.isArray(messages) ? messages.slice(0, messageIndex) : [];
  for (const msg of source) {
    const rawText = textFromMessage(msg);
    const text = mode === 'full' ? String(rawText || '').trim() : textPreview(rawText, 1200);
    if (!text) continue;
    rows.push(`${roleLabel(msg.role)}：${text}`);
  }
  if (!rows.length) return '';
  const title = mode === 'full'
    ? '以下是图片之前的完整文本上下文（不含图片二进制）：'
    : '以下是图片之前的最近文本上下文（由历史文本摘取，供图片理解聚焦）：';
  if (mode === 'summary') {
    const picked = [];
    let size = title.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (size + row.length + 2 > maxChars && picked.length) break;
      picked.unshift(row);
      size += row.length + 2;
    }
    return clipContextText(`${title}\n${picked.join('\n')}`, maxChars);
  }
  return clipContextText(`${title}\n${rows.join('\n')}`, maxChars);
}

function visionContextForMessage(messages, messageIndex, userText, options) {
  const mode = options.contextMode || 'current';
  const prior = buildPriorContext(messages, messageIndex, mode, options.contextMaxChars);
  const current = String(userText || '').trim();
  if (!prior) return current;
  const currentBlock = `当前用户围绕图片提出的问题是：\n${current || '(当前消息没有额外文字)'}`;
  const maxChars = options.contextMaxChars;
  const joined = `${prior}\n\n${currentBlock}`;
  if (joined.length <= maxChars) return joined;
  const priorBudget = maxChars - currentBlock.length - 2;
  if (priorBudget <= 0) {
    return `${currentBlock}\n[前文因 visionContextMaxChars=${maxChars} 过小未发送给图片理解模型]`;
  }
  return `${clipContextText(prior, priorBudget, maxChars)}\n\n${currentBlock}`;
}

function visionPrompt(contextText = '', { imageCount = 1 } = {}) {
  const prefix = contextText
    ? `用户围绕图片提出的问题和可用上下文是：\n${contextText}\n\n`
    : '';
  if (imageCount > 1) {
    return `${prefix}你会收到 ${imageCount} 张图片。请用中文按图片顺序输出结构化理解结果，供另一个不能直接看图的文本模型回答用户问题。要求：
1. 必须逐张输出，使用“图片 #1”“图片 #2”等编号，不要合并或跳过任何图片。
2. 逐字抄录每张图片中所有可见文字。
3. 描述颜色、布局、位置关系、UI 元素和重要细节。
4. 如果是代码、表格、图表或网页截图，请尽量保留结构。
5. 结合用户问题和上下文，指出每张图片里最相关的细节。
6. 如果某张图片看不清，请保留编号并明确说明不确定点。
7. 不要说“我看不到图片”，除非确实没有收到图片。

建议输出格式：
图片 #1：
- 可见文字：
- 布局与元素：
- 与问题相关的细节：
- 不确定点：

图片 #2：
...`;
  }
  return `${prefix}请用中文详细描述这张图片，供另一个不能直接看图的文本模型回答用户问题。要求：
1. 逐字抄录图片中所有可见文字。
2. 描述颜色、布局、位置关系、UI 元素和重要细节。
3. 如果是代码、表格、图表或网页截图，请尽量保留结构。
4. 结合用户问题和上下文，指出最相关的图像细节。
5. 不确定或看不清的地方要明确说明。
6. 不要说“我看不到图片”，除非确实没有收到图片。

建议输出格式：
- 可见文字：
- 布局与元素：
- 与问题相关的细节：
- 不确定点：`;
}

function imageUrlPart(image) {
  return {
    type: 'image_url',
    image_url: { url: `data:${image.mimeType || 'image/png'};base64,${image.data}` },
  };
}

function openAIChatBody(model, images, prompt, imageFirst = false, maxTokens = DEFAULT_VISION_MAX_TOKENS) {
  const imageParts = (Array.isArray(images) ? images : [images]).map(imageUrlPart);
  const textPart = { type: 'text', text: prompt };
  return {
    model,
    messages: [{ role: 'user', content: imageFirst ? [...imageParts, textPart] : [textPart, ...imageParts] }],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
}

function inputImagePart(image) {
  return { type: 'input_image', image_url: `data:${image.mimeType || 'image/png'};base64,${image.data}` };
}

function openAIResponsesBody(model, images, prompt, maxTokens = DEFAULT_VISION_MAX_TOKENS) {
  return {
    model,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: prompt },
      ...(Array.isArray(images) ? images : [images]).map(inputImagePart),
    ] }],
    max_output_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
}

function anthropicImagePart(image) {
  return { type: 'image', source: { type: 'base64', media_type: image.mimeType || 'image/png', data: image.data } };
}

function anthropicBody(model, images, prompt, maxTokens = DEFAULT_VISION_MAX_TOKENS) {
  return {
    model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      ...(Array.isArray(images) ? images : [images]).map(anthropicImagePart),
    ] }],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
}

function protocolCandidates(provider, target, images, prompt, options = {}) {
  const model = target.model || provider.defaultModel;
  const chatPath = openAIChatPath(provider, target);
  const responsesPath = openAIResponsesPath(provider, target);
  const messagesPath = anthropicPath(provider, target);
  const maxTokens = normalizeVisionOptions(options).maxTokens;
  return [
    {
      label: 'openai-chat',
      url: fullUrl(provider, chatPath),
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: openAIChatBody(model, images, prompt, false, maxTokens),
    },
    {
      label: 'openai-chat-image-first',
      url: fullUrl(provider, chatPath),
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: openAIChatBody(model, images, prompt, true, maxTokens),
    },
    {
      label: 'openai-responses',
      url: fullUrl(provider, responsesPath),
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: openAIResponsesBody(model, images, prompt, maxTokens),
    },
    {
      label: 'anthropic-messages',
      url: fullUrl(provider, messagesPath),
      headers: { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: anthropicBody(model, images, prompt, maxTokens),
    },
    {
      label: 'anthropic-messages-bearer',
      url: fullUrl(provider, messagesPath),
      headers: { authorization: `Bearer ${provider.apiKey}`, 'anthropic-version': '2023-06-01' },
      body: anthropicBody(model, images, prompt, maxTokens),
    },
  ];
}

async function describeImageWithTarget(provider, target, image, contextText, options = {}) {
  const opts = normalizeVisionOptions(options);
  const meta = imageMeta(image);
  const prompt = visionPrompt(contextText, { imageCount: 1 });
  const key = cacheKey(target, image.data, prompt, opts);
  const cached = cacheGet(key);
  if (cached) return { text: cached, cached: true, protocol: 'cache', ...meta };

  const errors = [];
  let apiCalls = 0;
  for (const candidate of protocolCandidates(provider, target, image, prompt, opts)) {
    try {
      apiCalls++;
      const res = await requestJson(candidate.url, candidate.headers, candidate.body);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        errors.push(`${candidate.label}: HTTP ${res.statusCode}`);
        continue;
      }
      const text = extractText(res.json);
      if (usefulDescription(text)) {
        cacheSet(key, text);
        console.log(`  👁️  图片理解命中: ${provider.name}/${target.model || provider.defaultModel} (${candidate.label})`);
        return { text, cached: false, protocol: candidate.label, apiCalls, ...meta };
      }
      errors.push(`${candidate.label}: empty/missing-image`);
    } catch (e) {
      errors.push(`${candidate.label}: ${e.message}`);
    }
  }
  const err = new Error(errors.join(' | ') || 'no protocol candidate worked');
  err.apiCalls = apiCalls;
  throw err;
}

async function describeImageBatchWithTarget(provider, target, images, contextText, options = {}) {
  const opts = normalizeVisionOptions(options);
  const prompt = visionPrompt(contextText, { imageCount: images.length });
  const key = batchCacheKey(target, images, prompt, opts);
  const cached = cacheGet(key);
  const metas = images.map(imageMeta);
  const totalBytes = metas.reduce((sum, meta) => sum + meta.imageBytes, 0);
  const base64Length = metas.reduce((sum, meta) => sum + meta.base64Length, 0);
  if (cached) {
    return {
      text: cached,
      cached: true,
      protocol: 'cache',
      imageHashes: metas.map(meta => meta.imageHash),
      imageBytes: totalBytes,
      base64Length,
      apiCalls: 0,
    };
  }

  const errors = [];
  let apiCalls = 0;
  for (const candidate of protocolCandidates(provider, target, images, prompt, opts)) {
    try {
      apiCalls++;
      const res = await requestJson(candidate.url, candidate.headers, candidate.body);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        errors.push(`${candidate.label}: HTTP ${res.statusCode}`);
        continue;
      }
      const text = extractText(res.json);
      if (usefulDescription(text)) {
        cacheSet(key, text);
        console.log(`  👁️  批量图片理解命中: ${provider.name}/${target.model || provider.defaultModel} (${candidate.label}, ${images.length} images)`);
        return {
          text,
          cached: false,
          protocol: candidate.label,
          imageHashes: metas.map(meta => meta.imageHash),
          imageBytes: totalBytes,
          base64Length,
          apiCalls,
        };
      }
      errors.push(`${candidate.label}: empty/missing-image`);
    } catch (e) {
      errors.push(`${candidate.label}: ${e.message}`);
    }
  }
  const err = new Error(errors.join(' | ') || 'no protocol candidate worked');
  err.apiCalls = apiCalls;
  throw err;
}

function blockType(block) {
  return block?.type || null;
}

// 从 data: URL 解析 mimeType + base64 数据；非 data: URL 返回 null。
function parseDataImageUrl(url) {
  const m = String(url || '').trim().match(/^data:([^;,]+);base64,(.+)$/is);
  if (!m) return null;
  return { mimeType: m[1] || 'image/png', data: m[2] || '' };
}

// 识别三种协议的图片 block，统一返回 { data, mimeType, textBlockType }。
//   - Anthropic:  { type:'image',         source:{ media_type, data } }
//   - OpenAI Chat: { type:'image_url',    image_url:{ url } | image_url }
//   - OpenAI Resp: { type:'input_image',  image_url:'data:...' | image_url:{ url } }
// textBlockType 指明替换图片时应生成哪种文本 block，保证与原协议一致。
function imageFromBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const type = block.type;

  if (type === 'image') {
    const data = block.source?.data || block.data || block.base64_data || '';
    if (!data) return null;
    return {
      data,
      mimeType: block.source?.media_type || block.media_type || block.mime_type || 'image/png',
      textBlockType: 'text',
    };
  }

  if (type === 'image_url') {
    const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    const parsed = parseDataImageUrl(url);
    if (!parsed) return null;
    return { data: parsed.data, mimeType: parsed.mimeType, textBlockType: 'text' };
  }

  if (type === 'input_image') {
    const url = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    const parsed = parseDataImageUrl(url);
    if (!parsed) return null;
    return { data: parsed.data, mimeType: parsed.mimeType, textBlockType: 'input_text' };
  }

  return null;
}

function isTextBlock(block) {
  const t = blockType(block);
  return t === 'text' || t === 'input_text' || t === 'output_text';
}

function textFromMessage(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  return msg.content
    .filter(isTextBlock)
    .map(block => block.text || '')
    .filter(Boolean)
    .join('\n');
}

export function hasImageBlocks(messages) {
  return Array.isArray(messages)
    && messages.some(msg => Array.isArray(msg?.content) && msg.content.some(block => imageFromBlock(block) !== null));
}

const conversationImageMemory = new Map();
const CONVERSATION_MEMORY_MAX = parseInt(process.env.BYOK_VISION_CONVERSATION_MEMORY_MAX || '100', 10);
const CONVERSATION_IMAGE_MAX = parseInt(process.env.BYOK_VISION_CONVERSATION_IMAGE_MAX || '200', 10);

function messageTextParts(msg) {
  if (!msg) return [];
  if (typeof msg.content === 'string') return [msg.content];
  if (!Array.isArray(msg.content)) return [];
  return msg.content
    .filter(isTextBlock)
    .map(block => block.text || '')
    .filter(Boolean);
}

function imageHashesFromMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return [];
  return msg.content
    .map(imageFromBlock)
    .filter(Boolean)
    .map(img => imageMeta(img).imageHash);
}

function inferConversationKey(messages, context = {}) {
  if (context.conversationId) return String(context.conversationId);
  if (context.conversationKey) return String(context.conversationKey);
  const parts = [context.requestedModel || 'unknown-model'];
  for (const msg of messages || []) {
    for (const text of messageTextParts(msg)) {
      const preview = textPreview(text, 300);
      if (preview) parts.push(`${msg.role || 'unknown'}:${preview}`);
      if (parts.length >= 5) break;
    }
    if (parts.length >= 5) break;
  }
  if (parts.length === 1) {
    for (const msg of messages || []) {
      for (const hash of imageHashesFromMessage(msg)) {
        parts.push(`image:${hash}`);
        if (parts.length >= 4) break;
      }
      if (parts.length >= 4) break;
    }
  }
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

function getConversationMemory(conversationKey) {
  let memory = conversationImageMemory.get(conversationKey);
  if (!memory) {
    memory = { nextRef: 1, images: new Map(), lastSeenAt: Date.now() };
    conversationImageMemory.set(conversationKey, memory);
  }
  memory.lastSeenAt = Date.now();
  if (conversationImageMemory.size > CONVERSATION_MEMORY_MAX) {
    const oldest = [...conversationImageMemory.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0]?.[0];
    if (oldest && oldest !== conversationKey) conversationImageMemory.delete(oldest);
  }
  return memory;
}

function rememberConversationImage(memory, hash, data = {}) {
  let entry = memory.images.get(hash);
  if (!entry) {
    entry = {
      ref: memory.nextRef++,
      firstSeenAt: Date.now(),
      seenCount: 0,
      description: '',
      providerId: null,
      providerName: null,
      model: null,
      mimeType: 'image/png',
    };
    memory.images.set(hash, entry);
  }
  entry.lastSeenAt = Date.now();
  entry.seenCount += 1;
  if (data.description) entry.description = data.description;
  for (const key of ['providerId', 'providerName', 'model', 'mimeType']) {
    if (data[key]) entry[key] = data[key];
  }
  if (memory.images.size > CONVERSATION_IMAGE_MAX) {
    const oldest = [...memory.images.entries()].sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0))[0]?.[0];
    if (oldest && oldest !== hash) memory.images.delete(oldest);
  }
  return entry;
}

function imageDescriptionBlock({ ref, description, imageHash, messageIndex, blockIndex, cached, seenInConversation, textBlockType = 'text' }) {
  const seen = seenInConversation ? '；此前在本会话出现过，本次复用已有描述' : '';
  const cache = cached ? '；未重新调用图片理解模型' : '';
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：图片 #${ref}]\n来源：第 ${messageIndex + 1} 条用户消息，第 ${blockIndex + 1} 张图片；imageHash=${imageHash}${seen}${cache}\n内容：\n${description}`,
  };
}

function repeatedImageBlock({ ref, imageHash, messageIndex, blockIndex, textBlockType = 'text' }) {
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：图片 #${ref}]\n来源：第 ${messageIndex + 1} 条用户消息，第 ${blockIndex + 1} 张图片；imageHash=${imageHash}\n这张图片与本次请求中前面出现的图片 #${ref} 相同，沿用上方描述。`,
  };
}

function formatRefList(refs = []) {
  const unique = [...new Set(refs)].filter(ref => Number.isFinite(ref));
  if (unique.length === 0) return '';
  if (unique.length === 1) return `#${unique[0]}`;
  const contiguous = unique.every((ref, idx) => idx === 0 || ref === unique[idx - 1] + 1);
  return contiguous ? `#${unique[0]}-#${unique[unique.length - 1]}` : unique.map(ref => `#${ref}`).join('、');
}

function batchImageDescriptionBlock({ refs, description, imageHashes, messageIndex, blockIndexes, cached, textBlockType = 'text' }) {
  const refLabel = formatRefList(refs);
  const cache = cached ? '；未重新调用图片理解模型' : '';
  const sources = blockIndexes.map((idx, i) => `图片 #${refs[i]}=第 ${messageIndex + 1} 条用户消息，第 ${idx + 1} 张图片，imageHash=${imageHashes[i]}`).join('；');
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：批量图片 ${refLabel}]\n来源：${sources}${cache}\n内容：\n${description}`,
  };
}

function batchImageReferenceBlock({ ref, batchRefs, imageHash, messageIndex, blockIndex, textBlockType = 'text' }) {
  const refLabel = formatRefList(batchRefs);
  return {
    type: textBlockType,
    text: `\n\n[第三方图片理解：图片 #${ref}]\n来源：第 ${messageIndex + 1} 条用户消息，第 ${blockIndex + 1} 张图片；imageHash=${imageHash}\n这张图片已包含在上方批量图片 ${refLabel} 的描述中。`,
  };
}

function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function describeWithTargets(targets, providers, image, contextText, options) {
  let failedApiCalls = 0;
  const targetErrors = [];
  for (const target of targets) {
    const provider = providers.get(target.providerId);
    if (!provider || provider.enabled === false) {
      targetErrors.push(`${target.providerId}: provider unavailable`);
      continue;
    }
    try {
      const outcome = await describeImageWithTarget(provider, target, image, contextText, options);
      return { provider, target, outcome, failedApiCalls, targetErrors };
    } catch (e) {
      failedApiCalls += Number.isFinite(e.apiCalls) ? e.apiCalls : 0;
      targetErrors.push(`${provider.name}/${target.model}: ${e.message}`);
    }
  }
  const err = new Error(targetErrors.join(' | '));
  err.apiCalls = failedApiCalls;
  err.targetErrors = targetErrors;
  throw err;
}

async function describeBatchWithTargets(targets, providers, images, contextText, options) {
  let failedApiCalls = 0;
  const targetErrors = [];
  for (const target of targets) {
    const provider = providers.get(target.providerId);
    if (!provider || provider.enabled === false) {
      targetErrors.push(`${target.providerId}: provider unavailable`);
      continue;
    }
    try {
      const outcome = await describeImageBatchWithTarget(provider, target, images, contextText, options);
      return { provider, target, outcome, failedApiCalls, targetErrors };
    } catch (e) {
      failedApiCalls += Number.isFinite(e.apiCalls) ? e.apiCalls : 0;
      targetErrors.push(`${provider.name}/${target.model}: ${e.message}`);
    }
  }
  const err = new Error(targetErrors.join(' | '));
  err.apiCalls = failedApiCalls;
  err.targetErrors = targetErrors;
  throw err;
}

export async function preprocessImagesWithThirdPartyVision(messages, imageModels, providers, context = {}) {
  if (!hasImageBlocks(messages)) return { messages, conversions: [] };
  const targets = Array.isArray(imageModels) ? imageModels.filter(t => t?.providerId && t?.model) : [];
  if (targets.length === 0) throw new Error('没有有效的第三方图片理解目标');
  const options = normalizeVisionOptions(context.visionOptions || context);

  const conversions = [];
  const processed = [];
  const sourceMessages = messages || [];
  const conversationKey = inferConversationKey(sourceMessages, context);
  const memory = getConversationMemory(conversationKey);
  const requestImages = new Map();

  for (let messageIndex = 0; messageIndex < sourceMessages.length; messageIndex++) {
    const msg = sourceMessages[messageIndex];
    if (!msg || typeof msg.content === 'string' || !Array.isArray(msg.content) || msg.role !== 'user') {
      processed.push(msg);
      continue;
    }

    const keptBlocks = [];
    const userText = textFromMessage(msg);
    const messageContext = visionContextForMessage(sourceMessages, messageIndex, userText, options);
    const imageEntries = [];
    for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
      const block = msg.content[blockIndex];
      const image = imageFromBlock(block);
      if (image) {
        imageEntries.push({ blockIndex, image, textBlockType: image.textBlockType || 'text' });
      }
    }

    if (imageEntries.length > 1 && options.multiImageMode !== 'single') {
      const replacements = new Map();
      const groups = options.multiImageMode === 'chunk'
        ? chunkArray(imageEntries, options.batchSize)
        : [imageEntries];
      for (const group of groups) {
        const images = group.map(entry => entry.image);
        const metas = images.map(imageMeta);
        try {
          const { provider, target, outcome } = await describeBatchWithTargets(targets, providers, images, messageContext, options);
          const imageHashes = outcome.imageHashes || metas.map(meta => meta.imageHash);
          const memoryEntries = group.map((entry, idx) => rememberConversationImage(memory, metas[idx].imageHash, {
            description: `这张图片属于一次批量图片理解，完整批量描述如下：\n${outcome.text}`,
            providerId: provider.id,
            providerName: provider.name,
            model: target.model || provider.defaultModel,
            mimeType: entry.image.mimeType,
          }));
          const refs = memoryEntries.map(entry => entry.ref);
          const conversion = {
            kind: 'image_batch',
            providerId: provider.id,
            providerName: provider.name,
            model: target.model || provider.defaultModel,
            protocol: outcome.protocol,
            cached: outcome.cached,
            mimeType: images.map(image => image.mimeType).join(','),
            imageHashes,
            imageBytes: outcome.imageBytes,
            base64Length: outcome.base64Length,
            apiCalls: outcome.apiCalls || 0,
            textLength: outcome.text.length,
            messageIndex,
            blockIndexes: group.map(entry => entry.blockIndex),
            imageRefs: refs,
            textBlockType: group[0].textBlockType || 'text',
            batchSize: group.length,
          };
          conversions.push(conversion);
          recordVisionFallback({
            ...context,
            conversationKey,
            ...conversion,
            description: outcome.text,
            userTextPreview: textPreview(userText),
          });
          group.forEach((entry, idx) => {
            requestImages.set(metas[idx].imageHash, {
              ref: refs[idx],
              description: `这张图片属于一次批量图片理解，完整批量描述如下：\n${outcome.text}`,
              conversion: {
                ...conversion,
                kind: 'image_batch_reference',
                imageHash: imageHashes[idx],
                imageRef: refs[idx],
                blockIndex: entry.blockIndex,
              },
            });
            if (idx === 0) {
              replacements.set(entry.blockIndex, batchImageDescriptionBlock({
                refs,
                description: outcome.text,
                imageHashes,
                messageIndex,
                blockIndexes: conversion.blockIndexes,
                cached: outcome.cached,
                textBlockType: entry.textBlockType,
              }));
            } else {
              replacements.set(entry.blockIndex, batchImageReferenceBlock({
                ref: refs[idx],
                batchRefs: refs,
                imageHash: imageHashes[idx],
                messageIndex,
                blockIndex: entry.blockIndex,
                textBlockType: entry.textBlockType,
              }));
            }
          });
        } catch (e) {
          const error = `第三方批量图片理解目标全部失败: ${e.targetErrors?.join(' | ') || e.message}`;
          recordVisionFallback({
            ...context,
            conversationKey,
            status: 'error',
            kind: 'image_batch',
            apiCalls: Number.isFinite(e.apiCalls) ? e.apiCalls : 0,
            messageIndex,
            blockIndexes: group.map(entry => entry.blockIndex),
            imageHashes: metas.map(meta => meta.imageHash),
            userTextPreview: textPreview(userText),
            error,
          });
          throw new Error(error);
        }
      }
      if (replacements.size > 0) {
        for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
          keptBlocks.push(replacements.get(blockIndex) || msg.content[blockIndex]);
        }
        processed.push({ ...msg, content: keptBlocks });
        continue;
      }
    }

    for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
      const block = msg.content[blockIndex];
      const image = imageFromBlock(block);
      if (!image) {
        keptBlocks.push(block);
        continue;
      }
      const textBlockType = image.textBlockType || 'text';

      const meta = imageMeta(image);
      const remembered = memory.images.get(meta.imageHash);
      const seenInConversation = !!remembered;
      const duplicateInRequest = requestImages.get(meta.imageHash);
      if (duplicateInRequest) {
        const conversion = {
          ...duplicateInRequest.conversion,
          protocol: 'request-dedupe',
          cached: true,
          apiCalls: 0,
          textLength: duplicateInRequest.description.length,
          messageIndex,
          blockIndex,
          duplicateInRequest: true,
          seenInConversation: true,
          imageRef: duplicateInRequest.ref,
          textBlockType,
        };
        conversions.push(conversion);
        recordVisionFallback({
          ...context,
          conversationKey,
          ...conversion,
          description: duplicateInRequest.description,
          userTextPreview: textPreview(userText),
        });
        keptBlocks.push(repeatedImageBlock({
          ref: duplicateInRequest.ref,
          imageHash: meta.imageHash,
          messageIndex,
          blockIndex,
          textBlockType,
        }));
        continue;
      }

      let description = remembered?.description || '';
      let conversion = null;

      if (description) {
        conversion = {
          kind: 'image',
          providerId: remembered.providerId,
          providerName: remembered.providerName,
          model: remembered.model,
          protocol: 'conversation-memory',
          cached: true,
          mimeType: image.mimeType,
          imageHash: meta.imageHash,
          imageBytes: meta.imageBytes,
          base64Length: meta.base64Length,
          apiCalls: 0,
          textLength: description.length,
          messageIndex,
          blockIndex,
          duplicateInRequest: false,
          seenInConversation: true,
          imageRef: remembered.ref,
          textBlockType,
        };
      } else {
        try {
          const { provider, target, outcome } = await describeWithTargets(targets, providers, image, messageContext, options);
          description = outcome.text;
          conversion = {
            kind: 'image',
            providerId: provider.id,
            providerName: provider.name,
            model: target.model || provider.defaultModel,
            protocol: outcome.protocol,
            cached: outcome.cached,
            mimeType: image.mimeType,
            imageHash: outcome.imageHash,
            imageBytes: outcome.imageBytes,
            base64Length: outcome.base64Length,
            apiCalls: outcome.apiCalls || 0,
            textLength: description.length,
            messageIndex,
            blockIndex,
            duplicateInRequest: false,
            seenInConversation: false,
            textBlockType,
          };
        } catch (e) {
          const targetErrors = e.targetErrors || [e.message];
          const failedApiCalls = Number.isFinite(e.apiCalls) ? e.apiCalls : 0;
          const error = `第三方图片理解目标全部失败: ${targetErrors.join(' | ')}`;
          recordVisionFallback({
            ...context,
            conversationKey,
            ...meta,
            status: 'error',
            apiCalls: failedApiCalls,
            messageIndex,
            blockIndex,
            userTextPreview: textPreview(userText),
            error,
          });
          throw new Error(error);
        }
      }

      if (!description || !conversion) {
        const error = '第三方图片理解目标全部失败: 未返回有效描述';
        recordVisionFallback({
          ...context,
          conversationKey,
          ...meta,
          status: 'error',
          apiCalls: 0,
          messageIndex,
          blockIndex,
          userTextPreview: textPreview(userText),
          error,
        });
        throw new Error(error);
      }

      const memoryEntry = rememberConversationImage(memory, meta.imageHash, {
        description,
        providerId: conversion.providerId,
        providerName: conversion.providerName,
        model: conversion.model,
        mimeType: image.mimeType,
      });
      conversion.imageRef = memoryEntry.ref;
      conversion.seenInConversation = seenInConversation;
      conversions.push(conversion);
      requestImages.set(meta.imageHash, { ref: memoryEntry.ref, description, conversion });
      recordVisionFallback({
        ...context,
        conversationKey,
        ...conversion,
        description,
        userTextPreview: textPreview(userText),
      });
      keptBlocks.push(imageDescriptionBlock({
        ref: memoryEntry.ref,
        description,
        imageHash: meta.imageHash,
        messageIndex,
        blockIndex,
        cached: conversion.cached,
        seenInConversation,
        textBlockType,
      }));
    }

    processed.push({ ...msg, content: keptBlocks });
  }

  return { messages: processed, conversions };
}
