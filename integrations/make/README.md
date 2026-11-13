# Frameleaf Connect for Make

Connection source for a private Make custom app. Platform qualification is required before this connection can be used or any media modules can be added. This directory does not contain a complete Make integration.

The independently written connection uses the Frameleaf Connect wire protocol and is licensed under MIT. It imports no Library code or SDK. No runtime dependencies or custom IML JavaScript functions are needed.

## Connection components

Create an **OAuth 2.0** connection in the private app. Remove generated API-key sample authentication and leave the app Base as `{}` during connection qualification. Copy each file into the corresponding editor tab:

| Tab | Source |
| --- | --- |
| Communication | `connection/communication.json` |
| Parameters | `connection/parameters.json` |
| Default scope | `connection/scope.json` |
| Common data | Empty object `{}`; no shared secret |

The callback is exactly `https://www.make.com/oauth/cb/app`, paired with `oauth.makeRedirectUri`. A Frameleaf administrator registers this callback on each server and supplies its public client ID. The connection does not register clients automatically. The server URL is an immutable canonical HTTPS DNS origin, without a path, query, fragment, user information or trailing slash. Make must be able to reach it; a private LAN address alone is insufficient.

The fixed `library:read` scope is for connection qualification only. Users select owned readable albums in Frameleaf consent. No write, download, event, legacy API or API-key access is requested. Each later operation must receive a separately reviewed minimum scope profile; changing this foundation into a broad default grant is not acceptable.

The JSON uses only documented Make component fields. The `response.data` mapping hands both replacement tokens to Make's native connection store. It does **not** establish that rotation is atomic across scenarios. Ambiguous token or refresh failures must stop for reconnection or revocation; this source adds no retry of a possibly consumed token. The `invalidate` block requests revocation, but its lifecycle on deletion and failure must be verified. Revocation in Frameleaf Connected Apps remains the reliable user control.

Make's documented PKCE example uses `uuid`. The candidate here concatenates three evaluations to fit the RFC 7636 43–128 character range with adequate entropy **if** they are independent cryptographically random UUIDv4 values. Neither that independence nor the cryptographic randomness is established by these files. Qualification must prove native expression evaluation and obtain authoritative entropy evidence before accepting this implementation.

## Translated connection text

`locales.json` supplies English, French, Spanish, German, Italian, Portuguese, Dutch, Polish, Swedish, Danish and Norwegian Bokmål text. Make's documented connection `label` and `help` fields are strings. This source does not invent a runtime localization extension or claim automatic language selection in Make.

Choose a language while configuring the private app and render its native JSON:

```sh
node integrations/make/render.mjs fr parameters
node integrations/make/render.mjs fr communication
node integrations/make/render.mjs fr scope
node integrations/make/render.mjs fr help
```

The first three outputs belong in the matching connection tabs. The last is translated setup help for Frameleaf-controlled documentation. The renderer accepts only the eleven supplied locale identifiers and four named components; it never reads user-supplied filenames.

## Local validation

```sh
node --test integrations/make/test/connection.test.mjs
```

These tests check the connection contract, origin validation, scope boundary, token mappings, sanitized log paths and translated export shapes. They do not run Make's IML engine or prove a native OAuth exchange. Do not infer OAuth, concurrent refresh, deletion or end-to-end acceptance from them.

Native qualification requires an owner-authorized publicly reachable strict synthetic OAuth provider or test Library, followed by an actual Make round trip, simultaneous scenarios sharing one expiring connection, another rotation after the concurrent runs, failure/revocation checks, redirect handling and sanitized-log inspection. Plans, native evidence, synthetic credentials and test media stay outside this repository. No publication or deployment is part of these sources.

## Platform references

- [Make custom-app OAuth 2.0](https://developers.make.com/custom-apps-documentation/app-components/connections/oauth2): callback variables, PKCE, native persistence and revocation directive.
- [Make text parameters](https://developers.make.com/custom-apps-documentation/block-elements/parameters/text): supported input validation.
- [Make response validation](https://developers.make.com/custom-apps-documentation/component-blocks/api/handling-responses/valid): response conditions.
- [Make log sanitization](https://developers.make.com/custom-apps-documentation/app-components/base/sanitization): sensitive request and response fields.
- [Make custom IML functions](https://developers.make.com/custom-apps-documentation/app-components/iml-functions): custom JavaScript is unavailable by default and requires vendor enablement.
- [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636): verifier length, entropy and S256.
