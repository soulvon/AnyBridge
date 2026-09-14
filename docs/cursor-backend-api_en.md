# Cursor Backend API Specification

[English](cursor-backend-api_en.md) • [简体中文](cursor-backend-api.md)

This document specifies the Tauri commands available to the frontend for Cursor platform management. The Cursor view is fully decoupled and should not call deprecated functions such as `switch_ide_to_proxy({ target: "cursor" })`, legacy string states, or Node `cursor-proxy.js`.

## Commands

### `cursor_get_status`

No parameters. Returns:

```json
{
  "running": false,
  "controlPort": 17650,
  "healthUrl": "http://127.0.0.1:17650/__byok-api__/healthz",
  "configuredModels": 3,
  "certificateReady": true,
  "certificateMessage": "AnyBridge CA installed in CurrentUser\\Root",
  "availableActions": ["enable", "repair"],
  "lastError": null
}
```

### `cursor_preflight`

No parameters. Verifies:

- Cursor Core development/installed binary exists;
- At least one enabled proxy model exposing OpenAI format exists;
- AnyBridge local proxy key is generated.

Returns the same payload as `cursor_get_status` on success, or an explicit error string on failure.

### `cursor_enable`

No parameters. Lifecycle actions:

1. Ensures AnyBridge local gateway is running;
2. Launches Cursor Core;
3. Synchronizes `proxy-routes.json`;
4. Uses AnyBridge CA certificate;
5. Writes Cursor local proxy configuration;
6. Does NOT modify Cursor access token or subscription state.

Returns status object on success. Upon first enablement, prompt user to restart Cursor and create a new chat.

### `cursor_sync_routes`

No parameters. Atomically syncs the latest `proxy-routes.json` to the model directory while Cursor Core is running, without needing a Core restart. Call after saving proxy models.

### `cursor_disable`

No parameters. Instructs Core to restore original Cursor settings, then stops Core. Original values for `http.proxy`, `http.noProxy`, etc. captured prior to first enable are restored accurately.

### `cursor_restart`

No parameters. Restarts Cursor Core and resynchronizes model routes. Does not restart the Cursor IDE itself; call `restart_ide({ target: "cursor" })` when an IDE restart is required.

## Model Management Commands

### `cursor_list_models`
No parameters. Returns the combined model binding list for the Cursor platform:
- `id`: Unique binding ID
- `routeUid`: Associated shared route UID
- `displayName`: Display name in Cursor
- `exposedModelId`: Model identifier exposed to Cursor
- `enabled`: Enabled state
- `providerName`: Provider display name
- `targetModel`: Upstream model identifier
- `supportsTools` / `supportsReasoning` / `supportsVision`: Capability flags

### `cursor_list_provider_models`
No parameters. Returns sanitized provider model trees for the "Add Model" modal:
- Returns only provider ID, name, and model list with sensitive keys stripped;
- Includes `alreadyAdded` and bound ID indicators.

### `cursor_add_models`
Parameters: `{ req: { models: [{ providerId, modelId, displayName }] } }`.
Batch adds models to Cursor: reuses or creates shared routes and establishes Cursor-specific bindings.

### `cursor_update_model`
Parameters: `{ req: { id, displayName, reasoningEffort, contextWindowTokens, maxCompletionTokens } }`.
Updates specific parameters for a bound Cursor model.

### `cursor_remove_models`
Parameters: `{ req: { ids: string[] } }`.
Batch removes model bindings from Cursor **without affecting shared routes or other IDE platforms**.

### `cursor_set_models_enabled`
Parameters: `{ req: { ids: string[], enabled: boolean } }`.
Batch enables or disables Cursor models.

## UI State Recommendations

- `running=false && configuredModels=0`: Prompt "Add models first".
- `running=false && configuredModels>0`: Primary button "Start Access".
- `running=true`: Primary button "Restart Cursor", secondary buttons "Sync Models", "Stop Access".
- Always derive button state from `availableActions` rather than guessing backend state.

## Security Boundaries

- Never display or log `LOCAL_PROXY_KEY`;
- Never read or modify Cursor Access Tokens;
- Never display "Pro/Ultra Unlock" claims;
- Official models and official account requests continue to be processed directly by Cursor official services;
- Local model IDs originate exclusively from AnyBridge proxy model routes.
