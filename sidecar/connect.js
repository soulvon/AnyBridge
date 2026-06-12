// connect.js — Connect-RPC envelope framing + gzip helpers

import zlib from 'node:zlib';

// ─── Gzip helpers ──────────────────────────────────────────

export function gzipSync(buf) {
  return zlib.gzipSync(buf);
}

export function gunzipSync(buf) {
  return zlib.gunzipSync(buf);
}

export function tryGunzip(buf) {
  try {
    return zlib.gunzipSync(buf);
  } catch {
    return null;
  }
}

// ─── Connect-RPC envelope ──────────────────────────────────
//
// Format: [flags(1 byte), length(4 bytes big-endian), payload(length bytes)]
//   flags=0: uncompressed
//   flags=1: gzip-compressed payload
//   flags=2: end-of-stream (trailers)
//   flags=3: end-of-stream + compressed
//

/**
 * Wrap a protobuf message in a Connect-RPC envelope.
 * Always gzip-compresses (flags=1) for consistency with real Windsurf.
 */
export function wrapEnvelope(protoBuf, compress = true) {
  if (compress) {
    const compressed = gzipSync(protoBuf);
    const header = Buffer.alloc(5);
    header[0] = 1; // flags = compressed
    header.writeUInt32BE(compressed.length, 1);
    return Buffer.concat([header, compressed]);
  }
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(protoBuf.length, 1);
  return Buffer.concat([header, protoBuf]);
}

/**
 * Build end-of-stream envelope (flags=3, JSON trailers).
 * Connect-RPC end-of-stream frame payload is JSON (not protobuf!).
 * Must contain at least `{}` for the client to parse successfully.
 */
export function endOfStreamEnvelope() {
  return endOfStreamJsonEnvelope({});
}

function endOfStreamJsonEnvelope(payload) {
  const jsonTrailers = gzipSync(Buffer.from(JSON.stringify(payload || {})));
  const header = Buffer.alloc(5);
  header[0] = 3; // flags = end-of-stream + compressed
  header.writeUInt32BE(jsonTrailers.length, 1);
  return Buffer.concat([header, jsonTrailers]);
}

/**
 * Build a terminal Connect-RPC stream error.
 *
 * The payload of an end-of-stream frame is JSON, even for proto streams:
 *   { "error": { "code": "unavailable", "message": "..." } }
 *
 * Sending this instead of a GetChatMessageResponse delta keeps provider
 * failures out of the assistant message context and lets the IDE render its
 * native stream error UI when supported.
 */
export function endOfStreamErrorEnvelope({ code = 'unavailable', message = 'Request failed', metadata } = {}) {
  const payload = {
    error: {
      code: String(code || 'unknown'),
      message: String(message || 'Request failed'),
    },
  };
  if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }
  return endOfStreamJsonEnvelope(payload);
}

/**
 * Unwrap a single Connect-RPC request body (single envelope).
 * Handles both content-encoding gzip and envelope-level compression.
 * Returns raw protobuf bytes.
 */
export function unwrapRequest(body, headers) {
  const contentEncoding = headers['connect-content-encoding'] || headers['content-encoding'] || '';
  const isGzipped = contentEncoding.includes('gzip');

  let buf = body;

  // If HTTP-level gzip, decompress first
  if (isGzipped) {
    const d = tryGunzip(buf);
    if (d) buf = d;
  }

  // Strip Connect-RPC envelope if present
  if (buf.length > 5) {
    const flags = buf[0];
    const msgLen = buf.readUInt32BE(1);
    if (msgLen === buf.length - 5 && flags <= 1) {
      let payload = buf.slice(5);
      if (flags === 1) {
        const d = tryGunzip(payload);
        if (d) payload = d;
      }
      return payload;
    }
  }

  return buf;
}

/**
 * Build a complete empty unary success response.
 * Raw gzipped empty protobuf (NO Connect-RPC envelope).
 */
export function emptyResponse() {
  return gzipSync(Buffer.alloc(0));
}

/**
 * Wrap protobuf for unary response — just gzip, NO envelope.
 * Real Codeium server sends: content-encoding: gzip + raw gzip(protobuf).
 */
export function wrapUnary(protoBuf) {
  return gzipSync(protoBuf);
}

/**
 * Standard headers for unary (non-streaming) responses.
 */
export function unaryHeaders() {
  return {
    'content-type': 'application/proto',
    'content-encoding': 'gzip',
  };
}

/**
 * Standard Connect-RPC response headers for streaming.
 */
export function streamHeaders() {
  return {
    'content-type': 'application/connect+proto',
    'connect-content-encoding': 'gzip',
    'transfer-encoding': 'chunked',
  };
}
