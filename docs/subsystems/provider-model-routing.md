# Provider and model routing

This page covers provider configuration, model slots, local gateway routes and
how Cursor receives them.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Providers & live binding resolution | Primary provider SSOT (`resolve_provider`), live `sourceProviderId` resolution across all platform configs (`codexConfigs`, `antigravityConfigs`, etc.), and read-only sidecar cache. | `sidecar/config-cache.js`, `src-tauri/src/commands/config/`, `src-tauri/src/commands/store_io.rs`, `sidecar/lib/local-proxy/routes.js` |
| Platform registry | Authoritative platform metadata (`name`, `vendor`, `config_path`, `api_format`). | `src-tauri/src/commands/agent_spec/`, `ui/assets/scripts/platforms/core.js` |
| Model slots | `model-map.json` maps model UIDs to display state and ordered failover targets. | `src-tauri/src/commands/model_map.rs` |
| Global routes | `proxy-routes.json` is the shared route list exposed by the local gateway. | `src-tauri/src/commands/proxy_routes.rs`, `src-tauri/src/commands/store_io.rs` |
| Codex routes | `codex-proxy-routes.json` is the Codex-specific route list synced with primary `api_keys`. | `src-tauri/src/commands/proxy_routes.rs`, `src-tauri/src/commands/platforms/codex/` |
| Cursor bindings | `cursor-models.json` binds route UIDs to exposed Cursor model IDs. | `src-tauri/src/commands/cursor_models/` |
| Runtime cache | Read-only sidecar cache using mtime + 2s TTL, keeping last healthy snapshot on corrupt disk reads. | `sidecar/config-cache.js` |

## Runtime path

1. UI mutations go through `ui/assets/scripts/state/provider-store.js` (`mutateProviderStore` / `persistProviders` with queued rollback) into Tauri async commands; `src-tauri/src/commands/store_io.rs` serializes all file RMW via canonical-path in-process `Mutex` + `.lock` file lock + `write_atomic`, then triggers non-blocking sidecar reload notifications.
2. `sidecar/config-cache.js` reloads `providers.json`, `model-map.json`, `proxy-routes.json` and `codex-proxy-routes.json` by mtime (honoring `entry.dirty` on `invalidate`); within the 2s TTL it reuses the parsed value, and on parse/read failure it preserves the last valid snapshot rather than poisoning cache with empty entries.
3. `sidecar/local-proxy.js` resolves a requested exposed ID for the requested
   protocol kind and turns a route into upstream targets through
   `sidecar/provider-pool.js` (read-only; memory capability flags are never written back to `providers.json`).
4. Cursor is separate: starting Cursor Core passes explicit paths for routes,
   Cursor bindings and providers, then Rust posts the paths and gateway URL to
   `/__byok-api__/api/harness/cursor/routes/sync` (`src-tauri/src/commands/cursor_core.rs`).

## Invariants

- A route's `uid` is its stable identity; `id` is the exposed identity.
- Exposed-ID lookup is built in two passes: literal IDs first, then IDs rendered
  by a rename rule. A rendered alias conflicting with a literal ID yields and
  warns; it must not throw and must not affect unrelated routes. Two routes with
  the same literal ID is a real conflict and must fail.
- Codex routes keep raw model IDs, do not receive the global rename rule, and track `sourceProviderId` so `sync_provider_api_keys` updates both `proxy-routes.json` and `codex-proxy-routes.json`.
- Cursor bindings must have unique exposed model IDs.
- All platform configs linked via `sourceProviderId` (`Antigravity`, `Codex`, `ClaudeCode`, `OpenCode`, `Grok`, `ClaudeDesktop`) resolve live host, path, key/pool, and effective format from the referenced provider instead of preferring legacy snapshots or nested `settingsConfig` values; missing or disabled source providers are explicitly blocked (`enabled = false` / validation error) without silent fallback.
- Platform metadata (`api_format` including `"gemini"` for Antigravity) originates
  solely from `src-tauri/src/commands/agent_spec/`; UI keeps copy-only labels.

## Failure behavior to preserve

- An unreadable or unparsable `proxy-routes.json` keeps `fileExists: true` and
  carries `loadError` instead of pretending the file was absent.
- Changing the provider or model-map parse-failure behavior is a contract
  change: add a test that reproduces the old incident first.

## Verification

- `node --test sidecar/local-gateway.test.js`
- `node --test sidecar/config-cache.test.js`
- `node --test sidecar/provider-pool.test.js`
- Rust tests for Cursor binding normalization run under `cargo test`.
