# Connect Frameleaf to n8n

Use a regular, single-process self-hosted n8n installation. Queue mode, multiple workers and n8n Cloud are unsupported. The n8n node interface is in English.

1. Install the Frameleaf community node and add a Frameleaf OAuth2 API credential.
2. Copy the exact OAuth Redirect URL. Ask your Library administrator to register it as a public PKCE client with a trusted HTTPS callback.
3. Enter your Library URL and the administrator-provided client ID. Choose the smallest permission profile you need, then connect.
4. Select readable albums and writable destinations separately. Reconnect after changing the Library address or permissions.

Direct LAN or customer HTTPS access needs no Frameleaf Cloud plan. Relay access needs an eligible plan. Keep certificate validation and n8n network protection enabled; allowlist only your Library when needed.

For album creation and uploads, map a stable Source ID from the source event. Uploads also need a stable Source Date. Keep the same ID, date, filename, content and destination when retrying. Wait for the displayed Retry-After delay after rate limits. Files use n8n binary fields; downloads have a configurable size limit.

Triggers for new photos, album additions and Studio exports are coming in a later release. Until then, start workflows from another trigger, such as a schedule or a webhook.

Revoke the connection in Frameleaf and delete the n8n credential to disconnect. Copies already saved elsewhere remain there. Contact support@frameleaf.app with the operation and HTTP status, without credentials, private filenames or media.
