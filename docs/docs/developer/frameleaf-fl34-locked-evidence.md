---
title: FL-34 sensitive Locked timeline evidence
---

# FL-34 sensitive Locked timeline

[FL-34](https://heroit.atlassian.net/browse/FL-34) remains In Progress. This bounded server/web continuation combines reviewed projection [PR127](https://github.com/Frameleaf/frameleaf-app/pull/127) at `44c8b5fb53e70e0281fa53f444abeb02c9d5fe2c` and browser/revocation [PR131](https://github.com/Frameleaf/frameleaf-app/pull/131) at `25990c373cdf49cc3fe03aa08e154731fadf0f0f`. Their ancestry includes the approved mobile-CI removal at `a3b0cae7e785e31339353ad9b0a55cfb10d03f56`. Mobile implementation remains deferred.

## Behavior

Locked defaults to the signed-in owner's sensitive timeline. The additive `sensitiveOnly` option on the existing time-bucket endpoints requires an elevated session and rejects shared-link, partner and cross-owner requests, including administrators. Counts and rows use the same authoritative classification predicate and an explicit owner predicate, including album/person queries whose ordinary behavior can include shared media. Sensitive filtering is independent of tag/person suppression preferences and detector enablement. Missing active privacy rows remain quarantined using the existing fail-closed predicate.

The default sensitive view includes timeline and archived assets, preserving their visibility, album membership and original paths. Previously moved visibility-locked items remain in a separate, explicitly selected view at `/locked?view=legacy`, with their existing move-out and permanent-delete actions. The Sensitive view uses normal Trash deletion. Existing suppressed-content routes and legacy APIs remain available. Existing PIN elevation and the reviewed root revocation guard protect both views.

The existing manual-review actions display **Mark Sensitive** and **Unmark Sensitive** in English; their stable translation keys and backend actions are retained. Successful unmarks remove items from the sensitive view. Ordinary asset events lack authoritative classification, so the sensitive view re-queries its server filter rather than inserting event data directly. This may reset the timeline position after an update; scroll retention belongs to the separate library-session work.

Drag/drop and paste previously assumed every `/locked` route meant a visibility-locked upload. That behavior now remains only in the explicit legacy view. The sensitive view declines those transfers and directs users to upload from the library and then mark Sensitive. It does not temporarily upload an unprotected asset or silently relocate it. This is a filtered browsing/manual-review slice, not a new atomic sensitive-upload workflow.

## Local validation

- Five disposable PostgreSQL cases exercise real timeline service/repository queries, active-sidecar and pre-cutover classification, mark → query → unmark, counts and rows, album/path/visibility preservation, suppression distinction, missing-row quarantine, album/person shared-content ownership and rejected unelevated/shared-link/partner/admin cross-owner requests.
- The existing 12 timeline PostgreSQL cases and 13 timeline service unit cases pass.
- Seventy-one focused web tests cover timeline event handling, successful manual-review events, PIN-gated sensitive/legacy route selection and upload transfer separation, alongside the existing manager/action regressions.
- Generated OpenAPI and TypeScript SDK changes are additive and limited to the two time-bucket query functions. No mobile files, migrations, video persistence, FileDelete or FL-39 media policies are changed.
- TypeScript, selected-file ESLint and the repository's Svelte check pass. The stock unfiltered Svelte check reports existing `state_referenced_locally` warnings; the repository command explicitly ignores that warning and reports no errors or warnings.

These checks use synthetic data and disposable databases. The previous [browser privacy evidence](frameleaf-fl34-browser-evidence.md) remains separate: it does not qualify this new Locked UI against a deployed application or real library.

## Review and remaining acceptance

GitNexus identifies TimelineManager as HIGH impact (18 direct references, 44 total); changes are conditional on the new option. Time-bucket repository methods each have one direct service caller, and service checks have two direct callers, reported LOW. New Svelte helpers are unindexed, so their risk is UNKNOWN; callers and route-specific upload behavior were traced directly. Exact-candidate independent privacy review and current-head hosted Actions are required before delivery claims.

Full application owner/cross-account, search/Trash/facet/export, derivative-source restrictions and native acceptance remain open. No migration, merge, publication or deployment is claimed. The published prerequisite PRs and this continuation must be integrated with other pending API additions through normal reviewed regeneration; generated output is not evidence those other features are present.
