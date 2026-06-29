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
const VISION_MAX_TOKENS = parseInt(process.env.BYOK_VISION_FALLBACK_MAX_TOKENS || '1200', 10);
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

function cacheKey(target, data) {
  return crypto
    .createHash('sha256')
    .update(`${target.providerId || ''}|${target.model || ''}|`)
    .update(data || '')
    .digest('hex')
    .slice(0, 40);
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

function visionPrompt(userText = '') {
  const prefix = userText
    ? `用户围绕图片提出的问题是：\n${userText}\n\n`
    : '';
  return `${prefix}请用中文详细描述这张图片，供另一个不能直接看图的文本模型回答用户问题。要求：
1. 逐字抄录图片中所有可见文字。
2. 描述颜色、布局、位置关系、UI 元素和重要细节。
3. 如果是代码、表格、图表或网页截图，请尽量保留结构。
4. 不要说“我看不到图片”，除非确实没有收到图片。`;
}

function openAIChatBody(model, image, prompt, imageFirst = false) {
  const imagePart = {
    type: 'image_url',
    image_url: { url: `data:${image.mimeType || 'image/png'};base64,${image.data}` },
  };
  const textPart = { type: 'text', text: prompt };
  return {
    model,
    messages: [{ role: 'user', content: imageFirst ? [imagePart, textPart] : [textPart, imagePart] }],
    max_tokens: VISION_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
}

function openAIResponsesBody(model, image, prompt) {
  return {
    model,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: prompt },
      { type: 'input_image', image_url: `data:${image.mimeType || 'image/png'};base64,${image.data}` },
    ] }],
    max_output_tokens: VISION_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
}

function anthropicBody(model, image, prompt) {
  return {
    model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image', source: { type: 'base64', media_type: image.mimeType || 'image/png', data: image.data } },
    ] }],
    max_tokens: VISION_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
}

function protocolCandidates(provider, target, image, prompt) {
  const model = target.model || provider.defaultModel;
  const chatPath = openAIChatPath(provider, target);
  const responsesPath = openAIResponsesPath(provider, target);
  const messagesPath = anthropicPath(provider, target);
  return [
    {
      label: 'openai-chat',
      url: fullUrl(provider, chatPath),
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: openAIChatBody(model, image, prompt, false),
    },
    {
      label: 'openai-chat-image-first',
      url: fullUrl(provider, chatPath),
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: openAIChatBody(model, image, prompt, true),
    },
    {
      label: 'openai-responses',
      url: fullUrl(provider, responsesPath),
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: openAIResponsesBody(model, image, prompt),
    },
    {
      label: 'anthropic-messages',
      url: fullUrl(provider, messagesPath),
      headers: { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      body: anthropicBody(model, image, prompt),
    },
    {
      label: 'anthropic-messages-bearer',
      url: fullUrl(provider, messagesPath),
      headers: { authorization: `Bearer ${provider.apiKey}`, 'anthropic-version': '2023-06-01' },
      body: anthropicBody(model, image, prompt),
    },
  ];
}

async function describeImageWithTarget(provider, target, image, userText) {
  const key = cacheKey(target, image.data);
  const meta = imageMeta(image);
  const cached = cacheGet(key);
  if (cached) return { text: cached, cached: true, protocol: 'cache', ...meta };

  const prompt = visionPrompt(userText);
  const errors = [];
  let apiCalls = 0;
  for (const candidate of protocolCandidates(provider, target, image, prompt)) {
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

export async function preprocessImagesWithThirdPartyVision(messages, imageModels, providers, context = {}) {
  if (!hasImageBlocks(messages)) return { messages, conversions: [] };
  const targets = Array.isArray(imageModels) ? imageModels.filter(t => t?.providerId && t?.model) : [];
  if (targets.length === 0) throw new Error('没有有效的第三方图片理解目标');

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
      let failedApiCalls = 0;
      const targetErrors = [];
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
        for (const target of targets) {
          const provider = providers.get(target.providerId);
          if (!provider || provider.enabled === false) {
            targetErrors.push(`${target.providerId}: provider unavailable`);
            continue;
          }
          try {
            const outcome = await describeImageWithTarget(provider, target, image, userText);
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
            break;
          } catch (e) {
            failedApiCalls += Number.isFinite(e.apiCalls) ? e.apiCalls : 0;
            targetErrors.push(`${provider.name}/${target.model}: ${e.message}`);
          }
        }
      }

      if (!description || !conversion) {
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
