# Frameleaf Connect for Zapier

This is an independently written, MIT-licensed **connection foundation**, not the completed Zapier integration. It contains no actions, searches, files or event triggers. Hosted qualification must pass before those features are added or this package is used in production. No Library code or generated SDK is imported.

## Connection setup

The native OAuth 2.0 connection uses Zapier PKCE (`enablePkce: true`) and Zapier's credential storage. The only user inputs are `serverUrl` and `frameleafClientId`. The latter maps to the protocol's `client_id`; it is a non-secret public client ID, not a token. No client secret or shared API key is used.

1. In the private Zapier application's authentication settings, obtain its exact OAuth callback. Do not copy a callback from another app or treat a shared platform callback as verification.
2. A Frameleaf administrator registers that exact callback in **Connect setup**, using the Zapier preset where available, and gives the user its public client ID. Dynamic registration remains subject to administrator policy and is not attempted by this adapter.
3. Enter the canonical public HTTPS server origin, for example `https://photos.example.org`, without a path, trailing slash, user information, query or fragment. Enter the client ID and complete browser consent. Zapier manages state and the S256 PKCE challenge; the exchange submits the platform-provided verifier.
4. Choose the exact owned readable albums in Frameleaf. This qualification profile requests only `library:read`. Whole-library reading requires an explicit choice. No originals, people, events or writes are requested.

Zapier's hosted service must reach the Library over public HTTPS. Customer-provided HTTPS does not require a Frameleaf Cloud plan. Frameleaf relay requires an eligible plan; Zapier subscriptions and task limits are separate. Direct LAN-only operation is unsupported. These files reject plain HTTP, IP literals and local-only hostnames; actual public DNS reachability and TLS remain part of qualification.

The returned native credential includes a pinned Connect resource and client ID. Later capability requests and refreshes refuse a changed origin, resource or client before sending stored credentials. Requests use exact fixed endpoint paths, a 10-second deadline, a 64 KiB response bound and no redirects. Both rotated tokens and their metadata are returned together; malformed, incomplete, broadened or unchanged refresh results are refused. The adapter never retries a token request or keeps a second token store. Native access-token expiry delegates to Zapier's refresh mechanism.

## Rotation qualification is a release gate

Local tests do **not** prove Zapier coordinates concurrent refreshes across Zaps. The open-source core raises a native `RefreshAuthError` for 401 responses. Its public tester runs the requested refresh method independently; platform orchestration and durable credential persistence are outside that npm runtime.

Before expanding this adapter, qualify the actual hosted private application against an owner-authorized public HTTPS synthetic provider or test Library:

- Complete browser OAuth with the application's real callback and native PKCE; confirm code, verifier, resource, selected scope and consent binding.
- Run simultaneous Zaps sharing one expiring connection. Verify safe serialization/coalescing, one rotation, full replacement-set persistence and another successful rotation afterward.
- Exercise a lost refresh response and failed persistence. Confirm the platform does not replay a consumed token. Do not add a reuse grace period or API-key fallback.
- Check an in-flight 401 during reconnection cannot send the replacement connection's token to the prior Library.
- Inspect native logs for token redaction, validate strict TLS and redirect refusal, and test access revocation. The integration must stay blocked if the platform cannot preserve Frameleaf's refresh reuse protection.

No authorized public endpoint or live hosted evidence accompanies these sources. Zapier's local `invoke auth start` in CLI 19.3.0 is not an alternative qualification path: its implementation prompts for a shared client secret and does not generate the required PKCE parameters or preserve the custom connection fields through that flow. Do not work around it by inventing a secret or disabling PKCE.

Zapier's OAuth schema has no adapter disconnect/revocation callback. Removing a Zapier connection is not claimed to revoke the Library grant. Users can revoke it in **Frameleaf Connected Apps**. Future actions and trigger help must keep that control clear.

## Translations

Frameleaf connection text and help are supplied in English plus `fr`, `es`, `de`, `it`, `pt`, `nl`, `pl`, `sv`, `da` and `nb_NO`. Zapier descriptor labels are static strings; these files do not claim native per-user locale selection. English is the default entry point. To prepare a private application copy with another supplied language, generate its entry point:

```sh
node render.cjs fr > /path/to/private-copy/index.js
```

The private copy must contain this package's source and locked dependencies. The renderer accepts only a supplied locale, and its output contains no credentials. Translated setup help is in `../help/zapier/`.

## Local checks

Use Node.js 22, matching Zapier's documented runtime:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run validate
```

Tests use the public `zapier-platform-core` tester and handler with synthetic, network-isolated responses. They cover request binding, token exchange and rotation result shapes, resource/client changes, redirect refusal, response bounds, uncertain failures, native 401 signaling, native token-log redaction and all eleven language catalogues. Concurrent local invocations deliberately document the absence of hosted coordination evidence; they do not assert a Zapier Cloud failure.

CLI validation currently has no errors and three general warnings: two auth-field help-link recommendations (public setup documentation is not yet published), and manual domain validation review. Origin validation is implemented and tested; the warnings remain visible rather than being suppressed. A structurally valid package is not production or marketplace approval.

The future bounded event triggers will return at most the newest 1,000 matching events across ten pages; they will not be lossless bulk synchronization. Those triggers, stable Source IDs, deferred files, full scopes, review materials and production support ownership remain unimplemented here.

## Platform references

- [OAuth and reserved authentication inputs](https://docs.zapier.com/integrations/build/oauth)
- [Platform CLI, PKCE and Node.js runtime](https://docs.zapier.com/integrations/build-cli/overview)
- [Public core and CLI implementation](https://github.com/zapier/zapier-platform)
- [OAuth schema](https://github.com/zapier/zapier-platform/blob/main/packages/schema/docs/build/schema.md)
