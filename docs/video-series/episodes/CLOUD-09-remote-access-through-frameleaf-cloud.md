# CLOUD-09 · Remote access through Frameleaf Cloud

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | Learn |
| Target length | 2:45 |
| Audience | Operators who want their library reachable away from home without opening ports, and anyone deciding between Frameleaf Cloud and running their own remote access |
| Features demonstrated | Blind relay model, linked server and plan as prerequisites, Allow remote access, Your public address (QR code, certificate issued to this server only), Connection (Relay only, Relay and direct), direct connection and shared public address, Use your own domain (Custom hostname, DNS records, Check DNS, Verified), Apps card Available anywhere and the Frameleaf mobile app, Require Frameleaf sign-in for remote visitors (always on), relay limits (speed, monthly allowance, slowed not cut off, originals off the relay), Test connection, turning it off |
| Source docs | /Users/adamtaylor/Github/frameleaf-cloud/docs/remote-access.md, docs/docs/administration/frameleaf-cloud.md |
| Capture checklist | HOLD: capture from the app design prototype (design/frameleaf/template) with the on-screen label "Preview" on every beat. Taylor (admin), server linked with a Frameleaf Cloud plan. Settings → Frameleaf Cloud → Remote access with remote access off, then on and connected; "Your public address"; Connection on "Relay and direct" with the Relay and Direct connection cards; the "Your internet provider shares one public address" banner; "Use your own domain" with photos.example.com pending and then verified; Account & link's apps card in both states; the "Who can connect" card; the Relay card's meter and "Allow original downloads over the relay"; "Test connection". Phone frame: the Frameleaf mobile app on the timeline away from home, and the sign-in page through remote access. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Remote access through Frameleaf Cloud · Frameleaf Cloud". TITLE "Remote access" with subheading "Your library, away from home". | Preview · Remote access · Your library, away from home | "This is a preview of remote access through Frameleaf Cloud. It lets you, and the people you share with, reach your server from anywhere, without opening ports or managing certificates." |
| 3 | 0:16–0:32 | DIAGRAM: node "frameleaf.home" (green) at home; a blue arrow from it out to node "Frameleaf relay" (blue) labelled "dials out · stays connected". Node "Phone, away from home" joins the relay. A padlock travels the whole path from phone to server; the relay node shows "can't see inside". | Preview · Your server dials out · The relay never sees inside | "Here is how it works. Your server dials out to a Frameleaf relay and keeps that connection open. Visitors reach the relay, and the relay passes their encrypted traffic straight through. It never sees inside." |
| 4 | 0:32–0:44 | SCREEN (app prototype): CURSOR traces Settings → Frameleaf Cloud → Remote access. Card "Remote access" ("The relay never sees inside your connection.") with the chip "Off"; CURSOR turns on "Allow remote access"; notice "Remote access is on."; the chip reads "On · connected". | Preview · Allow remote access · Remote access is on. | "To turn it on, you need a linked server and a Frameleaf Cloud plan. Open Settings, Frameleaf Cloud, Remote access, and switch on Allow remote access." |
| 5 | 0:44–0:56 | ZOOM on "Your public address": the address (its label blurred) with Copy, the QR code, and the facts Certificate, Renews "Automatically…" and Issued to "This server only; the private key never leaves it". | Preview · Your public address · The private key never leaves it | "Your public address appears with a QR code to scan on a phone. Its certificate renews automatically, and the private key never leaves your server." |
| 6 | 0:56–1:13 | ZOOM on "Connection": CURSOR picks "Relay and direct"; the cards "Relay" and "Direct connection" side by side; CALLOUT on "Direct connections are faster and do not count toward your relay allowance." Cut to the banner "Your internet provider shares one public address" ("…Remote access keeps working through the relay."). | Preview · Relay only · Relay and direct | "Connection offers Relay only, or Relay and direct. Direct connections go straight to your router, so they are faster and don't count toward your relay allowance. If your internet provider shares one public address, the relay keeps working." |
| 7 | 1:13–1:30 | ZOOM on "Use your own domain": CURSOR types photos.example.com in "Custom hostname"; the table of two DNS records (Type, Name, Points to) appears; CURSOR clicks "Check DNS"; the chip reads "Waiting for DNS", then "Verified" with "photos.example.com points to this server. Its certificate is issued and renewed here." | Preview · Use your own domain · Check DNS · Verified | "Use your own domain publishes your server at an address you own. Add the two DNS records it shows, then choose Check DNS. Your server gets its own certificate for it, and traffic still flows through the relay." |
| 8 | 1:30–1:44 | SCREEN: Account & link, the card "Access your library from the Frameleaf mobile apps": the chip "At home only" flips to "Available anywhere" with "Away from home the app connects directly when it can and through the Frameleaf relay otherwise." Cut to a phone frame away from home: the Frameleaf mobile app on the timeline. | Preview · Available anywhere | "On Account & link, the apps card changes from At home only to Available anywhere. Away from home, the Frameleaf mobile app connects directly when it can, and through the relay otherwise." |
| 9 | 1:44–1:59 | ZOOM on "Who can connect": "Require Frameleaf sign-in for remote visitors" marked "Always on", with its help text. Phone frame: the sign-in page reached through remote access offers only "Sign in with Frameleaf". | Preview · Require Frameleaf sign-in · Always on | "Everyone who connects from outside your home signs in with a Frameleaf account linked to their account here. That rule is always on. Public shared links still open without signing in." |
| 10 | 1:59–2:17 | ZOOM on the "Relay" card: Speed and the meter "Relay use this month"; then the toggle "Allow original downloads over the relay", off, with "Previews and streaming always work." | Preview · Relay allowance · Previews and streaming always work | "The relay has limits. Its speed is capped, and each server has a monthly allowance. Past the allowance it slows down, but it never cuts you off. Originals stay off the relay unless you allow them; previews and streaming always work." |
| 11 | 2:17–2:28 | CURSOR clicks "Test connection" ("Testing…", then "Last tested …"). CURSOR turns off "Allow remote access": notice "Remote access is off."; the apps card returns to "At home only". | Preview · Test connection · Remote access is off. | "Test connection checks the routes. Turn remote access off, and remote visitors are disconnected immediately. Your home network is unaffected." |
| 12 | 2:28–2:42 | CARD headline "Get ready"; bullets: "Link your server", "Everyone links their own Frameleaf account", "Remote access comes with a plan". | Preview · Get ready | "To get ready, link your server, and ask everyone to link their own Frameleaf account." |
| 13 | 2:42–2:45 | LOGO OUTRO | Guide: Frameleaf Cloud | "The written guide is linked below." |

## Voice-over (clean)

This is a preview of remote access through Frameleaf Cloud. It lets you, and the people you share with, reach your server from anywhere, without opening ports or managing certificates.

Here is how it works. Your server dials out to a Frameleaf relay and keeps that connection open. Visitors reach the relay, and the relay passes their encrypted traffic straight through. It never sees inside.

[pause]

To turn it on, you need a linked server and a Frameleaf Cloud plan. Open Settings, Frameleaf Cloud, Remote access, and switch on Allow remote access.

Your public address appears with a QR code to scan on a phone. Its certificate renews automatically, and the private key never leaves your server.

Connection offers Relay only, or Relay and direct. Direct connections go straight to your router, so they are faster and don't count toward your relay allowance. If your internet provider shares one public address, the relay keeps working.

Use your own domain publishes your server at an address you own. Add the two DNS records it shows, then choose Check DNS. Your server gets its own certificate for it, and traffic still flows through the relay.

[pause]

On Account & link, the apps card changes from At home only to Available anywhere. Away from home, the Frameleaf mobile app connects directly when it can, and through the relay otherwise.

Everyone who connects from outside your home signs in with a Frameleaf account linked to their account here. That rule is always on. Public shared links still open without signing in.

The relay has limits. Its speed is capped, and each server has a monthly allowance. Past the allowance it slows down, but it never cuts you off. Originals stay off the relay unless you allow them; previews and streaming always work.

Test connection checks the routes. Turn remote access off, and remote visitors are disconnected immediately. Your home network is unaffected.

[beat]

To get ready, link your server, and ask everyone to link their own Frameleaf account.

The written guide is linked below.

## Production notes

- Narration tone: Explanatory and plain; the diagram carries the idea, the screens confirm it.
- HOLD dependency: remote access is not built. The app makes no relay, DNS, certificate or hostname calls, and turning remote access on only records the wish (frameleaf-cloud `docs/app-integration-as-built.md` §11). Capture the Remote access page from the app design prototype `design/frameleaf/template` (`FrameleafCloud.jsx` RemoteAccess), and the apps card and phone shots from the prototype or the mock network, with the on-screen label "Preview" on every beat. Publish only after remote access ships.
- Plan: frameleaf-cloud.md says a Frameleaf Cloud plan adds remote access; plans and prices are CLOUD-04. The prototype shows "Remote access is part of a Frameleaf Cloud plan" when there is none; capture with a plan so the gate stays out of frame.
- Sign-in rule: frameleaf-cloud.md says the server does not yet refuse passwords or other sessions that arrive through remote access; that enforcement comes with remote access itself. remote-access.md designs it as required (every relayed request needs a Frameleaf session; public shared links stay reachable; API keys work only for people who linked an account). The VO describes that design, inside this preview. The prototype's extra toggle "Allow password sign-in over the relay" is in neither doc: keep it out of the ZOOM and do not mention it.
- Limits: the relay speed (8 Mbit/s), the monthly allowance (200 GB per server) and the 1 Mbit/s slow-down are placeholders in remote-access.md and the prototype README. They may show on the prototype screens under "Preview" but are never spoken. "Never cut off" and "originals refused over the relay unless allowed" are in remote-access.md.
- Region and provider: the Relay card's Region row in the prototype names a European data-centre city; set it to Taylor's region or crop the row. Never name the hosting provider behind the relays or any GPU or storage provider.
- The shared-public-address banner is reached through the prototype's "Preview other network conditions" switch; keep the switch out of frame and show only the banner.
- Blur the label in the public address (`r.<label>.frameleaf-direct.net`) and in the certificate name. photos.example.com is the prototype's placeholder on a reserved example domain. remote-access.md: custom hostnames are relay only, and the server orders and renews their certificates itself.
- Mobile: say "the Frameleaf mobile app" and frame the phone with no store listing. The phone shows the current mobile app on the timeline only; the apps card's line that the server "appears automatically" after sign-in is not narrated, because native Frameleaf apps are planned only.
- Left for the written guide: "Public server URL" with "Use the Frameleaf address" and "Use my domain", "I forward the port myself", router mapping, and turning remote access on or off from the Frameleaf account (needs "Turn remote access on or off" on Account & link, off by default).
- Before remote access ships, the other options in OPS-17 (Remote access: your options) still apply.
- Only the client side appears. Never show the staff console.
