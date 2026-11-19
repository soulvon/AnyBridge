# Protocol conversion

This page covers local-proxy request normalization, upstream format selection
and streamed Responses/Chat conversion.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Request normalization | Turn OpenAI Chat, Responses, Anthropic and Gemini requests into the internal context. | `sidecar/lib/local-proxy/normalize.js` (`normalizeRequest`) |
| Gemini native passthrough | Losslessly forward `gemini -> gemini` native parts (`fileData`, `executableCode`, `codeExecutionResult`), multi-part `systemInstruction`, raw `tools`, and `:countTokens`. | `sidecar/lib/local-proxy/upstream-payload.js` (`buildGeminiNativePassthroughPayload`), `sidecar/local-proxy.js` (`executeGeminiCountTokens`) |
| Standard SSE stream parser | `StringDecoder('utf8')` incremental SSE parser supporting multi-line `data:`, `data:{...}` without space, default `message` event, and EOF `flush()`. | `sidecar/lib/sse-parser.js` (`createSSEParser`, `parseSSEStream`) |
| Unified stream codec registry | Cross-protocol decoding from 4 upstreams (`openai`, `responses`, `anthropic`, `gemini`) into 5 targets (`openai`, `responses`, `anthropic`, `gemini`, `antigravity`), plus Cursor streaming adapter and `runStreamPipeline`. | `sidecar/lib/codec-registry.js`, `sidecar/lib/upstream-decoder.js`, `sidecar/lib/cursor/streaming.js` |
| OpenAI / Anthropic / Responses upstreams | Send, stream, and rotate per-provider `apiKeys` on 401/429 before headers are sent; emit tool calls, reasoning, and `cache_creation_input_tokens`. | `sidecar/lib/local-proxy/transport.js`, `sidecar/lib/http-retry.js`, `sidecar/lib/local-proxy/response-emitters.js`, `sidecar/lib/local-proxy/count-tokens.js` |
| Responses non-stream / fake stream | Build the Responses object and emit its SSE event sequence without empty message items on tool-only turns. | `sidecar/lib/local-proxy/response-emitters.js` (`responseObject`, `sendOpenAIResponses`) |
| Responses true stream | Convert Chat SSE into Responses SSE incrementally. | `sidecar/lib/responses-chat-transform.js`, `sidecar/lib/responses-chat/` |
| Responses → Chat | Convert inbound Responses/Anthropic SSE into Chat SSE including `reasoning_content` and `cache_creation_input_tokens`. | `sidecar/lib/chat-sse-transform.js` |
| Google Gemini / Vertex protocol | Resolve AI Studio & Vertex endpoints (preserving proxy `basePath`), Vertex ADC/Bearer/SA/Impersonation auth with OAuth retry + singleflight, thinking normalization, JSON array stream unwrapping, inline `{ error }` termination, and Windsurf/Devin native Gemini chat format. | `sidecar/lib/google-gemini.js`, `sidecar/lib/google-gemini/thinking.js`, `sidecar/lib/gemini-sse-transform.js`, `sidecar/handlers/chat/` |
| Gemini tool call signatures | Bounded LRU (2000 entries) host/model-scoped `thoughtSignature` and upstream `call.id` cache for cross-protocol replay to Gemini 3/4 upstreams. | `sidecar/lib/gemini-thought-signature.js` |

## Invariants

- A Responses `function_call` carries `arguments` as a JSON string.
- `responseObject` must place every upstream tool call in `output` as a
  `function_call` item after the message.
- In `sendOpenAIResponses` fake streaming, every additional output item is sent
  as `response.output_item.added` followed by `response.output_item.done`,
  starting at `output_index` 1. `response.completed` carries the full object.
- Assistant history sent back to a Responses upstream uses `output_text`
  content parts, not plain text.
- A Responses upstream request keeps `store: false` even when passthrough would
  preserve extra parameters.
- Same-protocol `gemini -> gemini` requests (without `visionFallbackApplied`)
  must take `buildGeminiNativePassthroughPayload` so `fileData`, `executableCode`,
  `codeExecutionResult`, multi-part `systemInstruction`, and raw `tools` such as
  `googleSearch` bypass lossy chat IR flattening.
- Cross-protocol `tool_use` and `tool_result` blocks targeted at a `gemini`
  upstream must be converted by `geminiContents` (`geminiPartsFromInternalPart`)
  into `functionCall` and `functionResponse` parts (preserving `id` only when
  originally emitted by that upstream, resolving `name` from `tool_use`, merging
  adjacent same-role turns, and replaying cached `thoughtSignature` or falling
  back to `skip_thought_signature_validator` on the first `functionCall` of a
  model turn).

## Failure behavior

- A stream that fails after headers must end in a way the client can observe;
  do not replace it with an empty successful body, do not emit synthetic
  `STOP`/`[DONE]` on errors or premature EOF before terminal frames, and settle
  tracker as `failed`/`aborted` (never `ok`).
- `runStreamPipeline` and `consumeCursorUpstreamStream` bind `res.once('close')`
  and always `destroy()` `upstreamResponse` inside `try/finally` so aborted or
  errored streams never leak `providerInflightGate` slots.
- Upstream error text classification treats an empty body or an interception
  page as "no information"; preserve readable fallbacks in
  `upstreamErrorText` / `failureMessage`.

## Verification

- `node --test sidecar/local-gateway.test.js`
- `node --test sidecar/lib/codec-registry.test.js`
- `node --test sidecar/lib/sse-parser.test.js`
- `node --test sidecar/lib/responses-chat-transform.test.js`
- `node --test sidecar/lib/chat-sse-transform.test.js`
- Live vendor checks belong to an explicit probe under `tmp/`, never to the
  hermetic unit suite.
