// handlers/anthropic-stream.js — Anthropic Messages API SSE → protobuf chunk processor
//
// Processes Anthropic streaming API SSE events and emits raw protobuf
// GetChatMessageResponse buffers (NOT wrapped in Connect-RPC envelope).
//
// Anthropic SSE event sequence:
//   message_start
//   content_block_start   (type: text | tool_use | thinking)
//     content_block_delta (type: text_delta | input_json_delta | thinking_delta)
//     ...
//   content_block_stop
//   message_delta         (carries stop_reason, usage)
//   message_stop
//
// Usage:
//   const processor = new AnthropicStreamProcessor(messageId, modelUid);
//   for (const sseEvent of parseSSEChunk(rawChunk)) {
//     const protoBuffers = processor.processEvent(sseEvent);
//     for (const buf of protoBuffers) res.write(wrapEnvelope(buf));
//   }
//   if (processor.isDone) { res.write(endOfStreamEnvelope()); res.end(); }

import {
  buildTextDelta,
  buildThinkingDelta,
  buildToolCallDelta,
  buildSignatureDelta,
  buildStopChunk,
  STOP_REASON,
} from './build-response.js';

// ─── SSE parser ────────────────────────────────────────────

/**
 * Parse a raw SSE text chunk into an array of typed event objects.
 *
 * Handles multiple events in a single chunk. Each complete event block
 * (terminated by a blank line) is parsed as { event, data }. The `data`
 * field is JSON-decoded when possible; otherwise kept as a raw string.
 *
 * @param {string} text - Raw SSE text (may contain multiple events)
 * @returns {{ event: string, data: any }[]}
 */
export function parseSSEChunk(text) {
  const events = [];
  const lines = text.split('\n');
  let currentEvent = null;
  let currentData = '';

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentEvent !== null) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(currentData) });
      } catch {
        events.push({ event: currentEvent, data: currentData });
      }
      currentEvent = null;
      currentData = '';
    }
  }

  return events;
}

// ─── Stream processor ──────────────────────────────────────

/**
 * Stateful processor that maps Anthropic Messages API SSE events to raw
 * protobuf GetChatMessageResponse buffers.
 *
 * Content block state machine:
 *   - Tracks the currently open block type (text | tool_use | thinking)
 *   - Accumulates tool call JSON across successive input_json_delta events
 *   - Flushes the complete tool call proto on content_block_stop
 *   - Maps Anthropic stop_reason → exa StopReason enum on message_stop
 */
export class AnthropicStreamProcessor {
  /**
   * @param {string} messageId - UUID echoed in every response chunk (field 1)
   * @param {string} modelUid  - Anthropic model name echoed in stop chunk (field 20)
   */
  constructor(messageId, modelUid) {
    this._messageId = messageId;
    this._modelUid = modelUid;

    /** Incremented on each text_delta; written into delta_tokens (field 4). */
    this._tokenCount = 0;

    /** Set to true after message_stop has been processed. */
    this._done = false;

    /**
     * Anthropic stop_reason string captured from message_delta.
     * One of: "end_turn" | "tool_use" | "max_tokens" | null
     */
    this._stopReason = null;

    // ── Active content block state ──────────────────────────
    /** 'text' | 'tool_use' | 'thinking' | null */
    this._currentBlockType = null;
    /** Index from content_block_start (informational). */
    this._currentBlockIndex = -1;

    // ── Tool call accumulator (reset per tool_use block) ────
    this._toolId = null;
    this._toolName = null;
    this._toolArgsBuffer = '';

    // ── Signature accumulator (reset per thinking block) ──
    this._signatureBuffer = '';

    // ── Token usage captured from message_start / message_delta ──
    this._usage = { inputTokens: 0, outputTokens: 0 };
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Process a single parsed SSE event and return proto buffers to send.
   *
   * @param {{ event: string, data: any }} event - Parsed SSE event
   * @returns {Buffer[]} Raw proto buffers — wrap each with wrapEnvelope() before writing
   */
  processEvent(event) {
    const { event: evtName, data } = event;
    const chunks = [];

    switch (evtName) {
      case 'content_block_start':
        this._onContentBlockStart(data, chunks);
        break;

      case 'content_block_delta':
        this._onContentBlockDelta(data, chunks);
        break;

      case 'content_block_stop':
        this._onContentBlockStop(data, chunks);
        break;

      case 'message_delta':
        // Capture stop_reason now; emit the stop chunk on message_stop instead.
        // Also log usage if present (callers can inspect processor.stopReason).
        if (data?.delta?.stop_reason) {
          this._stopReason = data.delta.stop_reason;
        }
        if (data?.usage?.output_tokens != null) {
          this._usage.outputTokens = data.usage.output_tokens;
        }
        break;

      case 'message_start':
        if (data?.message?.usage) {
          if (data.message.usage.input_tokens != null)
            this._usage.inputTokens = data.message.usage.input_tokens;
          if (data.message.usage.output_tokens != null)
            this._usage.outputTokens = data.message.usage.output_tokens;
        }
        break;

      case 'message_stop':
        this._onMessageStop(chunks);
        break;

      // message_start — metadata only, nothing to emit
      default:
        break;
    }

    return chunks;
  }

  /**
   * True after the message_stop event has been processed.
   * @returns {boolean}
   */
  get isDone() {
    return this._done;
  }

  /**
   * The Anthropic stop_reason string set during message_delta.
   * Available after processEvent() returns for a message_stop event.
   * @returns {string|null}
   */
  get stopReason() {
    return this._stopReason;
  }

  /**
   * Token usage captured during the stream.
   * @returns {{ inputTokens: number, outputTokens: number }}
   */
  get usage() {
    return this._usage;
  }

  // ── Private event handlers ─────────────────────────────────

  _onContentBlockStart(data, chunks) {
    const block = data?.content_block;
    if (!block) return;

    this._currentBlockType = block.type;       // 'text' | 'tool_use' | 'thinking'
    this._currentBlockIndex = data?.index ?? -1;

    if (block.type === 'tool_use') {
      // Capture tool metadata; arguments accumulate via input_json_delta
      this._toolId = block.id ?? null;
      this._toolName = block.name ?? null;
      this._toolArgsBuffer = '';
    } else if (block.type === 'thinking') {
      // Reset signature accumulator for new thinking block
      this._signatureBuffer = '';
    }
  }

  _onContentBlockDelta(data, chunks) {
    const delta = data?.delta;
    if (!delta) return;

    if (delta.type === 'text_delta' && delta.text) {
      // field 3 = delta_text, field 4 = delta_tokens
      this._tokenCount++;
      chunks.push(buildTextDelta(this._messageId, delta.text, this._tokenCount));

    } else if (delta.type === 'thinking_delta' && delta.thinking) {
      // field 9 = delta_thinking
      chunks.push(buildThinkingDelta(this._messageId, delta.thinking));

    } else if (delta.type === 'input_json_delta' && delta.partial_json != null) {
      // Accumulate tool call arguments; do NOT emit yet — wait for block_stop
      this._toolArgsBuffer += delta.partial_json;

    } else if (delta.type === 'signature_delta' && delta.signature != null) {
      // Accumulate thinking signature; emit on block_stop
      this._signatureBuffer += delta.signature;
    }
  }

  _onContentBlockStop(data, chunks) {
    if (this._currentBlockType === 'tool_use') {
      // Arguments are now complete — emit the tool call chunk
      // field 6 = repeated ChatToolCall delta_tool_calls
      chunks.push(buildToolCallDelta(this._messageId, [{
        id: this._toolId ?? '',
        name: this._toolName ?? '',
        arguments_json: this._toolArgsBuffer,
      }]));

      // Reset accumulator for the next tool_use block (if any)
      this._toolId = null;
      this._toolName = null;
      this._toolArgsBuffer = '';

    } else if (this._currentBlockType === 'thinking' && this._signatureBuffer) {
      // Emit the accumulated signature for this thinking block
      // field 10 = delta_signature in GetChatMessageResponse
      chunks.push(buildSignatureDelta(this._messageId, this._signatureBuffer));
      this._signatureBuffer = '';
    }

    this._currentBlockType = null;
    this._currentBlockIndex = -1;
  }

  _onMessageStop(chunks) {
    const protoStopReason = this._mapStopReason(this._stopReason);
    chunks.push(buildStopChunk(this._messageId, protoStopReason, this._modelUid));
    this._done = true;
  }

  // ── Helpers ────────────────────────────────────────────────

  /**
   * Map an Anthropic stop_reason string to the exa StopReason varint.
   *
   * Anthropic → exa mapping:
   *   "end_turn"   → STOP_REASON_STOP_PATTERN  (2)  — normal completion
   *   "tool_use"   → STOP_REASON_FUNCTION_CALL (10) — model wants to call a tool
   *   "max_tokens" → STOP_REASON_MAX_TOKENS    (3)  — context window exhausted
   *   (others)     → STOP_REASON_STOP_PATTERN  (2)  — safe default
   *
   * @param {string|null} reason
   * @returns {number}
   */
  _mapStopReason(reason) {
    switch (reason) {
      case 'end_turn':   return STOP_REASON.STOP_PATTERN;  // 2
      case 'tool_use':   return STOP_REASON.FUNCTION_CALL; // 10
      case 'max_tokens': return STOP_REASON.MAX_TOKENS;    // 3
      default:           return STOP_REASON.STOP_PATTERN;  // 2
    }
  }
}
