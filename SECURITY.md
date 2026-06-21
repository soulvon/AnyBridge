# Security Policy

## Supported Versions

The project is starting a new open-source release line at `0.1.0`. Security fixes target the latest released version unless otherwise stated.

## Reporting A Vulnerability

Do not open a public issue for vulnerabilities, leaked credentials, captured traffic, or exploitable proxy behavior.

Please contact the maintainer privately through the GitHub repository owner profile or a private advisory if available. Include:

- Affected version or commit.
- Reproduction steps.
- Impact and required local permissions.
- Logs or traces with secrets removed.

## Sensitive Data Rules

Never commit:

- API keys or bearer tokens.
- Session tokens or account identifiers.
- Local MITM certificates or private keys.
- `tauri-sign.key` or code signing material.
- Captured request/response bodies.
- Files from `.local-archive/`.
