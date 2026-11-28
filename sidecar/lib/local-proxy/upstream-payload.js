// upstream-payload.js — Outbound request payload dispatcher & Gemini/Vertex payload builders
// (Gemini tool history & thoughtSignature replay, Gemini native passthrough; OpenAI/Anthropic builders live in ./openai-anthropic-payload.js).

import { cleanGeminiToolParameters } from '../gemini-schema.js';
import {
  GEMINI_SKIP_THOUGHT_SIGNATURE,
  buildGeminiSignatureScope,
  lookupGeminiToolCall,
} from '../gemini-thought-signature.js';
import { geminiActionApiPath, normalizeGeminiThinkingConfig } from '../google-gemini.js';
import { applyThinkingToPayload } from '../thinking-effort.js';
import {
  cleanBody,
  hasGeminiNativeOnlyParts,
  isPlainObject,
  parseJsonObject,
  textPart,
  toolResultOutputText,
} from './normalize.js';
import { buildCrossProtocolToolNameCodec } from './tool-name-codec.js';
import {
  anthropicTools,
  applyChatAssistantReasoning,
  buildAnthropicUpstreamBody,
  buildOpenAIUpstreamBody,
  clientAnthropicEffort,
  clientChatReasoningEffort,
  clientReasoningEffort,
  openAIChatMessages,
  openAIResponsesInput,
  openAITools,
  responsesToolChoice,
} from './openai-anthropic-payload.js';

export {
  anthropicTools,
  applyChatAssistantReasoning,
  openAIChatMessages,
  openAIResponsesInput,
  openAITools,
  responsesToolChoice,
};

function geminiPartFromAnthropic(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    const out = { text: String(part.text || '') };
    if (part.thoughtSignature) out.thoughtSignature = part.thoughtSignature;
    return out;
  }
  if (part.type === 'image' && part.source?.data) {
    return { inlineData: { mimeType: part.source.media_type || 'image/png', data: part.source.data } };
  }
  if (part.type === 'gemini_part' && part.part) return part.part;
  return null;
}

function geminiCallId(call, assignedCallIds = null) {
  if (assignedCallIds && call && assignedCallIds.has(call)) {
    return assignedCallIds.get(call);
  }
  const name = String(call?.name || '').trim();
  return String(call?.id || '') || (name ? `call_${name}` : '');
}

function extractGeminiFunctionResponseContent(response) {
  const raw = response.response ?? response.result ?? response.content ?? response.output;
  const rawIsEmptyObj = isPlainObject(raw) && Object.keys(raw).length === 0;
  const rawText = raw !== undefined && !rawIsEmptyObj ? toolResultOutputText(raw) : '';

  const respParts = Array.isArray(response.parts) ? response.parts : [];
  const partTexts = [];
  const partImages = [];
  for (const p of respParts) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.text === 'string' && p.text) partTexts.push(p.text);
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      const mime = String(inline.mimeType || inline.mime_type || 'image/png');
      if (mime.startsWith('image/')) {
        partImages.push({ type: 'image', source: { type: 'base64', media_type: mime, data: String(inline.data) } });
      }
    }
  }
  const combinedText = [rawText, ...partTexts].filter(Boolean).join('\n');
  if (partImages.length > 0) {
    const blocks = [];
    if (combinedText) blocks.push({ type: 'text', text: combinedText });
    blocks.push(...partImages);
    return blocks;
  }
  if (combinedText) return combinedText;
  return raw !== undefined ? toolResultOutputText(raw) : '';
}

function crossProtocolGeminiPart(part, resolveResponseId, assignedCallIds = null) {
  if (!part || part.type !== 'gemini_part' || !part.part) return null;
  const native = part.part;
  const call = native.functionCall || native.function_call;
  if (call) {
    const name = String(call.name || '').trim();
    if (!name) return null;
    const args = call.args ?? call.arguments ?? call.input ?? {};
    return {
      type: 'tool_use',
      id: geminiCallId(call, assignedCallIds),
      name,
      input: typeof args === 'string' ? parseJsonObject(args) : (args && typeof args === 'object' ? args : {}),
    };
  }
  const response = native.functionResponse || native.function_response;
  if (response) {
    const name = String(response.name || '').trim();
    return {
      type: 'tool_result',
      tool_use_id: resolveResponseId(response),
      content: extractGeminiFunctionResponseContent(response),
      ...(name ? { toolName: name } : {}),
    };
  }
  const inline = native.inlineData || native.inline_data;
  if (inline) {
    const mime = String(inline.mimeType || inline.mime_type || 'application/octet-stream');
    return textPart(`[Gemini Native 附件 ${mime}：跨协议上游不支持该媒体类型，内容已省略]`);
  }
  const fileData = native.fileData || native.file_data;
  if (fileData) {
    const uri = String(fileData.fileUri || fileData.file_uri || '').trim();
    const mime = String(fileData.mimeType || fileData.mime_type || '').trim();
    return textPart(`[Gemini FileData${mime ? ` ${mime}` : ''}: ${uri || '(no uri)'}]`);
  }
  const execCode = native.executableCode || native.executable_code;
  if (execCode) {
    const lang = String(execCode.language || '').trim();
    const code = String(execCode.code || '').trim();
    return textPart(code ? `\`\`\`${lang.toLowerCase()}\n${code}\n\`\`\`` : '[Gemini ExecutableCode]');
  }
  const codeRes = native.codeExecutionResult || native.code_execution_result;
  if (codeRes) {
    const outcome = String(codeRes.outcome || '').trim();
    const outText = String(codeRes.output || '').trim();
    return textPart(`[Code Execution${outcome ? ` ${outcome}` : ''}]${outText ? `\n${outText}` : ''}`);
  }
  return null;
}

function messagesForNonGeminiUpstream(messages) {
  if (!hasGeminiNativeOnlyParts(messages)) return messages;
  const callIds = [];
  const idsByName = new Map();
  const assignedCallIds = new WeakMap();
  let autoCallSeq = 0;
  for (const message of messages || []) {
    for (const part of message.content || []) {
      if (part?.type !== 'gemini_part') continue;
      const call = part.part?.functionCall || part.part?.function_call;
      if (!call) continue;
      const name = String(call.name || '').trim();
      const explicitId = String(call.id || '').trim();
      const safeSlug = (name || 'fn').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'fn';
      const id = explicitId || `call_${safeSlug}_${++autoCallSeq}`;
      assignedCallIds.set(call, id);
      callIds.push(id);
      if (name) {
        const queue = idsByName.get(name) || [];
        queue.push(id);
        idsByName.set(name, queue);
      }
    }
  }
  let sequential = 0;
  const resolveResponseId = (response) => {
    const explicit = String(response?.id || '');
    if (explicit && (!callIds.length || callIds.includes(explicit))) return explicit;
    const name = String(response?.name || '').trim();
    const queue = name ? idsByName.get(name) : null;
    if (queue?.length) return queue.shift();
    if (callIds.length) return callIds[Math.min(sequential++, callIds.length - 1)];
    return explicit || (name ? `call_${name}` : '');
  };
  return (messages || [])
    .map((message) => ({
      ...message,
      content: (message.content || []).map((part) => {
        if (part?.type !== 'gemini_part') return part;
        const converted = crossProtocolGeminiPart(part, resolveResponseId, assignedCallIds);
        if (converted) return converted;
        return part.part?.thought === true ? null : textPart('[Gemini Native 内容：跨协议上游不支持该结构，已省略]');
      }).filter(Boolean),
    }))
    .filter((message) => Array.isArray(message.content) && message.content.length > 0);
}

function geminiToolResponsePayload(part) {
  const raw = Array.isArray(part.content)
    ? part.content.filter((b) => typeof b === 'string' || b?.type !== 'image')
    : part.content;
  const text = toolResultOutputText(raw);
  return part.is_error === true ? { error: text || 'tool execution failed' } : { result: text };
}

function geminiToolResultImageParts(part) {
  if (!Array.isArray(part.content)) return [];
  const extras = [];
  for (const block of part.content) {
    if (block?.type === 'image' && block.source?.data) {
      extras.push({ inlineData: { mimeType: block.source.media_type || 'image/png', data: block.source.data } });
    }
  }
  return extras;
}

function geminiPartsFromInternalPart(part, callNameById, scope = '') {
  if (!part || typeof part !== 'object') return [];
  if (part.type === 'tool_use') {
    const name = String(part.name || '').trim();
    if (!name) return [];
    const id = String(part.id || '').trim();
    const cached = id ? lookupGeminiToolCall(id, scope) : null;
    const signature = String(part.thoughtSignature || part.thought_signature || cached?.signature || '').trim();
    const upstreamId = String(cached?.upstreamId || '').trim();
    const rawArgs = part.input ?? part.arguments ?? {};
    const args = isPlainObject(rawArgs) ? rawArgs : (typeof rawArgs === 'string' ? parseJsonObject(rawArgs) : {});
    const functionCall = upstreamId ? { id: upstreamId, name, args } : { name, args };
    return [signature ? { functionCall, thoughtSignature: signature } : { functionCall }];
  }
  if (part.type === 'tool_result') {
    const toolUseId = String(part.tool_use_id || '').trim();
    const cached = toolUseId ? lookupGeminiToolCall(toolUseId, scope) : null;
    const upstreamId = String(cached?.upstreamId || '').trim();
    const name = callNameById.get(toolUseId) || String(part.toolName || part.name || '').trim() || 'function';
    const response = geminiToolResponsePayload(part);
    const functionResponse = upstreamId ? { id: upstreamId, name, response } : { name, response };
    return [{ functionResponse }, ...geminiToolResultImageParts(part)];
  }
  const single = geminiPartFromAnthropic(part);
  return single ? [single] : [];
}

function orderedContentWithAlignedToolResults(content, prevCallOrder) {
  if (!prevCallOrder?.size || !Array.isArray(content) || content.length <= 1) return content;
  const resultIndices = [];
  const resultParts = [];
  content.forEach((p, idx) => {
    if (p?.type === 'tool_result') {
      resultIndices.push(idx);
      resultParts.push(p);
    }
  });
  if (resultParts.length <= 1) return content;
  const sorted = [...resultParts].sort((a, b) => {
    const ia = prevCallOrder.has(String(a.tool_use_id || '')) ? prevCallOrder.get(String(a.tool_use_id || '')) : Number.MAX_SAFE_INTEGER;
    const ib = prevCallOrder.has(String(b.tool_use_id || '')) ? prevCallOrder.get(String(b.tool_use_id || '')) : Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
  const out = [...content];
  resultIndices.forEach((origIdx, k) => { out[origIdx] = sorted[k]; });
  return out;
}

export function geminiContents(system, messages, conn = null) {
  const scope = buildGeminiSignatureScope(conn);
  const callNameById = new Map();
  for (const m of messages || []) {
    for (const p of m.content || []) {
      if (p?.type === 'tool_use' && p.id && p.name) callNameById.set(String(p.id), String(p.name));
      else if (p?.type === 'gemini_part' && p.part) {
        const call = p.part.functionCall || p.part.function_call;
        if (call?.id && call?.name) callNameById.set(String(call.id), String(call.name));
      }
    }
  }
  const out = [];
  let prevCallOrder = new Map();
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const sourceContent = role === 'user' ? orderedContentWithAlignedToolResults(m.content || [], prevCallOrder) : (m.content || []);
    const parts = [];
    let hasConvertedToolUse = false;
    for (const p of sourceContent) {
      if (p?.type === 'tool_use' && p.name) hasConvertedToolUse = true;
      parts.push(...geminiPartsFromInternalPart(p, callNameById, scope));
    }
    if (!parts.length) continue;
    if (role === 'model') {
      const nextCallOrder = new Map();
      let callSeq = 0;
      for (const p of sourceContent) {
        if (p?.type === 'tool_use' && p.id) nextCallOrder.set(String(p.id), callSeq++);
      }
      prevCallOrder = nextCallOrder;
      if (hasConvertedToolUse) {
        const firstCallPart = parts.find((pt) => pt.functionCall || pt.function_call);
        if (firstCallPart && !(firstCallPart.thoughtSignature || firstCallPart.thought_signature)) {
          firstCallPart.thoughtSignature = GEMINI_SKIP_THOUGHT_SIGNATURE;
        }
      }
    }
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  if (!out.length && system) out.push({ role: 'user', parts: [{ text: system }] });
  return out;
}

export function geminiTools(tools, rawGeminiTools = []) {
  const out = [];
  const declarations = [];
  for (const tool of tools || []) {
    if (tool && typeof tool === 'object' && !Array.isArray(tool) && (tool.google_search || tool.googleSearch) && !tool.name && !tool.function?.name) {
      out.push(tool.googleSearch ? { googleSearch: tool.googleSearch } : { google_search: tool.google_search });
      continue;
    }
    const fn = tool?.type === 'function' ? tool.function : tool;
    const name = String(fn?.name || '').trim();
    if (!name) continue;
    const rawParams = fn.parameters ?? fn.parametersJsonSchema ?? fn.parameters_json_schema ?? fn.input_schema;
    declarations.push({
      name,
      description: String(fn.description || ''),
      parameters: cleanGeminiToolParameters(rawParams),
    });
  }
  if (declarations.length) out.push({ functionDeclarations: declarations });
  for (const entry of (Array.isArray(rawGeminiTools) ? rawGeminiTools : [])) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { functionDeclarations, function_declarations, ...builtin } = entry;
    if (Object.keys(builtin).length > 0) out.push(builtin);
  }
  return out.length ? out : undefined;
}

export function geminiToolConfig(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (toolChoice === 'required' || toolChoice?.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (toolChoice === 'auto' || toolChoice?.type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  const name = toolChoice?.function?.name || toolChoice?.name;
  if (name) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [String(name)] } };
  return undefined;
}

export function geminiGenerationConfig(ctx) {
  const raw = ctx.rawBody?.generationConfig || ctx.rawBody?.generation_config || {};
  const config = isPlainObject(raw) ? { ...raw } : {};
  delete config.max_output_tokens;
  const explicitMax = raw.maxOutputTokens ?? raw.max_output_tokens
    ?? ctx.rawBody?.max_output_tokens ?? ctx.rawBody?.max_tokens ?? ctx.rawBody?.max_completion_tokens;
  if (explicitMax === undefined || explicitMax === null || explicitMax === '') delete config.maxOutputTokens;
  else config.maxOutputTokens = ctx.maxTokens;
  if (ctx.temperature !== undefined) config.temperature = ctx.temperature;
  return config;
}

export function geminiStreamApiPath(conn) {
  return geminiActionApiPath(String(conn?.apiPath || ''), 'streamGenerateContent');
}

export function buildGeminiChatPayload({
  conn,
  system = '',
  messages = [],
  tools = [],
  rawTools = undefined,
  toolChoice = undefined,
  generationConfig = undefined,
  safetySettings = undefined,
  cachedContent = undefined,
  effort = null,
  extras = {},
} = {}) {
  const { model: _ignoredModel, stream: _ignoredStream, ...geminiExtras } = extras || {};
  let body = cleanBody({
    ...geminiExtras,
    contents: geminiContents(system, messages, conn),
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig,
    tools: geminiTools(tools, rawTools),
    toolConfig: geminiToolConfig(toolChoice),
    safetySettings: safetySettings || undefined,
    cachedContent: cachedContent || undefined,
  });
  if (effort === 'none') applyThinkingToPayload(body, conn, { mode: 'off' });
  else if (effort) applyThinkingToPayload(body, conn, { mode: 'level', level: effort });
  return normalizeGeminiThinkingConfig(body, conn);
}

const ANTIGRAVITY_INTERNAL_WRAPPER_KEYS = [
  'model',
  'stream',
  'extra_body',
  'customModelInfoOverride',
  'request',
  'project',
  'requestId',
  'requestType',
  'userAgent',
  'sessionId',
  'session_id',
  'user_prompt_id',
  'metadata',
];

function schemaNeedsGeminiSanitization(schema, isChildProperty = false) {
  if (!schema || typeof schema !== 'object') return false;
  if (Array.isArray(schema)) return schema.some((item) => schemaNeedsGeminiSanitization(item, false));
  if (Array.isArray(schema.type)) return true;
  if (isChildProperty && schema.type === undefined && !Array.isArray(schema.anyOf) && !Array.isArray(schema.enum) && Object.keys(schema).length > 0) {
    return true;
  }
  for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (typeof schema[k] === 'string') return true;
  }
  for (const k of ['$schema', '$defs', 'definitions', 'additionalProperties', 'allOf', 'oneOf', 'exclusiveMinimum', 'exclusiveMaximum', 'const']) {
    if (Object.prototype.hasOwnProperty.call(schema, k)) return true;
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const v of Object.values(schema.properties)) {
      if (schemaNeedsGeminiSanitization(v, true)) return true;
    }
  }
  if (schema.items && schemaNeedsGeminiSanitization(schema.items, false)) return true;
  if (Array.isArray(schema.anyOf) && schema.anyOf.some((item) => schemaNeedsGeminiSanitization(item, false))) return true;
  return false;
}

function normalizeGeminiTopLevelSnakeCase(body) {
  const topAliases = [
    ['system_instruction', 'systemInstruction'],
    ['generation_config', 'generationConfig'],
    ['tool_config', 'toolConfig'],
    ['safety_settings', 'safetySettings'],
    ['cached_content', 'cachedContent'],
  ];
  for (const [snake, camel] of topAliases) {
    if (body[snake] !== undefined && body[camel] === undefined) {
      body[camel] = body[snake];
    }
    delete body[snake];
  }
  if (isPlainObject(body.generationConfig)) {
    const gen = body.generationConfig;
    if (gen.max_output_tokens !== undefined && gen.maxOutputTokens === undefined) {
      gen.maxOutputTokens = gen.max_output_tokens;
    }
    delete gen.max_output_tokens;
    if (gen.thinking_config !== undefined && gen.thinkingConfig === undefined) {
      gen.thinkingConfig = gen.thinking_config;
    }
    delete gen.thinking_config;
    if (isPlainObject(gen.thinkingConfig)) {
      const tc = gen.thinkingConfig;
      if (tc.thinking_budget !== undefined && tc.thinkingBudget === undefined) tc.thinkingBudget = tc.thinking_budget;
      delete tc.thinking_budget;
      if (tc.thinking_level !== undefined && tc.thinkingLevel === undefined) tc.thinkingLevel = tc.thinking_level;
      delete tc.thinking_level;
      if (tc.include_thoughts !== undefined && tc.includeThoughts === undefined) tc.includeThoughts = tc.include_thoughts;
      delete tc.include_thoughts;
    }
  }
}

export function buildGeminiNativePassthroughPayload(conn, ctx, extras = {}) {
  const raw = structuredClone(ctx.rawBody || {});
  for (const stripKey of ANTIGRAVITY_INTERNAL_WRAPPER_KEYS) {
    delete raw[stripKey];
  }
  const {
    model: _ignoredModel,
    stream: _ignoredStream,
    extra_body: _ignoredExtraBody,
    ...cleanExtras
  } = extras || {};
  const body = { ...raw, ...cleanExtras };
  normalizeGeminiTopLevelSnakeCase(body);

  if (ctx.systemOverridden) {
    delete body.system_instruction;
    if (ctx.system) body.systemInstruction = { parts: [{ text: ctx.system }] };
    else delete body.systemInstruction;
  } else if (ctx.systemPromptPrefixApplied) {
    const origSys = body.systemInstruction;
    const origParts = Array.isArray(origSys?.parts) ? origSys.parts : [];
    body.systemInstruction = {
      ...(origSys && typeof origSys === 'object' ? origSys : {}),
      parts: [{ text: ctx.systemPromptPrefixApplied }, ...origParts],
    };
  }

  if (ctx.toolsMutated) {
    const rebuiltTools = geminiTools(ctx.tools, ctx.rawBody?.tools);
    if (rebuiltTools) body.tools = rebuiltTools;
    else delete body.tools;
  } else if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const decls = entry.functionDeclarations || entry.function_declarations;
      if (!Array.isArray(decls)) return entry;
      const cleanedDecls = decls.map((fn) => {
        if (!fn || typeof fn !== 'object') return fn;
        const hasJsonSchemaField = fn.parametersJsonSchema !== undefined || fn.parameters_json_schema !== undefined;
        const rawParams = fn.parameters ?? fn.parametersJsonSchema ?? fn.parameters_json_schema;
        if (!rawParams) return fn;
        if (!hasJsonSchemaField && !conn?.isVertex && !schemaNeedsGeminiSanitization(rawParams)) return fn;
        const nextFn = { ...fn, parameters: cleanGeminiToolParameters(rawParams) };
        delete nextFn.parametersJsonSchema;
        delete nextFn.parameters_json_schema;
        return nextFn;
      });
      const out = { ...entry, functionDeclarations: cleanedDecls };
      delete out.function_declarations;
      return out;
    });
  }

  if (ctx.toolChoiceMutated) {
    delete body.tool_config;
    const rebuiltChoice = geminiToolConfig(ctx.toolChoice);
    if (rebuiltChoice) body.toolConfig = rebuiltChoice;
    else delete body.toolConfig;
  }

  if (ctx.maxTokensOverridden || ctx.temperatureOverridden) {
    const origGen = isPlainObject(body.generationConfig) ? { ...body.generationConfig } : {};
    if (ctx.maxTokensOverridden) {
      delete origGen.max_output_tokens;
      origGen.maxOutputTokens = ctx.maxTokens;
    }
    if (ctx.temperatureOverridden) {
      origGen.temperature = ctx.temperature;
    }
    if (Object.keys(origGen).length) body.generationConfig = origGen;
  }

  return normalizeGeminiThinkingConfig(cleanBody(body), conn);
}

export function upstreamBody(conn, ctx) {
  const extras = {
    ...(ctx.preserveExtraParams === true ? (ctx.extraParams || {}) : {}),
    ...(ctx.paramOverrideExtras || {}),
  };
  const messages = conn.format === 'gemini' ? ctx.messages : messagesForNonGeminiUpstream(ctx.messages);
  if (conn.format === 'anthropic') {
    const codec = buildCrossProtocolToolNameCodec(ctx.tools, messages, ctx.toolChoice);
    ctx._toolNameCodec = codec;
    return buildAnthropicUpstreamBody(conn, ctx, messages, extras, codec);
  }
  if (conn.format === 'gemini') {
    ctx._toolNameCodec = null;
    if (ctx.kind === 'gemini' && isPlainObject(ctx.rawBody) && ctx.visionFallbackApplied !== true) {
      return buildGeminiNativePassthroughPayload(conn, ctx, extras);
    }
    const rawTools = ctx.kind === 'gemini' ? ctx.rawBody?.tools : undefined;
    const geminiEffort = clientReasoningEffort(conn, ctx) || clientChatReasoningEffort(conn, ctx) || clientAnthropicEffort(conn, ctx);
    return buildGeminiChatPayload({
      conn,
      system: ctx.system,
      messages,
      tools: ctx.tools,
      rawTools,
      toolChoice: ctx.toolChoice,
      generationConfig: geminiGenerationConfig(ctx),
      safetySettings: ctx.rawBody?.safetySettings || ctx.rawBody?.safety_settings || undefined,
      cachedContent: ctx.rawBody?.cachedContent || ctx.rawBody?.cached_content || undefined,
      effort: geminiEffort,
      extras,
    });
  }
  const codec = buildCrossProtocolToolNameCodec(ctx.tools, messages, ctx.toolChoice);
  ctx._toolNameCodec = codec;
  return buildOpenAIUpstreamBody(conn, ctx, messages, extras, codec);
}
