# Codex integration

This page covers switching Codex between AnyBridge providers and the official
OpenAI configuration.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Apply third-party provider | Edit `~/.codex/config.toml` (or `CODEX_HOME`) in place, preserving unrelated TOML. | `src-tauri/src/commands/platforms.rs` (`Platform::Codex::apply_codex`) |
| Restore official | Point the managed provider back to OpenAI OAuth without depending on an old backup. | `src-tauri/src/commands/platforms.rs` (`apply_codex_official`) |
| Managed provider | The runtime provider ID is `codex_local_access`; the legacy ID is `byok`. | `src-tauri/src/commands/platforms.rs` |
| Codex routes | Third-party proxy mode writes `codex-proxy-routes.json`. | `src-tauri/src/commands/platforms.rs`, `src-tauri/src/commands/proxy_routes.rs` |
| Model catalog | `anybridge-model-catalog.json` lives beside `config.toml` and is removed when no catalog is configured. | `CODEX_MODEL_CATALOG_FILENAME` |
| Managed agents | Managed agent files live under `anybridge-agents/` with `manifest.json`; user agent roles are preserved. | `apply_codex_agents` |

## Runtime contract

1. `apply_codex` only rewrites the managed provider block, the active model
   pointer, retry fields and AnyBridge-managed catalog/agent state. TOML
   sections such as `mcp_servers`, `projects` and unrelated provider tables
   stay untouched.
2. `wire_api` in `config.toml` is always `responses`; Chat-only upstreams are
   translated by the local proxy, not by writing `chat` into Codex config.
3. Auth fields are mutually exclusive: OAuth uses
   `requires_openai_auth = true`; third-party bearer mode uses
   `requires_openai_auth = false` plus `experimental_bearer_token`. Do not leave
   `env_key` or an `auth` table behind.
4. Official restore removes third-party model/catalog state and switches the
   managed provider to OAuth. It must not resurrect stale bearer or backup data.
5. User edits outside AnyBridge-managed state survive both apply and restore.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml --lib codex`
- Existing behavior tests include preserving unrelated TOML, clearing conflicting
  auth fields, OAuth restore and managed-agent cleanup.
- `codex_apply_restore_contract_is_idempotent_and_preserves_user_edits` locks the
  end-to-end apply/restore contract: repeated apply is byte-stable, user edits
  between syncs survive, and official restore only reverses managed state.

New Codex behavior must be added to this suite before the contract is changed.
Other platforms should adopt the same apply/restore contract before expanding
broad "all platform" changes.
