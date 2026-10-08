# OPS-18 · Reverse proxy setup

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators putting Frameleaf behind their own HTTPS domain with Caddy, nginx or another reverse proxy |
| Features demonstrated | Root of a (sub)domain only, forwarded headers (Host, X-Real-IP, X-Forwarded-Proto, X-Forwarded-For), Caddy example, nginx example (upload size, request buffering, headers, HTTP 1.1, WebSockets, timeouts), Traefik responding timeouts, well-known path for Let's Encrypt http-01, External domain in Server identity & network, IMMICH_TRUSTED_PROXIES, testing with the Frameleaf mobile app |
| Source docs | docs/docs/administration/reverse-proxy.md, docs/docs/administration/system-settings.md, docs/docs/install/environment-variables.md, docs/docs/FAQ.mdx |
| Capture checklist | Example domain `photos.example.test` pointing at a proxy host `192.168.1.10`; Frameleaf on `frameleaf.home:2283`; a text editor or TERMINAL with the Caddyfile and nginx site file from the guide, substituted with these names; Taylor signed in as administrator; Settings → Server & updates → Server identity & network with External domain empty at the start; Settings → Server & updates → Versions & compatibility captured once with WebSockets blocked so Installed build channel reads "Unknown"; the login page at https://photos.example.test; a phone frame of the Frameleaf mobile app on its server address screen; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Reverse proxy setup · Running Frameleaf". DIAGRAM: browser (blue) → "https://photos.example.test" → node "Reverse proxy" → node "frameleaf.home:2283" (green). | LOWER-THIRD | "A reverse proxy gives Frameleaf a proper HTTPS address and passes every request on to port 2283. This episode covers what any proxy needs, with Caddy and nginx as examples." |
| 3 | 0:18–0:38 | CARD "Every proxy must": bullet 1 "Serve Frameleaf at the root of a domain or subdomain"; bullet 2 "Forward all headers: Host, X-Real-IP, X-Forwarded-Proto, X-Forwarded-For"; bullet 3 "Allow large uploads and WebSockets". A small strike-through example under bullet 1: `photos.example.test/frameleaf`. | CARD | "Three rules apply everywhere. Serve Frameleaf at the root of a domain or subdomain, never under a sub-path. Forward every header, including the four forwarding headers. And allow large uploads and WebSockets. The guide has worked examples for Caddy, nginx, Apache and Traefik." |
| 4 | 0:38–0:50 | TERMINAL titled "Caddyfile": `photos.example.test {` / `    reverse_proxy http://frameleaf.home:2283` / `}` typed line by line. CALLOUT "HTTPS configured automatically". | TERMINAL; CALLOUT "HTTPS configured automatically" | "Caddy is the shortest route. Three lines name your domain and the Frameleaf server, and Caddy configures HTTPS for you automatically." |
| 5 | 0:50–1:02 | TERMINAL titled "nginx site": `server_name photos.example.test;` then `client_max_body_size 50000M;`, `proxy_request_buffering off;`, `client_body_buffer_size 1024k;`. HIGHLIGHT the three upload lines. | TERMINAL; CALLOUT "Uploads" | "In nginx, you spell it out. First, uploads: raise the maximum body size so large videos fit, and turn off request buffering so uploads stream straight through." |
| 6 | 1:02–1:12 | TERMINAL continues: `proxy_set_header Host $host;`, `proxy_set_header X-Real-IP $remote_addr;`, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, `proxy_set_header X-Forwarded-Proto $scheme;`. | TERMINAL; CALLOUT "Headers" | "Next, the headers: pass on the host, the visitor's real address, the forwarding chain and the original scheme." |
| 7 | 1:12–1:26 | TERMINAL continues: `proxy_http_version 1.1;`, the three `600s` timeout lines, then `location / {` with `proxy_pass http://frameleaf.home:2283;`, `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`. HIGHLIGHT the Upgrade and Connection lines. | TERMINAL; CALLOUT "WebSockets"; CALLOUT "Timeouts" | "Then WebSockets: use HTTP 1.1 and pass the Upgrade and Connection headers, which carry Frameleaf's live updates. Set generous timeouts too; the example uses ten minutes." |
| 8 | 1:26–1:44 | SPLIT. Left: CARD "Uploads stop after a minute" with "Raise the proxy timeouts (Traefik defaults to 60 s)". Right: SCREEN Settings → Server & updates → Versions & compatibility with ZOOM on "Installed build channel: Unknown"; CALLOUT "WebSockets blocked". | CALLOUT "Traefik: raise respondingTimeouts"; CALLOUT "Unknown = WebSockets blocked" | "Two symptoms to know. If long uploads stop after a minute, your proxy's timeout is too short; Traefik's default is sixty seconds. If the installed build channel reads Unknown, WebSockets are not getting through." |
| 9 | 1:44–1:56 | TERMINAL: `location = /.well-known/immich {` / `    proxy_pass http://frameleaf.home:2283;` / `}`. CALLOUT "Let's Encrypt http-01". | TERMINAL; CALLOUT "Keep the well-known path on Frameleaf" | "If your certificate uses the Let's Encrypt HTTP challenge, make sure the server's well-known address still reaches Frameleaf, or the mobile app may fail to connect." |
| 10 | 1:56–2:16 | SCREEN: Settings → Server & updates → Server identity & network. HIGHLIGHT External domain; CURSOR types `https://photos.example.test`; CALLOUT "No trailing slash". CURSOR clicks Save changes. | CALLOUT "Settings → Server & updates → Server identity & network"; CALLOUT "External domain" | "Now tell Frameleaf its public address. Open Settings, then Server & updates, then Server identity & network, and enter External domain without a trailing slash. Shared links and emails use it, so they point at your public address rather than your home network." |
| 11 | 2:16–2:27 | TERMINAL: .env gains `IMMICH_TRUSTED_PROXIES=192.168.1.10`, then `docker compose up -d` recreates frameleaf_server. | TERMINAL; CALLOUT "Proxy on another machine" | "If the proxy runs on another machine, add its address to the trusted proxies variable in your .env file, then recreate the containers." |
| 12 | 2:27–2:42 | SPLIT: left, a browser outside the home network opens https://photos.example.test and shows the Frameleaf login page; right, a phone frame of the Frameleaf mobile app with `https://photos.example.test` in the server address field, then the timeline. | CALLOUT "Test from outside your network" | "Test from outside your network: open the address in a browser, then enter the same address in the Frameleaf mobile app. Keep port 2283 itself closed to the internet." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: OPS-19 · Scaling across machines | "Next up: Scaling across machines." |

## Voice-over (clean)

A reverse proxy gives Frameleaf a proper HTTPS address and passes every request on to port 2283. This episode covers what any proxy needs, with Caddy and nginx as examples.

[pause]

Three rules apply everywhere. Serve Frameleaf at the root of a domain or subdomain, never under a sub-path. Forward every header, including the four forwarding headers. And allow large uploads and WebSockets. The guide has worked examples for Caddy, nginx, Apache and Traefik.

Caddy is the shortest route. Three lines name your domain and the Frameleaf server, and Caddy configures HTTPS for you automatically.

[beat]

In nginx, you spell it out. First, uploads: raise the maximum body size so large videos fit, and turn off request buffering so uploads stream straight through.

Next, the headers: pass on the host, the visitor's real address, the forwarding chain and the original scheme.

[beat]

Then WebSockets: use HTTP 1.1 and pass the Upgrade and Connection headers, which carry Frameleaf's live updates. Set generous timeouts too; the example uses ten minutes.

Two symptoms to know. If long uploads stop after a minute, your proxy's timeout is too short; Traefik's default is sixty seconds. If the installed build channel reads Unknown, WebSockets are not getting through.

[pause]

If your certificate uses the Let's Encrypt HTTP challenge, make sure the server's well-known address still reaches Frameleaf, or the mobile app may fail to connect.

Now tell Frameleaf its public address. Open Settings, then Server & updates, then Server identity & network, and enter External domain without a trailing slash. Shared links and emails use it, so they point at your public address rather than your home network.

[beat]

If the proxy runs on another machine, add its address to the trusted proxies variable in your .env file, then recreate the containers.

Test from outside your network: open the address in a browser, then enter the same address in the Frameleaf mobile app. Keep port 2283 itself closed to the internet.

[pause]

Next up: Scaling across machines.

## Production notes

- All configuration lines are from reverse-proxy.md, with `<public_url>` and `<backend_url>` replaced by the example names. The guide also has Apache and Traefik examples; they are not typed on screen. The Traefik note (60 s default `respondingTimeouts`, uploads failing after one minute with error 499, raise to 600 s) is summarised in beat 8.
- Sub-path serving is not supported (reverse-proxy.md caution). Header names are shown on screen; the VO paraphrases them.
- The well-known path contains another product's name (`/.well-known/immich`); it appears only in the TERMINAL and is described, not read aloud. It matters only for the Let's Encrypt http-01 challenge (reverse-proxy.md info box).
- WebSocket symptom: the FAQ still describes "Server Status Offline | Version Unknown", which is the previous interface. In the current build the version reaches the web app over the WebSocket, so Versions & compatibility → Installed build channel reads "Unknown" when WebSockets are blocked (verified in `NewVersionCheckSettings.svelte`, `release-channel.ts`, `websocket.ts`). Capture beat 8 with a proxy that omits the Upgrade and Connection headers.
- External domain (system-settings.md "Server Settings"): overrides the domain in shared links and email notifications; no trailing slash. Build path: Settings → Server & updates → Server identity & network (label "External domain").
- IMMICH_TRUSTED_PROXIES (environment-variables.md): comma-separated IPs set as trusted proxies, api worker. Environment changes need a container recreate (OPS-16). `192.168.1.10` is a fictional LAN address.
- The "keep port 2283 closed" line restates remote-access.md; only the proxy's HTTPS listener should face the internet.
