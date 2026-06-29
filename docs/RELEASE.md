# Release

AnyBridge uses GitHub Actions to build release assets and Tauri updater metadata.

## Versioning

For each release, keep these versions aligned:

- `package.json`
- `package-lock.json`
- `sidecar/package.json`
- `sidecar/package-lock.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md`

The open-source line starts at `0.1.0`.

## Legacy Updater Migration

Existing `1.x` builds cannot update directly to `0.1.0` through the default
Tauri updater comparison. `0.1.0` is lower than `1.2.18`, so old clients will
consider it a downgrade and report no update.

Use a bridge release when migrating installed users from the historical line:

1. Build and publish a temporary bridge version higher than the last legacy
   release, for example `1.2.19`.
2. The bridge build must include the explicit version-line reset comparator in
   `src-tauri/src/commands/update.rs`. It allows only `1.x -> 0.1.0`; it does
   not enable arbitrary downgrades.
3. Publish `v1.2.19` as the latest updater release first. Existing `1.2.18`
   clients will see this as a normal update.
4. After bridge adoption is verified, publish `v0.1.0` as the latest updater
   release. Bridge clients will then detect the explicit reset target and
   install it through the normal updater UI.
5. Verify the full path on Windows before public rollout:
   `1.2.18 -> 1.2.19 -> 0.1.0`.

If Windows installer downgrade behavior blocks the final `1.2.19 -> 0.1.0`
step on a real machine, keep `v1.2.19` as the updater latest release and direct
users to the `v0.1.0` installer manually. Do not publish mixed or misleading
`latest.json` metadata.

## Local Build

Build the sidecar:

```bash
python scripts/build/build_sidecar_plain.py
```

Build a sidecar for a specific release target:

```bash
python scripts/build/build_sidecar_plain.py --platform x86_64-pc-windows-msvc
python scripts/build/build_sidecar_plain.py --platform aarch64-apple-darwin
python scripts/build/build_sidecar_plain.py --platform x86_64-apple-darwin
python scripts/build/build_sidecar_plain.py --platform x86_64-unknown-linux-gnu
```

Build a local package without updater artifacts:

```bash
npm run tauri:build:local
```

## Signed Release Build

The release workflow needs these repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `RELEASE_REPO_TOKEN` if assets are mirrored to a separate release repository

The private key file `tauri-sign.key` must never be committed.

## Release Flow

1. Update versions and `CHANGELOG.md`.
2. Commit the release changes.
3. Create and push a tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. Verify the GitHub Actions run.
5. Verify every expected platform asset and `latest.json`.

## Release Repository

By default, updater metadata points at:

```text
https://github.com/soulvon/AnyBridge-Release/releases/latest/download/latest.json
```

If releases should live in the source repository instead, update:

- `.github/workflows/release.yml`
- `src-tauri/tauri.conf.json`
- `scripts/release/build_merged_latest_json.cjs` arguments
