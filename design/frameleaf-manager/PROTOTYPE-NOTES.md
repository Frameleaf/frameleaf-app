# Scope and behavior

This is a standalone interaction prototype. It does not access Docker, import a database, scan media, create accounts, send email, pair a phone, or implement a server endpoint/native client. All setup progress and profile details are sample state kept in this browser tab. Only theme preference persists. Refreshing the page resets the demonstration.

After the install/import/restore result, the flow now collects first name, last name and email. A user may keep the local photo account, create an optional Frameleaf account, or sign in to one. The verification page is explicitly simulated; it sends nothing and accepts the displayed sample code. No password or legal acceptance is collected. No paid service is enabled.

The next screen contains real QR codes and official screenshots for iOS and Android, plus instructions to connect the new server and authenticate using the local/imported photo account. Because both platform pages currently say coming soon, the codes open those pages and do not promise live store downloads.

The phone preview connects, authenticates, and starts a user-scoped catalog/album/search/preview sync while the server rescans. Manager and mobile consume the same local setup state. Before authentication the proposed status projection exposes only setupRequired. Authenticated status distinguishes new_import, new_library and restored_library; it carries setup/library identifiers, progress, rescan completion, verification and the final library revision. Detailed counts and user-specific library data require the existing authenticated library sync API in the eventual product.

Finish requires a completed server rescan and verification plus a phone catalog and browsing previews caught up to the server's final revision. Wrong library IDs, missing authentication, stale revisions, incomplete previews and verification failure keep Finish unavailable. Cloud identity is never a substitute for local library authorization. Sync describes catalog and browsing data; it does not download all original media. Mobile operating systems may pause background work; the UI describes resuming on reopen rather than guaranteeing unrestricted OS background execution.

Use Preview > Mobile onboarding, or ?preview=mobile, for the short route. The full Immich import also reaches the new flow. Prototype controls support pause, resume, interruption, accelerated completion and inspection of the proposed authenticated status response. The completed phone view reuses the official sample app screenshot.

The previous database-only policy is preserved: a readable, completed, verified backup for the selected source/database with age 0–24 hours skips the backup page and backup creation step. Import copies the current stopped database; it does not import an older recovery snapshot. Photos/videos/external libraries are excluded from backups.

Production implementation remains a separate phase: real authenticated status API, durable setup sessions and sync cursors, user-scoped data reconciliation, secure local claiming and account linking, native background execution and tests on real phones still need implementation and validation. This prototype is not that evidence.

The sample managed-server service label uses `frameleaf-server`, matching the canonical deployment identifier. Service rows and logs remain fictional; the live Manager lists actual owned containers and uses the server's SQL-backed queues.
