---
title: FL-34 browser privacy evidence
---

# FL-34 browser privacy follow-up

[FL-34](https://heroit.atlassian.net/browse/FL-34) remains In Progress. This local follow-on builds on independently reviewed `bebfed12ff03b68f1a8213acd28d605cf024b740` and incorporates the approved mobile-CI removal at `a3b0cae7e785e31339353ad9b0a55cfb10d03f56`. It does not change server APIs, generated clients, assets, albums or classification. Mobile implementation remains deferred.

## Behavior

The root privacy guard does not mount application children until initial auth status is verified. Initial request failure or an unverifiable elevated expiry keeps those children absent and offers Retry. Public/signed-out views do not require an authenticated status request.

Elevated expiry is calculated from the existing HTTP Date header and PIN expiry, subtracting the header's whole-second rounding interval and request duration. Monotonic elapsed time and a conservative wall-elapsed deadline prevent a slow client clock or subsequent clock adjustment from extending access. Status requests bypass browser caching. Missing or malformed server time fails closed for an elevated response. Other authenticated requests may extend the server deadline; clearing at the last confirmed deadline can reload a legitimately elevated view early.

Revocation clears native media sources, source children, stream objects and posters, including native players in open shadow roots. Removing the production `hls-video` source invokes its existing HLS.js teardown. Native Picture-in-Picture exit is requested before document replacement; the document and media are already concealed/cleared while that promise settles. The existing Safari presentation API is asked to return inline when present. Unsupported APIs do not prevent the full-document replacement path.

## Local evidence

The focused guard, clearing and existing elevation-toggle suites pass 22 tests. They include initial failure/retry, missing server Date, client-clock skew in both directions, stale status responses, expiry during stalled requests, timer suspension, shadow-player source clearing and asynchronous PiP exit ordering and account sign-out timer cleanup. Changed-file ESLint, web TypeScript and Svelte checking pass.

A local standalone Vite harness imported the actual production guard component, privacy utilities, AuthManager/event manager and installed `hls-video-element`. Playwright 1.62.1 drove Chromium with synthetic auth responses and canvas video streams; SvelteKit navigation/environment seams were substituted. No live server, user media or account credentials were used.

Observed browser results on 2026-09-21:

- Pending initial status: zero protected fixture nodes mounted; verified response: fixture visible.
- Initial HTTP 503: zero protected nodes, Retry visible; successful retry: fixture visible.
- Browser clock one day behind/ahead: the server-derived four-second expiry cleared after 3,003/3,011 ms, conservatively accounting for HTTP Date precision.
- Native and actual HLS shadow players were playing before revocation. A real Chromium native PiP window was active. Before unload, the document was hidden, both players were paused, both stream objects were null, and `document.pictureInPictureElement` was null.

Harness files, runner scripts and outputs are preserved locally under `/Users/adamtaylor/.codex/worktrees/frameleaf-fl34-browser-evidence/20260921/`. This is real-browser evidence for production modules with synthetic seams, not full production-library or deployed-service qualification.

## Remaining qualification

Sensitive-only Locked timeline integration with explicit legacy compatibility remains open. End-to-end owner/cross-account, search/Trash/facet/export and derivative qualification against the complete application is still required. Safari/Firefox, actual HLS network streams, AirPlay/remote casting and operating-system screen capture were not qualified by the Chromium harness. Already downloaded or externally captured bytes cannot be recalled.

GitNexus impact queries could not resolve the newer privacy helpers in the canonical index, so their risk was reported as unknown. Direct source tracing identified AuthManager and the root guard as callers; staged change detection and the actual diff are checked before commit. Independent exact-candidate review and hosted Actions are separate gates. No merge, publication or deployment is claimed.
