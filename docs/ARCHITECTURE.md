# Architecture

[English](ARCHITECTURE.md) • [简体中文](ARCHITECTURE_zh.md)

AnyBridge consists of four tightly coordinated components:

- `src-tauri/` — Tauri desktop shell (Rust)
- `cursor-core/` — Dedicated Connect RPC / local takeover engine (Rust)
- `ui-src/` & `ui/` — Modular static frontend (HTML partials + ES Modules)
- `sidecar/` — Node.js local gateway and multi-protocol conversion service

```text
AI coding tools / IDEs
  -> local gateway or Rust-managed config files
  -> AnyBridge sidecar (HTTP/SSE protocol codecs) / cursor-core (HTTP/2 Connect)
  -> configured primary provider APIs

AnyBridge desktop (src-tauri)
  -> platform detection & authoritative agent_spec registry
  -> primary provider Single Source of Truth (SSOT) & live projections
  -> store_io cross-process file-lock transactions + write_atomic
  -> format-preserving jsonc_edit & field_restore (both enabled by default)
  -> local CA management, sidecar lifecycle & async reload notifications
```

## Desktop (`src-tauri/`)

The Tauri backend owns native OS integration, authoritative configuration persistence, and client takeover:

- **Locked atomic storage (`commands/store_io.rs`)**: Serializes Read-Modify-Write transactions on `providers.json`, `proxy-routes.json`, and `codex-proxy-routes.json` using canonical-path in-process `Mutex` guards plus sidecar `.lock` file locks (`std::fs::File::lock`). `write_atomic` writes unique PID/nanosecond/sequence temp files and retries atomic renames for both config files and large `app.asar` patches (mirrored in `cursor-core/src/fs_atomic.rs`).
- **Primary provider SSOT (`commands/config/conversions.rs`)**: All six platform config types (`Antigravity`, `Codex`, `ClaudeCode`, `OpenCode`, `Grok`, `ClaudeDesktop`) resolve live connection fields, full `api_keys` pools, capabilities, and enabled status via `resolve_provider` / `validate_active_source` when `source_provider_id` is set, overriding stale `settingsConfig` snapshots and rejecting missing/disabled sources.
- **Format-preserving edits & field-level restore (`commands/jsonc_edit/`, `commands/field_restore.rs`, `commands/agent_stash.rs`)**: Both are enabled by default (falling back only when explicitly disabled via env vars). `jsonc_edit` supports indentation-aligned `Object`/`Array` edits; `field_restore` performs semantic `serde_json::Value` comparisons and cleans up `.byok-bak` and companion state files upon completion.
- **Async IPC & single registry (`commands/agent_spec/`, `commands/platforms/`)**: Core storage and probe `#[tauri::command]` handlers run via `async fn` + `spawn_blocking` with non-blocking sidecar reload notifications; platform metadata is anchored in `agent_spec::AGENTS`.

## Frontend (`ui-src/` & `ui/`)

The UI builds HTML partials from `ui-src/` into `ui/index.html` (`scripts/build-ui.mjs`) and loads ES Modules via `ui/assets/scripts/main.js`:

- **Centralized store & transaction layer (`ui/assets/scripts/state/provider-store.js`)**: Owns `providerStore`, `resolveBoundProviderView` live binding resolution, virtual built-in provider filtering, and queued `persistProviders` / `mutateProviderStore` transactions with 100% automatic snapshot rollback on failure.
- **Shared platform layers (`ui/assets/scripts/platforms/shared_config_editor.js`, `managed_models.js`, `models_table_factory.js`)**: Unifies race-guarded model fetching, checklist rendering, live-bound saving, and managed-model tables across platforms without late-script overrides.
- **Action bus & static guards (`05-actions.js`)**: Every `data-action` is 100% statically reachable (`KNOWN_MISSING` is 0), and async controls use `ui/feedback.js` (`loadingHtml`/`setLoading`) with `try/finally` cleanup. Before committing UI changes, run:

```bash
npm run check:ui && npm run check:i18n
```

## Sidecar (`sidecar/`)

The Node.js sidecar reads configuration directories in read-only mode and handles gateway routing, protocol translation, and resilient upstream transport:

- **Read-only config cache (`sidecar/config-cache.js`, `sidecar/provider-pool.js`)**: Caches `providers.json`, `model-map.json`, `proxy-routes.json`, and `codex-proxy-routes.json` by mtime + TTL; retains the last healthy snapshot on corrupt disk reads, resolves live `sourceProviderId` bindings across `codexConfigs` and other platform configs (including `apiKeys` and disabled-source checks), and never writes back to `providers.json`.
- **Standard SSE & CodecRegistry (`sidecar/lib/sse-parser.js`, `sidecar/lib/codec-registry.js`, `sidecar/lib/upstream-decoder.js`)**: Provides `StringDecoder('utf8')`-based incremental SSE parsing and unified streaming codecs from 4 upstream formats (OpenAI Chat / Responses / Anthropic / Gemini) to 5 downstream targets (including Antigravity). Native `gemini -> gemini` keeps its lossless fast-path, while `runStreamPipeline` binds `res.once('close')` aborts and guarantees `upstreamResponse.destroy()` in `try/finally` to prevent `providerInflightGate` slot leaks.
- **Resilience & terminal ledger settlement (`sidecar/system-proxy.js`, `sidecar/lib/http-retry.js`, `sidecar/request-tracker.js`)**: Shares `SHARED_HTTPS_AGENT` / `SHARED_HTTP_AGENT` with dead-port system-proxy fallback, supports per-target 401/429 `apiKeys` rotation and `<2s` `Retry-After` micro-backoff before headers are sent, and defers `tracker.finish()` until stream termination so `usage-ledger.js` records actual token counts (never marking aborted or truncated EOF streams as `ok`).

Run the sidecar standalone during development with:

```bash
npm run start
```

Release builds bundle the sidecar and `cursor-core` as target-specific external binaries invoked by Tauri.

## Local Data

Runtime configuration and ledgers live in the user's app data directory (`AppData` / `.config`), never inside the repository. Keep tokens, provider keys, certificates, and captured traffic out of Git.
