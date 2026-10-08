# CLOUD-10 · Your Frameleaf account site

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | How-to |
| Target length | 2:45 |
| Audience | Frameleaf account holders who manage their servers, plan, keys, credit and backups from the web |
| Features demonstrated | account.frameleaf.cloud sign-in (passkey, email code), Overview, Servers (server cards, Link a server, Sharing with Invite someone and roles, Unlink with what stops), Subscription & billing (Current plan, switch monthly and annual, Payment method, Invoices and receipts), Licenses (keys by last four, activations, license files for offline servers), AI Wallet (balance, held, spent today, Top up, Limits and auto top-up, Ledger, Monthly statements), Cloud processing (Jobs history, Consent), Cloud backup (bucket per server, key mode, Recent runs), Security (passkeys, optional password, authenticator app, sessions), Privacy & data (data region, export, delete with 30-day grace) |
| Source docs | /Users/adamtaylor/Github/frameleaf-cloud/design/prototype/README.md |
| Capture checklist | HOLD: capture from the account-site prototype (frameleaf-cloud/design/prototype, `pnpm dev`) with the on-screen label "Preview" on every beat. Signed in as Taylor with the sample data renamed as in the production notes. Screens: #/signin; #/overview; #/servers; #/servers/link; frameleaf.home → Sharing with an invitation to emma@example.test; old-server → Unlink (not confirmed); #/billing; #/licenses; #/wallet scrolled to Ledger and Monthly statements; #/processing/jobs and the Consent tab; #/backup; #/security; #/privacy with the Subprocessors panel out of frame. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "Your Frameleaf account site · Frameleaf Cloud". SCREEN (account-site prototype): "Sign in to Frameleaf Cloud" with "Sign in with a passkey" and, below, Email with "Email me a sign-in code". CURSOR clicks "Sign in with a passkey". | Preview · account.frameleaf.cloud · Sign in with a passkey | "This is a preview of your Frameleaf account site, at account.frameleaf.cloud. Sign in with a passkey, or with a code sent to your email." |
| 3 | 0:15–0:29 | SCREEN: Overview, "Good afternoon, Taylor" with the lede "Everything your Frameleaf servers use from the cloud. Your servers keep working without any of it." ZOOM across the tiles Servers, Subscription, AI credit balance and Cloud backup, then the Notices panel. | Preview · Overview | "Overview shows your servers, your subscription, your AI credit balance and backup health, with notices that need a decision. Your servers keep working without any of it." |
| 4 | 0:29–0:42 | SCREEN: Servers: the cards "frameleaf.home" and "old-server" with Last contact, Region and Remote access, and the buttons Manage and Share. CURSOR clicks "Link a server": "Enter the code from your server" with the field "Link code". | Preview · Servers · Link a server | "Servers lists each linked server with its last contact, region and remote access. Link a server is where you enter the code your server shows." |
| 5 | 0:42–0:55 | SCREEN: frameleaf.home → Sharing. "Invite someone": CURSOR types emma@example.test, picks Role "Editor" and clicks "Send invitation"; the row appears under "Pending invitations". ZOOM on "People with access" and "Role changes take effect at their next sign-in; removal signs them out immediately." | Preview · Invite someone · Viewer · Editor · Admin | "Share invites someone by email as a viewer, editor or admin. They accept with a verified Frameleaf account, and removing someone signs them out immediately." |
| 6 | 0:55–1:06 | SCREEN: old-server → Unlink: the list "What stops when you unlink" and the notice "Your photos stay put" ("Unlinking never deletes anything on the server…"). HIGHLIGHT "Unlink old-server" without clicking; CALLOUT on "You'll confirm with your passkey and type the server name." | Preview · Unlink · Your photos stay put | "Unlink lists what stops. Unlinking never deletes anything on the server, and you confirm with your passkey and the server's name." |
| 7 | 1:06–1:20 | SCREEN: Billing → Subscription & billing. ZOOM on "Current plan" with its "Switch to annual (…)" button, then "Payment method" and "Invoices and receipts"; CALLOUT on the Cloud processing panel "Not part of the subscription. Paid from your prepaid AI Wallet." | Preview · Subscription & billing | "Subscription & billing holds your plan, where you can switch between monthly and annual, plus your payment method and invoices. Cloud processing is never part of the subscription." |
| 8 | 1:20–1:32 | SCREEN: Licenses: supporter keys shown by their last four characters, each key's activations with "Deactivate", "Download license file", and the "Subscription certificate" table. | Preview · Licenses | "Licenses lists your supporter keys by their last four characters, where each one is active, and license files for servers without internet access." |
| 9 | 1:32–1:47 | SCREEN: AI Wallet: AI credit balance, Held and Spent today; HIGHLIGHT "Top up"; ZOOM on "Limits and auto top-up" ("Changes need your passkey."); scroll to "Ledger" and "Monthly statements". Amounts blurred. | Preview · AI Wallet · Ledger · Monthly statements | "AI Wallet shows your balance, what is held and what you spent today. Top up, set your limits and auto top-up, and read every movement in the ledger and monthly statements." |
| 10 | 1:47–1:59 | SCREEN: Cloud services → Cloud processing, tab Jobs: rows with Workload and model, Estimate, Cost and Status, and the server filter "All servers" (amounts blurred). CURSOR switches to the tab Consent: "What you've agreed to". | Preview · Cloud processing · Jobs · Consent | "Cloud processing keeps the job history from all your servers, each estimate next to its cost. Consent shows what you agreed to." |
| 11 | 1:59–2:11 | SCREEN: Cloud backup, lede "One encrypted bucket per server. Your server holds the key; Frameleaf Cloud can see file names and sizes to meter usage, never the contents." ZOOM on the frameleaf.home panel: Key mode, Key check, Verification and "Recent runs" (bucket name blurred). | Preview · Cloud backup · names and sizes, never contents | "Cloud backup shows each server's bucket, its key mode and its recent runs. Frameleaf Cloud sees file names and sizes, never the contents." |
| 12 | 2:11–2:20 | SCREEN: Settings → Security: Passkeys with "Add passkey", Password ("Optional…"), Authenticator app, Active sessions. | Preview · Security | "Security manages your passkeys, an optional password and authenticator app, and your active sessions." |
| 13 | 2:20–2:32 | SCREEN: Privacy & data: Data region, "Export your data", "Delete your account" ("30-day grace period, then everything in Frameleaf Cloud is purged…") and Consents. | Preview · Privacy & data | "Privacy & data shows your data region, exports your account data, and deletes your account after a thirty-day grace period." |
| 14 | 2:32–2:42 | SCREEN: back on Overview, dimmed. TITLE "Everything here is optional" with subheading "Your photos never depend on it". | Preview · Everything here is optional | "Everything here is optional. Your photos and every local feature never depend on this account." |
| 15 | 2:42–2:45 | LOGO OUTRO | Guide: Frameleaf Cloud | "The written guide is linked below." |

## Voice-over (clean)

This is a preview of your Frameleaf account site, at account.frameleaf.cloud. Sign in with a passkey, or with a code sent to your email.

Overview shows your servers, your subscription, your AI credit balance and backup health, with notices that need a decision. Your servers keep working without any of it.

[pause]

Servers lists each linked server with its last contact, region and remote access. Link a server is where you enter the code your server shows.

Share invites someone by email as a viewer, editor or admin. They accept with a verified Frameleaf account, and removing someone signs them out immediately.

Unlink lists what stops. Unlinking never deletes anything on the server, and you confirm with your passkey and the server's name.

[pause]

Subscription & billing holds your plan, where you can switch between monthly and annual, plus your payment method and invoices. Cloud processing is never part of the subscription.

Licenses lists your supporter keys by their last four characters, where each one is active, and license files for servers without internet access.

AI Wallet shows your balance, what is held and what you spent today. Top up, set your limits and auto top-up, and read every movement in the ledger and monthly statements.

Cloud processing keeps the job history from all your servers, each estimate next to its cost. Consent shows what you agreed to.

Cloud backup shows each server's bucket, its key mode and its recent runs. Frameleaf Cloud sees file names and sizes, never the contents.

[pause]

Security manages your passkeys, an optional password and authenticator app, and your active sessions.

Privacy & data shows your data region, exports your account data, and deletes your account after a thirty-day grace period.

Everything here is optional. Your photos and every local feature never depend on this account.

The written guide is linked below.

## Production notes

- Narration tone: A calm guided tour; one page per sentence or two. Read "account.frameleaf.cloud" as "account dot frameleaf dot cloud".
- HOLD dependency: the account site is not live. Capture every beat from the account-site prototype (`frameleaf-cloud/design/prototype`, `pnpm dev`, http://127.0.0.1:5188), which is UI only with simulated data, and carry the on-screen label "Preview" on every beat. Publish only after the account site ships.
- The staff console never appears. The sign-in page has a "Staff console" link: keep it out of frame and never open `#/staff`. Do not open "Models and rates" either; it lists GPU models.
- Provider names stay out of frame: Privacy & data's "Subprocessors" panel names the hosting and payment providers, and its "Hosted in" row names data-centre cities; crop both. Subscription & billing's header button and payment-method note name the payment processor; keep them out of the ZOOM and never click through. Blur GPU class text in job rows. The VO names no GPU, storage, hosting or payment provider.
- Sample data: the prototype's customer is "Taylor Morgan" (taylor@morgan-family.test) with the servers "Home archive", "Cottage NAS" and "Old Mac mini". For the series, edit the local capture copy of `src/cloud-data.mjs` (not committed): rename Home archive to frameleaf.home and Old Mac mini to old-server, set the email to taylor@example.test, and invite emma@example.test. Region stays North America, as in CLOUD-02.
- Doc discrepancy: Subscription & billing's lede ("Frameleaf Cloud covers remote access and cloud backup"), the Current plan's "Included" list (1 TB encrypted cloud backup, relay limits, 3 servers) and the Cloud backup page's "included in … plan" description conflict with frameleaf-cloud.md, where a plan adds remote access and cloud backup is priced separately by what you store. Keep those lines out of the ZOOM; the VO names neither. The prototype's plan prices carry the note "Prototype price"; no price is spoken or zoomed in this episode.
- The prototype writes "Licenses" and "license file"; the app writes "Licence". The VO follows each screen.
- Not spoken: the 12-month credit expiry (ai-wallet.md: still to be verified before launch), the 14-day invitation expiry, the relay allowance and the servers-included count (placeholders).
- The 30-day grace for deleting the account is in the prototype README route map (#/privacy) and on the page.
- This is the last episode in the series; the outro points to the written guide.
