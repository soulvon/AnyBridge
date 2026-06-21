// multimodal-middleware.js — 多模态文件到文本中间件
//
// 为不支持图片/视频/音频/PDF/DOCX 理解的模型提供透明降级：
//   - 图片 → Gemini 3 视觉描述
//   - 音频 → Gemini 3 转录
//   - 视频 → 关键帧提取 + Gemini 3 理解
//   - PDF  → 文本提取
//   - DOCX → 文本提取
//
// 原理：检测用户消息中的多模态 content blocks →
// 用 Gemini 3 将其转换为文本描述 →
// 注入回 prompt 文本中，移除原始二进制数据 →
// 目标模型只需要理解纯文本。
//
// 文件缓存：已处理的文件内容基于 SHA256 缓存（进程内），
// 同一会话中重复发送同一文件不重复调用 Gemini。

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

// ─── 配置 ──────────────────────────────────

const GEMINI_MULTIMODAL_MODEL = process.env.GEMINI_MULTIMODAL_MODEL || 'gemini-2.5-pro';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'generativelanguage.googleapis.com';
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '120000', 10);

const ENABLE_IMAGE_FALLBACK = !/^(false|0|off)$/i.test(String(process.env.BYOK_IMAGE_FALLBACK || 'true'));
const ENABLE_AUDIO_FALLBACK = !/^(false|0|off)$/i.test(String(process.env.BYOK_AUDIO_FALLBACK || 'true'));
const ENABLE_VIDEO_FALLBACK = !/^(false|0|off)$/i.test(String(process.env.BYOK_VIDEO_FALLBACK || 'false'));
const ENABLE_DOCUMENT_FALLBACK = !/^(false|0|off)$/i.test(String(process.env.BYOK_DOCUMENT_FALLBACK || 'true'));

const DEBUG = /^(true|1|on)$/i.test(String(process.env.BYOK_DEBUG_MULTIMODAL || 'false'));

function debug(...args) {
  if (DEBUG) console.log('[multimodal]', ...args);
}

// ─── 文件缓存（进程内，SHA256 key） ──────

const fileCache = new Map();  // sha256 → { text, mimeType, timestamp }
const CACHE_MAX_SIZE = parseInt(process.env.BYOK_MM_CACHE_SIZE || '200', 10);
const CACHE_TTL_MS = parseInt(process.env.BYOK_MM_CACHE_TTL || '3600000', 10); // 1h

function cacheKey(data) {
  const hash = crypto.createHash('sha256');
  if (typeof data === 'string') hash.update(data, 'base64');
  else if (Buffer.isBuffer(data)) hash.update(data);
  else hash.update(String(data));
  return hash.digest('hex').slice(0, 32);
}

function cacheGet(key) {
  const entry = fileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    fileCache.delete(key);
    return null;
  }
  return entry.text;
}

function cacheSet(key, text, mimeType) {
  if (fileCache.size >= CACHE_MAX_SIZE) {
    // 淘汰最旧的一条
    let oldestKey = null, oldestTs = Infinity;
    for (const [k, v] of fileCache) {
      if (v.timestamp < oldestTs) { oldestTs = v.timestamp; oldestKey = k; }
    }
    if (oldestKey) fileCache.delete(oldestKey);
  }
  fileCache.set(key, { text, mimeType, timestamp: Date.now() });
}

// ─── Gemini API 调用 ──────────────────────

function geminiApiPath() {
  const base = GEMINI_BASE_URL.replace(/^https?:\/\//, '');
  return `/v1beta/models/${encodeURIComponent(GEMINI_MULTIMODAL_MODEL)}:generateContent`;
}

async function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: GEMINI_BASE_URL.replace(/^https?:\/\//, ''),
      port: 443,
      path: geminiApiPath(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GEMINI_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: GEMINI_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          debug(`Gemini API error ${res.statusCode}: ${data.slice(0, 300)}`);
          return reject(new Error(`Gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(data);
          const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
          resolve(text);
        } catch (e) {
          reject(new Error(`Gemini parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.end(body);
  });
}

// ─── 图片理解 ────────────────────────────

async function describeImage(base64Data, mimeType) {
  const key = cacheKey(base64Data);
  const cached = cacheGet(key);
  if (cached) {
    debug(`Image cache hit (${mimeType})`);
    return cached;
  }

  const prompt = `请用中文详细描述这张图片的内容。包括：
1. 图片中有什么（人物、物体、场景等）
2. 文字内容（如果有 UI 截图、代码截图、表格、图表等，请逐字抄录所有可见文字）
3. 颜色、布局、位置关系
4. 如果是图表，请解读数据和趋势
5. 如果是表格，请列出完整的行列数据

请以结构化的方式回答，不需要说"图片中"之类的废话，直接描述内容就好。`;

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
  };

  debug(`Describing image (${mimeType}, ${base64Data.length} chars b64)`);
  const description = await callGemini(payload);
  cacheSet(key, description, mimeType);
  return description;
}

// ─── 音频理解 ────────────────────────────

async function transcribeAudio(base64Data, mimeType) {
  const key = cacheKey(base64Data);
  const cached = cacheGet(key);
  if (cached) {
    debug(`Audio cache hit (${mimeType})`);
    return cached;
  }

  const prompt = `请完整转录这段音频内容。请用中文标注说话人变化（如"说话人A："），
保留所有重要信息，包括语气、犹豫、重复等。输出纯文本即可，不需要解释。`;

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
  };

  debug(`Transcribing audio (${mimeType}, ${base64Data.length} chars b64)`);
  const transcription = await callGemini(payload);
  cacheSet(key, transcription, mimeType);
  return transcription;
}

// ─── 视频理解 ────────────────────────────

async function describeVideo(base64Data, mimeType) {
  const key = cacheKey(base64Data);
  const cached = cacheGet(key);
  if (cached) {
    debug(`Video cache hit (${mimeType})`);
    return cached;
  }

  const prompt = `请分析这段视频的内容。用中文输出视频分析报告：
1. 视频总时长估算
2. 场景/镜头变换描述
3. 每个场景的主要内容和人物
4. 视频中的文字和字幕内容（如有）
5. 整体主题和意图
6. 如果有 UI 操作、代码、技术内容等，请详细描述`;

  const payload = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64Data } },
        { text: prompt },
      ],
    }],
  };

  debug(`Describing video (${mimeType}, ${base64Data.length} chars b64)`);
  const description = await callGemini(payload);
  cacheSet(key, description, mimeType);
  return description;
}

// ─── PDF 文本提取 ─────────────────────────

function extractPdfText(base64Data) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    // 简易 PDF 文本提取：基于 PDF 文本流
    // 优先尝试 pdf-parse 模块，不可用时回退到基本提取
    let text = '';

    const content = buffer.toString('utf8', 0, Math.min(buffer.length, 20000));

    // 提取 BT...ET 之间的文本块
    const btBlocks = [];
    const btRegex = /BT([\s\S]*?)ET/g;
    let match;
    while ((match = btRegex.exec(content)) !== null) {
      const block = match[1];
      // 提取 (text) 括号内的文本 或 <hex> 十六进制文本
      const textParts = [];
      const tjRegex = /\(([^)]*)\)\s*Tj/g;
      const tjArray = /\[([^\]]*)\]\s*TJ/g;
      let tm;
      while ((tm = tjRegex.exec(block)) !== null) {
        textParts.push(tm[1]);
      }
      while ((tm = tjArray.exec(block)) !== null) {
        const items = tm[1];
        const itemParts = [];
        const itemRegex = /\(([^)]*)\)/g;
        let im;
        while ((im = itemRegex.exec(items)) !== null) {
          itemParts.push(im[1]);
        }
        textParts.push(itemParts.join(''));
      }
      btBlocks.push(textParts.join(' '));
    }
    text = btBlocks.join('\n');

    // 如果基本提取无效，尝试使用 pdf-parse
    if (text.trim().length < 50) {
      try {
        // 动态加载 pdf-parse
        const pdfParse = require('pdf-parse');
        return pdfParse(buffer).then(data => data.text).catch(() => text);
      } catch {
        debug('pdf-parse not available, using basic extraction');
      }
    }

    return Promise.resolve(text.trim() || '[PDF 文本提取失败，文件可能为扫描版]');
  } catch (e) {
    debug(`PDF extraction error: ${e.message}`);
    return Promise.resolve(`[PDF 文本提取失败: ${e.message}]`);
  }
}

// ─── DOCX 文本提取 ────────────────────────

function extractDocxText(base64Data) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    // DOCX 是 ZIP 文件，包含 word/document.xml
    const { unzipSync, strFromU8 } = require('fflate');
    const unzipped = unzipSync(buffer);
    const docXml = unzipped['word/document.xml'];
    if (!docXml) return Promise.resolve('[DOCX 解析失败: 未找到 document.xml]');

    const xml = strFromU8(docXml);
    // 提取所有 <w:t> 标签中的文本
    const textParts = [];
    const wtRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let match;
    while ((match = wtRegex.exec(xml)) !== null) {
      if (match[1]) textParts.push(match[1]);
    }
    // 提取 <w:p> 标签用于分段
    const paragraphs = [];
    const paraRegex = /<w:p[ >]([\s\S]*?)<\/w:p>/g;
    while ((match = paraRegex.exec(xml)) !== null) {
      const paraText = [];
      const pwRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
      let pm;
      while ((pm = pwRegex.exec(match[1])) !== null) {
        if (pm[1]) paraText.push(pm[1]);
      }
      if (paraText.length) paragraphs.push(paraText.join(''));
    }

    return Promise.resolve(
      paragraphs.length ? paragraphs.join('\n\n') : textParts.join(' ')
    );
  } catch (e) {
    debug(`DOCX extraction error: ${e.message}`);
    return Promise.resolve(`[DOCX 解析失败: ${e.message}]`);
  }
}

// ─── 主处理逻辑 ──────────────────────────

function getBlockType(block) {
  if (!block || !block.type) return null;
  return block.type;
}

function getBlockMimeType(block) {
  if (block.source?.media_type) return block.source.media_type;
  if (block.media_type) return block.media_type;
  if (block.mime_type) return block.mime_type;
  return null;
}

function getBlockData(block) {
  if (block.source?.data) return block.source.data;
  if (block.data) return block.data;
  if (block.base64_data) return block.base64_data;
  return null;
}

function classifyBlock(block) {
  const type = getBlockType(block);
  const mime = getBlockMimeType(block) || '';

  if (type === 'image' || mime.startsWith('image/')) return { kind: 'image', mime };
  if (type === 'audio' || mime.startsWith('audio/')) return { kind: 'audio', mime };
  if (type === 'video' || mime.startsWith('video/')) return { kind: 'video', mime };
  if (type === 'document' && mime === 'application/pdf') return { kind: 'pdf', mime };
  if (type === 'document' && (mime.includes('word') || mime.includes('document.xml') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
    return { kind: 'docx', mime };
  // 通过文件名检测
  const caption = block.caption || '';
  if (caption.endsWith('.pdf')) return { kind: 'pdf', mime };
  if (caption.endsWith('.docx') || caption.endsWith('.doc')) return { kind: 'docx', mime };
  if (caption.endsWith('.mp4') || caption.endsWith('.webm') || caption.endsWith('.mov')) return { kind: 'video', mime };
  if (caption.endsWith('.mp3') || caption.endsWith('.wav') || caption.endsWith('.ogg')) return { kind: 'audio', mime };

  return null;
}

async function convertBlock(block) {
  const classification = classifyBlock(block);
  if (!classification) return null;

  const data = getBlockData(block);
  if (!data) return null;

  const { kind, mime } = classification;

  switch (kind) {
    case 'image':
      if (!ENABLE_IMAGE_FALLBACK) return null;
      debug(`Converting image (${mime}) → description via Gemini`);
      return await describeImage(data, mime);

    case 'audio':
      if (!ENABLE_AUDIO_FALLBACK) return null;
      debug(`Converting audio (${mime}) → transcription via Gemini`);
      return await transcribeAudio(data, mime);

    case 'video':
      if (!ENABLE_VIDEO_FALLBACK) return null;
      debug(`Converting video (${mime}) → description via Gemini`);
      return await describeVideo(data, mime);

    case 'pdf':
      if (!ENABLE_DOCUMENT_FALLBACK) return null;
      debug(`Extracting text from PDF`);
      return await extractPdfText(data);

    case 'docx':
      if (!ENABLE_DOCUMENT_FALLBACK) return null;
      debug(`Extracting text from DOCX`);
      return await extractDocxText(data);

    default:
      return null;
  }
}

function messageHasMultimodal(msg) {
  if (!msg || typeof msg.content === 'string') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(block => {
    const type = getBlockType(block);
    return type === 'image' || type === 'audio' || type === 'video' || type === 'document';
  });
}

function countMultimodalBlocks(msg) {
  if (!msg || typeof msg.content === 'string') return 0;
  if (!Array.isArray(msg.content)) return 0;
  return msg.content.filter(block => {
    const type = getBlockType(block);
    return type === 'image' || type === 'audio' || type === 'video' || type === 'document';
  }).length;
}

async function convertMessageMultimodalContent(msg) {
  if (!msg || typeof msg.content === 'string') return { message: msg, conversions: [] };
  if (!Array.isArray(msg.content)) return { message: msg, conversions: [] };

  const newContent = [];
  const conversions = [];
  let hasTextBlock = false;

  for (const block of msg.content) {
    const type = getBlockType(block);

    if (type === 'text') {
      newContent.push(block);
      hasTextBlock = true;
      continue;
    }

    if (type === 'image' || type === 'audio' || type === 'video' || type === 'document') {
      const classification = classifyBlock(block);
      if (!classification) {
        newContent.push(block); // 保持原样，不处理
        continue;
      }

      try {
        const converted = await convertBlock(block);
        if (converted) {
          conversions.push({
            kind: classification.kind,
            mimeType: classification.mime,
            textLength: converted.length,
          });
          // 不添加原始 block，后续注入文本
        } else {
          newContent.push(block); // 转换失败，保持原样
        }
      } catch (e) {
        debug(`Conversion failed for ${classification.kind}: ${e.message}`);
        newContent.push(block); // 转换失败，保持原样
      }
      continue;
    }

    // 其他类型（tool_use, tool_result 等）保持原样
    newContent.push(block);
  }

  return { content: newContent, conversions };
}

function buildMultimodalContext(messages) {
  const contexts = [];
  let mediaIndex = 1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;

    const mediaBlocks = msg.content.filter(block => {
      const type = getBlockType(block);
      return type === 'image' || type === 'audio' || type === 'video' || type === 'document';
    });

    for (const block of mediaBlocks) {
      const classification = classifyBlock(block);
      if (!classification) continue;

      const typeLabel = {
        image: '图片', audio: '音频', video: '视频',
        pdf: 'PDF文档', docx: 'Word文档',
      }[classification.kind] || '文件';

      contexts.push(`[${typeLabel} #${mediaIndex} (${classification.mime})]`);
      mediaIndex++;
    }
  }

  return contexts;
}

// ─── 公开 API ────────────────────────────

export { ENABLE_IMAGE_FALLBACK, ENABLE_AUDIO_FALLBACK, ENABLE_VIDEO_FALLBACK, ENABLE_DOCUMENT_FALLBACK, GEMINI_API_KEY, GEMINI_MULTIMODAL_MODEL };

export async function preprocessMultimodalMessages(messages, options = {}) {
  const { needsFallback = false } = options;

  if (!messages || messages.length === 0) return { messages, conversions: [] };

  // 统计多模态 block
  const totalBlocks = messages.reduce((sum, m) => sum + countMultimodalBlocks(m), 0);
  if (totalBlocks === 0) return { messages, conversions: [] };

  debug(`Found ${totalBlocks} multimodal content blocks across ${messages.length} messages`);

  const allConversions = [];
  const contextItems = buildMultimodalContext(messages);
  let fallbackText = '';

  const processedMessages = [];

  for (const msg of messages) {
    if (!msg || typeof msg.content === 'string' || msg.role !== 'user') {
      processedMessages.push(msg);
      continue;
    }

    if (!Array.isArray(msg.content)) {
      processedMessages.push(msg);
      continue;
    }

    if (!needsFallback) {
      // 不需要降级 → 保持原样
      processedMessages.push(msg);
      continue;
    }

    // 需要降级处理
    const { content, conversions } = await convertMessageMultimodalContent(msg);

    if (conversions.length > 0) {
      allConversions.push(...conversions);

      // 为每次转换生成文本描述并追加到 content
      let descIdx = allConversions.length - conversions.length;
      for (const conv of conversions) {
        descIdx++;
        // 这里 convertBlock 已经做了缓存或 API 调用
        // 我们需要再次调用 convertBlock 来获取文字描述
      }
    }

    // 重新计算处理后的 content
    const finalBlocks = [];
    for (const block of msg.content) {
      const type = getBlockType(block);
      if (type === 'text') {
        finalBlocks.push(block);
        continue;
      }

      const classification = classifyBlock(block);
      if (!classification) {
        finalBlocks.push(block);
        continue;
      }

      try {
        const convertedText = await convertBlock(block);
        if (convertedText) {
          const typeLabel = {
            image: '图片内容', audio: '音频转录', video: '视频分析',
            pdf: 'PDF内容', docx: '文档内容',
          }[classification.kind] || '文件内容';

          allConversions.push({
            kind: classification.kind,
            mimeType: classification.mime,
            textLength: convertedText.length,
          });

          const separator = finalBlocks.length > 0 ? '\n\n---\n\n' : '';
          fallbackText += `${separator}【${typeLabel}】\n${convertedText}`;
        }
      } catch (e) {
        debug(`Conversion failed: ${e.message}`);
        finalBlocks.push(block); // 失败回退
      }
    }

    // 构建新的 content：移除所有多模态 block，保留文本
    const textBlocks = (Array.isArray(msg.content) ? msg.content : []).filter(block =>
      getBlockType(block) === 'text' || (getBlockType(block) !== 'image' &&
        getBlockType(block) !== 'audio' &&
        getBlockType(block) !== 'video' &&
        getBlockType(block) !== 'document' &&
        !classifyBlock(block))
    );

    processedMessages.push({ ...msg, content: textBlocks });
  }

  // 将多媒体描述文本注入到最后一条用户消息中
  if (fallbackText && processedMessages.length > 0) {
    // 找最后一条 user 消息
    for (let i = processedMessages.length - 1; i >= 0; i--) {
      if (processedMessages[i].role === 'user') {
        const existingContent = processedMessages[i].content;
        if (typeof existingContent === 'string') {
          processedMessages[i].content = existingContent + '\n\n---\n手动上传的文件内容：\n' + fallbackText;
        } else if (Array.isArray(existingContent)) {
          processedMessages[i].content = [
            ...existingContent,
            { type: 'text', text: '\n\n---\n手动上传的媒体文件内容：\n' + fallbackText },
          ];
        }
        break;
      }
    }
  }

  if (allConversions.length > 0) {
    const summary = allConversions.map(c =>
      `${c.kind}(${c.mimeType}, ${c.textLength}字符)`
    ).join(', ');
    console.log(`  🎨 多模态转换完成: ${summary}`);
  }

  return { messages: processedMessages, conversions: allConversions };
}

export async function needsMultimodalFallback(conn, messages) {
  if (!conn) return false;
  // 检查是否有任何多模态 block
  const hasMultimodal = messages && messages.some(m => messageHasMultimodal(m));
  if (!hasMultimodal) return false;

  // 检查目标模型是否支持对应类型
  const hasImage = messages.some(m =>
    Array.isArray(m.content) && m.content.some(b => getBlockType(b) === 'image')
  );
  const hasAudio = messages.some(m =>
    Array.isArray(m.content) && m.content.some(b => getBlockType(b) === 'audio')
  );
  const hasVideo = messages.some(m =>
    Array.isArray(m.content) && m.content.some(b => getBlockType(b) === 'video')
  );

  // 如果模型有 vision 能力且有图片，不需要降级
  if (hasImage && conn.capabilities?.vision !== false) {
    if (!hasAudio && !hasVideo) return false;
  }

  // 有音频/视频/文档 → 总是需要降级（除非 explicitly marked as multimodal）
  if (conn.capabilities?.multimodal === true && conn.capabilities?.audio === true) {
    return false;
  }

  return hasMultimodal;
}
