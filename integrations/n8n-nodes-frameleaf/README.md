# n8n-nodes-frameleaf

Connect selected Frameleaf albums to your self-hosted n8n workflows. Browse media, download renditions, create albums, add assets, apply tags, and upload new files into Photos or Boards.

Polling triggers for ready assets, album additions and completed Studio exports are coming in a later release. They are held until n8n fixes how polling triggers save their progress across restarts.

## Supported installation

Use **n8n 2.47.5 or later in regular, single-process self-hosted mode**. Version 2.47.5 is the qualified minimum. Queue mode, multiple n8n processes sharing credentials, and n8n Cloud are unsupported: their native refresh coordination can reuse a rotating refresh token after a lock timeout. Frameleaf retains refresh-token reuse protection. Do not share this credential across multiple n8n processes.

An **administrator-provisioned client ID** is required. Native n8n dynamic registration currently requests all advertised scopes instead of the selected profile. This package does not offer that registration path.

Direct access on your LAN or through customer-provided HTTPS does not require a Frameleaf Cloud plan. Frameleaf relay requires the existing eligible plan. Your n8n server must reach the Library; your browser must reach both applications during consent. Configure trusted HTTPS for n8n's OAuth callback. A LAN HTTP callback is not accepted.

Keep n8n network protection enabled. For a private Library, an administrator can permit its specific host or range through n8n's [SSRF allowlisting](https://docs.n8n.io/hosting/securing/ssrf-protection/). Keep certificate validation enabled and install your certificate authority where necessary.

## Connect

1. Install the package using n8n's community-node installation procedure. For an unpublished test build, run `npm pack` after building and install the archive into n8n's user nodes directory using its manual community-package procedure. Load it as a package; the custom-extension directory loader does not preserve credential-to-node restrictions.
2. Add a **Frameleaf OAuth2 API** credential. Copy its exact **OAuth Redirect URL**.
3. Ask your Library administrator to register that callback as a public PKCE client for the Connect resource. Enter the resulting non-secret client ID and the Library's canonical origin, such as `https://photos.example.com`.
4. Choose the smallest permission profile needed by the workflow. Connect and select readable albums and writable destinations separately. Whole-library access requires an explicit choice.
5. Reconnect after changing permissions or the Library address. The credential refuses to send an old token to a different Library.

Tokens stay in n8n's encrypted credential store. Workflow exports contain credential references, not tokens. Revoke a connection in Frameleaf's connected-application settings and delete the n8n credential when disconnecting. Previously downloaded or uploaded copies remain where they were saved.

| Profile                  | Use                                                                       |
| ------------------------ | ------------------------------------------------------------------------- |
| Read Media               | Browse albums, search, retrieve metadata and processed renditions         |
| Read Media and Originals | Also download original files when the Library's transfer policy allows it |
| Organize Media           | Read, create/add to albums and apply tags                                 |
| Upload Photos            | Upload only to consented Photos destinations                              |
| Upload to Boards         | Upload only to consented Boards destinations                              |
| Automate Photos          | Read, organize and upload to Photos                                       |
| Automate Boards          | Read, organize and upload to Boards                                       |

Creation also needs permission to create destinations in the chosen workspace. Tags require an asset that is both readable and within a writable destination. The Library rechecks consent and current visibility for every operation; shared, hidden, Locked, and trashed content is not exposed through the grant.

## Retry-safe writes and binary media

For **Create Album** and **Upload Media**, map **Source ID** from a stable source event or item identity, such as the ID your upstream service gives each item. The adapter combines it with the saved workflow and node identities. Never use an execution ID, timestamp generated at execution time, or random UUID. Saving a workflow is required before these actions run.

For uploads, also map a stable **Source Date**, such as the source item's creation time, and keep the filename, content, workspace, and album unchanged on retries. The same operation resumes its durable offset or returns its prior receipt. A changed payload with the same Source ID returns 409. To intentionally save another result, use a new source identity. Receipts remain available for at least 30 days; do not assume retries beyond that window remain deduplicated.

File input/output uses n8n binary fields. Connect respects the Library's effective quota, supported types and append limits. Upload chunks are at most 8 MiB. Downloads have a configurable decoded-response limit (32 MiB by default); originals additionally need explicit download consent. The current upload implementation reads the input binary into memory for checksum calculation, so size your single-process installation for your files. **Inspect Upload** checks a known upload ID; **Cancel Upload** removes unpublished staging and preserves completed publications. Execution cancellation stops requests and leaves resumable staging available until expiry.

Network errors after an acknowledged append or commit are reconciled against upload state. Rate limits and temporary service failures return sanitized errors; when `Retry-After` is present, wait at least the displayed delay before retrying with the same source values. Further requests to the same Library are suppressed within the current n8n process until that delay expires, including generic node retries and concurrent workflows. This temporary backoff state resets when n8n restarts. Do not configure an immediate retry loop.

## Examples

Import the synthetic workflow from [`examples`](examples). Select your credentials and replace the synthetic destination ID before running it:

- `save-generated-artwork.json`: provide a synthetic binary file and save it to Boards.

No example contains credentials, tokens, private media, or a live connection.

## Development and qualification

```sh
npm ci
npm run build
npm test
npm run lint
npm run test:platform
npm pack --dry-run
```

The platform test uses the pinned official n8n 2.47.5 image, a disposable database and a strict synthetic OAuth server. It checks native PKCE callbacks, default and changed scope profiles, same-process refresh coordination, native HTTP transfers, and binary response bounds. Its internal HTTP fixture does not qualify a real Library consent screen or a production HTTPS callback. Full Library LAN/customer-HTTPS/relay testing and marketplace review remain separate release requirements. The optional `--probe-queue` mode of `test/platform/refresh.mjs` reproduces the unsupported native cross-process lock-timeout failure; it is expected to fail against the pinned release.

This adapter is independently implemented under MIT and has no external runtime dependencies. It imports neither the Library SDK nor AGPL Library code. n8n provides the host API. n8n requires its community-node interface and package documentation to be in English; translated Frameleaf setup help lives separately in [`../help/n8n`](../help/n8n). Published package availability and verified n8n Cloud availability are not implied by a successful build.

Support: [support@frameleaf.app](mailto:support@frameleaf.app). Describe the failing operation and sanitized HTTP status; do not send tokens, signed URLs, private filenames, or media. The node sends requests only to your configured Library and adds no telemetry. Your n8n installation controls workflow execution history and binary-data retention.
