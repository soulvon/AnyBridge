import http from 'node:http';
import https from 'node:https';
import { withRetry } from '../http-retry.js';

export function createVisionProtocolHelpers({
  httpsAgentFor,
  HTTPS_AGENT,
  VISION_TIMEOUT_MS,
  DEFAULT_VISION_MAX_TOKENS,
  DEFAULT_VISION_CONTEXT_MAX_CHARS,
}) {
  const imageDescriptionCache = new Map();
  const IMAGE_CACHE_TTL_MS = 30 * 60 * 1000;
  const IMAGE_CACHE_MAX = 256;

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

  function requestJsonOnce(urlString, headers, body, signal) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlString);
      const isHttp = url.protocol === 'http:';
      const bodyText = JSON.stringify(body);
      const ctrl = new AbortController();
      const hardTimer = setTimeout(() => ctrl.abort(), VISION_TIMEOUT_MS);
      const onExtAbort = () => ctrl.abort();
      if (signal) {
        if (signal.aborted) {
          clearTimeout(hardTimer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', onExtAbort, { once: true });
      }
      const cleanup = () => {
        clearTimeout(hardTimer);
        if (signal) signal.removeEventListener('abort', onExtAbort);
      };

      const mod = isHttp ? http : https;
      const req = mod.request({
        agent: isHttp ? undefined : httpsAgentFor(HTTPS_AGENT),
        hostname: url.hostname,
        port: url.port || (isHttp ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyText),
          ...headers,
        },
        timeout: VISION_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          cleanup();
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* raw text is kept for diagnostics */ }
          resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
        });
        res.on('error', (err) => {
          cleanup();
          reject(err);
        });
      });
      req.on('error', (err) => {
        cleanup();
        if (ctrl.signal.aborted && !signal?.aborted) {
          reject(Object.assign(new Error('vision fallback timeout'), { code: 'ETIMEDOUT' }));
          return;
        }
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('vision fallback timeout'), { code: 'ETIMEDOUT' }));
      });
      req.end(bodyText);
    });
  }

  function requestJson(urlString, headers, body) {
    return withRetry(
      async (signal) => {
        const r = await requestJsonOnce(urlString, headers, body, signal);
        if (r.statusCode === 429 || (r.statusCode >= 500 && r.statusCode < 600)) {
          throw Object.assign(new Error(`Vision upstream HTTP ${r.statusCode}`), {
            statusCode: r.statusCode,
            headers: r.headers,
            response: r,
          });
        }
        return r;
      },
      { maxRetries: 1, baseMs: 250, capMs: 1000, maxTotalMs: VISION_TIMEOUT_MS, label: 'vision' },
    ).catch((err) => {
      if (err?.response) return err.response;
      throw err;
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

  return {
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
  };
}

