# Usage statistics and logs

This page covers runtime counters, the persisted daily summary, request/body
logs and the Cursor call database. It describes what the code does today; known
deviations are listed explicitly so they are not mistaken for intended behavior.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Runtime counters | In-memory daily counters plus a 60s sliding window (6 x 10s buckets). | `sidecar/stats.js` |
| Persisted daily summary | `stats.json` version 2: `{ retentionDays, days: { "YYYY-MM-DD": snapshot } }`, debounced 500ms. | `sidecar/stats.js` |
| Vision fallback log | `vision-logs/vision-YYYY-MM-DD.jsonl`, one line per image conversion. | `sidecar/stats.js` |
| MITM body log | `mitm-logs/mitm-YYYY-MM-DD.jsonl`, only when `BYOK_MITM_LOG` is set; bodies truncated to 8192 bytes unless `BYOK_MITM_FULL_LOG`. | `sidecar/mitm-logger.js` |
| RPC audit log | `rpc-audit/rpc-YYYY-MM-DD.jsonl`, only when `BYOK_RPC_AUDIT` is set; route/method/status/bytes, no bodies. | `sidecar/mitm-logger.js` |
| Log retention | Removes expired log directories on write. | `sidecar/lib/log-cleanup.js` |
| Cursor call records | `runs` and `llm_calls` tables (timing chain, tokens, status, error kind). | `cursor-core/src/store/llm_calls.rs` |
| Stats endpoint | `GET /__byok/stats`, local UI only, returns `snapshot()`. | `sidecar/hybrid-server.js` |

## Runtime path

1. `sidecar/handlers/chat.js`, `sidecar/local-proxy.js` and
   `sidecar/cursor-proxy.js` call `recordRequest` immediately before each
   upstream attempt, `recordUsage` when an upstream stream finishes, and
   `recordError` on rejections and terminal failures.
2. `recordRetry` is called by `sidecar/local-proxy.js` and `sidecar/retry.js`.
3. Writes mutate in-memory state, then schedule a debounced `stats.json` write
   (500ms, timer unref'd).
4. `snapshot()` is read by the proxy console through the Tauri `get_stats`
   command; it rolls the day over and prunes history older than
   `STATS_RETENTION_DAYS` (default 365, clamped 1..3650, read from
   `byok-config.json`).

## Invariants

- `requests` counts upstream attempts; `upstreamAttempts = requests + retries`.
- `errors` counts `recordError` calls, which include locally rejected requests
  that never reached an upstream.
- `estCostUsd` is a blended estimate (`input * 3 + output * 15` per million);
  cache tokens are recorded but do not contribute to the estimate.
- History pruning is based on the date key, never on file mtime.
- A missing or unreadable `stats.json` must not crash the proxy: counters
  restart from zero and history is empty.
- MITM and RPC audit logs are off unless explicitly enabled by environment
  variable; header values are redacted.

## Known deviations (current behavior, not targets)

- `requests` excludes rejected requests while `errors` includes them, so the
  60s `errorRate` can exceed 100%.
- There is no per-request ledger: the in-day `recent` ring keeps the last 20
  entries and is not a substitute for request-level history.
- Codeium RPC forwarding (`proxyToCodeium`), blocked/preflight responses and
  plugin upstream calls are not recorded in `stats.json`.
- Retries inside `sidecar/handlers/chat.js` are not reported through
  `recordRetry`, so `retries` only reflects the local-proxy path.
- `byModel` is keyed by the resolved upstream model; requested identity and
  provider/account dimensions are not aggregated.

## Verification

- `npm run test:unit` covers sidecar behavior tests, including stats-adjacent
  modules.
- `npm run check:fast` runs the source-level guards in
  `scripts/check-key-features.mjs`.
- Runtime behavior of the real clients is validated only by
  `npm run check:live`, which is never part of `verify`.
