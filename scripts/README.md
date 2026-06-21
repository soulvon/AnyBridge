# Scripts

This directory keeps only reusable project automation that is safe to publish.

## Build

- `build/build_sidecar_plain.py` builds the sidecar binary for the current or selected platform.
- `build/build_protected_sidecar.py` builds a protected sidecar variant for release validation.

## Release

- `release/extract_changelog_section.cjs` extracts release notes for a version.
- `release/build_merged_latest_json.cjs` builds the Tauri updater `latest.json` from release assets.

## Validation

- `check-ui.mjs` validates frontend file order and JavaScript syntax.

One-off probes, captured payload tools, temporary diagnostics, and private research scripts are archived under `.local-archive/` and are not part of the public project.
