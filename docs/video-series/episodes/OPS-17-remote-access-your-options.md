# OPS-17 · Remote access: your options

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | Administrators deciding how family members and their phones reach a home Frameleaf server from outside the home network |
| Features demonstrated | Never forward port 2283, Option 1 VPN (WireGuard, OpenVPN) with pros and cons, Option 2 Tailscale with pros and cons, Option 3 reverse proxy with HTTPS and Let's Encrypt with pros and cons, Frameleaf mobile app without a VPN app, Frameleaf Cloud remote access as the coming option (linked server, Sign in with Frameleaf only), choosing an option |
| Source docs | docs/docs/guides/remote-access.md, docs/docs/administration/frameleaf-cloud.md |
| Capture checklist | Mostly DIAGRAM and CARD work on the dark canvas. One SCREEN: the Frameleaf mobile app in a phone frame on its timeline (Summer in the Rockies), used in beats 2 and 9. Server node label "frameleaf.home"; example domain `photos.example.test`. No router, VPN or Tailscale product screens are needed; no Frameleaf Cloud pages are shown. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:19 | LOWER-THIRD "Remote access: your options · Running Frameleaf". DIAGRAM: a house outline containing node "frameleaf.home" (green); a phone frame showing the Frameleaf mobile app sits outside the house, with a blue "Internet" cloud between them and no line yet. | LOWER-THIRD | "At home, Frameleaf sits on your own network. Away from home, your phone and browser need a safe way back in. There are three proven options, and a fourth is coming from Frameleaf Cloud." |
| 3 | 0:19–0:36 | DIAGRAM: a line from the Internet cloud straight through the router to "frameleaf.home" labelled "port 2283 · http"; the line turns red and is struck through. CARD "Never forward port 2283". | Never forward port 2283 | "First, what not to do. Never forward port 2283 on your router to the internet. That serves the web app over plain HTTP, open to anyone who can sit between you and your server." |
| 4 | 0:36–0:52 | DIAGRAM "Option 1 · VPN": the phone connects through a green encrypted tunnel to the router, which opens one small VPN port, then to "frameleaf.home". Labels fade in: "WireGuard", "OpenVPN". | Option 1 · VPN | "Option one is a VPN into your home network, such as WireGuard or OpenVPN. It is simple and very secure: even if Frameleaf had a flaw, only the VPN faces the internet." |
| 5 | 0:52–1:05 | CARD "VPN: the costs": bullet 1 "One port opened on your router"; bullet 2 "Dynamic DNS without a static address"; bullet 3 "The VPN app on every device". | CARD | "The costs: you open one port for the VPN, you need dynamic DNS if you have no static address, and the VPN app runs on every device." |
| 6 | 1:05–1:19 | DIAGRAM "Option 2 · Tailscale": phone and "frameleaf.home" each get a small client badge; a green peer-to-peer tunnel links them across two firewall icons; the router shows no open port. | Option 2 · Tailscale | "Option two is Tailscale. It builds the same kind of encrypted tunnel directly between your devices, even behind firewalls, without opening any port. Setup on each end is minimal." |
| 7 | 1:19–1:34 | CARD "Tailscale: the trade-offs": bullet 1 "Client usually runs with full system rights"; bullet 2 "Paid service, free tier for personal use"; bullet 3 "Installed on both ends". | CARD | "The trade-offs: its client usually runs with full system rights, it is a paid service with a free tier for personal use, and it must run on both ends." |
| 8 | 1:34–1:51 | DIAGRAM "Option 3 · Reverse proxy": the Internet cloud (blue) connects over "HTTPS" to a node "Reverse proxy · photos.example.test" with a padlock and a small "Let's Encrypt" certificate tag, which forwards to "frameleaf.home:2283" inside the house. The phone and a laptop browser both connect with no client badge. | Option 3 · Reverse proxy | "Option three is a reverse proxy. Your own domain answers over HTTPS with a free Let's Encrypt certificate and passes requests on to Frameleaf. Browsers and the Frameleaf mobile app connect with no extra app." |
| 9 | 1:51–2:07 | CARD "Reverse proxy: the trade-offs": bullet 1 "The most complex to configure"; bullet 2 "Web app and API reachable from the internet"; bullet 3 "Access controls can shield web-only use". | CARD | "It is the most complex option, and both the web app and its API face the internet. If you only need the web app remotely, an access-control layer in front of it can shield it." |
| 10 | 2:07–2:25 | DIAGRAM: a fourth node "Frameleaf Cloud remote access" (blue, dashed outline) appears above the house with a chip "Coming". A dashed line reaches the house only through a small "Linked" tag. Beside it a mock sign-in card shows one button, "Sign in with Frameleaf". | Frameleaf Cloud remote access · coming | "The coming option is remote access through Frameleaf Cloud, for a server you choose to link. Through it, the sign-in page offers only Sign in with Frameleaf. It is optional, and your server never depends on it." |
| 11 | 2:25–2:42 | CARD "Choosing": bullet 1 "Only your own devices: VPN or Tailscale"; bullet 2 "A normal web address: reverse proxy"; bullet 3 "Either way: HTTPS, never port 2283". The phone frame of the Frameleaf mobile app returns beside the card. | Choosing | "To choose: if only your own devices need access, a VPN or Tailscale keeps Frameleaf off the internet. If you want a normal web address, use a reverse proxy. The next episode sets one up." |
| 12 | 2:42–2:45 | LOGO OUTRO | Guide: Remote Access | "The written guide is linked below." |

## Voice-over (clean)

At home, Frameleaf sits on your own network. Away from home, your phone and browser need a safe way back in. There are three proven options, and a fourth is coming from Frameleaf Cloud.

[pause]

First, what not to do. Never forward port 2283 on your router to the internet. That serves the web app over plain HTTP, open to anyone who can sit between you and your server.

[pause]

Option one is a VPN into your home network, such as WireGuard or OpenVPN. It is simple and very secure: even if Frameleaf had a flaw, only the VPN faces the internet.

The costs: you open one port for the VPN, you need dynamic DNS if you have no static address, and the VPN app runs on every device.

[beat]

Option two is Tailscale. It builds the same kind of encrypted tunnel directly between your devices, even behind firewalls, without opening any port. Setup on each end is minimal.

The trade-offs: its client usually runs with full system rights, it is a paid service with a free tier for personal use, and it must run on both ends.

[pause]

Option three is a reverse proxy. Your own domain answers over HTTPS with a free Let's Encrypt certificate and passes requests on to Frameleaf. Browsers and the Frameleaf mobile app connect with no extra app.

It is the most complex option, and both the web app and its API face the internet. If you only need the web app remotely, an access-control layer in front of it can shield it.

[pause]

The coming option is remote access through Frameleaf Cloud, for a server you choose to link. Through it, the sign-in page offers only Sign in with Frameleaf. It is optional, and your server never depends on it.

To choose: if only your own devices need access, a VPN or Tailscale keeps Frameleaf off the internet. If you want a normal web address, use a reverse proxy. The next episode sets one up.

[pause]

The written guide is linked below.

## Production notes

- Narration tone: neutral and practical; no option is sold over another. The pros and cons are those in remote-access.md.
- Port 2283 (remote-access.md danger box): forwarding it directly exposes the web interface over http and invites man-in-the-middle attacks. The VO paraphrases without the term.
- Third-party services named on screen and in VO are the ones the guide names: WireGuard, OpenVPN, Tailscale and Let's Encrypt. The guide also names a DNS provider, a remote reverse proxy service and its access product as examples; they are left out so no hosting provider is named. "An access-control layer" stands in for them.
- Tailscale facts (remote-access.md): peer-to-peer WireGuard tunnel through NAT; client usually needs to run as root; paid service with a free tier suitable for personal use. The guide links a third-party tutorial video; do not show or name it.
- Reverse proxy (remote-access.md Option 3): lets the mobile apps connect without a VPN or Tailscale app; requires a certificate (Let's Encrypt recommended); complex configuration; web interface and API may be exposed. OPS-18 is the setup episode.
- Frameleaf Cloud remote access is named only as the coming option. Documented facts used (frameleaf-cloud.md): it is part of Frameleaf Cloud's optional extras for a linked server; through remote access the sign-in page offers only Sign in with Frameleaf; local photos and features never depend on a link. The doc states that password refusal "comes with remote access itself", so it is not live yet: no Frameleaf Cloud pages, prices, plans or dates appear in this episode. CLOUD-09 (HOLD) covers it.
- The DIAGRAM in beat 10 uses a mock sign-in card, not a capture; keep it clearly schematic (no browser chrome) so it does not read as a shipped screen.
- Outro CTA on screen: `Guide: Remote Access`; producer fills the public URL.
