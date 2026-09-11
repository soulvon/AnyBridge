// handlers/build-response.js — GetChatMessageResponse protobuf chunk builders
//
// Builds exa.api_server_pb.GetChatMessageResponse wire-format buffers for
// Connect-RPC streaming responses.
//
//   message GetChatMessageResponse {
//     string message_id = 1;
//     Timestamp timestamp = 2;
//     string delta_text = 3;
//     uint32 delta_tokens = 4;
//     StopReason stop_reason = 5;
//     repeated ChatToolCall delta_tool_calls = 6;
//     ModelUsageStats usage = 7;
//     bool redact = 8;
//     string delta_thinking = 9;
//     string delta_signature = 10;
//     bool thinking_redacted = 11;
//     double latency = 12;              ← wire type 1, fixed64 LE IEEE 754
//     int32 credit_cost = 14;
//     string output_id = 15;
//     string thinking_id = 16;
//     string request_id = 17;
//     string actual_model_uid = 20;
//   }
//
//   message ChatToolCall {
//     string id = 1;
//     string name = 2;
//     string arguments_json = 3;
//   }
//
//   message Timestamp {
//     int64 seconds = 1;
//     int32 nanos = 2;
//   }
//
//   enum StopReason {
//     STOP_REASON_UNSPECIFIED  = 0;
//     STOP_REASON_STOP_PATTERN = 2;   // normal end
//     STOP_REASON_MAX_TOKENS   = 3;
//     STOP_REASON_FUNCTION_CALL = 10; // tool call end
//     STOP_REASON_ERROR        = 13;
//   }

import {
  writeStringField,
  writeVarintField,
  writeMessageField,
  writeFixed64Field,
  parseFields,
  getField,
  getAllFields,
} from '../proto.js';
import { tryGunzip } from '../connect.js';

// ─── StopReason enum ───────────────────────────────────────

export const STOP_REASON = {
  UNSPECIFIED:   0,
  INCOMPLETE:    1,
  STOP_PATTERN:  2,   // normal end
  MAX_TOKENS:    3,
  FUNCTION_CALL: 10,  // tool call end
  ERROR:         13,
};

// ─── Internal helpers ──────────────────────────────────────

/**
 * Build a serialized Timestamp message.
 *   int64 seconds = 1;
 *   int32 nanos   = 2;
 */
function buildTimestamp() {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  return Buffer.concat([
    writeVarintField(1, seconds),
    writeVarintField(2, nanos),
  ]);
}

/**
 * Encode a proto double (wire type 1 = fixed64) as little-endian IEEE 754.
 * Buffer.writeDoubleBE gives big-endian; swap64() flips to the LE proto wire format.
 */
function writeDoubleField(fieldNum, value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(value, 0);
  buf.swap64(); // BE → LE for protobuf fixed64
  return writeFixed64Field(fieldNum, buf);
}

function toNonNegativeInt(value) {
  const n = Number(value) || 0;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function buildUsageStats(usage = {}) {
  const inputTokens = toNonNegativeInt(usage.inputTokens);
  const outputTokens = toNonNegativeInt(usage.outputTokens);
  const cachedTokens = toNonNegativeInt(usage.cachedTokens ?? usage.cacheReadInputTokens);
  const cacheCreationInputTokens = toNonNegativeInt(usage.cacheCreationInputTokens);
  const parts = [];
  if (inputTokens > 0) parts.push(writeVarintField(1, inputTokens));
  if (outputTokens > 0) parts.push(writeVarintField(2, outputTokens));
  if (cachedTokens > 0) parts.push(writeVarintField(3, cachedTokens));
  if (cacheCreationInputTokens > 0) parts.push(writeVarintField(4, cacheCreationInputTokens));
  return Buffer.concat(parts);
}

// ─── Public builders ───────────────────────────────────────

/**
 * Text content streaming chunk.
 *
 * Sets:
 *   message_id   (field 1)
 *   timestamp    (field 2)
 *   delta_text   (field 3) — omitted if falsy
 *   delta_tokens (field 4) — omitted if 0
 *
 * @param {string} messageId
 * @param {string} text
 * @param {number} tokenCount
 * @returns {Buffer}
 */
export function buildTextDelta(messageId, text, tokenCount) {
  const parts = [
    writeStringField(1, messageId),
    writeMessageField(2, buildTimestamp()),
  ];
  if (text) {
    parts.push(writeStringField(3, text));
  }
  if (tokenCount > 0) {
    parts.push(writeVarintField(4, tokenCount));
  }
  return Buffer.concat(parts);
}

/**
 * Reasoning/thinking streaming chunk.
 *
 * Sets:
 *   message_id      (field 1)
 *   timestamp       (field 2)
 *   delta_thinking  (field 9)
 *
 * @param {string} messageId
 * @param {string} thinkingText
 * @returns {Buffer}
 */
export function buildThinkingDelta(messageId, thinkingText) {
  return Buffer.concat([
    writeStringField(1, messageId),
    writeMessageField(2, buildTimestamp()),
    writeStringField(9, thinkingText),
  ]);
}

/**
 * Tool call streaming chunk.
 *
 * Each element of toolCalls becomes a serialized ChatToolCall nested message
 * written into field 6 (repeated delta_tool_calls).
 *
 *   message ChatToolCall {
 *     string id             = 1;
 *     string name           = 2;
 *     string arguments_json = 3;
 *   }
 *
 * Sets:
 *   message_id        (field 1)
 *   timestamp         (field 2)
 *   delta_tool_calls  (field 6, repeated)
 *
 * @param {string} messageId
 * @param {Array<{id: string, name: string, arguments_json: string}>} toolCalls
 * @returns {Buffer}
 */
export function buildToolCallDelta(messageId, toolCalls) {
  const parts = [
    writeStringField(1, messageId),
    writeMessageField(2, buildTimestamp()),
  ];

  for (const tc of toolCalls) {
    const callMsg = Buffer.concat([
      writeStringField(1, tc.id ?? ''),
      writeStringField(2, tc.name ?? ''),
      writeStringField(3, tc.arguments_json ?? ''),
    ]);
    parts.push(writeMessageField(6, callMsg));
  }

  return Buffer.concat(parts);
}

/**
 * Final stop chunk.
 *
 * Sets:
 *   message_id        (field 1)
 *   timestamp         (field 2)
 *   stop_reason       (field 5)
 *   latency           (field 12, double) — omitted if not provided
 *   actual_model_uid  (field 20)         — omitted if not provided
 *
 * @param {string} messageId
 * @param {number} stopReason    — one of STOP_REASON values
 * @param {string} [modelUid]
 * @param {number} [latencyMs]   — elapsed ms; encoded as double in field 12
 * @returns {Buffer}
 */
export function buildStopChunk(messageId, stopReason, modelUid, latencyMs, usage, requestId = messageId) {
  const parts = [
    writeStringField(1, messageId),
    writeMessageField(2, buildTimestamp()),
    writeVarintField(5, stopReason),
  ];
  const usageStats = buildUsageStats(usage);
  if (usageStats.length > 0) {
    parts.push(writeMessageField(7, usageStats));
  }
  if (latencyMs !== undefined && latencyMs !== null) {
    parts.push(writeDoubleField(12, latencyMs));
  }
  parts.push(writeVarintField(14, 0));
  if (requestId) {
    parts.push(writeStringField(17, requestId));
  }
  if (modelUid) {
    parts.push(writeStringField(20, modelUid));
  }
  return Buffer.concat(parts);
}

/**
 * Thinking signature streaming chunk.
 *
 * Emitted after a thinking block's content_block_stop, carrying the accumulated
 * signature needed by Anthropic's API for extended thinking validation.
 *
 * Sets:
 *   message_id        (field 1)
 *   timestamp         (field 2)
 *   delta_signature   (field 10)
 *
 * @param {string} messageId
 * @param {string} signature
 * @returns {Buffer}
 */
export function buildSignatureDelta(messageId, signature) {
  return Buffer.concat([
    writeStringField(1, messageId),
    writeMessageField(2, buildTimestamp()),
    writeStringField(10, signature),
  ]);
}

/**
 * Error chunk.
 *
 * Sends the error message as delta_text (field 3) with stop_reason = ERROR (field 5).
 *
 * Sets:
 *   message_id   (field 1)
 *   timestamp    (field 2)
 *   delta_text   (field 3) — error description
 *   stop_reason  (field 5) — STOP_REASON.ERROR (13)
 *
 * @param {string} messageId
 * @param {string} errorText
 * @returns {Buffer}
 */
export function buildErrorChunk(messageId, errorText) {
  return Buffer.concat([
    writeStringField(1, messageId),
    writeMessageField(2, buildTimestamp()),
    writeStringField(3, errorText),
    writeVarintField(5, STOP_REASON.ERROR),
  ]);
}

/**
 * 将 streaming 响应帧合并成一个完整的 GetChatMessageResponse protobuf（unary 语义）。
 *
 * Devin Local (devin-cli) 是 Connect unary 客户端，用 application/proto 调 GetChatMessage，
 * 期待一次性的 gzip(完整 GetChatMessageResponse)。而 AnyBridge 内部统一按 streaming 帧
 * （wrapEnvelope + endOfStreamEnvelope）逐段产出，需要在此把增量字段合并还原：
 *
 *   delta_text / delta_thinking / delta_signature → 拼接
 *   delta_tokens → 求和
 *   delta_tool_calls → 累积
 *   stop_reason / usage / latency / request_id / actual_model_uid / credit_cost → 取最后一次出现
 *   message_id / timestamp → 取第一次出现
 *
 * @param {Buffer[]} frames — streaming 帧序列（每个 wrapEnvelope 产物，末尾可能含 end-of-stream 帧）
 * @returns {Buffer} 完整 GetChatMessageResponse protobuf
 */
export function mergeUnaryFrames(frames) {
  let messageId = '';
  let timestamp = null;
  let deltaText = '';
  let deltaTokens = 0;
  let stopReason = 0;
  const toolCalls = [];
  let usage = null;
  let thinking = '';
  let signature = '';
  let latency = null;
  let creditCost = null;
  let requestId = '';
  let modelUid = '';

  for (const raw of frames) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length < 5) continue;
    const flags = buf[0];
    const len = buf.readUInt32BE(1);
    if (len !== buf.length - 5) continue; // 非 Connect 帧，跳过
    let payload = buf.subarray(5);
    if (flags & 1) { // gzip 压缩
      const d = tryGunzip(payload);
      if (!d) continue;
      payload = d;
    }
    if (flags & 2) { // end-of-stream（JSON trailers），可能含 error
      try {
        const json = JSON.parse(payload.toString('utf8'));
        if (json && json.error && json.error.message) {
          deltaText = json.error.message;
          stopReason = STOP_REASON.ERROR;
        }
      } catch { /* 非 JSON 或无 error，忽略 */ }
      continue;
    }

    const fields = parseFields(payload);
    const f1 = getField(fields, 1, 2);
    const f2 = getField(fields, 2, 2);
    const f3 = getField(fields, 3, 2);
    const f4 = getField(fields, 4, 0);
    const f5 = getField(fields, 5, 0);
    const f7 = getField(fields, 7, 2);
    const f9 = getField(fields, 9, 2);
    const f10 = getField(fields, 10, 2);
    const f12 = getField(fields, 12, 1);
    const f14 = getField(fields, 14, 0);
    const f17 = getField(fields, 17, 2);
    const f20 = getField(fields, 20, 2);
    const f6 = getAllFields(fields, 6);

    if (!messageId && f1) messageId = f1.value.toString('utf8');
    if (!timestamp && f2) timestamp = f2.value;
    if (f3) deltaText += f3.value.toString('utf8');
    if (f4) deltaTokens += f4.value;
    if (f5) stopReason = f5.value;
    if (f9) thinking += f9.value.toString('utf8');
    if (f10) signature = f10.value.toString('utf8');
    if (f12) latency = f12.value;
    if (f14) creditCost = f14.value;
    if (f17) requestId = f17.value.toString('utf8');
    if (f20) modelUid = f20.value.toString('utf8');
    if (f7) usage = f7.value;
    for (const tc of f6) toolCalls.push(tc.value);
  }

  const parts = [];
  if (messageId) parts.push(writeStringField(1, messageId));
  if (timestamp) parts.push(writeMessageField(2, timestamp));
  if (deltaText) parts.push(writeStringField(3, deltaText));
  if (deltaTokens > 0) parts.push(writeVarintField(4, deltaTokens));
  if (stopReason) parts.push(writeVarintField(5, stopReason));
  for (const tc of toolCalls) parts.push(writeMessageField(6, tc));
  if (usage) parts.push(writeMessageField(7, usage));
  if (thinking) parts.push(writeStringField(9, thinking));
  if (signature) parts.push(writeStringField(10, signature));
  if (latency) parts.push(writeFixed64Field(12, latency));
  if (creditCost !== null && creditCost !== undefined) parts.push(writeVarintField(14, creditCost));
  if (requestId) parts.push(writeStringField(17, requestId));
  if (modelUid) parts.push(writeStringField(20, modelUid));

  return Buffer.concat(parts);
}
