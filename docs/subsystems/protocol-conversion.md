# Protocol conversion

This page covers local-proxy request normalization, upstream format selection
and streamed Responses/Chat conversion.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Request normalization | Turn OpenAI Chat, Responses, Anthropic and Gemini requests into the internal context. | `sidecar/local-proxy.js` (`normalizeRequest`) |
| OpenAI upstream | Send and stream Chat Completions; emit tool calls for both stream modes. | `sidecar/local-proxy.js` (`sendOpenAIChat`) |
| Responses non-stream / fake stream | Build the Responses object and emit its SSE event sequence. | `sidecar/local-proxy.js` (`responseObject`, `sendOpenAIResponses`) |
| Responses true stream | Convert Chat SSE into Responses SSE incrementally. | `sidecar/lib/responses-chat-transform.js` |
| Responses → Chat | Convert inbound Responses SSE into Chat SSE for chat-only clients. | `sidecar/lib/chat-sse-transform.js` |

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

## Failure behavior

- A stream that fails after headers must end in a way the client can observe;
  do not replace it with an empty successful body.
- Upstream error text classification treats an empty body or an interception
  page as "no information"; preserve readable fallbacks in
  `upstreamErrorText` / `failureMessage`.

## Verification

- `node --test sidecar/local-proxy.test.js`
- `node --test sidecar/lib/responses-chat-transform.test.js`
- `node --test sidecar/lib/chat-sse-transform.test.js`
- Live vendor checks belong to an explicit probe under `tmp/`, never to the
  hermetic unit suite.
