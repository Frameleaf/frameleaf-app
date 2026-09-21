---
title: FL-34 session revocation evidence
---

# FL-34 explicit session revocation

[FL-34](https://heroit.atlassian.net/browse/FL-34) remains In Progress. This follow-on slice is independent of the projection fix in [PR127](https://github.com/Frameleaf/frameleaf-app/pull/127), based on `5acd172436a0c8b68d93e51527c5461812511310`. Mobile implementation remains deferred.

## Behavior

Successful local and remote session locks send an additive `on_session_lock` event only to the affected session room. PIN change/reset, password change and administrator credential updates revoke elevation and notify the affected user room. Authentication and ownership checks remain in place. Unrelated profile updates do not lock sessions.

The web AuthManager consumes the lock event and existing session deletion/PIN-reset events. It immediately conceals the complete document, pauses ordinary audio/video elements, clears pending download UI state and replaces the document with the existing Photos or logout route. A full document navigation discards singleton result caches and outstanding in-page work. If navigation fails, the old document remains concealed until reload. Already downloaded files cannot be recalled.

The root web guard revalidates the existing auth-status endpoint on navigation, focus, visibility restoration and websocket connection. Once elevation is observed, it clears the document at the last confirmed expiry without waiting for a network response, including after suspended timers resume. A failed revalidation of known elevation also clears the document. Generation ordering rejects superseded status responses. Other requests can extend the server expiry; the conservative last-confirmed deadline may therefore reload an otherwise still-elevated view. Browser clock skew and initial status acquisition still need browser qualification.

Automatic server refresh now conditionally updates only a stored, unexpired elevation in an unexpired session. PostgreSQL rechecks this predicate after a competing row update. Authentication uses whether the conditional write succeeded, so a stale near-expiry snapshot cannot restore elevation after session or owner-wide locking. Explicit authenticated PIN unlock remains the elevation-granting operation.

This changes no schema, migration, REST DTO, generated clients, asset classification, album membership or legacy visibility. Old web clients ignore the additive websocket event. Rolling back these changes restores the former notification/cache behavior; sessions already locked stay locked.

## Evidence and limits

The new assertions against the unmodified baseline produce eight failures: missing local/remote lock notifications, PIN reset/change notifications and revocation on password/admin credential changes. The implementation passes all 121 tests in the auth, session and user-admin service suites. Ten isolated PostgreSQL auth tests pass, including two deterministic stale-read/lock interleavings that fail on the prior implementation and an active/expired/deleted refresh boundary test. Fifteen web tests cover document concealment, media/export clearing, expiry with stalled requests, resume after suspended timers, missed-lock reconnect, superseded responses, revalidation failure, listener cleanup and the existing elevation toggle integration. Svelte checking reports zero errors and warnings. Server and web TypeScript checks and changed-file ESLint pass.

GitNexus upstream analysis preceded existing method edits. Server methods have zero to two direct dependents. AuthManager is HIGH risk with 25 direct dependents and 126 affected symbols; its only behavioral change is the three revocation subscriptions. Explicit-worktree change detection is required before commit. The canonical index has stale line offsets; nearby methods reported as touched are checked against the actual diff.

This is bounded explicit-revocation integration, not full FL-34 qualification. Sensitive-only Locked timeline/legacy compatibility, browser clock/initial-acquisition behavior, custom player/Picture-in-Picture handling, and complete browser/derivative qualification remain open. The isolated tests do not establish live behavior. Independent exact-candidate privacy review, hosted Actions and Smart Commit ingestion are separate delivery gates. No merge, publication or deployment is authorized by this evidence.
