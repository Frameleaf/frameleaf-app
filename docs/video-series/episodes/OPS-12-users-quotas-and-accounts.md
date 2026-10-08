# OPS-12 · Users, quotas and accounts

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators adding family members to their server and looking after their accounts |
| Features demonstrated | Users area and account table, Create account (Email, Name, Sign-in method, Initial password, Require a password change at the next sign-in, Role, Storage quota (GiB), Storage label, Send a welcome email), quota behaviour (blank, zero, Over quota, external libraries), account details (Overview, Libraries, Security, Activity, Edit account), storage label notice, Reset password, Reset PIN, Signed-in devices (Sign out), account lifecycle (Delete account, recovery period, Restore account, Removing, skip recovery), Delete delay, own-account protection |
| Source docs | docs/docs/administration/user-management.mdx |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Settings → Users with Taylor and Jamie before Emma's account exists (create it in beat 3 as `emma@example.test`, storage label `emma`, quota 250 GiB). SMTP configured so "Send a welcome email" is available (OPS-14). Emma then has a Locked folder PIN set, two signed-in devices (the Frameleaf mobile app on a phone and a desktop browser) and a few uploads. For the Over quota beat, a mock row or a small quota on a test account. Delete Emma and restore her in the same session so the sample library ends unchanged. Blur passwords, the temporary password and PIN fields. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Users, quotas and accounts · Running Frameleaf". SCREEN: Settings → Users ("Manage profiles, features, preferences, storage and sign-in."). Table columns Account, Role, Status, Items, Storage used / quota; rows Taylor (Administrator, Active) and Jamie (User, Active). Filters All, Active, Administrators, Deleted. | Settings → Users | "Every person gets their own library. Accounts live in Settings, under Users, with each person's role, status, items and storage against their quota." |
| 3 | 0:13–0:28 | CURSOR clicks "Create account". Dialog "Create account": CURSOR types Email `emma@example.test`, Name "Emma"; opens "Sign-in method" showing "Password" and "Sign-in provider only", keeps Password; types "Initial password" and "Confirm password" (blurred); ticks "Require a password change at the next sign-in"; Role stays "User". | Create account · Sign-in method | "Choose Create account. Enter the email and name, and choose how they sign in: a password, or your sign-in provider only. Give a first password, and require a change at the next sign-in." |
| 4 | 0:28–0:45 | ZOOM on "Storage quota (GiB)": CURSOR types 250; hint "Leave the quota blank for no limit. A quota of 0 blocks new uploads while keeping existing photos." ZOOM on "Storage label": CURSOR types `emma`; hint "The storage label is an optional folder name: letters, numbers, hyphens or underscores." HIGHLIGHT "Send a welcome email". | Storage quota (GiB) · Storage label · Send a welcome email | "Storage quota is set in gibibytes. Leave it blank for no limit; zero blocks new uploads but keeps existing photos. Storage label names the person's folder in the storage template. Send a welcome email needs email set up first." |
| 5 | 0:45–0:56 | CURSOR clicks "Save account"; Emma's row appears: "User · Active · … of 250 GiB". CALLOUT "A quota does not reserve disk space". Cut to a second row reading "Over quota · new uploads need more space". | Save account · Over quota | "Save account. A quota never reserves disk space, and external libraries do not count toward it. When someone runs out, their row reads Over quota." |
| 6 | 0:56–1:07 | CURSOR selects Emma; the detail panel opens below with View analytics, Edit account and Close details, and the tabs Overview, Libraries, Security, Activity. HIGHLIGHT each tab, then "Edit account". | Overview · Libraries · Security · Activity | "Select an account to open its details: Overview, Libraries, Security and Activity. Edit account changes the name, role, quota or label later." |
| 7 | 1:07–1:17 | CURSOR clicks Edit account; ZOOM on the notice under Storage label: "Changing the label does not move existing files. Run the storage template migration separately when you are ready." CURSOR clicks Cancel. | Storage label notice | "Changing a storage label does not move files already stored. Run the storage template migration when you are ready." |
| 8 | 1:17–1:31 | CURSOR opens the Security tab, panel "Sign-in and security". Row "Password · No password change is required." CURSOR clicks "Reset password"; dialog: "A one-time temporary password is generated for Emma. Their current password stops working and they must choose a new one at their next sign-in." CURSOR clicks "Generate temporary password"; "Temporary password" appears (blurred) with "Copy it now. Closing this dialog hides it for good." | Reset password · Generate temporary password | "Security handles sign-in help. Reset password makes a one-time temporary password, shown only once. The old password stops working, and they choose a new one at the next sign-in." |
| 9 | 1:31–1:45 | ZOOM on "Locked folder PIN · PIN is set". CURSOR clicks "Reset PIN"; dialog text: "Clear Emma’s PIN so they can set a new one after signing in. Every device signed in to this account is signed out of Locked content. Their protected media stays protected." CURSOR confirms; row reads "No PIN set". | Locked folder PIN · Reset PIN | "Forgot their Locked folder PIN? Reset PIN clears it so they can set a new one after signing in. Their devices leave Locked content, and their protected media stays protected." |
| 10 | 1:45–1:57 | ZOOM on "Signed-in devices": two rows, the Frameleaf mobile app on a phone ("Last seen 25 Sep 2026") and a desktop browser ("Last seen 26 Sep 2026"). CURSOR clicks "Sign out" on the phone; dialog "Sign out device · Sign this device out? It will need to sign in again to access the library."; confirm; notice "Device signed out." | Signed-in devices · Sign out | "Signed-in devices lists every session and when it was last seen. Sign out a lost phone here; it must sign in again to reach the library." |
| 11 | 1:57–2:12 | CURSOR returns to Overview and scrolls to "Account lifecycle": "Deleting an account signs out its devices and starts a recovery period of 7 days." CURSOR clicks "Delete account"; dialog "Emma will lose access. Their account can be restored for 7 days, and their files remain during that recovery period."; CURSOR types the email into "Type the account email to confirm" and confirms. | Account lifecycle · Delete account | "At the bottom of Overview is the account lifecycle. Delete account signs out every device and starts a seven-day recovery period, during which the files remain. Type the account's email to confirm." |
| 12 | 2:12–2:21 | Emma's row status "Deleted"; lifecycle reads "Deleted 26 Sep 2026. Recovery is available until 3 Oct 2026." HIGHLIGHT "Restore account"; CURSOR restores her. Insert: a second capture of a row with status "Removing" and "This account is scheduled for permanent removal and cannot be restored." | Restore account · Removing | "Until then, Restore account brings it back. After that, the account shows Removing and can no longer be restored." |
| 13 | 2:21–2:34 | ZOOM on the delete dialog option "Skip recovery and permanently remove this account" and its warning "The account, its original photos and videos, and its owned library entries will be removed. This cannot be undone." (not ticked). Cut to Settings → Storage & originals → User Settings → "Delete delay" 7. | Skip recovery · Delete delay | "Skip recovery removes the account, its originals and its library entries at once, and cannot be undone. Change the seven-day window with Delete delay, in Storage & originals." |
| 14 | 2:34–2:42 | SCREEN: Users → Taylor's own detail; ZOOM on "Your own administrator account cannot be deleted or demoted from this session." | Your own account is protected | "Your own administrator account cannot be deleted or demoted from your own session." |
| 15 | 2:42–2:45 | LOGO OUTRO | Next: OPS-13 · Access & security: single sign-on | "Next up: Access & security: single sign-on." |

## Voice-over (clean)

Every person gets their own library. Accounts live in Settings, under Users, with each person's role, status, items and storage against their quota.

Choose Create account. Enter the email and name, and choose how they sign in: a password, or your sign-in provider only. Give a first password, and require a change at the next sign-in.

Storage quota is set in gibibytes. Leave it blank for no limit; zero blocks new uploads but keeps existing photos. Storage label names the person's folder in the storage template. Send a welcome email needs email set up first.

Save account. A quota never reserves disk space, and external libraries do not count toward it. When someone runs out, their row reads Over quota.

[pause]

Select an account to open its details: Overview, Libraries, Security and Activity. Edit account changes the name, role, quota or label later.

Changing a storage label does not move files already stored. Run the storage template migration when you are ready.

[pause]

Security handles sign-in help. Reset password makes a one-time temporary password, shown only once. The old password stops working, and they choose a new one at the next sign-in.

Forgot their Locked folder PIN? Reset PIN clears it so they can set a new one after signing in. Their devices leave Locked content, and their protected media stays protected.

Signed-in devices lists every session and when it was last seen. Sign out a lost phone here; it must sign in again to reach the library.

[pause]

At the bottom of Overview is the account lifecycle. Delete account signs out every device and starts a seven-day recovery period, during which the files remain. Type the account's email to confirm.

Until then, Restore account brings it back. After that, the account shows Removing and can no longer be restored.

Skip recovery removes the account, its originals and its library entries at once, and cannot be undone. Change the seven-day window with Delete delay, in Storage & originals.

Your own administrator account cannot be deleted or demoted from your own session.

[pause]

Next up: Access & security: single sign-on.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. user-management.mdx still describes "Administration > Users", an edit-user icon, a context menu with "Reset Password" and a "Queue user and assets for immediate deletion" checkbox. The current build is Settings → Users ("People with server access"), with "Create account", the account table, and one account's detail panel (Overview, Libraries, Security, Activity) holding Edit account, the Sign-in and security panel and the Account lifecycle zone. The old `/admin/users` addresses redirect there.
- Create account labels verified: "Email", "Name", "Sign-in method" ("Password", "Sign-in provider only"), "Initial password", "Confirm password", "Require a password change at the next sign-in", "Role" ("User", "Administrator"), "Storage quota (GiB)" with the hint quoted in beat 4, "Storage label" with its hint, "Initial six-digit PIN" (optional, not shown in the VO), "Avatar colour", "Send a welcome email", "Save account". The doc's welcome-email note (only when SMTP is configured) backs the VO line; OPS-14 sets up email.
- Quota facts: blank means unlimited (doc); a quota of 0 blocks new uploads (form hint); "A quota does not reserve disk space" (the build's over-capacity warning); external libraries do not count (doc). The Over quota row text is "Over quota · new uploads need more space". Quotas use logical original sizes (detail footnote), not narrated.
- Storage label: the doc says labels replace the account ID in the folder path and that existing files need the storage migration job; the build's notice is quoted in beat 7 and OPS-08 shows the migration.
- Security panel strings: "Sign-in and security", "Password", "Reset password", "Generate temporary password", "Temporary password", "Copy it now. Closing this dialog hides it for good.", "Locked folder PIN", "PIN is set", "No PIN set", "Set PIN", "Change PIN", "Reset PIN" (shown only while a PIN is set), the Reset PIN description quoted in beat 9, "Signed-in devices", "Last seen {date}", "Sign out", "Sign out device", "Device signed out.", "Sign-in provider". The doc's password reset ("reset to a random password and they have to change it next time") matches the temporary-password flow.
- Lifecycle strings: "Account lifecycle", "Delete account", the delete description and body quoted in beats 11 and 12, "Type the account email to confirm", "Skip recovery and permanently remove this account", "Permanently delete", "Restore account", "Deleted {date}. Recovery is available until {deadline}.", "This account is scheduled for permanent removal and cannot be restored.", "Your own administrator account cannot be deleted or demoted from this session." The default delay is 7 days (server config and doc); the deletion job runs at midnight. "Delete delay" lives in Settings → Storage & originals → "User Settings" (group Trash); the doc still says "Administration -> Settings -> User Settings".
- Blur every password, the temporary password and PIN fields. Never show a real email address; use the sample `@example.test` accounts.
