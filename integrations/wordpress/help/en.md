# Import Frameleaf images

1. Install and activate the Frameleaf Connect ZIP in WordPress.
2. As an administrator, open **Media → Frameleaf** and add your Library HTTPS origin. Allow private networking only for your own Library. If automatic registration is disabled, register the exact callback shown in Frameleaf Connect and enter its client ID.
3. Each editor chooses **Connect Frameleaf** and grants access to selected albums. A trusted HTTPS WordPress callback is required.
4. Open the media selector in Gutenberg or the Classic Editor and choose **Frameleaf**. Browse an album or search, acknowledge the local copy, then import an image. Edit caption and alt text using WordPress's attachment controls.

Imported JPEG, PNG and WebP images become ordinary WordPress attachments with the site's normal visibility. They remain after disconnecting or revoking Frameleaf access. There is no background synchronization or deletion. Repeated imports download the current rendition to compare its SHA-256: identical content reuses the attachment; changed content creates a new copy.

The WordPress server must reach and trust the Library. Direct local or customer-provided HTTPS access needs no Frameleaf Cloud plan; Frameleaf relay requires its existing plan. Files must fit WordPress's upload limit and the plugin's 16 MiB / 40-megapixel limit.

If disconnected or offline, check the Library address and certificate, then reconnect. When refresh is uncertain, reconnect instead of retrying a possibly used token. Disconnect retries revocation and preserves encrypted credentials until successful. After WordPress keys or salts change, revoke WordPress access in Frameleaf, confirm that revocation here, and choose **Reset after a WordPress key change**.

A failed sideload removes temporary data. An interrupted publication with an uncertain receipt blocks automatic duplicate creation. Ask the site administrator to inspect the local attachment and the pending `frameleaf_imports` record before recovery. Never blindly clear pending records. Support: support@frameleaf.app.

Frameleaf requires PHP cURL with HTTPS support and a direct network route to the Library. HTTP proxies are not used for Library requests.
