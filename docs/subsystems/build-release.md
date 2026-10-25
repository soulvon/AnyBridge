# Build and release

This page covers source-to-binary ownership and local release validation.

## Binary ownership

| Binary | Built from | Built by | Consumed by |
| --- | --- | --- | --- |
| `anybridge-proxy-<triple>` | Node sidecar | `scripts/build/build_sidecar_plain.py` | Tauri `externalBin` |
| `anybridge-cursor-core-<triple>` | Rust cursor-core | `scripts/build/build_cursor_core.py` | Tauri `externalBin` |

Both live in `src-tauri/binaries/`, which is ignored by Git. A stale binary is
not a source-code regression but is still a release defect.

## Commands

| Command | Meaning |
| --- | --- |
| `npm run build:sidecar` | Build the current sidecar binary for this machine. |
| `npm run verify` | The hermetic validation used by pre-push and CI. |
| `npm run tauri:build:local` | Build the sidecar first, then let Tauri build UI/cursor-core and package locally. |
| `npm run verify:release` | Run `npm run verify`, then build the local package. |

`npm run tauri:build:local` intentionally rebuilds the sidecar first so a local
package cannot silently contain a stale `anybridge-proxy`.

## Release rules

- Signed releases are tag-driven; follow `docs/RELEASE_zh.md` for versions,
  `CHANGELOG.md`, tag creation and release assets.
- `verify:release` proves the current source builds and the local package
  builds. It does not replace platform-specific installation smoke tests.
- Never treat an old binary timestamp or a successful CI run on a different
  commit as proof that this package contains this source.

## Verification

- `npm run verify`
- `npm run verify:release` before a local release build
- CI release workflow additionally builds all target triples.
