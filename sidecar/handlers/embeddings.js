// ⚠️  WIP — Not wired into hybrid-server.js yet. Requires VOYAGE_API_KEY env var.
// handlers/embeddings.js — GetEmbeddings handler
//
// Routes embedding requests to Voyage AI API for real semantic vectors.
// The Go binary calls this to build the local FAISS search index.
//
// Voyage AI: voyage-3-lite, 1024-dim, up to 32K tokens context.
// Falls back to deterministic hash embeddings if Voyage is unreachable.

import crypto from 'node:crypto';
import https from 'node:https';
import {
  writeMessageField, writeBytesField,
  parseFields, getField, getAllFields,
} from '../proto.js';
import {
  wrapUnary, unaryHeaders, unwrapRequest,
  wrapEnvelope, endOfStreamEnvelope, streamHeaders,
  tryGunzip,
} from '../connect.js';
import { httpsAgentFor } from '../system-proxy.js';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || '';
const VOYAGE_MODEL = 'voyage-3-lite';  // 512 dims native, code-optimized
const EMBEDDING_DIM = 512;
const VOYAGE_MAX_BATCH = 128; // Voyage max texts per request

// ─── Voyage AI API ──────────────────────────────────────

function callVoyageAPI(texts, inputType = 'document') {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: inputType,
    });

    const req = https.request({
      agent: httpsAgentFor(),
      hostname: 'api.voyageai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const json = JSON.parse(body);
          if (json.data) {
            // Sort by index to preserve order
            const sorted = json.data.sort((a, b) => a.index - b.index);
            resolve(sorted.map(d => new Float32Array(d.embedding)));
          } else {
            reject(new Error(json.detail || json.error?.message || 'Unknown Voyage error'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Voyage timeout')); });
    req.end(payload);
  });
}

async function getEmbeddings(texts, prefix = 1) {
  // prefix: 1=document, 2=search/query
  const inputType = prefix === 2 ? 'query' : 'document';

  try {
    // Batch if needed
    if (texts.length <= VOYAGE_MAX_BATCH) {
      return await callVoyageAPI(texts, inputType);
    }

    // Split into chunks
    const results = [];
    for (let i = 0; i < texts.length; i += VOYAGE_MAX_BATCH) {
      const batch = texts.slice(i, i + VOYAGE_MAX_BATCH);
      const batchResult = await callVoyageAPI(batch, inputType);
      results.push(...batchResult);
    }
    return results;
  } catch (e) {
    console.log(`  ⚠️ Voyage API failed: ${e.message} — using hash fallback`);
    return texts.map(t => hashToEmbedding(t));
  }
}

// ─── Hash fallback (deterministic, for when Voyage is down) ──

function hashToEmbedding(text) {
  const hash = crypto.createHash('sha512').update(text).digest();
  const values = new Float32Array(EMBEDDING_DIM);
  let seedBuf = hash;
  let seedOffset = 0;

  for (let i = 0; i < EMBEDDING_DIM; i++) {
    if (seedOffset + 4 > seedBuf.length) {
      seedBuf = crypto.createHash('sha512')
        .update(seedBuf)
        .update(Buffer.from([i & 0xff, (i >> 8) & 0xff]))
        .digest();
      seedOffset = 0;
    }
    const raw = seedBuf.readUInt32LE(seedOffset);
    values[i] = (raw / 0xFFFFFFFF) * 2 - 1;
    seedOffset += 4;
  }

  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += values[i] * values[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIM; i++) values[i] /= norm;
  return values;
}

// ─── Proto builders ──────────────────────────────────────

function buildEmbeddingProto(values) {
  // Embedding { repeated float values = 1; } — packed float32
  const dim = values.length;
  const floatBuf = Buffer.allocUnsafe(dim * 4);
  for (let i = 0; i < dim; i++) floatBuf.writeFloatLE(values[i], i * 4);
  return writeBytesField(1, floatBuf);
}

function buildEmbeddingResponse(vectors) {
  const parts = vectors.map(vec => writeMessageField(1, buildEmbeddingProto(vec)));
  return Buffer.concat(parts);
}

function buildGetEmbeddingsResponse(vectors, latencyMs) {
  const embResp = buildEmbeddingResponse(vectors);
  const latencyBuf = Buffer.allocUnsafe(8);
  latencyBuf.writeDoubleLE(latencyMs / 1000, 0);
  const latencyField = Buffer.concat([Buffer.from([0x11]), latencyBuf]);
  return Buffer.concat([writeMessageField(1, embResp), latencyField]);
}

// ─── Request parser ──────────────────────────────────────

function extractPrompts(protoBuf) {
  try {
    const outerFields = parseFields(protoBuf);
    const requestField = getField(outerFields, 1, 2);
    if (!requestField) return { prompts: [''], prefix: 1 };

    const innerFields = parseFields(requestField.value);
    const promptFields = getAllFields(innerFields, 1).filter(f => f.wireType === 2);
    const prefixField = getField(innerFields, 3, 0);
    const prefix = prefixField ? prefixField.value : 1;

    if (promptFields.length === 0) return { prompts: [''], prefix };
    return { prompts: promptFields.map(f => f.value.toString('utf8')), prefix };
  } catch {
    return { prompts: [''], prefix: 1 };
  }
}

// ─── Streaming envelope parser ───────────────────────────

function parseEnvelopes(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buf.length) {
    const flags = buf[offset];
    const msgLen = buf.readUInt32BE(offset + 1);
    offset += 5;
    if (offset + msgLen > buf.length) break;
    const payload = buf.slice(offset, offset + msgLen);
    offset += msgLen;
    if (flags === 2 || flags === 3) continue;
    let data = payload;
    if (flags === 1) { const d = tryGunzip(payload); if (d) data = d; }
    frames.push(data);
  }
  return frames;
}

// ─── Handler (auto-detects unary vs streaming) ───────────

export function handleGetEmbeddings(req, res, body) {
  const contentType = req.headers['content-type'] || '';
  const isStreaming = contentType.includes('connect+proto');

  if (isStreaming) {
    handleStreamingEmbeddings(req, res, body);
  } else {
    handleUnaryEmbeddings(req, res, body);
  }
}

async function handleUnaryEmbeddings(req, res, body) {
  let prompts = [''];
  let prefix = 1;
  if (body && body.length > 0) {
    try {
      const protoBuf = unwrapRequest(body, req.headers);
      const result = extractPrompts(protoBuf);
      prompts = result.prompts;
      prefix = result.prefix;
    } catch (e) {
      console.log(`  🧮 Embeddings parse error: ${e.message}`);
    }
  }

  const t0 = Date.now();
  const vectors = await getEmbeddings(prompts, prefix);
  const latency = Date.now() - t0;

  console.log(`  🧮 Embeddings (unary): ${prompts.length} texts → Voyage ${latency}ms, first="${prompts[0]?.slice(0, 60) || ''}"`);

  const respProto = buildGetEmbeddingsResponse(vectors, latency);
  const respBody = wrapUnary(respProto);
  res.writeHead(200, { ...unaryHeaders(), 'content-length': respBody.length });
  res.end(respBody);
}

async function handleStreamingEmbeddings(req, res, body) {
  let allFrames = [];
  if (body && body.length > 0) {
    let buf = body;
    const contentEnc = req.headers['content-encoding'] || '';
    if (contentEnc.includes('gzip')) { const d = tryGunzip(buf); if (d) buf = d; }
    allFrames = parseEnvelopes(buf);
  }

  console.log(`  🧮 Embeddings (stream): ${allFrames.length} request frames`);
  res.writeHead(200, streamHeaders());

  for (const frame of allFrames) {
    const { prompts, prefix } = extractPrompts(frame);
    const t0 = Date.now();
    const vectors = await getEmbeddings(prompts, prefix);
    const latency = Date.now() - t0;
    console.log(`  🧮   Frame: ${prompts.length} texts → Voyage ${latency}ms`);
    const respProto = buildGetEmbeddingsResponse(vectors, latency);
    res.write(wrapEnvelope(respProto));
  }

  if (allFrames.length === 0) {
    const vectors = await getEmbeddings([''], 1);
    const respProto = buildGetEmbeddingsResponse(vectors, 1);
    res.write(wrapEnvelope(respProto));
  }

  res.write(endOfStreamEnvelope());
  res.end();
}
