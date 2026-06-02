// handlers/parse-request.js — Full protobuf parser for GetChatMessageRequest
//
// GetChatMessageRequest {
//   Metadata metadata = 1;
//   string prompt = 2;                                   // top-level system prompt
//   repeated ChatMessagePrompt chat_message_prompts = 3; // conversation history
//   repeated ChatToolDefinition tools = 10;              // tool definitions
//   ChatToolChoice tool_choice = 12;                     // tool choice policy
//   string chat_model_uid = 21;                          // model ID
// }

import fs from 'node:fs';
import { parseFields, getField, getAllFields } from '../proto.js';
import { unwrapRequest } from '../connect.js';

// ─── System prompt override ─────────────────────────────────
//
// Replace the static Cascade prompt (proto field 2) with a custom one.
// Dynamic IDE additions (SOURCE.SYSTEM_PROMPT messages: workspace rules,
// memories, context) are still appended after the override.
//
// Hot-reloads on file change — edit the file, next request picks it up.

const SYSTEM_PROMPT_OVERRIDE = process.env.SYSTEM_PROMPT_OVERRIDE === 'true';
const SYSTEM_PROMPT_PATH     = process.env.SYSTEM_PROMPT_PATH || '';

let _promptCache = { content: '', mtime: 0, path: '' };

function getCustomSystemPrompt() {
  if (!SYSTEM_PROMPT_OVERRIDE || !SYSTEM_PROMPT_PATH) return '';
  try {
    const stat = fs.statSync(SYSTEM_PROMPT_PATH);
    if (_promptCache.path === SYSTEM_PROMPT_PATH && _promptCache.mtime === stat.mtimeMs) {
      return _promptCache.content;
    }
    const content = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
    _promptCache = { content, mtime: stat.mtimeMs, path: SYSTEM_PROMPT_PATH };
    console.log(`  📝 Custom system prompt loaded (${content.length} chars)`);
    return content;
  } catch (err) {
    console.error(`  ❌ Failed to load custom system prompt: ${err.message}`);
    return '';
  }
}

// ─── Functional section extractor ──────────────────────────
//
// Keeps tool/workspace/IDE sections from original Cascade prompt,
// drops identity ("You are Cascade...") and style sections.

const KEEP_SECTIONS = [
  'tool_calling',
  'making_code_changes',
  'citation_guidelines',
  'running_commands',
  'calling_external_apis',
  'workflows',
  'user_information',
  'workspace_information',
  'memory_system',
  'ide_metadata',
];

// Also keep standalone lines that contain functional instructions
const KEEP_LINE_PATTERNS = [
  /^There will be an <ephemeral_message>/,
  /^Bug fixing discipline:/,
  /^Long-horizon workflow:/,
  /^Planning cadence:/,
  /^Testing discipline:/,
  /^Verification tools:/,
  /^Progress notes:/,
];

function extractFunctionalSections(original) {
  const parts = [];

  // Extract XML sections by tag name
  for (const tag of KEEP_SECTIONS) {
    const regex = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
    let match;
    while ((match = regex.exec(original)) !== null) {
      parts.push(match[0]);
    }
    // Also match sections that contain nested tags (e.g. workspace_layout inside workspace_information)
    const openTag = `<${tag} `;
    const closeTag = `</${tag}>`;
    let idx = original.indexOf(openTag);
    while (idx !== -1) {
      const end = original.indexOf(closeTag, idx);
      if (end !== -1) {
        parts.push(original.slice(idx, end + closeTag.length));
      }
      idx = original.indexOf(openTag, idx + 1);
    }
  }

  // Extract standalone functional lines
  for (const line of original.split('\n')) {
    const trimmed = line.trim();
    if (KEEP_LINE_PATTERNS.some(p => p.test(trimmed))) {
      parts.push(trimmed);
    }
  }

  // Sanitize: strip product identity references from preserved sections
  let result = parts.join('\n\n');
  result = result.replace(/\bCascade\b/gi, 'the assistant');
  result = result.replace(/\bCASCADE\b/g, 'SYSTEM');
  return result;
}

// ChatMessageSource enum values
const SOURCE = {
  UNSPECIFIED:   0,
  USER:          1,
  SYSTEM:        2,  // maps to assistant role
  UNKNOWN:       3,  // assistant
  TOOL:          4,  // tool result
  SYSTEM_PROMPT: 5,  // folded into systemPrompt
};

// ─── Nested parsers ────────────────────────────────────────

/**
 * Parse an ImageData message buffer.
 *
 * ImageData {
 *   string base64_data = 1;
 *   string mime_type = 2;
 *   string caption = 3;
 * }
 */
function parseImageData(buf) {
  const fields = parseFields(buf);
  const base64Field = getField(fields, 1, 2);
  const mimeField   = getField(fields, 2, 2);
  const captionField = getField(fields, 3, 2);
  return {
    base64_data: base64Field ? base64Field.value.toString('utf8') : '',
    mime_type:   mimeField   ? mimeField.value.toString('utf8')   : 'image/png',
    caption:     captionField ? captionField.value.toString('utf8') : '',
  };
}

/**
 * Parse a ChatToolCall message buffer.
 *
 * ChatToolCall {
 *   string id = 1;
 *   string name = 2;
 *   string arguments_json = 3;
 * }
 */
function parseChatToolCall(buf) {
  const fields = parseFields(buf);
  const idField    = getField(fields, 1, 2);
  const nameField  = getField(fields, 2, 2);
  const argsField  = getField(fields, 3, 2);
  return {
    id:             idField   ? idField.value.toString('utf8')   : '',
    name:           nameField ? nameField.value.toString('utf8') : '',
    arguments_json: argsField ? argsField.value.toString('utf8') : '{}',
  };
}

/**
 * Parse a ChatMessagePrompt message buffer.
 *
 * ChatMessagePrompt {
 *   string message_id = 1;
 *   ChatMessageSource source = 2;      // varint enum
 *   string prompt = 3;
 *   uint32 num_tokens = 4;
 *   repeated ChatToolCall tool_calls = 6;
 *   string tool_call_id = 7;
 *   bool tool_result_is_error = 9;
 *   repeated ImageData images = 10;
 *   string thinking = 11;
 *   string signature = 12;
 * }
 */
function parseChatMessagePrompt(buf) {
  const fields = parseFields(buf);

  const messageIdField        = getField(fields, 1, 2);
  const sourceField           = getField(fields, 2, 0);
  const promptField           = getField(fields, 3, 2);
  const toolCallIdField       = getField(fields, 7, 2);
  const toolResultIsErrorField = getField(fields, 9, 0);
  const thinkingField         = getField(fields, 11, 2);
  const signatureField        = getField(fields, 12, 2);

  const toolCallFields = getAllFields(fields, 6);
  const imageFields    = getAllFields(fields, 10);

  return {
    messageId:        messageIdField        ? messageIdField.value.toString('utf8')        : '',
    source:           sourceField           ? sourceField.value                            : 0,
    prompt:           promptField           ? promptField.value.toString('utf8')           : '',
    toolCalls:        toolCallFields.map(f => parseChatToolCall(f.value)),
    toolCallId:       toolCallIdField       ? toolCallIdField.value.toString('utf8')       : '',
    toolResultIsError: toolResultIsErrorField ? Boolean(toolResultIsErrorField.value)      : false,
    images:           imageFields.map(f => parseImageData(f.value)),
    thinking:         thinkingField         ? thinkingField.value.toString('utf8')         : '',
    signature:        signatureField        ? signatureField.value.toString('utf8')        : '',
  };
}

/**
 * Parse a ChatToolDefinition message buffer.
 *
 * ChatToolDefinition {
 *   string name = 1;
 *   string description = 2;
 *   string json_schema_string = 3;
 *   bool strict = 4;
 * }
 *
 * Returns Anthropic native tool format.
 */
function parseChatToolDefinition(buf) {
  const fields = parseFields(buf);

  const nameField   = getField(fields, 1, 2);
  const descField   = getField(fields, 2, 2);
  const schemaField = getField(fields, 3, 2);

  const name        = nameField   ? nameField.value.toString('utf8')   : '';
  const description = descField   ? descField.value.toString('utf8')   : '';
  const schemaStr   = schemaField ? schemaField.value.toString('utf8') : '{}';

  let input_schema;
  try {
    input_schema = JSON.parse(schemaStr);
  } catch {
    input_schema = { type: 'object', properties: {} };
  }

  return { name, description, input_schema };
}

/**
 * Parse a ChatToolChoice message buffer.
 *
 * ChatToolChoice {
 *   string option_name = 1;   // "auto" | "any" | "none"
 *   string tool_name = 2;     // specific tool name (oneof alternative)
 * }
 *
 * Returns Anthropic tool_choice object or undefined.
 */
function parseChatToolChoice(buf) {
  const fields = parseFields(buf);

  const optionNameField = getField(fields, 1, 2);
  const toolNameField   = getField(fields, 2, 2);

  const toolName   = toolNameField   ? toolNameField.value.toString('utf8').trim()   : '';
  const optionName = optionNameField ? optionNameField.value.toString('utf8').trim() : '';

  if (toolName) {
    return { type: 'tool', name: toolName };
  }
  if (optionName) {
    return { type: optionName }; // "auto" | "any" | "none"
  }
  return undefined;
}

// ─── ChatMessagePrompt → Anthropic message ─────────────────

/**
 * Convert a parsed ChatMessagePrompt into an Anthropic Messages API message object.
 * Returns null for SYSTEM_PROMPT source (caller folds into systemPrompt).
 * Returns null for UNSPECIFIED source.
 */
function toAnthropicMessage(parsed) {
  const { source, prompt, toolCalls, toolCallId, toolResultIsError, images, thinking, signature } = parsed;

  // SYSTEM_PROMPT messages are folded into the top-level system prompt
  if (source === SOURCE.SYSTEM_PROMPT || source === SOURCE.UNSPECIFIED) {
    return null;
  }

  // TOOL source → user message with a tool_result content block
  if (source === SOURCE.TOOL) {
    const block = {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: prompt,
    };
    if (toolResultIsError) block.is_error = true;
    return { role: 'user', content: [block] };
  }

  // USER source → user message, with images if present
  if (source === SOURCE.USER) {
    if (images && images.length > 0) {
      const contentBlocks = [];
      // Add images first
      for (const img of images) {
        if (img.base64_data) {
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mime_type || 'image/png',
              data: img.base64_data,
            },
          });
        }
      }
      // Then text
      if (prompt) {
        contentBlocks.push({ type: 'text', text: prompt });
      }
      return { role: 'user', content: contentBlocks };
    }
    return { role: 'user', content: prompt };
  }

  // UNKNOWN (3) and SYSTEM (2) → assistant messages
  if (source === SOURCE.UNKNOWN || source === SOURCE.SYSTEM) {
    const contentBlocks = [];

    // Extended thinking block (must come first, before text/tool_use)
    if (thinking) {
      const thinkingBlock = { type: 'thinking', thinking };
      if (signature) thinkingBlock.signature = signature;
      contentBlocks.push(thinkingBlock);
    }

    // Text block (after thinking, before tool_use)
    if (prompt) {
      contentBlocks.push({ type: 'text', text: prompt });
    }

    // Tool use blocks (last)
    for (const tc of toolCalls) {
      let input;
      try {
        input = JSON.parse(tc.arguments_json);
      } catch {
        input = {};
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      });
    }

    // Use array content when we have structured blocks; plain string otherwise
    if (contentBlocks.length > 1 || (contentBlocks.length === 1 && contentBlocks[0].type !== 'text')) {
      return { role: 'assistant', content: contentBlocks };
    }
    return { role: 'assistant', content: prompt };
  }

  return null;
}

// ─── Merge consecutive same-role messages ────────────────
//
// Anthropic API requires strictly alternating user/assistant roles.
// Windsurf sends separate TOOL source messages for each tool result,
// producing consecutive {role:'user'} entries. This merges them.

function normalizeContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function mergeConsecutiveMessages(messages) {
  if (messages.length <= 1) return messages;

  const merged = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = messages[i];

    if (prev.role === curr.role) {
      // Merge: combine content blocks into a single array
      const prevBlocks = normalizeContent(prev.content);
      const currBlocks = normalizeContent(curr.content);
      prev.content = [...prevBlocks, ...currBlocks];
    } else {
      merged.push(curr);
    }
  }

  // Simplify single text-block arrays back to plain strings
  for (const m of merged) {
    if (Array.isArray(m.content) && m.content.length === 1 && m.content[0].type === 'text') {
      m.content = m.content[0].text;
    }
  }

  return merged;
}

// ─── Main export ───────────────────────────────────────────

/**
 * Parse a Connect-RPC GetChatMessageRequest body into structured objects
 * ready for the Anthropic Messages API.
 *
 * @param {Buffer} body    - Raw request body (may be Connect-RPC envelope + gzip)
 * @param {object} headers - HTTP request headers
 * @returns {{
 *   systemPrompt: string,
 *   messages: Array<{role: string, content: string|Array}>,
 *   tools: Array<{name: string, description: string, input_schema: object}>|undefined,
 *   toolChoice: object|undefined,
 *   requestedModel: string,
 * }}
 */
export function parseGetChatMessageRequest(body, headers) {
  const protoBuf = unwrapRequest(body, headers);
  const fields   = parseFields(protoBuf);

  // DEBUG: dump all field numbers and types (find user/agent distinction)
  const knownFields = new Set([1, 2, 3, 10, 12, 21]);
  const unknownFields = fields.filter(f => !knownFields.has(f.field));
  if (unknownFields.length > 0) {
    console.log(`  🔍 GetChatMessage unknown fields:`);
    for (const f of unknownFields) {
      if (f.wireType === 0) console.log(`    field ${f.field} (varint): ${f.value}`);
      else if (f.wireType === 2) {
        const str = f.value.toString('utf8');
        const isPrintable = /^[\x20-\x7e\n\r\t]+$/.test(str.slice(0, 50));
        console.log(`    field ${f.field} (bytes/${f.value.length}b): ${isPrintable ? str.slice(0, 120) : '[binary ' + f.value.toString('hex').slice(0, 40) + ']'}`);
      }
      else console.log(`    field ${f.field} (wire ${f.wireType}): ${f.value?.toString?.('hex')?.slice(0, 40)}`);
    }
  }
  // field 2 = top-level system prompt string
  const systemField = getField(fields, 2, 2);
  let systemPrompt  = systemField ? systemField.value.toString('utf8') : '';

  // Override static Cascade prompt if configured (dynamic IDE additions still appended below)
  if (SYSTEM_PROMPT_OVERRIDE) {
    const custom = getCustomSystemPrompt();
    if (custom) {
      const originalLen = systemPrompt.length;
      // Extract functional XML sections from original prompt (tool instructions,
      // workspace info, etc.) while dropping identity and style sections.
      const preserved = extractFunctionalSections(systemPrompt);
      systemPrompt = preserved ? `${custom}\n\n${preserved}` : custom;
      console.log(`  🔀 System prompt: custom ${custom.length} + preserved ${preserved.length} chars (was ${originalLen})`);
    }
  }

  // field 21 = model ID string
  const modelField    = getField(fields, 21, 2);
  const requestedModel = modelField ? modelField.value.toString('utf8') : '';

  // field 3 = repeated ChatMessagePrompt
  const messageFields  = getAllFields(fields, 3);
  const parsedPrompts  = messageFields.map(f => parseChatMessagePrompt(f.value));

  // Fold SYSTEM_PROMPT source messages into systemPrompt
  for (const p of parsedPrompts) {
    if (p.source === SOURCE.SYSTEM_PROMPT && p.prompt) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n${p.prompt}` : p.prompt;
    }
  }

  // Determine initiator from the ORIGINAL protobuf sources (before any Anthropic conversion)
  // Rule: "user" only when the actual last ChatMessagePrompt from Windsurf is SOURCE.USER
  // If it's SOURCE.TOOL → agent (free). Windsurf appends a synthetic user-source message
  // after tool results with context instructions — that's still an agent round.
  let initiator = 'agent';
  const nonSystemPrompts = parsedPrompts.filter(p =>
    p.source !== SOURCE.SYSTEM_PROMPT && p.source !== SOURCE.UNSPECIFIED
  );
  if (nonSystemPrompts.length > 0) {
    const lastParsed = nonSystemPrompts[nonSystemPrompts.length - 1];
    // Only count as "user" if the very last protobuf message is USER source
    // AND the one before it (if any) is NOT TOOL source (meaning this isn't a
    // tool-result round with an appended context message)
    if (lastParsed.source === SOURCE.USER) {
      const secondToLast = nonSystemPrompts.length >= 2
        ? nonSystemPrompts[nonSystemPrompts.length - 2]
        : null;
      if (!secondToLast || secondToLast.source !== SOURCE.TOOL) {
        initiator = 'user';
      } else {
        // Last is USER but preceded by TOOL → this is a synthetic context append
        // Log what it contains for debugging
        console.log(`  🔍 Agent-round trailing USER text (${lastParsed.prompt.length} chars): "${lastParsed.prompt.slice(0, 150)}..."`);
      }
    }
  }

  // Build Anthropic messages array (drop null entries, merge consecutive same-role)
  const messages = mergeConsecutiveMessages(
    parsedPrompts.map(toAnthropicMessage).filter(Boolean)
  );

  // Sanitize product identity from conversation messages (ephemeral messages say "CASCADE system")
  if (SYSTEM_PROMPT_OVERRIDE) {
    for (const m of messages) {
      if (typeof m.content === 'string') {
        m.content = m.content.replace(/\bCASCADE\b/g, 'SYSTEM');
        m.content = m.content.replace(/\bCascade\b/g, 'the assistant');
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text' && block.text) {
            block.text = block.text.replace(/\bCASCADE\b/g, 'SYSTEM');
            block.text = block.text.replace(/\bCascade\b/g, 'the assistant');
          }
        }
      }
    }
  }

  // field 10 = repeated ChatToolDefinition
  const toolFields = getAllFields(fields, 10);
  const tools      = toolFields.length > 0
    ? toolFields.map(f => parseChatToolDefinition(f.value))
    : undefined;

  // field 12 = ChatToolChoice (nested message)
  const toolChoiceField = getField(fields, 12, 2);
  const toolChoice      = toolChoiceField
    ? parseChatToolChoice(toolChoiceField.value)
    : undefined;

  return {
    systemPrompt,
    messages,
    tools,
    toolChoice,
    requestedModel,
    initiator,
  };
}
