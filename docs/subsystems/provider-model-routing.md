# Provider and model routing

This page covers provider configuration, model slots, local proxy routes and
how Cursor receives them.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Providers | Supplier definitions and local-proxy pseudo provider. | `sidecar/config-cache.js`, `src-tauri/src/commands/config.rs` |
| Model slots | `model-map.json` maps model UIDs to display state and ordered failover targets. | `src-tauri/src/commands/model_map.rs` |
| Global routes | `proxy-routes.json` is the shared route list exposed by the local proxy. | `src-tauri/src/commands/proxy_routes.rs` |
| Codex routes | `codex-proxy-routes.json` is the Codex-specific route list. | `src-tauri/src/commands/proxy_routes.rs`, `src-tauri/src/commands/platforms.rs` |
| Cursor bindings | `cursor-models.json` binds route UIDs to exposed Cursor model IDs. | `src-tauri/src/commands/cursor_models.rs` |
| Runtime cache | Sidecar caches configuration with mtime detection plus a 2s TTL. | `sidecar/config-cache.js` |

## Runtime path

1. UI actions go through Tauri commands; the owning Rust command validates and
   writes the JSON file atomically.
2. `sidecar/config-cache.js` reloads `providers.json`, `model-map.json`,
   `proxy-routes.json` and `codex-proxy-routes.json` by mtime; within the 2s
   TTL it reuses the parsed value.
3. `sidecar/local-proxy.js` resolves a requested exposed ID for the requested
   protocol kind and turns a route into upstream targets through
   `sidecar/provider-pool.js`.
4. Cursor is separate: starting Cursor Core passes explicit paths for routes,
   Cursor bindings and providers, then Rust posts the paths and gateway URL to
   `/__byok-api__/api/harness/cursor/routes/sync` (`src-tauri/src/commands/cursor_core.rs`).

## Invariants

- A route's `uid` is its stable identity; `id` is the exposed identity.
- Exposed-ID lookup is built in two passes: literal IDs first, then IDs rendered
  by a rename rule. A rendered alias conflicting with a literal ID yields and
  warns; it must not throw and must not affect unrelated routes. Two routes with
  the same literal ID is a real conflict and must fail.
- Codex routes keep raw model IDs and do not receive the global rename rule.
- Cursor bindings must have unique exposed model IDs.

## Failure behavior to preserve

- An unreadable or unparsable `proxy-routes.json` keeps `fileExists: true` and
  carries `loadError` instead of pretending the file was absent.
- Changing the provider or model-map parse-failure behavior is a contract
  change: add a test that reproduces the old incident first.

## Verification

- `node --test sidecar/local-proxy.test.js`
- `node --test sidecar/config-cache.test.js`
- `node --test sidecar/provider-pool.test.js`
- Rust tests for Cursor binding normalization run under `cargo test`.
