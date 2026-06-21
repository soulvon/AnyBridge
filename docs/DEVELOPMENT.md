# Development

## Requirements

- Node.js 20+
- Rust stable
- Tauri v2 CLI through `@tauri-apps/cli`
- Platform-specific Tauri native dependencies

On Linux, install WebKitGTK, GTK, AppIndicator, OpenSSL, and related build packages before running Tauri.

## Install

```bash
npm install
cd sidecar
npm install
cd ..
```

## Run

Run the desktop app:

```bash
npm run tauri:dev
```

Run only the sidecar:

```bash
npm run start
```

Run UI checks:

```bash
npm run check:ui
```

## Build Sidecar

```bash
python scripts/build/build_sidecar_plain.py
```

The output goes to `src-tauri/binaries/`, which is ignored by Git.

## Local Archive

Historical docs, one-off scripts, private probes, old screenshots, and legacy assets are kept in `.local-archive/`. That directory is intentionally ignored and must not be committed.
