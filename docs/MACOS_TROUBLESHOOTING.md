# macOS Troubleshooting

[English](MACOS_TROUBLESHOOTING.md) • [简体中文](MACOS_TROUBLESHOOTING_zh.md)

> Environment recorded for this issue: macOS 27, Devin 3.10.35.
> These versions describe the reported environment; other macOS and Devin versions have not been verified by this record.

Use this guide to diagnose AnyBridge gateway, certificate trust, and TLS issues on macOS. Trust changes affect device security settings. Collect diagnostic information first, confirm the exact certificate and operation scope, and avoid repeatedly rotating the CA.

## Identify the symptom

| Symptom                                              | Possible area                                                                                                             | First checks                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| IDE reports`TLS alert bad certificate` or alert 42 | The client rejected the certificate presented by the gateway; trust, validity, SAN, chain, or client policy may be involved | The leaf certificate and CA chain actually used by the gateway, plus system SSL evaluation                                                 |
| `no user interaction was possible`                 | macOS could not complete trust-setting authorization in the current execution context                                     | Whether this is a logged-in graphical desktop session, whether an authorization prompt is visible, and whether the device is MDM-managed |
| Certificate appears installed but TLS still fails    | Certificate presence does not prove SSL-policy trust; the IDE may not have reloaded its state                             | System SSL verification, the gateway's active certificate fingerprint, and a request after fully quitting and reopening the IDE            |
| Failure persists after reinstall or recurs           | The in-memory gateway certificate, disk package, and system trust may be inconsistent                                       | Stop the gateway and verify the certificate directory and CA/leaf fingerprints; do not rotate blindly                                      |

Some telemetry requests succeeding, a reachable gateway port, or a clean-looking health summary does not by itself prove that IDE model requests have working TLS.

## Safe recovery procedure

1. Record the macOS, AnyBridge, and IDE/CLI versions, the complete error, and a diagnostic report. Remove API keys, cookies, access tokens, and other sensitive data before sharing logs.
2. Save work, stop the gateway managed by AnyBridge, and fully quit the target IDE. Do not rotate certificates while the gateway is running, and do not repeatedly select “clean reinstall.”
3. Use the `cert_file` path in AnyBridge's environment report to identify the active certificate directory. The usual location is `~/Library/Application Support/anybridge/certs`, but legacy migration, development mode, or environment variables may change it. Do not assume the default path is the active one.
4. Inspect existing certificates first. If they are valid, prefer repairing trust instead of generating a new CA solely because of a TLS error. The public CA file is `server.codeium.com.pem`; do not import any `*-key.pem` private key or trust `mitm-leaf.pem` as a root.
5. If the error says interaction is unavailable, use Keychain Access in a locally logged-in graphical session and complete authorization according to organizational policy. Verify the certificate fingerprint and trust domain; system-wide trust affects the whole device. If MDM or organizational policy blocks authorization, stop and contact the administrator rather than bypassing policy.
6. Use the read-only commands below to inspect certificate material and system SSL policy. If command options differ on that macOS version, check `security help verify-cert`; do not substitute trust-changing commands for diagnostics.
7. Once trust is verified, start the AnyBridge gateway and IDE. New processes should reload the current certificate. Verify with a real IDE model request, including the TLS handshake, expected local route, and response; check that TLS rejection messages stop recurring.

## Read-only diagnostics

Set `CERT_DIR` to the directory confirmed in step 3. These commands only read certificates and verify them; they do not install, remove, or change Keychain trust:

```sh
CERT_DIR="$HOME/Library/Application Support/anybridge/certs"

openssl x509 -in "$CERT_DIR/server.codeium.com.pem" \
  -noout -subject -issuer -dates -fingerprint -sha256
openssl x509 -in "$CERT_DIR/mitm-leaf.pem" \
  -noout -subject -issuer -dates -fingerprint -sha256
openssl verify -CAfile "$CERT_DIR/server.codeium.com.pem" \
  "$CERT_DIR/mitm-leaf.pem"
/usr/bin/security verify-cert -c "$CERT_DIR/mitm-leaf.pem" \
  -p ssl -s server.codeium.com
```

Interpret results carefully:

- `openssl verify -CAfile` checks a chain against the explicitly supplied root. It does not establish macOS system trust or IDE trust.
- `security verify-cert` supplements macOS SSL-policy evaluation. Consult `security help verify-cert` on the target machine for chain loading and option behavior.
- The CA and leaf fingerprints differ. When comparing the running gateway with the certificate on disk, compare leaf to leaf, not CA to leaf.
- Passing any individual command does not replace a real TLS request from the target IDE.

## First use and retries

For first use, follow the AnyBridge UI to generate the complete certificate package and then perform explicit trust installation. If authorization is canceled or interaction is unavailable:

- Treat the operation as failed. “Certificate files generated” does not mean “system trust installed.”
- Preserve the original authorization error and certificate fingerprints. Confirm the gateway is stopped before deciding what to do next.
- Before retrying, make sure you are in an interactive local desktop session. Do not repeatedly request authorization from a background task, SSH session, or hidden process.
- Do not automatically remove old trust roots, disable SIP, modify the authorization database, or ask users to disable TLS verification.

## Avoid

- Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` or disable SSL verification in the IDE/client.
- Do not upload the CA private key, leaf private key, or an unredacted diagnostic directory to an issue, chat, or repository.
- Do not inject the AnyBridge CA into every process or expand its scope through global proxy/certificate environment variables.
- Do not clear Keychain or rotate the CA after a single TLS error. Adding or removing a trust root requires explicit confirmation; follow administrator/MDM policy on managed devices.

## Escalation information

Share this redacted information with maintainers or the device administrator: macOS and AnyBridge/IDE versions, the original error and time, the active certificate directory, CA and leaf SHA-256 fingerprints, exit statuses from read-only checks, and whether a real IDE request changed after stopping/restarting the gateway. Never include private keys or provider credentials.

Developer prerequisites and packaging are covered in the [Development Guide](DEVELOPMENT.md) and [Release Guide](RELEASE.md). Historical incident evidence and implementation status remain in the repository-root `修复mac环境异常方案.md`.
