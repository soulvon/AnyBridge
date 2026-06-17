// ⚠️  WIP — Not wired into hybrid-server.js yet. FIM response schema not fully reverse-engineered.
// handlers/completions.js — GetCompletions handler (inline code completion)
//
// Receives Windsurf's GetCompletions RPC (Connect-RPC, unary, application/proto),
// extracts prefix/suffix code context from the protobuf request, calls the
// Anthropic Messages API non-streaming, and returns a single inline suggestion.
//
// Proto schemas (reverse-engineered):
//
//   GetCompletionsResponse {
//     CompletionResponse completion_response = 1;
//   }
//
//   CompletionResponse {  // exa.codeium_common_pb
//     repeated Completion completions = 1;
//     string prompt_id = 8;
//   }
//
//   Completion {  // exa.codeium_common_pb
//     string completion_id = 1;
//     string text          = 2;
//     StopReason stop_reason = 12;   // 2 = STOP_REASON_STOP_PATTERN
//   }

import https from 'node:https';
import crypto from 'node:crypto';
import {
  parseFields,
  writeStringField,
  writeMessageField,
  writeVarintField,
} from '../proto.js';
import { wrapUnary, unaryHeaders, unwrapRequest } from '../connect.js';
import { httpsAgentFor } from '../system-proxy.js';

// ─── Config ────────────────────────────────────────────────

const API_HOST    = process.env.ANTHROPIC_API_HOST || 'api.anthropic.com';
const API_PATH    = '/v1/messages';
const MODEL       = 'claude-sonnet-4-6';
const MAX_TOKENS  = 256;
const TIMEOUT_MS  = 5000;

// Context window caps — keep prompts short for fast completions
const PREFIX_CHARS = 2000;
const SUFFIX_CHARS = 500;

const SYSTEM_PROMPT =
  'You are a code completion engine. Output ONLY the code that should be ' +
  'inserted at the cursor position. No explanations, no markdown, no ' +
  'backticks. Just raw code.';

// ─── Recursive string extractor ────────────────────────────
//
// Walk every wire-type-2 field at each nesting level.  For each buffer, test
// whether it looks like printable text (code, paths, UUIDs etc.).  Also
// recurse into it as a potential nested message.  This lets us harvest
// candidate strings without knowing the exact field numbers.

/**
 * @param {Buffer} buf
 * @param {number} depth       - current nesting depth (guard against infinite loops)
 * @param {number} parentField - parent field number (for logging)
 * @returns {Array<{text: string, field: number, parentField: number, depth: number}>}
 */
function extractAllStrings(buf, depth = 0, parentField = 0) {
  if (depth > 6 || !buf || buf.length === 0) return [];

  let fields;
  try {
    fields = parseFields(buf);
  } catch {
    return [];
  }

  const results = [];

  for (const f of fields) {
    if (f.wireType !== 2) continue;

    const raw = f.value;
    if (!raw || raw.length === 0) continue;

    // Check printable ratio — code/text should be mostly printable ASCII + whitespace
    const str = raw.toString('utf8');
    const printable = (str.match(/[\x09\x0a\x0d\x20-\x7e]/g) || []).length;
    const ratio = printable / (str.length || 1);

    if (str.length > 5 && ratio >= 0.80) {
      results.push({ text: str, field: f.field, parentField, depth });
    }

    // Recurse regardless — the buffer might be a nested message even if it
    // also happens to pass the printability test (e.g. short strings that
    // coincidentally match a valid protobuf structure).
    const nested = extractAllStrings(raw, depth + 1, f.field);
    results.push(...nested);
  }

  return results;
}

// ─── Code context extraction ───────────────────────────────
//
// Strategy: collect all printable string blobs from the proto tree,
// de-duplicate them, then sort by length descending.  In a FIM request the
// two longest strings are almost always:
//   [0] = prefix  (code before cursor — longer, includes file preamble)
//   [1] = suffix  (code after cursor  — shorter, tail of file)
//
// We also filter out obvious metadata strings (UUIDs, short tokens).

function extractCodeContext(protoBuf) {
  const allStrings = extractAllStrings(protoBuf);

  // De-duplicate by exact text
  const seen  = new Set();
  const unique = [];
  for (const s of allStrings) {
    if (!seen.has(s.text)) {
      seen.add(s.text);
      unique.push(s);
    }
  }

  // Sort by length descending so the richest context comes first
  unique.sort((a, b) => b.text.length - a.text.length);

  // Filter obvious non-code strings: UUIDs, short tokens, pure hex, pure digits
  const looksLikeCode = (s) => {
    if (s.length < 10) return false;
    // UUID pattern — skip
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return false;
    // Pure hex string — skip
    if (/^[0-9a-f]+$/i.test(s) && s.length < 80) return false;
    // Pure digits — skip
    if (/^\d+$/.test(s)) return false;
    return true;
  };

  const codeCandidates = unique.filter(s => looksLikeCode(s.text));

  const prefix = codeCandidates[0]?.text ?? '';
  const suffix = codeCandidates[1]?.text ?? '';

  return { prefix, suffix, allCandidates: unique, codeCandidates };
}

// ─── Proto response builder ────────────────────────────────

/**
 * Build a GetCompletionsResponse with a single completion.
 * Returns an empty Buffer (no completion) when completionText is empty/falsy.
 *
 * Structure:
 *   GetCompletionsResponse {
 *     CompletionResponse completion_response = 1 {
 *       Completion completions = 1 {
 *         string completion_id = 1;
 *         string text          = 2;
 *         StopReason stop_reason = 12;  // 2 = STOP_REASON_STOP_PATTERN
 *       }
 *     }
 *   }
 */
function buildGetCompletionsResponse(completionText) {
  if (!completionText) {
    // Empty buffer → empty CompletionResponse → no autocomplete suggestion shown
    return Buffer.alloc(0);
  }

  const completionId = crypto.randomUUID();

  // Completion message
  const completion = Buffer.concat([
    writeStringField(1, completionId),   // completion_id
    writeStringField(2, completionText), // text — the actual insertion
    writeVarintField(12, 2),             // stop_reason = STOP_REASON_STOP_PATTERN
  ]);

  // CompletionResponse { repeated Completion completions = 1; }
  const completionResponse = writeMessageField(1, completion);

  // GetCompletionsResponse { CompletionResponse completion_response = 1; }
  const response = writeMessageField(1, completionResponse);

  return response;
}

// ─── Anthropic API call ────────────────────────────────────

/**
 * Non-streaming call to the Anthropic Messages API.
 * Resolves with the completion string, or '' on any error/timeout.
 *
 * @param {string} prefix - code before cursor (trimmed)
 * @param {string} suffix - code after cursor  (trimmed, may be empty)
 * @returns {Promise<string>}
 */
function callAnthropicAPI(prefix, suffix) {
  return new Promise((resolve) => {
    // Trim context to avoid blowing the prompt window
    const p = prefix.slice(-PREFIX_CHARS);
    const s = suffix.slice(0, SUFFIX_CHARS);

    // Build a FIM-style user message the model can understand
    let userMessage;
    if (s.length > 0) {
      userMessage =
        'Complete the code at the cursor position.\n\n' +
        '<code_before_cursor>\n' + p + '\n</code_before_cursor>\n\n' +
        '<code_after_cursor>\n' + s + '\n</code_after_cursor>\n\n' +
        'Output only the text to insert between the two blocks.';
    } else {
      userMessage = 'Continue the following code:\n\n' + p;
    }

    const payload = {
      model:      MODEL,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
      stream:     false,
      max_tokens: MAX_TOKENS,
    };

    const body = JSON.stringify(payload);

    console.log(
      `  [completions] API call: model=${MODEL}` +
      ` prefix=${p.length}b suffix=${s.length}b`
    );

    const apiReq = https.request(
      {
        agent: httpsAgentFor(),
        hostname: API_HOST,
        port:     443,
        path:     API_PATH,
        method:   'POST',
        headers:  {
          'content-type':      'application/json',
          'anthropic-version': '2023-06-01',
          'content-length':    Buffer.byteLength(body),
        },
      },
      (apiRes) => {
        let raw = '';
        apiRes.setEncoding('utf8');

        apiRes.on('data', (chunk) => { raw += chunk; });

        apiRes.on('end', () => {
          console.log(
            `  [completions] API status=${apiRes.statusCode}` +
            ` body=${raw.slice(0, 400)}`
          );

          if (apiRes.statusCode !== 200) {
            console.error(
              `  [completions] API error ${apiRes.statusCode}: ${raw.slice(0, 200)}`
            );
            resolve('');
            return;
          }

          try {
            const json = JSON.parse(raw);
            const text = json?.content?.[0]?.text ?? '';
            console.log(
              `  [completions] Completion text: ${JSON.stringify(text.slice(0, 120))}`
            );
            resolve(text.trim());
          } catch (e) {
            console.error(`  [completions] JSON parse error: ${e.message}`);
            resolve('');
          }
        });

        apiRes.on('error', (err) => {
          console.error(`  [completions] API response error: ${err.message}`);
          resolve('');
        });
      }
    );

    // Hard 5-second timeout — completions must be fast or they're useless
    apiReq.setTimeout(TIMEOUT_MS, () => {
      console.warn(`  [completions] API timeout after ${TIMEOUT_MS}ms — returning empty`);
      apiReq.destroy();
      resolve('');
    });

    apiReq.on('error', (err) => {
      if (err.message.includes('socket hang up') || err.message.includes('ECONNRESET')) {
        // Expected when we destroy on timeout — already resolved above
        return;
      }
      console.error(`  [completions] API request error: ${err.message}`);
      resolve('');
    });

    apiReq.end(body);
  });
}

// ─── Main handler ──────────────────────────────────────────

/**
 * Handle GetCompletions RPC.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @param {Buffer}                         body - raw request body
 */
export async function handleGetCompletions(req, res, body) {
  console.log(`[completions] GetCompletions (${body?.length ?? 0}b)`);

  // ── Step 1: Decode the Connect-RPC envelope + optional gzip ──────────────
  let protoBuf;
  try {
    protoBuf = unwrapRequest(body, req.headers);
  } catch (e) {
    console.error(`  [completions] unwrapRequest failed: ${e.message}`);
    const respBody = wrapUnary(Buffer.alloc(0));
    res.writeHead(200, { ...unaryHeaders(), 'content-length': respBody.length });
    res.end(respBody);
    return;
  }

  // ── Step 2: Parse and log ALL top-level fields ───────────────────────────
  let topFields = [];
  try {
    topFields = parseFields(protoBuf);
  } catch (e) {
    console.error(`  [completions] parseFields failed: ${e.message}`);
  }

  console.log(`  [completions] Top-level fields (${topFields.length}):`);
  for (const f of topFields) {
    if (f.wireType === 0) {
      console.log(`    field ${f.field} (varint): ${f.value}`);
    } else if (f.wireType === 1) {
      const hex = Buffer.isBuffer(f.value) ? f.value.toString('hex') : String(f.value);
      console.log(`    field ${f.field} (fixed64): ${hex}`);
    } else if (f.wireType === 2) {
      const raw = f.value;
      const str = raw.toString('utf8');
      const printableCount = (str.match(/[\x09\x0a\x0d\x20-\x7e]/g) || []).length;
      const ratio = printableCount / (raw.length || 1);
      if (ratio >= 0.85) {
        console.log(
          `    field ${f.field} (string/${raw.length}b): ` +
          JSON.stringify(str.slice(0, 120))
        );
      } else {
        console.log(
          `    field ${f.field} (bytes/${raw.length}b): [binary] ` +
          raw.toString('hex').slice(0, 48)
        );
      }
    } else if (f.wireType === 5) {
      const hex = Buffer.isBuffer(f.value) ? f.value.toString('hex') : String(f.value);
      console.log(`    field ${f.field} (fixed32): ${hex}`);
    }
  }

  // ── Step 3: Extract code context via recursive string scan ───────────────
  const { prefix, suffix, allCandidates, codeCandidates } =
    extractCodeContext(protoBuf);

  console.log(
    `  [completions] String candidates: ${allCandidates.length} total, ` +
    `${codeCandidates.length} code-like`
  );

  // Log top candidates for debugging (shows us which fields carry the code)
  for (const c of codeCandidates.slice(0, 6)) {
    console.log(
      `    [field=${c.field} parent=${c.parentField} depth=${c.depth}` +
      ` len=${c.text.length}]: ` +
      JSON.stringify(c.text.slice(0, 100))
    );
  }

  console.log(
    `  [completions] prefix=${prefix.length}b suffix=${suffix.length}b`
  );
  if (prefix.length > 0) {
    console.log(
      `  [completions] prefix tail: ` +
      JSON.stringify(prefix.slice(-100))
    );
  }
  if (suffix.length > 0) {
    console.log(
      `  [completions] suffix head: ` +
      JSON.stringify(suffix.slice(0, 100))
    );
  }

  // ── Step 4: Call Anthropic API (best-effort) ─────────────────────────────
  let completionText = '';

  if (prefix.length > 0) {
    completionText = await callAnthropicAPI(prefix, suffix);
  } else {
    console.log(
      `  [completions] No code context found — skipping API call, returning empty`
    );
  }

  // ── Step 5: Build and send the proto response ─────────────────────────────
  const responseBuf = buildGetCompletionsResponse(completionText);
  const respBody    = wrapUnary(responseBuf);

  console.log(
    `  [completions] Response: proto=${responseBuf.length}b` +
    ` gzip=${respBody.length}b` +
    ` completion=${completionText.length}b`
  );

  res.writeHead(200, { ...unaryHeaders(), 'content-length': respBody.length });
  res.end(respBody);
}
