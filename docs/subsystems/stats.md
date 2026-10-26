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

### Chat main path (request-tracker)

1. Each entry point creates one tracker per request and passes it in:
   `sidecar/hybrid-server.js` (HTTP `direct` and MITM `devin`/`windsurf`) and
   `sidecar/inference-proxy.js`.
2. `handleGetChatMessage(req, res, body, tracker)` requires the tracker, binds
   `messageId` as `requestId`, and stores it on `res.__byokTracker`; deep stream
   functions reach it through `trackerOf(res)` (missing tracker throws, it does
   not silently skip accounting).
3. `tracker.beginAttempt()` is called once per upstream attempt (same moment the
   old `recordRequest` fired) and records `requests` plus the attempt entry.
4. Success terminals call `tracker.endAttempt({ status: 'ok', usage, ms })`
   followed by `tracker.finish()`.
5. Error terminals all pass through `sendTerminalError`, which calls
   `tracker.finish()`; the caller sets `reject()` / `fail()` / `abort()` first.
6. `finish()` is the only ledger exit: it calls `recordUsage` + `recordLatency`
   for `ok`, `recordError` for `failed` / `rejected`, and `recordRetry` when
   retries happened. It is idempotent.

### Local proxy path

`sidecar/local-proxy.js` and `sidecar/cursor-proxy.js` still call the `stats.js`
`record*` functions directly; they do not use the tracker yet.

### Storage

Writes mutate in-memory state, then schedule a debounced `stats.json` write
(500ms, timer unref'd). `snapshot()` is read by the proxy console through the
Tauri `get_stats` command; it rolls the day over and prunes history older than
`STATS_RETENTION_DAYS` (default 365, clamped 1..3650, read from
`byok-config.json`).

## Tracker contract

- `status` is one of `ok`, `failed`, `rejected`, `aborted` — no other values.
- `errorKind` classifies the terminal: `unconfigured`, `invalid-tool`,
  `rate-limit`, `cooldown`, `vision-config`, `vision`, `search-config`,
  `search`, `search-conflict`, `search-exhausted`, `upstream-http`,
  `upstream-stream`, `network`, `failover`, `unclassified`, `client-abort`.
- `beginAttempt` requires provider and model; unknown identity throws instead of
  defaulting.
- `endAttempt` requires a preceding `beginAttempt` with no open attempt.
- `fail` / `abort` after `finish` are no-ops (late socket events must not rewrite
  a settled ledger); `beginAttempt` / `endAttempt` after `finish` throw.
- A request that finishes with no terminal status is recorded as
  `failed` / `unclassified`, never as success.

## Invariants

- `requests` = all attempts + one extra entry for requests rejected before any
  attempt (so rejections are counted).
- `errors` = `failed` + `rejected`; `aborted` counts in `requests` only.
- `errorRate` is therefore mathematically bounded by 100%.
- Tokens and latency come from the successful attempt only (failed attempts keep
  their usage in `attempts` for inspection but do not contribute).
- `upstreamAttempts = requests + retries`.
- `estCostUsd` is a blended estimate (`input * 3 + output * 15` per million);
  cache tokens are recorded but do not contribute to the estimate.
- History pruning is based on the date key, never on file mtime.
- A missing or unreadable `stats.json` must not crash the proxy: counters
  restart from zero and history is empty.
- MITM and RPC audit logs are off unless explicitly enabled by environment
  variable; header values are redacted.

## Known deviations (current behavior, not targets)

- There is no per-request ledger: the in-day `recent` ring keeps the last 20
  entries and is not a substitute for request-level history.
- Codeium RPC forwarding (`proxyToCodeium`), blocked/preflight responses and
  plugin upstream calls are not recorded in `stats.json`.
- `sidecar/local-proxy.js` and `sidecar/cursor-proxy.js` do not use the tracker;
  their retry/rejection accounting still differs from the chat path.
- `byModel` is keyed by the resolved upstream model; requested identity and
  provider/account dimensions are not aggregated.
- `estCostUsd` is a single blended rate; cache read/write are not priced.

## Verification

- `npm run test:unit` covers sidecar behavior tests, including stats-adjacent
  modules.
- `npm run check:fast` runs the source-level guards in
  `scripts/check-key-features.mjs`.
- Runtime behavior of the real clients is validated only by
  `npm run check:live`, which is never part of `verify`.
