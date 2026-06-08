// handlers/openai-stream.js — OpenAI Responses API SSE → protobuf chunk processor
//
// Processes OpenAI Responses API streaming events and emits raw protobuf
// GetChatMessageResponse buffers (NOT wrapped in Connect-RPC envelope).
//
// Responses API SSE event types:
//   response.created              — initial response metadata
//   response.in_progress          — status update
//   response.output_item.added    — new output item (reasoning | message | function_call)
//   response.reasoning.delta      — reasoning/thinking text delta  (NEW — 2025+)
//   response.output_text.delta    — text content delta
//   response.function_call_arguments.delta — tool call arguments delta
//   response.content_part.done    — content part finalized
//   response.output_item.done     — output item finalized
//   response.completed            — final response with usage
//
// Key differences from Chat Completions:
//   - Events have a `type` field instead of raw `data:` JSON with choices
//   - Reasoning comes as separate output items with summary
//   - Tool calls are `function_call` type output items
//   - Session/prompt caching built-in (2h keep-alive)

import {
  buildTextDelta,
  buildThinkingDelta,
  buildToolCallDelta,
  buildStopChunk,
  STOP_REASON,
} from './build-response.js';

// ─── SSE parser ────────────────────────────────────────────

/**
 * Parse raw SSE text into typed event objects.
 * Responses API uses `data:` lines with JSON containing a `type` field.
 *
 * @param {string} text - Raw SSE text (may contain multiple events)
 * @returns {{ done: boolean, type: string, data: any }[]}
 */
export function parseOpenAISSEChunk(text) {
  const events = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
      events.push({ done: true, type: 'done', data: null });
      continue;
    }
    try {
      const data = JSON.parse(payload);
      events.push({ done: false, type: data.type || '', data });
    } catch {
      // Skip malformed JSON
    }
  }

  return events;
}

// ─── Stream processor ──────────────────────────────────────

export class OpenAIStreamProcessor {
  constructor(messageId, modelUid) {
    this._messageId = messageId;
    this._modelUid = modelUid;
    this._tokenCount = 0;
    this._done = false;
    this._stopReason = null;

    // Tool call accumulators — keyed by output_index
    // { [index]: { id, name, arguments } }
    this._toolCalls = {};

    // Track which output items are reasoning vs final answer
    // { [output_index]: 'reasoning' | 'message' | 'function_call' }
    this._itemTypes = {};
    // Track message phases: { [output_index]: 'thinking' | 'final_answer' | undefined }
    this._itemPhases = {};

    // Token usage captured from response.completed
    this._usage = { inputTokens: 0, outputTokens: 0 };
  }

  get isDone() { return this._done; }
  get stopReason() { return this._stopReason; }
  get usage() { return this._usage; }

  /**
   * Process a single parsed SSE event and return proto buffers to send.
   *
   * @param {{ done: boolean, type: string, data: any }} event
   * @returns {Buffer[]}
   */
  processEvent(event) {
    if (event.done) {
      return this._onDone();
    }

    const { type, data } = event;
    const chunks = [];

    switch (type) {
      // ── Reasoning (thinking) deltas ────────────────────
      case 'response.reasoning.delta':
        if (data.delta) {
          chunks.push(buildThinkingDelta(this._messageId, data.delta));
        }
        break;

      case 'response.reasoning_summary_text.delta':
        if (data.delta) {
          // Summary text also goes to thinking stream
          chunks.push(buildThinkingDelta(this._messageId, data.delta));
        }
        break;

      // ── Text content deltas ────────────────────────────
      case 'response.output_text.delta':
        if (data.delta) {
          const idx = data.output_index ?? 0;
          const itemType = this._itemTypes[idx];
          const phase = this._itemPhases[idx];

          // Route to thinking if: reasoning item, or message with thinking phase
          if (itemType === 'reasoning' || phase === 'thinking') {
            chunks.push(buildThinkingDelta(this._messageId, data.delta));
          } else {
            this._tokenCount++;
            chunks.push(buildTextDelta(this._messageId, data.delta, this._tokenCount));
          }
        }
        break;

      // ── Tool/function call handling ────────────────────
      case 'response.output_item.added': {
        const item = data.item;
        const idx = data.output_index ?? 0;
        if (item) {
          this._itemTypes[idx] = item.type; // 'reasoning' | 'message' | 'function_call'
          if (item.phase) this._itemPhases[idx] = item.phase; // 'thinking' | 'final_answer'
        }
        if (item?.type === 'function_call') {
          this._toolCalls[idx] = {
            id: item.call_id || item.id || '',
            name: item.name || '',
            arguments: '',
          };
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const idx = data.output_index ?? 0;
        if (this._toolCalls[idx]) {
          this._toolCalls[idx].arguments += data.delta || '';
        }
        break;
      }

      // ── Completion ─────────────────────────────────────
      case 'response.completed': {
        const resp = data.response;
        if (resp?.status === 'completed') {
          this._stopReason = 'stop';
          // Check if it ended due to tool calls
          const hasToolCalls = resp.output?.some(o => o.type === 'function_call');
          if (hasToolCalls) this._stopReason = 'tool_calls';
        }
        if (resp?.usage) {
          if (resp.usage.input_tokens != null) this._usage.inputTokens = resp.usage.input_tokens;
          if (resp.usage.output_tokens != null) this._usage.outputTokens = resp.usage.output_tokens;
        }
        // Flush everything on completed
        return this._onDone();
      }

      // Skip metadata events
      case 'response.created':
      case 'response.in_progress':
      case 'response.output_item.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
      case 'response.reasoning_summary_text.done':
      case 'codex.rate_limits':
        break;

      default:
        // Log unknown event types for debugging
        if (type && !type.startsWith('response.')) {
          console.log(`  ℹ️  Unknown OpenAI event: ${type}`);
        }
        break;
    }

    return chunks;
  }

  // ── Private ─────────────────────────────────────────────

  _onDone() {
    if (this._done) return [];
    const chunks = [];
    let validToolCallCount = 0;
    let droppedInvalidToolCall = false;

    // Flush accumulated tool calls
    const toolIndices = Object.keys(this._toolCalls);
    if (toolIndices.length > 0) {
      const calls = toolIndices
        .sort((a, b) => Number(a) - Number(b))
        .map(idx => ({
          id: this._toolCalls[idx].id,
          name: this._toolCalls[idx].name,
          arguments_json: this._toolCalls[idx].arguments,
        }))
        .filter(tc => {
          if (!tc.arguments_json) return true;
          try {
            JSON.parse(tc.arguments_json);
            return true;
          } catch {
            droppedInvalidToolCall = true;
            console.warn(`  ⚠️  Drop incomplete tool call ${tc.name || tc.id || '(unknown)'}: invalid JSON arguments (${tc.arguments_json.length} chars)`);
            return false;
          }
        });
      validToolCallCount = calls.length;
      if (calls.length > 0) {
        chunks.push(buildToolCallDelta(this._messageId, calls));
      }
    }

    const stopReason = droppedInvalidToolCall && validToolCallCount === 0 ? 'length' : this._stopReason;
    const protoStopReason = this._mapStopReason(stopReason);
    chunks.push(buildStopChunk(this._messageId, protoStopReason, this._modelUid));
    this._done = true;

    return chunks;
  }

  _mapStopReason(reason) {
    switch (reason) {
      case 'stop':       return STOP_REASON.STOP_PATTERN;
      case 'tool_calls': return STOP_REASON.FUNCTION_CALL;
      case 'length':     return STOP_REASON.MAX_TOKENS;
      default:           return STOP_REASON.STOP_PATTERN;
    }
  }
}

// ─── Chat Completions stream processor ─────────────────────

export class OpenAIChatCompletionsStreamProcessor {
  constructor(messageId, modelUid) {
    this._messageId = messageId;
    this._modelUid = modelUid;
    this._tokenCount = 0;
    this._done = false;
    this._stopReason = null;
    this._usage = { inputTokens: 0, outputTokens: 0 };
    this._toolCalls = {};
  }

  get isDone() { return this._done; }
  get stopReason() { return this._stopReason; }
  get usage() { return this._usage; }

  processEvent(event) {
    if (event.done) return this._onDone();

    const data = event.data;
    const chunks = [];

    if (data?.usage) {
      if (data.usage.prompt_tokens != null) this._usage.inputTokens = data.usage.prompt_tokens;
      if (data.usage.completion_tokens != null) this._usage.outputTokens = data.usage.completion_tokens;
    }

    const choice = data?.choices?.[0];
    if (!choice) return chunks;

    const delta = choice.delta || {};
    const text = delta.content || delta.text || '';
    if (text) {
      this._tokenCount++;
      chunks.push(buildTextDelta(this._messageId, text, this._tokenCount));
    }

    const thinking = delta.reasoning_content || delta.reasoning || '';
    if (thinking) {
      chunks.push(buildThinkingDelta(this._messageId, thinking));
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!this._toolCalls[idx]) {
          this._toolCalls[idx] = { id: '', name: '', arguments: '' };
        }
        if (tc.id) this._toolCalls[idx].id = tc.id;
        if (tc.function?.name) this._toolCalls[idx].name = tc.function.name;
        if (tc.function?.arguments) this._toolCalls[idx].arguments += tc.function.arguments;
      }
    }

    if (choice.finish_reason) {
      this._stopReason = choice.finish_reason;
    }

    return chunks;
  }

  _onDone() {
    if (this._done) return [];
    const chunks = [];
    let droppedInvalidToolCall = false;

    const calls = Object.keys(this._toolCalls)
      .sort((a, b) => Number(a) - Number(b))
      .map(idx => ({
        id: this._toolCalls[idx].id,
        name: this._toolCalls[idx].name,
        arguments_json: this._toolCalls[idx].arguments,
      }))
      .filter(tc => tc.id || tc.name || tc.arguments_json)
      .filter(tc => {
        if (!tc.arguments_json) return true;
        try {
          JSON.parse(tc.arguments_json);
          return true;
        } catch {
          droppedInvalidToolCall = true;
          console.warn(`  ⚠️  Drop incomplete tool call ${tc.name || tc.id || '(unknown)'}: invalid JSON arguments (${tc.arguments_json.length} chars)`);
          return false;
        }
      });

    if (calls.length > 0) {
      chunks.push(buildToolCallDelta(this._messageId, calls));
    }

    const stopReason = droppedInvalidToolCall && calls.length === 0 ? 'length' : this._stopReason;
    chunks.push(buildStopChunk(this._messageId, this._mapStopReason(stopReason), this._modelUid));
    this._done = true;
    return chunks;
  }

  _mapStopReason(reason) {
    switch (reason) {
      case 'tool_calls': return STOP_REASON.FUNCTION_CALL;
      case 'length':     return STOP_REASON.MAX_TOKENS;
      case 'stop':
      default:           return STOP_REASON.STOP_PATTERN;
    }
  }
}
