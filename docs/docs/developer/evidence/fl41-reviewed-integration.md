# FL-41 reviewed web/server integration

Issue: [FL-41](https://heroit.atlassian.net/browse/FL-41). This is a local qualification assembly, not a replacement for the issue-owned PRs, hosted acceptance, merge, publication or deployment. All mobile work remains deferred under the user's September 21 instruction.

## Source provenance

Assembly runtime commit: `39da25a85f7789909b2400149b574368e311302b`. Default-branch baseline: `a3b0cae7e785e31339353ad9b0a55cfb10d03f56`, including removal of mobile CI. Merge parents preserve the original reviewed commits:

| Issue | Reviewed input |
| --- | --- |
| FL-29 People filters | `79b7f9caa40e4c08fe3c09a75927dcf2984671ea` |
| FL-34 sensitive Locked view | `aabef632a6f1b1c5390a86a6a4cae265e634778e` |
| FL-39 versions and original-media bounds | `6cd128decbd9ef66f6b43c195ac3bbb582882559` |
| FL-84 reproducible engine build | `a7882dcf7de1f087a21c93a792c2946ddac4d66d` |
| FL-41 server/SDK validation | `83100cdaafe199658a51af5ddd3d6f009527720b` |

The 26/39/30/11/6 files changed exclusively by those respective inputs remain byte-identical. Shared changes preserve owner-only sensitive timelines, version APIs, original-media metadata, action-discriminated validation and the stronger no-Dart CI assertions. An independent bounded integration review approved the runtime assembly with no P0/P1/P2 findings, subject to refreshing the tracked-path golden. It did not repeat the individual feature audits.

## Local validation

Before the final original-bounds merge, combined checkpoint `a762277790d71eda5cfd62e84a82dc7301735105` passed 664 server tests, 131 web tests (one existing skip), three SDK transport tests, server/web TypeScript and Svelte checks.

After that merge, the changed paths passed 138 server controller/DTO/asset-service tests, seven video-editor tests, eight version-control tests and three SDK transport tests. Server build, SDK build, web TypeScript and Svelte checks passed; Svelte reported zero errors and warnings. These targeted checks qualify the delta locally; they do not claim a repeated full suite.

Server OpenAPI generation and oazapfts 7.5.0 regeneration are byte-identical to the merged sources:

- OpenAPI SHA-256: `62e8c76f21cc28a79c464cb5528921ba426b6a9bff3ceeab0f75896d04bce3b0`.
- SDK SHA-256: `c5b6359cce7efab60eba52a3fc757660d58db3481b8669061108ae46c13a3f93`.

All 313 existing operations remain, with five additional version operations. Existing operation fields and parameters remain identical except for optional `sensitiveOnly` query parameters on the two timeline endpoints. Existing schemas remain identical except for optional `originalVideo` on `AssetEditsResponseDto`; no existing required fields changed. This structural comparison does not replace hosted OpenAPI compatibility checks.

The final receipt/golden commit `e9e61bbdb97f2605bc2aa3b73b72b9a0886b4aac` passed all 22 documentation/workflow contracts and independent consistency review. Its strict snapshot retains 517 source anchors, with 53 added tracked paths and zero removed paths relative to the FL-41 input; the validator is unchanged.

Starting the installed Docker Desktop resolved the local database blocker. Using the already-cached PostgreSQL and Ryuk images, all 58 PostgreSQL tests passed across the six changed medium-test files: enrichment backfill, migration ledgers, video edit versions, authentication, image enrichment and sensitive timelines. This includes the original-bounds regression. The run used disposable test databases and did not pull registry images or change application databases.

## Remaining qualification

Current-candidate GitHub Actions, broader media qualification and full authenticated application checks remain open. The previously unavailable original-bounds PostgreSQL regression is now locally verified; existing issue-specific limitations beyond that check remain in their receipts. No mobile generator or application validation was reintroduced.

Issue-owned PRs and their monitoring owners remain unchanged. The assembly is unpushed, so its Smart Commit commands have no Jira ingestion receipt. FL-41 remains In Progress. Any merge/publication requires the existing explicit authorization procedure.

## Reviewed follow-ups

The assembly now also incorporates independently approved FL-29 `e6f0c9bc361be93812867ddd5383ad3521ea7fba` and FL-39 `fd9c4b7d39ca7b9ab3b551dc901288aa30808c2e`, combined at `aa47dce6e`. These supersede the corresponding inputs above without rewriting their history.

FL-29 repairs an authenticated-browser keyboard defect: deleting a focused People chip before moving focus let the parent close the dropdown. Focus now moves to its existing People button first. Twelve component tests pass, and the new focus-out regression fails against the previous implementation. Real local Chromium, HTTP authentication, active-fork PostgreSQL and WebSocket notifications verified keyboard selection/removal, owner-only thumbnail access and two-tab lock clearing. A follow-up recovery assertion verifies that both tabs return to the locked application shell and display the empty People picker after the reload. The synthetic fixture and qualification limits are recorded in [the People receipt](../frameleaf-plan/FL-29-people-filters.md).

FL-39 stream-copies qualified pure rotations from original H.264 SDR MP4/MOV inputs into private masters, retaining an independently rendered playback proxy. Inputs with inherited display matrices, incompatible streams or unsupported formats keep their existing baked/fail-closed path. Review found that hardware decoding suppressed metadata autorotation in proxies; the correction disables decoding for rotated masters while retaining the configured encoder. The owner passed 255 media-service tests, including publication-command regressions for four hardware backends, plus 13 media-repository tests. Real FFmpeg tests verify packet/timestamp and decoded-frame preservation. Physical GPU execution remains unqualified; see [the rotation receipt](../frameleaf-plan/FL-39-version-persistence.md).

The combined checkout passed all 22 documentation/workflow contracts. Its server typecheck exposed one new original-bounds test array whose inferred action enum was wider than FL-41's discriminated DTO. Adding the existing `AssetEditActionItem[]` annotation repairs the fixture without changing runtime validation; the server typecheck and all 70 asset-service tests then pass. Runtime source files for both reviewed follow-ups remain byte-identical to their owners' candidates.

## Archive authorization follow-up

A focused active-fork PostgreSQL regression first plans an explicitly Sensitive asset under owner elevation, then submits the remembered archive IDs as the locked owner and as a different elevated administrator. Both archive requests are denied before ZIP creation. The download medium suite passes both tests; server TypeScript and changed-file ESLint pass. This verifies the existing request-time authorization boundary, without changing production code. It does not qualify revocation during an already streaming archive, browser viewer/Trash workflows, or the separately identified direct asset-file privacy gap being repaired by the FL-34 owner.

## Authenticated viewer and Trash follow-up

Using the existing disposable active-fork API and synthetic People-suppression fixture, Chromium loaded a decoded image in the normal photo viewer and then the Trash viewer. Each phase confirmed original download HTTP 200 before a real server session lock. After locking, the asset image disappeared, the Search control and Unlock sensitive content button returned, and fresh preview/original requests returned 400/404. Both phases reported no page errors. The test uses real HTTP authentication and WebSocket notifications without API interception; it adds synthetic preview/thumbnail rows rather than qualifying background derivative generation.

The runnable setup, browser script, assertions, JSON result and before/after accessibility trees are retained in the local authenticated-browser evidence bundle. Backend build `39da25a85f7789909b2400149b574368e311302b` and web `7ebd72e34223f3c24be1660d71d516edc94ea888` retain the reviewed privacy handlers. This closes the named local photo/Trash-viewer lock-flow gap for People-suppressed media; it does not qualify every Sensitive classifier, an already streaming export, direct asset-file endpoints, other browsers or deployed services.

## Reviewed direct asset-file privacy repair

Merge `00f85b4a0d923fad90d5571131a0a248fed94c43` incorporates independently approved FL-34 `02db47e12cdc46430ab4ae6b90450c2106a77395`. Direct asset-file metadata, download and deletion now pass the authenticated privacy context into the existing owner query and apply its hidden-content predicate to the joined source asset. Remembered file IDs no longer bypass source restrictions; owner-only access, legacy Locked elevation and shared-link denial remain enforced. The owner's PostgreSQL regression changes from six failures/four passes to ten passes, with TypeScript and lint passing. The two production files and regression remain byte-identical to that reviewed candidate. See [the derivative receipt](../frameleaf-fl34-derivative-evidence.md) for precise scope and remaining qualification.
