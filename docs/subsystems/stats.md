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
| Per-request ledger | `usage/usage-YYYY-MM-DD.jsonl`, whitelist fields only, 90-day retention. | `sidecar/usage-ledger.js` |
| Pricing | Built-in per-model unit prices (input/output/cache read/cache write). | `sidecar/pricing.js` |
| Bypass scan | Reads agent-owned logs/databases and writes `usage-local.json`. | `src-tauri/src/commands/usage_scan.rs` |
| Stats page | KPI, daily trend, model ranking, data sources. | `ui-src/partials/pages/stats.html`, `ui/assets/scripts/67-stats.js` |

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

## Bypass sources (local logs)

Statistics must survive the proxy being stopped or in development. The bypass
scanner reads what the clients already write, never injects into them, and never
requires traffic to pass through AnyBridge:

| Source | Input | Aggregation |
| --- | --- | --- |
| `claude-code` | `~/.claude/projects/**/*.jsonl` assistant rows (`message.usage`) | Incremental by byte offset per file; file shrink resets the offset and re-reads. |
| `cursor` | `<config>/cursor-core/cursor-core.db` `llm_calls` | Full recompute per scan (idempotent), read-only connection. |
| `cpa` | `<LocalAppData>/anybridge/extensions/services/cpa-suite/cpamp-data/usage.sqlite` account daily rollups | Full recompute, read-only, grouped by day × account × model. |
| `pi` | `~/.pi/agent/analytics/usage.jsonl`, one JSON array per call: `[ts_ms, session, workspace, model, input, output, cache_read, cache_write, total, ?]` | Full recompute (file is small and grows slowly; offsets would risk permanent undercounting). Provider prefix in `model` (`CPA/…`, `local/…`) is stripped so names align with the gateway ledger. |
| `zcode` | `~/.zcode/cli/db/db.sqlite` `model_usage` | Full recompute, read-only, grouped by day × model; rows with `started_at = 0` are skipped. |

Rules:

- Results land in `<config>/usage-local.json`, separate from `stats.json`.
- Rejection by the scanner (missing file, unreadable database) is recorded in
  `errors` and reported in the UI; it is never silently treated as zero usage.
- Scanning runs in `spawn_blocking`; it must not run on the UI thread.
- Codex sessions are not scanned yet: the local samples were empty files, so the
  record shape is unverified. Do not guess a parser without a real sample.

### Evaluated and rejected (do not re-litigate)

Investigated on 2026-10-29 with real local data; conclusions below are final
until the client changes its storage format.

| Source | Verdict | Evidence |
| --- | --- | --- |
| Gemini CLI (`~/.gemini/tmp/*/chats/session-*.json`) | **Won't add** | Format is clean (`model` + `tokens{input,output,cached}` per assistant message, 211 messages locally), but the CLI is being retired in favour of Antigravity CLI, which is out of support scope. |
| Antigravity IDE (`~/.gemini/antigravity/conversations/*.db`) | Won't add | `gen_metadata` / `steps` hold protobuf blobs with no schema; a parser would be guesswork that breaks on version bumps. |
| Codex | Deferred by the owner | `state_5.sqlite` → `threads.tokens_used` holds real history (764 threads, 571 with usage, **9.07B tokens**, 2025-12 → 2026-09, `model` populated, `model_provider` always `codex_local_access` so no overlap with our ledgers). But it is session-level only: no input/output/cache split, no request count, and all 571 `rollout_path` files are gone, so there is no per-call `token_count` left to parse. Bucketing to a day would mean crediting each thread's whole total to its last-active day (locally that puts 3.4B on a single day), which distorts the trend. Parked until Codex is used again and fresh rollouts exist. Note: `input_tokens` inside `session_index.jsonl` is prompt text, not a field — do not cite it as evidence. |
| Trae | Won't add | `ModularData/ai-agent/database.db` (63 MB) is not SQLite (`file is not a database`); encrypted or private format. |
| Zed | Won't add | All three `db.sqlite` files are 4 KB empty shells. |
| CodeBuddy | Won't add | No usage artefact anywhere in `~/.codebuddy`. |
| Windsurf | Won't add | `state.vscdb` only stores extension `lastUsed` timestamps. |
| Grok / WorkBuddy | Won't add | Runtime logs / audit events, no per-call tokens. |
| Claude Desktop | Won't add | No local database or jsonl holding usage. |
| VS Code Copilot Chat | Won't add | Extension ships metadata only. |

## Two ledgers, never merged

- **Gateway ledger** (`stats.json` + `usage/*.jsonl`): requests that actually
  passed through the proxy. Carries routing, retries and provider identity.
- **Bypass ledger** (`usage-local.json`): usage reported by the clients
  themselves. Carries account identity and is available even while the proxy is
  stopped.

The stats page sums both for request/token totals but keeps cost and success
rate gateway-only, because bypass sources have no price and no error contract.
Never merge them into one file: the same request may appear in both.

### Overlap dedupe

A client that forwards through our own gateway (or through the CPA suite) writes
the same call into its own log as well. Counting both inflates the total, so the
client record carries an upstream marker and the overlap is excluded:

| Client | Upstream marker | Overlapping ledger |
| --- | --- | --- |
| `zcode` | `model_usage.provider_id` such as `AnyBridge-35222063` | gateway |
| `pi` | model prefix before `/` such as `CPA/…` or `AnyBridge/…` | cpa / gateway |

Rules:

- Only markers that name an own ledger are treated as overlap (`AnyBridge*`,
  `CPA`); external providers (`AnyRouter`, `account:*`) and `local` stay counted.
- Excluded amounts are recorded in `overlapped` per source and shown on the
  channel card as「已去重 N 次」, so a shrinking total is never unexplained.
- The dedupe is conservative: when a marker is unrecognised the usage is
  counted, because undercounting silently is worse than asking the user to look.

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
