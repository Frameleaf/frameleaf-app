# Frameleaf open PR reconciliation — September 23, 2026

Requested by the owner before any further implementation. Audit baseline: PR137 at `fbbdc7970eca748fef793e04ec1847660a73c9d3`, default branch `1303c1e702f1dcaf7be3b8e7d4e38a4240c99498`. Implementation and testing agents were paused; this pass only inspected GitHub metadata and committed source. Original dirty worktrees are preserved.

## Correction to the takeover assumption

The September 23 handoff says PR127/130/131/132/133 are superseded because their FL keys were reimplemented. That is not sufficient evidence of behavior preservation. None of those PR heads is an ancestor of PR137, and inspection has confirmed missing safeguards. The earlier implementation should have been reconciled before fresh coding began.

PR133 is the combined source: PR127 is an ancestor of PR131, and PR131, PR132 and PR130 are ancestors of PR133. Reuse PR133's relevant commits and evidence, with the current September 22 prototype controlling UI. Do not treat separate issue labels, rewritten implementations or missing ancestry alone as proof of equivalence or missing behavior.

## Open PR inventory and hosted snapshot

| PR                                                         | Head         | Created UTC  | Existing work                                                           | Hosted snapshot / merge status                                                       |
| ---------------------------------------------------------- | ------------ | ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [127](https://github.com/Frameleaf/frameleaf-app/pull/127) | `44c8b5fb53` | September 21 | Sensitive review/privacy projection                                     | 32 success, 1 skipped; conflicts                                                     |
| [130](https://github.com/Frameleaf/frameleaf-app/pull/130) | `d458d8aac2` | September 21 | Reproducible isolated Studio engine                                     | 28 success, 1 skipped, 1 cancelled, 2 failures; conflicts                            |
| [131](https://github.com/Frameleaf/frameleaf-app/pull/131) | `d7cfe8b1a7` | September 21 | Locked access and browser revocation                                    | 32 success, 2 skipped, 2 cancelled, 1 aggregate failure; conflicts                   |
| [132](https://github.com/Frameleaf/frameleaf-app/pull/132) | `4944eecfe7` | September 21 | Video masters/version persistence                                       | 33 success, 2 skipped, 1 cancelled, 2 failures; conflicts                            |
| [133](https://github.com/Frameleaf/frameleaf-app/pull/133) | `0a042d2490` | September 21 | Combined library/search/archive/layout/privacy/video/Studio foundations | 32 success, 2 skipped; integration, Test Web and SQL Schema checks failed; conflicts |
| [135](https://github.com/Frameleaf/frameleaf-app/pull/135) | `2640dd13aa` | September 23 | September 22 prototype and handoff                                      | 30 success, 1 skipped; mergeable                                                     |
| [136](https://github.com/Frameleaf/frameleaf-app/pull/136) | `64f2e83651` | September 23 | Design authority, native boundary and unified Locked rules              | No head checks returned; mergeable into PR135's branch                               |

No GitHub review entries or comments were returned for these PRs. Some descriptions and repository evidence cite independent reviews; that is distinct from a recorded GitHub approval. These snapshots are not approval to merge or deploy. No PR was closed or merged during the audit.

## Confirmed privacy gaps: PR127 and PR131

- PR127 updates the privacy projection inside the enrichment metadata transaction and supports explicit manual repair of a missing projection row. PR137's new `asset_lock` implementation differs and applies manual mark operations after the metadata transaction. Several detector review-preservation paths were independently recovered, but that does not establish equivalent atomicity.
- PR131 passes the caller's hidden-content filter through derivative file authorization. Current file-ID checks use `asset_lock` and live-photo rules but omit that filter in `AssetFileAccess` and permission dispatch.
- PR131 conditionally updates PIN expiry to avoid a lock race and emits/handles `on_session_lock` for lock, reset, change and revocation. Those mechanisms are absent from PR137.
- PR131's browser guard gates initial content, enforces a verified expiry deadline, revalidates on focus/reconnect, and clears media/PiP/downloads before replacing the document. The unmerged FL83 candidate `b832bb19bd` provides persistent local-lock concealment/retry and dialog cleanup, but does not replace the older initial-load, expiry and remote-revocation behavior.
- PR131's legacy sensitive/moved tabs should not replace the new prototype's unified Locked reason filter. Reuse safeguards while adapting to the current lock model and FL83 shield.

## Design PRs: already present in substance

PR135 touches 131 files relative to the default branch; 115 are byte-identical in PR137 and none is missing. The remaining changes are later rule/receipt updates, template control extraction/test repairs, icon validation and coverage tooling. The September 22 prototype has not been discarded.

PR136's `AGENTS.md` and `design/frameleaf/INTERACTION-REQUIREMENTS.md` are byte-identical to PR137. Its mirror file has later updates. Rebuilding the design or rewriting these rules is unnecessary. PR135 is a green, mergeable existing design PR; PR136 is stacked on it and has no returned head checks.

## Studio and evidence preservation

Current `studio/` contains six metadata files. PR133 additionally contains the pinned isolated engine build, versioned patches, conformance tooling, default-deny resource admission, package/source notices and rights evidence. Those existing artifacts must be reconciled before treating the engine/qualification foundation as unstarted. This does not imply the editor is mounted or that distribution/rendering is approved.

Nine Confluence receipt identities in PR133 are absent from the current mirror: FL39 video persistence (61408340), FL30 navigation (61964350), FL31 search (61997109), FL29 primitives (61539380), reviewed integration (61441023), FL86 attribution (61997196), selected archive (61800603), matching archive (62423078), and Photos/Albums layouts (62390309). Preserve and reconcile these records rather than replacing their evidence with new claims. No Confluence changes were made during this audit.

## Video persistence: PR132

PR132's retained `video_edit_version` / `video_edit_selection`, requested-versus-current publication transactions, independent master/proxy paths, original-metadata bounds, history/export/download/restore/prune endpoints, queued completion refresh and corresponding physical-file retention are missing from PR137. Current develop revisions reject videos; the sole video recipe is replaced and the deterministic edited output is not equivalent to retained history. Current editor validation uses current asset dimensions/duration, so the original-bounds repair is still needed.

Some newer media-policy behavior overlaps: original-derived rendering, quality/color/decode policy, packet-copy rotation and lineage. Preserve these implementations while adapting PR132. Its explicit multi-audio refusal and post-render master validation are not in the current video-edit handler. Migration 100 conflicts with the current `AlbumKind` migration; persistence cannot be imported without migration/catalog reconciliation.

The recently recovered FL35 `VideoNativeViewer` work is complementary. PR132 does not change that component. Original bypassing HLS, source listener/session disposal, late-result guards and fatal playback retry should remain.

## Isolated engine: PR130 and PR133

PR130 contains the preparation/attestation tool, independent lockfile, package/toolchain patch and two clean-build workflow. Its follow-ups `a7882dcf7d` (worker source-map reproducibility) and `48d5fc71a8` (deferred profiler DOM teardown guard) are absent from PR137. The engine CI job succeeded in the supplied snapshot; unrelated E2E failures prevented a wholly green PR. Reuse the later combined PR133 form, including its additional resource-admission patch and attribution/conformance evidence, while preserving the newer production host/resource/command contracts. Neither PR130 nor PR137 supplies the production engine adapter registration.

## Library, search, archive and accessibility: PR133

The read-only comparison identified additional missing behavior:

- Search responses and cursor/loading updates lack the older generation/abort retirement checks. PR133 includes the session implementation and regressions for superseded success/error/cursor and coalesced paging.
- Delete confirmation no longer awaits its pre-action and captures the target ID before waiting. PR133 carries the mounted deletion regressions and gallery pre-action coordination; adapt them to the current viewer/session architecture.
- Current durable bulk jobs preserve handed-off IDs, but do not replace PR133's transactionally prepared archive membership/count before confirmation or persistent guarded Undo. Current matching IDs are resolved client-side and durable Undo is cleared.
- Photos/Albums Work views do not supply the selected-item inspector to `LibraryView`'s optional information pane. PR133's inspector and its metadata/collapse behavior are reusable. Exact viewport-relative anchor restoration also needs reconciliation.
- The shared modal accessible-name patch and About regression are missing. The native Frameleaf Dialog no longer has PR133's explicit opener/return-focus option and unfocused-invoker regression; the old evidence records a real WebKit pointer-focus failure.

These are functional/accessible behavior differences, not reasons to reinstate the old screen design. Production UI still comes from the September 22 prototype.

## Corrected continuation order

1. Keep all existing PRs and worktrees as recovery sources. Retire the handoff's blanket superseded assumption.
2. Reconcile PR133's privacy/remote revocation, stale search/deletion and transactional archive behavior first, retaining the new lock model, prototype UI and useful FL83 coordinator work.
3. Adapt video history/publication/original bounds as one coherent packet with cleanup, migration and catalog changes; keep newer media policy and the complementary FL35 playback fixes.
4. Restore the existing isolated engine/conformance/attribution implementation and evidence. It remains separate from production adapter and release qualification.
5. Reuse navigation/settings logic and accessibility fixes when completing the new Command Center; reassess the paused FL71 diff before any further coding.
6. Preserve the already-present prototype and rule changes from PR135/136. Reconcile missing historical receipts and exact-head checks before closing superseded branches or merging to the default branch.

No application code, PR lifecycle, deployment or external documentation was changed by this audit. The report is a code/source comparison; old tests and browser receipts were inspected, not rerun.

## Paused Command Center overlap

PR133's `SettingsOverview.svelte` already supplied filesystem usage, installed version/build, account quota/usage, WebSocket connection state, independent failures/retry and About behavior. The pending FL71 packet partly reimplements storage/About/error handling and currently omits the prior regular-user quota/connection behavior. Reuse the older implementation contracts and checks. The new 19-area prototype shell and removal of nested sidebars are additional work, not a wholesale duplicate.

## Reusable source checkpoints

- Search request ownership: `6ce2bc612d`.
- Captured action identity/awaited navigation and deletion regressions: `65b4153d47`, `ff66374915`, `2a38cbc108`, `55fdce8e95`.
- Archive preparation: `a9c4a1dcfc`, `b6e6d2278a`; combined real runtime `6a5386acff`.
- Layout runtime and reviewed integration: `dba7e6691c`, `4fc7323e63`.
- Shared modal accessible naming: `4ccad254cf`.
- Explicit native-dialog focus return: `2895b9b925`.
- Isolated engine: `6542d481f4`, followed by reproducibility `a7882dcf7d`, teardown `48d5fc71a8`, and PR133's resource-admission/attribution additions.

The prior actual browser receipts remain in local worktrees: `frameleaf-fl32-combined-browser-evidence-20260921`, `frameleaf-fl33-browser-evidence-20260921`, `frameleaf-fl29-webkit-evidence`, `frameleaf-fl30-overview-evidence`, and `frameleaf-fl39-browser-evidence`. Their old runtime identities are evidence to preserve and repeat after reconciliation, not current integration acceptance.

## Historical receipt recovery — September 23

The seven remaining missing source documents and receipt identities are restored byte-for-byte from PR133. The previously recovered FL29 and FL86 identities complete all nine missing records. All seven live pages were read; six contain the exact normalized source in an HTML code block and the matching-archive page contains the complete Markdown source. The reviewed-integration page is now version 17 and preserves the version-16 source as history. No external page was changed during this restoration.

| Page     | Live version | Recovered repository source                                       | Readback proof           |
| -------- | ------------ | ----------------------------------------------------------------- | ------------------------ |
| 61408340 | 9            | docs/docs/developer/frameleaf-plan/FL-39-version-persistence.md   | complete source block    |
| 61964350 | 5            | docs/docs/developer/frameleaf-plan/FL-30-navigation.md            | complete source block    |
| 61997109 | 12           | docs/docs/developer/frameleaf-plan/FL-31-search-session.md        | complete source block    |
| 61441023 | 17           | docs/docs/developer/evidence/fl41-reviewed-integration.md         | historical source block  |
| 61800603 | 5            | docs/docs/developer/frameleaf-plan/FL-32-selected-archive.md      | complete source block    |
| 62423078 | 5            | docs/docs/developer/frameleaf-plan/FL-32-matching-archive.md      | complete Markdown source |
| 62390309 | 1            | docs/docs/developer/frameleaf-plan/FL-33-photos-albums-layouts.md | complete source block    |

These documents retain their original checkpoint SHAs and old implementation details, including migration numbers and earlier UI contracts. They are recovery evidence, not instructions to restore obsolete UI or proof that the current integration passed the old runtime checks. The September 22 prototype remains the UI authority. Current recovery evidence lives in the separately dated evidence files.
