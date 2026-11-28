// normalize.js — Inbound request normalization (OpenAI Chat, Responses, Anthropic, Gemini)
// and schema/token/object utility functions.

export function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonObject(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

export function textPart(value) {
  const text = String(value || '');
  return text ? { type: 'text', text } : null;
}

function dataUrlToImage(url) {
  const m = String(url || '').trim().match(/^data:([^;,]+);base64,(.+)$/i);
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1] || 'image/png', data: m[2] || '' } };
}

function anthropicPartFromOpenAI(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text' || part.type === 'input_text') return textPart(part.text);
  if (part.type === 'image_url' || part.type === 'input_image') {
    const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    return dataUrlToImage(imageUrl || part.image_url);
  }
  return null;
}

export function openAIPartFromAnthropic(part, mode = 'chat') {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') return { type: mode === 'responses' ? 'input_text' : 'text', text: String(part.text || '') };
  if (part.type === 'image' && part.source?.data) {
    const url = `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`;
    return mode === 'responses' ? { type: 'input_image', image_url: url } : { type: 'image_url', image_url: { url } };
  }
  return null;
}

export function toolResultOutputText(raw) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object' && typeof p.text === 'string') return p.text;
      return p == null ? '' : JSON.stringify(p);
    }).join('\n');
  }
  if (raw == null) return '';
  return JSON.stringify(raw);
}

function appendMessageContent(messages, role, blocks, extraFields = null) {
  if (!Array.isArray(blocks) || blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    if (extraFields) {
      for (const [k, v] of Object.entries(extraFields)) {
        if (v !== undefined && last[k] === undefined) last[k] = v;
      }
    }
    return;
  }
  messages.push({ role, content: [...blocks], ...(extraFields || {}) });
}

function appendToolUseBlock(messages, block) {
  appendMessageContent(messages, 'assistant', [block]);
}

function appendToolResultBlock(messages, block) {
  appendMessageContent(messages, 'user', [block]);
}

export function normalizeOpenAI(body) {
  const messages = [];
  let system = String(body.instructions || '').trim();
  const input = Array.isArray(body.messages) ? body.messages : body.input;
  const rows = typeof input === 'string' ? [{ role: 'user', content: input }] : (Array.isArray(input) ? input : []);
  for (const msg of rows) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.type === 'function_call') {
      appendToolUseBlock(messages, {
        type: 'tool_use',
        id: String(msg.call_id || msg.id || ''),
        name: String(msg.name || ''),
        input: parseJsonObject(msg.arguments || '{}'),
      });
      continue;
    }
    if (msg.type === 'function_call_output') {
      appendToolResultBlock(messages, {
        type: 'tool_result',
        tool_use_id: String(msg.call_id || msg.id || ''),
        content: toolResultOutputText(msg.output),
      });
      continue;
    }
    const role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');
    const raw = msg.content ?? msg.text ?? '';
    if (role === 'system') {
      const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.map((p) => p?.text || '').join('\n') : '');
      system = [system, text].filter(Boolean).join('\n');
      continue;
    }
    if (msg.role === 'tool' || msg.tool_call_id) {
      const toolName = String(msg.name || '').trim();
      appendToolResultBlock(messages, {
        type: 'tool_result',
        tool_use_id: String(msg.tool_call_id || ''),
        content: toolResultOutputText(raw),
        ...(toolName ? { toolName } : {}),
      });
      continue;
    }
    const content = typeof raw === 'string' ? [textPart(raw)].filter(Boolean) : (Array.isArray(raw) ? raw.map(anthropicPartFromOpenAI).filter(Boolean) : []);
    for (const call of (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])) {
      if (!call?.function?.name) continue;
      const thoughtSignature = String(
        call.thoughtSignature
        || call.thought_signature
        || call.extra_content?.google?.thought_signature
        || call.extra_content?.google?.thoughtSignature
        || '',
      ).trim();
      content.push({
        type: 'tool_use',
        id: String(call.id || ''),
        name: String(call.function.name),
        input: parseJsonObject(call.function.arguments || '{}'),
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
    }
    if (content.length === 0) continue;
    const reasoningRaw = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
    const extraFields = role === 'assistant' && reasoningRaw ? { reasoningContent: reasoningRaw } : null;
    appendMessageContent(messages, role, content, extraFields);
  }
  return { system, messages };
}

function normalizeAnthropicContent(content) {
  if (typeof content === 'string') return [textPart(content)].filter(Boolean);
  if (!Array.isArray(content)) return [];
  return content.map((p) => {
    if (!p || typeof p !== 'object') return null;
    if (p.type === 'text') return textPart(p.text);
    if (p.type === 'image') return p;
    if (p.type === 'tool_use') return { type: 'tool_use', id: String(p.id || ''), name: String(p.name || ''), input: p.input || {} };
    if (p.type === 'tool_result') return { type: 'tool_result', tool_use_id: String(p.tool_use_id || ''), content: p.content, is_error: p.is_error === true };
    if (p.type === 'thinking') return { type: 'thinking', thinking: String(p.thinking || ''), signature: p.signature };
    if (p.type === 'redacted_thinking') return { type: 'redacted_thinking', data: p.data };
    return null;
  }).filter(Boolean);
}

function normalizeAnthropic(body) {
  const system = typeof body.system === 'string' ? body.system : (Array.isArray(body.system) ? body.system.map((p) => p?.text || '').filter(Boolean).join('\n') : '');
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: normalizeAnthropicContent(m?.content) }))
    .filter((m) => m.content.length > 0);
  return { system, messages };
}

function withThoughtSignature(part, signature) {
  return signature ? { ...part, thoughtSignature: signature } : part;
}

function geminiTextFromParts(parts) {
  return (Array.isArray(parts) ? parts : []).map((part) => part?.text || '').filter(Boolean).join('\n');
}

function normalizeGeminiPart(part) {
  if (!part || typeof part !== 'object') return null;
  const signature = String(part.thoughtSignature || part.thought_signature || '');
  if (part.thought === true && part.text !== undefined) {
    return {
      type: 'gemini_part',
      part: withThoughtSignature({ thought: true, text: String(part.text || '') }, signature),
    };
  }
  if (part.text !== undefined) {
    const t = textPart(part.text);
    if (!t) return null;
    return signature ? { type: 'text', text: t.text, thoughtSignature: signature } : t;
  }
  const inline = part.inlineData || part.inline_data;
  if (inline?.data) {
    const mime = String(inline.mimeType || inline.mime_type || 'image/png');
    if (!mime.startsWith('image/')) {
      return {
        type: 'gemini_part',
        part: withThoughtSignature({ inlineData: { mimeType: mime, data: String(inline.data || '') } }, signature),
      };
    }
    return { type: 'image', source: { type: 'base64', media_type: mime, data: String(inline.data || '') } };
  }
  if (part.functionResponse) return { type: 'gemini_part', part: withThoughtSignature({ functionResponse: part.functionResponse }, signature) };
  if (part.function_response) return { type: 'gemini_part', part: withThoughtSignature({ function_response: part.function_response }, signature) };
  if (part.functionCall) return { type: 'gemini_part', part: withThoughtSignature({ functionCall: part.functionCall }, signature) };
  if (part.function_call) return { type: 'gemini_part', part: withThoughtSignature({ function_call: part.function_call }, signature) };
  if (part.fileData || part.file_data || part.executableCode || part.executable_code || part.codeExecutionResult || part.code_execution_result) {
    return { type: 'gemini_part', part: structuredClone(part) };
  }
  return Object.keys(part).length > 0 ? { type: 'gemini_part', part: structuredClone(part) } : null;
}

function normalizeGeminiTools(tools) {
  const out = [];
  for (const group of (Array.isArray(tools) ? tools : [])) {
    const declarations = group?.functionDeclarations || group?.function_declarations || [];
    for (const fn of declarations) {
      const name = String(fn?.name || '').trim();
      if (!name) continue;
      const rawParams = fn.parameters ?? fn.parametersJsonSchema ?? fn.parameters_json_schema;
      out.push({
        type: 'function',
        function: {
          name,
          description: String(fn.description || ''),
          parameters: isPlainObject(rawParams) ? rawParams : { type: 'object', properties: {} },
        },
      });
    }
  }
  return out;
}

function normalizeGeminiToolChoice(body) {
  const cfg = body?.toolConfig?.functionCallingConfig || body?.tool_config?.function_calling_config;
  if (!cfg || typeof cfg !== 'object') return null;
  const mode = String(cfg.mode || '').trim().toUpperCase();
  if (!mode || mode === 'MODE_UNSPECIFIED' || mode === 'AUTO') return 'auto';
  if (mode === 'NONE') return 'none';
  const allowed = cfg.allowedFunctionNames || cfg.allowed_function_names || [];
  if (mode === 'ANY' && Array.isArray(allowed) && allowed.length === 1) {
    return { type: 'function', function: { name: String(allowed[0]) } };
  }
  if (mode === 'ANY') return 'required';
  return null;
}

function normalizeGemini(body) {
  const systemParts = body?.systemInstruction?.parts || body?.system_instruction?.parts || [];
  const system = geminiTextFromParts(systemParts);
  const messages = [];
  for (const content of (Array.isArray(body.contents) ? body.contents : [])) {
    const role = content?.role === 'model' ? 'assistant' : 'user';
    const parts = (Array.isArray(content?.parts) ? content.parts : []).map(normalizeGeminiPart).filter(Boolean);
    if (parts.length) messages.push({ role, content: parts });
  }
  return { system, messages };
}

function passthroughParams(kind, body = {}) {
  if (!body || typeof body !== 'object') return {};
  const blocked = new Set([
    'model', 'messages', 'input', 'instructions', 'system', 'stream',
    'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'temperature',
    'tools', 'tool_choice', 'toolChoice', 'extra_body', 'thinking', 'reasoning',
  ]);
  if (kind === 'gemini') {
    for (const key of [
      'contents', 'systemInstruction', 'system_instruction', 'generationConfig',
      'generation_config', 'toolConfig', 'tool_config', 'safetySettings',
      'safety_settings', 'cachedContent', 'cached_content',
    ]) blocked.add(key);
  }
  const out = isPlainObject(body.extra_body) ? { ...body.extra_body } : {};
  for (const [key, value] of Object.entries(body)) {
    if (blocked.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function normalizeRequest(kind, body) {
  const base = kind === 'anthropic'
    ? normalizeAnthropic(body)
    : (kind === 'gemini' ? normalizeGemini(body) : normalizeOpenAI(body));
  const generationConfig = kind === 'gemini' && body?.generationConfig && typeof body.generationConfig === 'object'
    ? body.generationConfig
    : {};
  return {
    kind,
    model: String(body.model || '').trim(),
    system: base.system,
    messages: base.messages,
    tools: kind === 'gemini' ? normalizeGeminiTools(body.tools) : (Array.isArray(body.tools) ? body.tools : []),
    toolChoice: kind === 'gemini' ? normalizeGeminiToolChoice(body) : (body.tool_choice || body.toolChoice || null),
    stream: body.stream === true,
    maxTokens: Number(body.max_tokens || body.max_output_tokens || body.max_completion_tokens || generationConfig.maxOutputTokens || generationConfig.max_output_tokens) || 4096,
    temperature: Number.isFinite(Number(body.temperature ?? generationConfig.temperature)) ? Number(body.temperature ?? generationConfig.temperature) : undefined,
    extraParams: passthroughParams(kind, body),
    rawBody: body,
  };
}

export function cleanBody(body) {
  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);
  return body;
}

export function estimateTokens(messages, system = '') {
  return Math.max(1, Math.ceil(JSON.stringify({ system, messages }).length / 4));
}

const GOOGLE_SCHEMA_TYPE_BY_INDEX = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
const GOOGLE_SCHEMA_TYPE_BY_NAME = {
  STRING: 'string', NUMBER: 'number', INTEGER: 'integer',
  BOOLEAN: 'boolean', ARRAY: 'array', OBJECT: 'object',
};

const NUMERIC_SCHEMA_CONSTRAINT_KEYS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
];

function normalizeSchemaTypeValue(type) {
  if (Array.isArray(type)) {
    return type.map((item) => normalizeSchemaTypeValue(item));
  }
  if (typeof type === 'number' && Number.isInteger(type) && type >= 1 && type <= 6) {
    return GOOGLE_SCHEMA_TYPE_BY_INDEX[type - 1];
  }
  if (typeof type === 'string') {
    return GOOGLE_SCHEMA_TYPE_BY_NAME[type.toUpperCase()] || type;
  }
  return type;
}

function coerceNumericSchemaConstraints(out) {
  for (const key of NUMERIC_SCHEMA_CONSTRAINT_KEYS) {
    const val = out[key];
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        if (Number.isFinite(num)) out[key] = num;
      }
    }
  }
}

export function normalizeToolParameters(schema, { isRoot = true } = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = { ...schema };
  if (out.type !== undefined) out.type = normalizeSchemaTypeValue(out.type);
  coerceNumericSchemaConstraints(out);
  if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
    const props = {};
    for (const [key, value] of Object.entries(out.properties)) {
      props[key] = normalizeToolParameters(value, { isRoot: false });
    }
    out.properties = props;
  }
  if (Array.isArray(out.items)) {
    out.items = out.items.map((item) => normalizeToolParameters(item, { isRoot: false }));
  } else if (out.items) {
    out.items = normalizeToolParameters(out.items, { isRoot: false });
  }
  if (isPlainObject(out.additionalProperties)) {
    out.additionalProperties = normalizeToolParameters(out.additionalProperties, { isRoot: false });
  }
  for (const defsKey of ['$defs', 'definitions']) {
    if (isPlainObject(out[defsKey])) {
      const nextDefs = {};
      for (const [k, v] of Object.entries(out[defsKey])) {
        nextDefs[k] = normalizeToolParameters(v, { isRoot: false });
      }
      out[defsKey] = nextDefs;
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(out[key])) out[key] = out[key].map((item) => normalizeToolParameters(item, { isRoot: false }));
  }
  if (isPlainObject(out.not)) {
    out.not = normalizeToolParameters(out.not, { isRoot: false });
  }
  if (isRoot) {
    if (out.type === undefined && !out.anyOf && !out.oneOf && !out.allOf) {
      out.type = 'object';
    }
    if (out.type === 'object' && out.properties === undefined && out.additionalProperties === undefined) {
      out.properties = {};
    }
  }
  return out;
}

export function toolDescriptor(tool) {
  if (tool?.type === 'function' && tool.function?.name) {
    return { name: tool.function.name, description: tool.function.description || '', schema: tool.function.parameters };
  }
  if (tool?.type === 'function' && tool?.name) {
    return { name: tool.name, description: tool.description || '', schema: tool.parameters };
  }
  if (tool?.name && tool.input_schema) {
    return { name: tool.name, description: tool.description || '', schema: tool.input_schema };
  }
  return null;
}

export function hasImage(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'));
}

export function hasGeminiNativeOnlyParts(messages) {
  return (messages || []).some((message) => (message.content || []).some((part) => part?.type === 'gemini_part'));
}
