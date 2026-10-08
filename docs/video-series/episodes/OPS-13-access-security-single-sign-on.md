# OPS-13 · Access & security: single sign-on

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators who already run an OpenID Connect identity provider and want people to sign in with it |
| Features demonstrated | Sign-in methods (Login with OAuth, Issuer URL, Client ID, OAuth client secret as a stored credential, Scope, verified email requirement, Storage label claim, Role Claim, Storage quota claim, Button text, Auto register, Auto launch, Mobile redirect URI override), Mobile app callbacks panel, Password Login kept on, login page button, Frameleaf mobile app sign-in |
| Source docs | docs/docs/administration/oauth.md, docs/docs/administration/system-settings.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home; Settings → Access & security → Sign-in methods with OAuth off at the start; a fictional provider "Example ID" at `https://id.example.test` with client ID `frameleaf`; the OAuth client secret row reading "Not set" before beat 7 and "Stored" after; the Mobile app callbacks panel visible with the override off; the login page after save showing the button "Sign in with Example ID"; a phone frame of the Frameleaf mobile app on its sign-in screen; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Access & security: single sign-on · Running Frameleaf". SCREEN: Settings open on the Access & security area, Sign-in methods section in view, OAuth group collapsed with Login with OAuth off; cursor idle. | LOWER-THIRD | "Frameleaf can sign people in with your own identity provider. It speaks OpenID Connect, so most providers work. Everything lives under Access & security." |
| 3 | 0:13–0:24 | CARD "Before you start": bullet 1 "Provider: OpenID Connect"; bullet 2 "Client: Confidential · Web"; bullet 3 "Grant: Authorization Code". | CARD | "Start in your provider. Create a client application: OpenID Connect, a confidential web client, and the authorization code grant." |
| 4 | 0:24–0:38 | TERMINAL panel titled "Redirect URIs" lists three lines typed one after another: `http://frameleaf.home:2283/auth/login`, `http://frameleaf.home:2283/user-settings`, `frameleaf-auth:///oauth-callback`. CALLOUT on the third line "Frameleaf mobile app". | TERMINAL; CALLOUT "Frameleaf mobile app callback" | "Register three redirect addresses. The login page and the user settings page on every address you use to reach Frameleaf, plus the Frameleaf mobile app callback." |
| 5 | 0:38–0:50 | SCREEN: Sign-in methods. HIGHLIGHT the toggle "Login with OAuth"; CURSOR clicks it; the OAuth fields expand below. | CALLOUT "Settings → Access & security → Sign-in methods" | "Now open Settings, then Access & security, then Sign-in methods. Turn on Login with OAuth and the fields appear." |
| 6 | 0:50–1:04 | ZOOM on Issuer URL and Client ID. CURSOR types `https://id.example.test` into Issuer URL, then `frameleaf` into Client ID. | CALLOUT "Issuer URL"; CALLOUT "Client ID" | "Enter the Issuer URL your provider gives you; the discovery part of the address is added for you. Then enter the Client ID." |
| 7 | 1:04–1:18 | ZOOM on the credential row "OAuth client secret — Not set". CURSOR clicks Replace credential; a dialog with one field "New value" opens (value blurred); CURSOR clicks Save credential; the row now reads "Stored". | CALLOUT "Replace credential"; CALLOUT "Stored" | "The client secret is a stored credential. Choose Replace credential, paste it once, and save. The row reads Stored, and the value is never shown again." |
| 8 | 1:18–1:33 | ZOOM on Scope showing `openid email profile`. CALLOUT beside it "email_verified must be true". | CALLOUT "Scope: openid email profile"; CALLOUT "email_verified = true" | "Keep the scope at openid, email and profile. A sign-in is matched to an account by email only when the provider says the address is verified. If yours does not send that claim, map it first." |
| 9 | 1:33–1:47 | ZOOM on the claim fields: Storage label claim `preferred_username`, Role Claim `immich_role`, Storage quota claim `immich_quota`, Default Storage Quota (GiB) empty. HIGHLIGHT each as it is named. | CALLOUT "Applied when the account is created" | "Three claims are optional. Storage label claim names the person's folder. Role Claim can make someone an administrator. Storage quota claim sets a quota. All three apply only when the account is created." |
| 10 | 1:47–2:00 | ZOOM on Button text; CURSOR types "Sign in with Example ID". HIGHLIGHT Auto register (on). HIGHLIGHT Auto launch (off). | CALLOUT "Button text"; CALLOUT "Auto register"; CALLOUT "Auto launch" | "Button text is what people see on the login page. Auto register creates accounts on first sign-in. Auto launch skips the login page; the guide shows how to reach it again." |
| 11 | 2:00–2:15 | SCREEN scrolls to the panel "Mobile app callbacks". ZOOM on the row "Frameleaf app" showing `frameleaf-auth:///oauth-callback`. HIGHLIGHT the toggle "Mobile redirect URI override" (off). | CALLOUT "Mobile app callbacks"; CALLOUT "Mobile redirect URI override" | "Mobile app callbacks lists the redirect addresses your mobile apps need; allow each one with your provider. If a custom scheme is refused, turn on Mobile redirect URI override and use this server's mobile-redirect address." |
| 12 | 2:15–2:28 | SCREEN scrolls to the group "Password Login". HIGHLIGHT the toggle "Login with email and password", which stays on. CALLOUT beside it. | CALLOUT "Keep this on until OAuth works" | "Leave Login with email and password on until single sign-on works; turning it off applies to administrators too. If you lock yourself out, the server command line turns it back on." |
| 13 | 2:28–2:42 | CURSOR clicks Save changes in the save bar. SPLIT: left, the web login page with a button "Sign in with Example ID" under the password form; right, a phone frame of the Frameleaf mobile app sign-in screen showing the same button. | CALLOUT "Sign in with Example ID" | "Save changes. The login page shows your button, and the Frameleaf mobile app signs in through the same provider. Each person can also link or unlink their account under Sign-in provider." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: OPS-14 · Email notifications | "Next up: Email notifications." |

## Voice-over (clean)

Frameleaf can sign people in with your own identity provider. It speaks OpenID Connect, so most providers work. Everything lives under Access & security. [pause]

Start in your provider. Create a client application: OpenID Connect, a confidential web client, and the authorization code grant. [beat]

Register three redirect addresses. The login page and the user settings page on every address you use to reach Frameleaf, plus the Frameleaf mobile app callback. [pause]

Now open Settings, then Access & security, then Sign-in methods. Turn on Login with OAuth and the fields appear. [beat]

Enter the Issuer URL your provider gives you; the discovery part of the address is added for you. Then enter the Client ID. [beat]

The client secret is a stored credential. Choose Replace credential, paste it once, and save. The row reads Stored, and the value is never shown again. [pause]

Keep the scope at openid, email and profile. A sign-in is matched to an account by email only when the provider says the address is verified. If yours does not send that claim, map it first. [pause]

Three claims are optional. Storage label claim names the person's folder. Role Claim can make someone an administrator. Storage quota claim sets a quota. All three apply only when the account is created. [beat]

Button text is what people see on the login page. Auto register creates accounts on first sign-in. Auto launch skips the login page; the guide shows how to reach it again. [beat]

Mobile app callbacks lists the redirect addresses your mobile apps need; allow each one with your provider. If a custom scheme is refused, turn on Mobile redirect URI override and use this server's mobile-redirect address. [pause]

Leave Login with email and password on until single sign-on works; turning it off applies to administrators too. If you lock yourself out, the server command line turns it back on. [beat]

Save changes. The login page shows your button, and the Frameleaf mobile app signs in through the same provider. Each person can also link or unlink their account under Sign-in provider. [pause]

Next up: Email notifications.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The OAuth fields live in Settings → Access & security → Sign-in methods (section key `authentication`); the doc still says "Administration → Settings → Authentication". The group titles are "OAuth" and "Password Login"; the toggles read "Login with OAuth" and "Login with email and password".
- Prerequisite: a reachable OIDC provider for the capture. Use a fictional one ("Example ID", `https://id.example.test`); never a real tenant. Blur the secret in beat 7.
- The client secret is write-only (system-settings.md "Server credentials"): the row shows "Stored" or "Not set", with "Replace credential" and "Clear". Saving a different Issuer URL clears the stored secret, so the animator should enter the issuer before the secret, as scripted.
- Verified email (oauth.md "Verified email addresses"): `email_verified` must be `true` (the text `"true"` is accepted). Providers such as Microsoft Entra ID do not send it; the VO says "map it first" and stays provider-neutral.
- Claims (Storage label claim, Role Claim, Storage quota claim) apply only on user creation and are not synchronised afterwards (oauth.md note 1). Casing follows the web strings: "Storage label claim", "Role Claim", "Storage quota claim", "Button text", "Auto register", "Auto launch", "Mobile redirect URI override".
- Redirect URIs in beat 4 follow the doc's `http://DOMAIN:PORT/auth/login` and `/user-settings` pattern plus the Frameleaf mobile app callback `frameleaf-auth:///oauth-callback`. The Mobile app callbacks panel also lists the other mobile app's callback (`app.immich:///oauth-callback`); keep the zoom in beat 11 on the "Frameleaf app" row so no other product name is in shot.
- Mobile redirect URI override: when it is on, the value must be this server's `/api/oauth/mobile-redirect` address and the provider must also allow `/api/oauth/frameleaf-mobile-redirect`; the panel shows a refusal message otherwise. The VO summarises; the written guide carries the exact addresses.
- Auto launch can be bypassed with `/auth/login?autoLaunch=0`; the VO does not read the parameter aloud.
- Password login: disabling it applies to administrators; recovery is `docker compose exec immich-server immich-admin enable-password-login` (server-commands.md). OPS-24 shows the command.
- Beat 13's "Sign-in provider" is the personal section under Access & security where a person connects or disconnects their account (user-settings.md "Your account").
- Sign in with Frameleaf (Frameleaf Cloud) is a separate section and is covered in CLOUD-03; it is not shown here.
