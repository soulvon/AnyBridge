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

## Local Build

Build the sidecar:

```powershell
python scripts/build/build_sidecar_plain.py
```

Build a local package without updater artifacts:

```powershell
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

   ```powershell
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
