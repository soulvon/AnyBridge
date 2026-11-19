// vision-fallback.js — user-configured third-party image understanding.
//
// This module is intentionally independent from provider apiFormat. Some older
// imported providers have stale protocol metadata, so vision calls probe common
// compatible protocols in order and use the first useful description.

import crypto from 'node:crypto';
import { SHARED_HTTPS_AGENT, httpsAgentFor } from './system-proxy.js';
import { recordVisionFallback } from './stats.js';

const VISION_TIMEOUT_MS = parseInt(process.env.BYOK_VISION_FALLBACK_TIMEOUT_MS || '120000', 10);
const DEFAULT_VISION_MAX_TOKENS = parseInt(process.env.BYOK_VISION_FALLBACK_MAX_TOKENS || '2048', 10);
const DEFAULT_VISION_CONTEXT_MAX_CHARS = parseInt(process.env.BYOK_VISION_CONTEXT_MAX_CHARS || '8000', 10);

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

import { createVisionProtocolHelpers } from './lib/vision/protocol-client.js';
import {
  batchImageDescriptionBlock,
  batchImageReferenceBlock,
  chunkArray,
  imageDescriptionBlock,
  repeatedImageBlock,
  visionContextForMessage,
} from './lib/vision/context-and-blocks.js';

const {
  textPreview,
  positiveInt,
  normalizeVisionOptions,
  cacheGet,
  cacheSet,
  requestJson,
  extractText,
  usefulDescription,
  visionPrompt,
  protocolCandidates,
} = createVisionProtocolHelpers({
  httpsAgentFor,
  HTTPS_AGENT: SHARED_HTTPS_AGENT,
  VISION_TIMEOUT_MS,
  DEFAULT_VISION_MAX_TOKENS,
  DEFAULT_VISION_CONTEXT_MAX_CHARS,
});

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
    const messageContext = visionContextForMessage(sourceMessages, messageIndex, userText, options, {
      textFromMessage,
      textPreview,
    });
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
