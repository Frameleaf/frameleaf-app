# OPS-14 · Email notifications

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:15 |
| Audience | Administrators who want Frameleaf to send welcome and shared-album emails through their own mail server |
| Features demonstrated | Settings → Notifications → Email delivery (Enable email notifications, Host, Port, Username, SMTP password as a stored credential, SMTPS, Ignore certificate errors, From address, Reply-to address), Send test email and save, Email Templates (Welcome email template, Invite Album Template, Update Album Template, variables, Preview), Send a welcome email when creating an account, per-person Notifications toggles (Receive email notifications, Album invitations, Album updates), Gmail app password |
| Source docs | docs/docs/administration/email-notification.mdx, docs/docs/guides/smtp-gmail.md, docs/docs/administration/system-settings.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home; Settings → Notifications with the Email delivery section open and Enable email notifications off at the start; a fictional mail server `mail.example.test`, port 587, username `photos@example.test`, From address `Frameleaf Photos <photos@example.test>`; the SMTP password row reading "Not set" until beat 7 and "Stored" after; a reachable test mail server (for example a local mail catcher) so the test email succeeds and the toast names taylor@example.test; the Email Templates group with the Welcome email template filled with a short custom greeting; Settings → Users → Create account dialog with the "Send a welcome email" checkbox; Jamie signed in on a second browser for the personal Notifications section; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Email notifications · Running Frameleaf". SCREEN: Settings open on the Notifications area, section list showing Email delivery and Notifications; cursor idle. | LOWER-THIRD | "Frameleaf can email people when they get an account, when they are invited to a shared album, and when new photos land in one. It sends through a mail server you choose." |
| 3 | 0:18–0:32 | CARD "What you need": bullet 1 "Mail server host and port"; bullet 2 "A username and password"; bullet 3 "An address you may send from". A small CALLOUT slides in under the card: "Gmail: 2-Step Verification + app password". | CARD; CALLOUT "Gmail: use an app password" | "You need the mail server host and port, a username and password, and an address you are allowed to send from. For Gmail, turn on 2-Step Verification and create an app password." |
| 4 | 0:32–0:41 | SCREEN: Email delivery, group "Email". HIGHLIGHT the toggle "Enable email notifications"; CURSOR turns it on and the fields below become active. CURSOR types `mail.example.test` into Host, `587` into Port and `photos@example.test` into Username. | CALLOUT "Settings → Notifications → Email delivery" | "Open Settings, then Notifications, then Email delivery. Turn on Enable email notifications, then fill in Host, Port and Username." |
| 5 | 0:41–0:54 | ZOOM on From address; CURSOR types `Frameleaf Photos <photos@example.test>`. Pull back to show Reply-to address (empty), the SMTPS toggle and Ignore certificate errors (off). HIGHLIGHT SMTPS without clicking. | CALLOUT "From address"; CALLOUT "SMTPS = SMTP over TLS" | "From address is the sender people see, and Reply-to address is optional. Turn on SMTPS if your mail server uses SMTP over TLS, and leave Ignore certificate errors off." |
| 6 | 0:54–1:07 | CARD "The password follows the server": bullet 1 "Saving a new host or username clears it"; bullet 2 "Save the server first". Then SCREEN: CURSOR turns Enable email notifications off (the fields dim but keep their values) and clicks Save changes in the save bar. | CARD; CALLOUT "Save changes" | "The password is a stored credential, and saving a different host or username clears it. So save the server first: switch email off for a moment and choose Save changes." |
| 7 | 1:07–1:19 | ZOOM on the credential row "SMTP password — Not set". CURSOR clicks Replace credential; a dialog with one field "New value" opens (value blurred); CURSOR clicks Save credential. The row now reads "Stored" with the note "Values are hidden after saving." | CALLOUT "Replace credential"; CALLOUT "Stored" | "Now, under SMTP password, choose Replace credential, paste the password once, and save it. The row reads Stored, and the value is never shown again." |
| 8 | 1:19–1:32 | SCREEN: CURSOR turns Enable email notifications back on, then clicks "Send test email and save". Toast: "A test email has been sent to taylor@example.test. Please check your inbox." ZOOM on the note under the button: "A successful test also saves your email settings. Your other pending changes stay in your draft." | CALLOUT "Send test email and save" | "Turn email back on and choose Send test email and save. The test goes to your own address, and a successful test saves the email settings and nothing else." |
| 9 | 1:32–1:46 | SCREEN scrolls to the group "Email Templates". ZOOM on the three fields Welcome email template, Invite Album Template and Update Album Template; CALLOUT on the variables line under Welcome email template ("{username}, {password}, {displayName}, {baseUrl}"). CURSOR clicks Preview; the rendered welcome email opens in a preview dialog. | CALLOUT "Email Templates"; CALLOUT "Preview" | "Below, Email Templates lets you replace the wording with your own HTML. Each template lists the variables it accepts, and Preview shows the result. An empty template uses the default email." |
| 10 | 1:46–1:58 | SCREEN: Settings → Users, section People with server access; CURSOR clicks Create account. In the dialog, HIGHLIGHT the ticked checkbox "Send a welcome email". Cut to Settings → Server & updates → Server identity & network with a CALLOUT on External domain. | CALLOUT "Send a welcome email"; CALLOUT "External domain" | "Once email works, Create account under Users offers Send a welcome email. Links in emails use the External domain from Server & updates, when you set one." |
| 11 | 1:58–2:12 | SCREEN: second browser, Jamie signed in. Settings → Notifications → Notifications section with three toggles: Receive email notifications (on), Album invitations (on), Album updates (on). CURSOR turns Album updates off; then turns Receive email notifications off and the other two dim. | CALLOUT "Each person chooses" | "Everyone controls their own email in the same area, under Notifications: Receive email notifications, Album invitations and Album updates. Turning the first one off turns off the other two." |
| 12 | 2:12–2:15 | LOGO OUTRO | Next: OPS-15 · Server & updates: upgrading Frameleaf | "Next up: Server & updates: upgrading Frameleaf." |

## Voice-over (clean)

Frameleaf can email people when they get an account, when they are invited to a shared album, and when new photos land in one. It sends through a mail server you choose.

[pause]

You need the mail server host and port, a username and password, and an address you are allowed to send from. For Gmail, turn on 2-Step Verification and create an app password.

[beat]

Open Settings, then Notifications, then Email delivery. Turn on Enable email notifications, then fill in Host, Port and Username.

From address is the sender people see, and Reply-to address is optional. Turn on SMTPS if your mail server uses SMTP over TLS, and leave Ignore certificate errors off.

[pause]

The password is a stored credential, and saving a different host or username clears it. So save the server first: switch email off for a moment and choose Save changes.

Now, under SMTP password, choose Replace credential, paste the password once, and save it. The row reads Stored, and the value is never shown again.

[beat]

Turn email back on and choose Send test email and save. The test goes to your own address, and a successful test saves the email settings and nothing else.

[pause]

Below, Email Templates lets you replace the wording with your own HTML. Each template lists the variables it accepts, and Preview shows the result. An empty template uses the default email.

Once email works, Create account under Users offers Send a welcome email. Links in emails use the External domain from Server & updates, when you set one.

Everyone controls their own email in the same area, under Notifications: Receive email notifications, Album invitations and Album updates. Turning the first one off turns off the other two.

[pause]

Next up: Server & updates: upgrading Frameleaf.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The doc still says "Administration → Settings → Notification settings"; the current build is Settings → Notifications, with the server section "Email delivery" (group titles "Email" and "Email Templates") and each person's own section "Notifications". The VO uses the build labels.
- Exact labels from the build: "Enable email notifications", "Host", "Port", "Username", "SMTP password", "SMTPS" (subtitle "Use SMTPS (SMTP over TLS)"), "Ignore certificate errors", "From address", "Reply-to address", "Send test email and save", "Welcome email template", "Invite Album Template", "Update Album Template", "Preview", "Send a welcome email", "Receive email notifications", "Album invitations", "Album updates". The Host description in the build reads "Host of the email server (e.g. smtp.immich.app)"; keep beat 4's zoom off that line or crop it, so no other product name is in shot.
- Credential order (system-settings.md "Server credentials"): the SMTP password is write-only, and saving a different host or username clears it. The documented sequence is: save the new server with email off, Replace credential, then turn email on again. Beats 6–8 follow that order. The fields are disabled while the toggle is off, but the typed values stay in the draft, which is what the save in beat 6 stores.
- Send test email (system-settings.md, `NotificationSettings.svelte`): the browser never sends the password; the server uses the stored one as long as host, port, username and security match the saved values. A successful test saves only the email settings; other pending changes stay in the draft.
- Replace credential verifies the mail server when email is on; with email off (beat 7) it only stores the value. The capture needs a reachable fictional mail server; never show a real mailbox or real app password. Blur the value in beat 7.
- Gmail (smtp-gmail.md): 2-Step Verification is required, then an app password is created and used as the SMTP password. The guide's screenshots carry the host and port; the VO does not read them. A Microsoft 365 guide also exists (docs/docs/guides/smtp-microsoft365.md) but is not shown.
- Emails sent (email-notification.mdx): new account (welcome), invitation to a shared album, new items in a shared album. "Send a welcome email" appears in the Create account dialog only while email is enabled, and is ticked by default (`AccountFormDialog.svelte`).
- External domain (system-settings.md "Server Settings"): it overrides the address used in shared links and email notifications. It is set in Settings → Server & updates → Server identity & network; OPS-18 covers it.
- Per-person toggles: turning off "Receive email notifications" also disables album invitations and update emails (subtitle "Turning this off also disables album invitations and update emails.").
