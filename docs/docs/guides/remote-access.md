# Remote access

Choose how people reach the photo application away from home. Use a trusted HTTPS address or a private encrypted network, and test sign-in, large uploads, original downloads and video playback from outside your LAN.

## Private network

A VPN or private mesh network can make the server reachable only to enrolled devices. Install and configure the network software on the server and each client, then use an address reachable through it. Follow that product's current documentation for authentication, routing and device access.

Private networking reduces public exposure; it does not remove the need for application updates, strong account credentials and backups.

## Public HTTPS address

A [reverse proxy](/administration/reverse-proxy) can terminate HTTPS for your domain and forward requests to Frameleaf's application port. Configure a valid certificate, WebSocket support, request-size limits and timeouts suitable for large videos. Use a dedicated hostname; Frameleaf must be served at its root path.

Forward the application through your chosen HTTPS endpoint. Do not expose its plain HTTP port directly to the Internet. Keep PostgreSQL, machine-learning workers and Manager's administration port on trusted networks.

A hosted tunnel or proxy may impose request-size, timeout or bandwidth limits. Check those limits before depending on it for large originals. Authentication layers outside Frameleaf must also work with the clients you use.

## Frameleaf account connection

When your installation has the optional account and remote-access connection configured, use the controls in **Settings** to link the server and review availability. Publishing port `2443` alone does not configure that connection or create a trusted certificate. See the [deployment variables](/install/environment-variables#optional-account-and-remote-access-connection).

## Verify access

1. Open the exact external address in a browser and check the certificate.
2. Sign in with a normal user account.
3. Upload a small photo and a representative large video, then download an original.
4. Test playback, shared links and any app you plan to use.
5. If a request fails, compare the application and proxy logs without posting credentials or private media URLs.

Set the application's **Public server URL** to the address recipients should use for email and share links. Keep a local administration route available for recovery.
