// sidecar/lib/local-proxy/tool-name-codec.js — Cross-protocol lossless tool name codec.
//
// Gemini / Antigravity FunctionDeclaration allows `.` and `:` in tool names
// (`^[a-zA-Z_][a-zA-Z0-9_\-\.:]{0,63}$`), whereas OpenAI Chat / Responses and
// Anthropic Messages strictly enforce `^[a-zA-Z0-9_-]{1,64}$`.
// When all names already conform, returns `null` (zero overhead fast path).

import crypto from 'node:crypto';

const SAFE_WIRE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isSafeWireToolName(name) {
  return SAFE_WIRE_TOOL_NAME_RE.test(String(name || ''));
}

function collectCandidateToolNames(tools = [], messages = [], toolChoice = null) {
  const names = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (s) names.push(s);
  };

  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    push(tool.function?.name || tool.name);
  }

  for (const msg of messages || []) {
    for (const part of msg?.content || []) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use') push(part.name);
      else if (part.type === 'tool_result') push(part.toolName || part.name);
      else if (part.type === 'gemini_part' && part.part) {
        const call = part.part.functionCall || part.part.function_call;
        const resp = part.part.functionResponse || part.part.function_response;
        if (call) push(call.name);
        if (resp) push(resp.name);
      }
    }
  }

  if (toolChoice && typeof toolChoice === 'object') {
    push(toolChoice.function?.name || toolChoice.name);
  }

  return names;
}

function encodeUnsafeToolName(original, usedWireNames) {
  const base = String(original)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool';
  const hash8 = crypto.createHash('sha256').update(String(original)).digest('hex').slice(0, 8);
  const suffix = `_${hash8}`;
  const headMax = Math.max(1, 64 - suffix.length);
  let candidate = `${base.slice(0, headMax)}${suffix}`;
  let collisionSeq = 1;
  while (usedWireNames.has(candidate)) {
    const altSuffix = `_${hash8.slice(0, 6)}${collisionSeq++}`;
    candidate = `${base.slice(0, Math.max(1, 64 - altSuffix.length))}${altSuffix}`;
  }
  usedWireNames.add(candidate);
  return candidate;
}

export function buildCrossProtocolToolNameCodec(tools = [], messages = [], toolChoice = null) {
  const allNames = collectCandidateToolNames(tools, messages, toolChoice);
  if (!allNames.some((n) => !isSafeWireToolName(n))) {
    return null;
  }

  const usedWireNames = new Set();
  const toWireMap = new Map();
  const fromWireMap = new Map();

  for (const name of allNames) {
    if (isSafeWireToolName(name)) usedWireNames.add(name);
  }
  for (const name of allNames) {
    if (isSafeWireToolName(name) || toWireMap.has(name)) continue;
    const wire = encodeUnsafeToolName(name, usedWireNames);
    toWireMap.set(name, wire);
    fromWireMap.set(wire, name);
  }

  return {
    toWire(name) {
      const s = String(name || '');
      return toWireMap.get(s) || s;
    },
    fromWire(name) {
      const s = String(name || '');
      return fromWireMap.get(s) || s;
    },
  };
}
