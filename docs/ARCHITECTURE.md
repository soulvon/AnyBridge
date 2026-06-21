# Architecture

AnyBridge has three main parts:

- Tauri desktop shell in `src-tauri/`
- Static frontend in `ui/`
- Node.js sidecar proxy in `sidecar/`

```text
AI coding tool
  -> local proxy or generated config
  -> AnyBridge sidecar
  -> configured provider API

AnyBridge desktop
  -> platform detection
  -> provider configuration
  -> certificate management
  -> sidecar lifecycle
  -> logs and metrics
```

## Desktop

The Tauri app owns native integration:

- Reading and writing app configuration.
- Detecting supported target tools.
- Managing local certificate files for proxy mode.
- Starting and stopping the sidecar process.
- Exposing commands to the frontend.

## Frontend

The UI is a static app under `ui/`. JavaScript is split by responsibility and loaded in a fixed order. Use:

```bash
npm run check:ui
```

before committing UI changes.

## Sidecar

The sidecar is a Node.js process that handles local proxy traffic, provider routing, model mapping, logging, and request/response conversion.

The sidecar can run by itself during development:

```bash
npm run start
```

Release builds package it as a platform-specific external binary for Tauri.

## Local Data

Runtime configuration is stored in the user's app data directory, not in the repository. Keep tokens, provider keys, certificates, and captured traffic out of Git.
