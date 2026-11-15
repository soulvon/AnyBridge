# Privacy Policy

Last updated: 2026-11-15

AnyBridge is a desktop application that helps you connect AI coding tools to API providers you configure yourself. It is distributed under the MIT license. This policy describes what the application stores on your device and which network requests it makes. In this document, "the author" refers to the maintainer of the AnyBridge repository.

## No account and no telemetry

- AnyBridge has no account system. It does not ask for your name, email address, or phone number.
- The application does not include analytics, crash-reporting, or advertising SDKs, and the author does not operate a server that collects usage or diagnostic data from users.
- AnyBridge does not display advertisements and does not contact any advertising service.
- The author operates a documentation website. Visiting it is optional and separate from using the application.

## Information stored on your device

**API credentials.** Provider base URLs and API keys are stored in a local JSON file as plain text, without encryption and without operating-system keychain or credential-store integration:

- Windows: `%APPDATA%\anybridge\providers.json`
- macOS: `~/Library/Application Support/anybridge/providers.json`
- Linux: `~/.config/anybridge/providers.json`

The application masks these values in on-screen previews and in error messages. Keys are transmitted only to the provider you configured, as part of the requests you initiate. Anyone with access to your user account or a backup of this file can read these keys.

**Local logs and statistics.** These files stay on your device unless you choose to share them:

- Aggregated request and token statistics are kept for 365 days by default.
- Daily usage records contain a fixed set of metadata fields and no message bodies; they are kept for 90 days by default.
- Detailed proxy, MITM, and RPC audit logs are written only when you explicitly enable the corresponding option or environment variable. They are kept for 7 days. When MITM logging is enabled, bodies are truncated and authorization values are reduced to a short prefix and suffix.
- A local database records metadata about model calls. Full request and response bodies are stored only when detailed logging is enabled, which is off by default.

**Local certificate.** To route traffic through the local gateway, the application may install a locally generated certificate authority on your device. Its private key remains on your device.

## Where your requests go

AnyBridge is a configuration and routing tool, not an AI provider. When you use an AI coding tool through the local gateway (listening on `127.0.0.1`), chat requests and their surrounding code context are converted and forwarded to the provider you configured yourself. Examples include self-hosted gateways, API relays, and model providers such as DeepSeek, OpenAI, Anthropic, Google, Moonshot, and OpenRouter. Non-chat traffic such as completions, indexing, sign-in, and a provider's own telemetry is passed through to that provider's official endpoints unchanged.

In direct-configuration mode, AnyBridge writes the base URL and key into the configuration file of the tool you selected, and the tool then connects to the provider directly. In that mode AnyBridge is not in the middle of the connection.

Because these destinations are chosen by you, the content you send and the provider's handling of it are governed by that provider's own terms and privacy policy.

## Network requests made by the application itself

Beyond the AI requests described above, the application may contact the following services:

- **Update checks.** By default the application checks GitHub Releases for a newer version once per hour. Automatic installation is off by default, and you can disable automatic checking in settings.
- **Extensions.** If you choose to install an extension, the application downloads third-party executable packages from GitHub.
- **Localization data.** Chinese-language dictionaries may be fetched from third-party repositories on `raw.githubusercontent.com`.
- **Sign-in.** OAuth flows for certain integrations are handled by Google, OpenAI, or xAI. Resulting tokens are stored in the application's plugin data area.
- **Web search.** The client-side web search retrieves results from DuckDuckGo, and favicons for those results may be loaded through Google's icon service. The built-in search enhancement also uses multiple sources, including Google, Bing, Brave, DuckDuckGo, StackOverflow, npm, PyPI, arXiv, and Crossref, depending on the features you enable.
- **Version and quota lookups.** Detecting tool versions may query `registry.npmjs.org`. Checking a provider's balance may query the official balance endpoints of DeepSeek, SiliconFlow, OpenRouter, or Moonshot, or the usage endpoints of relays you configured, such as New API and sub2api.
- **Image inputs.** When a feature processes images, the image and its accompanying text are sent to the model provider selected for that feature.

These requests are made to provide the features you use. The author does not receive the contents of your prompts, code, or model responses through them.

## Children

AnyBridge is not intended for children under 13, and the author does not knowingly collect personal information from them.

## Changes to this policy

This policy may be updated as the application changes. The current version is published in the AnyBridge repository, and the "Last updated" date above reflects the most recent revision.

## Contact

Questions about this policy can be raised through the Issues page of the AnyBridge repository: https://github.com/soulvon/AnyBridge/issues
