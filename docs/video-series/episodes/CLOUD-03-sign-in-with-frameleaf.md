# CLOUD-03 · Sign in with Frameleaf

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | How-to |
| Target length | 2:30 |
| Audience | Administrators turning on Sign in with Frameleaf, and members linking their own account |
| Features demonstrated | Access & security → Sign in with Frameleaf (chip, client ID, linked accounts), Require Frameleaf sign-in for remote access, Show "Sign in with Frameleaf" at home, Button text, personal Frameleaf account link and unlink, login page button, remote-access notice, same-network offer |
| Source docs | docs/docs/administration/frameleaf-cloud.md |
| Capture checklist | HOLD: linked server on the e2e mock network with the on-screen label "Preview". Taylor (admin): Settings → Access & security → Sign in with Frameleaf with chip "Available". Jamie (member): Settings → Your preferences → Frameleaf account, before and after linking. Login page at home with the "Sign in with Frameleaf" button and the "Opening frameleaf.cloud…" state. Login page reached through remote access with the relay notice and the same-network offer. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Sign in with Frameleaf · Frameleaf Cloud". TITLE "Sign in with Frameleaf" with subheading "One account, at home and away". | Preview · Sign in with Frameleaf · One account, at home and away | "This is a preview of Sign in with Frameleaf. Once your server is linked, people can sign in with their Frameleaf account. It works alongside passwords and your own OpenID provider, and never changes them." |
| 3 | 0:18–0:32 | SCREEN: Settings → Access & security → "Sign in with Frameleaf". CURSOR traces the path. ZOOM on the chip "Available" and the rows Provider, "This server's client ID", "Linked accounts". | Preview · Access & security → Sign in with Frameleaf · Available | "As an administrator, open Settings, then Access & security, then Sign in with Frameleaf. The chip says Available, and the page shows this server's client ID and how many accounts are linked." |
| 4 | 0:32–0:47 | ZOOM on the toggle "Require Frameleaf sign-in for remote access" marked "Always on"; CALLOUT "Always on". | Preview · Require Frameleaf sign-in for remote access · Always on | "Require Frameleaf sign-in for remote access is always on, so visitors who arrive through remote access see only the Frameleaf button. At home, people keep signing in as they do now." |
| 5 | 0:47–0:59 | HIGHLIGHT the toggle "Show 'Sign in with Frameleaf' at home"; CURSOR turns it on. ZOOM on the "Button text" field; CURSOR clicks Save. | Preview · Show "Sign in with Frameleaf" at home · Button text · Save | "Turn on Show Sign in with Frameleaf at home to add the button to the local sign-in page. Button text lets you change what it says. Save." |
| 6 | 0:59–1:13 | SCREEN: Jamie signed in. Settings → Your preferences → "Frameleaf account". HIGHLIGHT "Link Frameleaf account"; CURSOR clicks; dialog "Continue to frameleaf.cloud"; a new tab opens and returns. | Preview · Your preferences → Frameleaf account · Link Frameleaf account | "Each person links their own account. In Your preferences, open Frameleaf account and choose Link Frameleaf account. You continue to frameleaf.cloud, sign in, and come back." |
| 7 | 1:13–1:23 | ZOOM on the row "Linked to jamie@example.test since <today>" and the "Unlink" button beside it. | Preview · Linked to jamie@example.test · Unlink | "The page then says Linked to your email since today. Unlink here ends your other Frameleaf sessions." |
| 8 | 1:23–1:35 | SCREEN: the sign-in page at home with the "Sign in with Frameleaf" button under the password form. CURSOR clicks; the button reads "Opening frameleaf.cloud…"; cut to the timeline signed in as Jamie. | Preview · Sign in with Frameleaf · Opening frameleaf.cloud… | "On the sign-in page, choose Sign in with Frameleaf. The page says Opening frameleaf.cloud, and you return signed in." |
| 9 | 1:35–1:49 | SCREEN: the sign-in page reached through remote access. Only the Frameleaf button is offered. ZOOM on the notice "You're reaching this server through Frameleaf remote access… Passwords stay on the local network." | Preview · Remote access · Passwords stay on the local network | "Through remote access, the page explains that you are reaching this server through Frameleaf remote access, and that passwords stay on the local network." |
| 10 | 1:49–2:02 | CARD headline "You're on the same network as this server"; bullets: "The local address is faster and keeps your photos off the internet", "Open the local address", "Stay on remote access". | Preview · You're on the same network as this server · Stay on remote access | "If you turn out to be on the same network as this server, it offers the local address, which is faster, or Stay on remote access." |
| 11 | 2:02–2:12 | ZOOM on the sign-in page footnote "A Frameleaf account is optional here. It's needed only for remote access and Frameleaf Cloud features." | Preview · A Frameleaf account is optional here. | "At home, a Frameleaf account is optional. It is needed only for remote access and Frameleaf Cloud features." |
| 12 | 2:12–2:27 | CARD headline "Who gets an account"; bullets: "Authorised people get an account on first sign-in", "Existing accounts link only by a verified email", "Unlinking the server ends every Frameleaf session". | Preview · Who gets an account | "A person your account authorises for this server gets an account here on first sign-in. An existing account links only by a verified email address. Unlinking the server ends every Frameleaf session." |
| 13 | 2:27–2:30 | LOGO OUTRO | Next up: Plans, supporter keys and Support Frameleaf | "Next up: Plans, supporter keys and Support Frameleaf." |

## Voice-over (clean)

This is a preview of Sign in with Frameleaf. Once your server is linked, people can sign in with their Frameleaf account. It works alongside passwords and your own OpenID provider, and never changes them.

[pause]

As an administrator, open Settings, then Access & security, then Sign in with Frameleaf. The chip says Available, and the page shows this server's client ID and how many accounts are linked.

Require Frameleaf sign-in for remote access is always on, so visitors who arrive through remote access see only the Frameleaf button. At home, people keep signing in as they do now.

Turn on Show Sign in with Frameleaf at home to add the button to the local sign-in page. Button text lets you change what it says. Save.

[pause]

Each person links their own account. In Your preferences, open Frameleaf account and choose Link Frameleaf account. You continue to frameleaf.cloud, sign in, and come back.

The page then says Linked to your email since today. Unlink here ends your other Frameleaf sessions.

On the sign-in page, choose Sign in with Frameleaf. The page says Opening frameleaf.cloud, and you return signed in.

[pause]

Through remote access, the page explains that you are reaching this server through Frameleaf remote access, and that passwords stay on the local network.

If you turn out to be on the same network as this server, it offers the local address, which is faster, or Stay on remote access.

At home, a Frameleaf account is optional. It is needed only for remote access and Frameleaf Cloud features.

A person your account authorises for this server gets an account here on first sign-in. An existing account links only by a verified email address. Unlinking the server ends every Frameleaf session.

Next up: Plans, supporter keys and Support Frameleaf.

## Production notes

- Narration tone: Practical and unhurried; admin steps first, then the member's view.
- HOLD dependency: Sign in with Frameleaf needs a linked server and a live Frameleaf Cloud identity provider. Capture on the e2e mock network with the "Preview" label on every beat; the redirect to frameleaf.cloud is mocked, so cut around the external tab (beats 6 and 8 show the "Continue to frameleaf.cloud" and "Opening frameleaf.cloud…" states only).
- Prerequisites: server linked (CLOUD-02); Taylor is an administrator; Jamie is a member with a Frameleaf account whose email matches jamie@example.test. Existing accounts link only by a verified email address, so seed Jamie's cloud account with that email.
- Doc caveat: frameleaf-cloud.md says the server "does not yet refuse passwords or other sessions that arrive through remote access; that enforcement comes with remote access itself." The VO therefore says the remote page "offers only" the Frameleaf button and does not claim enforcement.
- The remote-access sign-in page (beat 9) and the same-network offer (beat 10) depend on remote access, which is itself HOLD (CLOUD-09). Capture from the design prototype if the mock network has no relay.
- If the server has its own OpenID provider configured, do not show its settings; the VO only states that they are untouched.
- The "Button text" value in beat 5 stays at its default; do not type a custom label.
- Never show the staff console. No prices in this episode.
