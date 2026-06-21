# Contributing

Thanks for considering a contribution to AnyBridge.

## Ground Rules

- Keep changes scoped and explain the user-facing behavior.
- Do not commit secrets, tokens, local certificates, captured traffic, logs, or files from `.local-archive/`.
- Prefer clear errors over silent fallbacks.
- Preserve local configuration and target tool settings unless the change explicitly handles migration.
- Include focused tests or verification steps for behavior changes.

## Development Setup

```bash
npm install
cd sidecar
npm install
cd ..
npm run check:ui
```

Run the desktop app:

```bash
npm run tauri:dev
```

Run the sidecar only:

```bash
npm run start
```

## Pull Requests

Before opening a pull request:

- Rebase or merge the latest target branch.
- Run `npm run check:ui`.
- Run relevant sidecar or Tauri checks for the files you changed.
- Update `README.md`, `docs/`, or `CHANGELOG.md` when behavior changes.
- Link related issues and describe manual verification.

Security issues should be reported through [SECURITY.md](SECURITY.md), not public pull requests.
