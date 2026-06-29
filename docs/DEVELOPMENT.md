# Development

## Requirements

- Node.js 20+
- Rust stable
- Tauri v2 CLI through `@tauri-apps/cli`
- Platform-specific Tauri native dependencies

Linux needs WebKitGTK 4.1, GTK 3, AppIndicator, OpenSSL, librsvg, patchelf, pkg-config, libnm, and xdg-utils before running Tauri.

macOS needs Xcode Command Line Tools. Certificate installation uses the login keychain first and requests administrator authorization only for the System keychain path.

Windows certificate installation uses CurrentUser\Root first and requests UAC only for the LocalMachine\Root path.

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

Build for an explicit target when preparing cross-platform release assets:

```bash
python scripts/build/build_sidecar_plain.py --platform x86_64-pc-windows-msvc
python scripts/build/build_sidecar_plain.py --platform aarch64-apple-darwin
python scripts/build/build_sidecar_plain.py --platform x86_64-unknown-linux-gnu
```

## Local Archive

Historical docs, one-off scripts, private probes, old screenshots, and legacy assets are kept in `.local-archive/`. That directory is intentionally ignored and must not be committed.
