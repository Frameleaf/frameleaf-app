# High-risk workflow interaction decisions

Status: reviewed interaction-design candidate for FL-27; production web, backend, Flutter, renderer, physical-device and release qualification remain open.

This specification closes the unsettled interaction decisions named by `FN-103` without treating the React template as production. The complete machine receipt is [high-risk-workflow-design-evidence.json](high-risk-workflow-design-evidence.json), and the current-run browser captures are under `docs/docs/developer/evidence/fl27-design-audit/`.

The review surface is available in the standalone design template at `?screen=review`. It deliberately prototypes only the adverse decisions that the accepted source template did not make reachable. It retains the approved dark-first visual system and sample media, but it does not mount in production Svelte or claim native Flutter behavior.

## Source-anchor reconciliation

The Jira issue names `prototypes/frameleaf/src`, `prototypes/frameleaf/design-qa.md`, and `docs/docs/developer/frameleaf-screen-parity-audit.md`. None exists in the freshly fetched FL-27 baseline. This candidate does not pretend they are present and does not copy their dirty historical contents. It uses the committed `design/frameleaf/template/src` package as the runnable visual source, this specification as the current-run design-audit record, and the accepted action-preservation ledger plus its hashed source evidence as the source-action contract.

## Current-run audit and resulting decisions

An independent current-run audit found that the accepted template showed the happy path for item sharing, manual face tagging, recovery candidate review, local sample lease state and responsive Studio, but did not expose complete album lifecycle roles/public links/leave/delete, People stale/forbidden/save-error, recovery empty/error/retry/result, or Studio conflict/takeover/stale-revision states. Its narrow Studio also lost media/timeline context, and responsive web could not prove native parity.

The bounded review surface now models all five workflows across normal, empty, forbidden, stale, cancel/retry, keyboard and narrow states. These 35 cases are interaction decisions, not 35 implementation claims.

The controls now enter and leave bounded structural states rather than only changing copy. Invite opens a focus-managed review region without sending; Review changes exposes both revisions and keeps overwrite blocked; Retry opens a two-row unresolved-only checkpoint while the recovered finding stays outside it; Close and Cancel remove their region and restore focus; Return invokes the provided navigation callback. `Enter` opens the keyboard review and moves focus to its heading; `Escape` closes it and restores focus to the primary button. DOM tests assert those structures, row counts, navigation and focus transitions instead of treating labels or toasts as evidence.

| Workflow                    | Approved decision                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Downstream action owners            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Album lifecycle and sharing | Roles and mutation consequences remain explicit. Removing or leaving a collaborator is distinct from deleting an owned album; deleting an album retains its assets. Public-link controls disclose restrictions before creation. Every action rechecks role and revision.                                                                                                                                                                                                      | FL-53, FL-54, FL-56, FL-121, FL-137 |
| People correction           | Correcting a detected face remains separate from drawing a new manual region. Numeric region controls are the keyboard alternative. Access loss clears the preview, names, regions and counts before any explanation appears.                                                                                                                                                                                                                                                 | FL-36, FL-57, FL-121, FL-137        |
| Bulk recovery               | Search roots and candidate evidence remain visible per owner-scoped finding. Filename and decode success are insufficient. Exact checksum, owner, access and current finding state are rechecked before publishing each replacement. Partial failure identifies what was published and what remained unchanged; cancellation changes nothing and retry resumes from a reviewed checkpoint.                                                                                    | FL-69, FL-72, FL-81, FL-123, FL-137 |
| Studio conflicts            | A stale lease or newer project revision blocks overwrite. The local draft stays recoverable while the user compares, opens latest, keeps a copy or discards, then acquires a fresh lease. Takeover remains unavailable until the server confirms the prior lease expired and current access permits it. Cloud processing remains a separate explicit choice.                                                                                                                  | FL-88, FL-91, FL-113, FL-137        |
| Native tablet adaptation    | The tablet design uses native project, preview, inspector and timeline controls over shared commands. Narrow layouts keep the current decision and preview visible and move secondary detail to a modal sheet. While open, the sheet is a native modal dialog: background controls are inert and do not receive focus, focus starts inside, `Escape` closes it, and focus returns to the invoking control. Phones retain review and quick edit, not a compressed full Studio. | FL-125–128, FL-137                  |

## State contract

Each workflow uses the same recovery grammar while retaining workflow-specific content:

- **Normal:** show the current scope, decisive action and exact safety consequence.
- **Empty:** render a structurally empty result, explain why it is empty and offer the next valid source action. Do not dim stale content behind an empty message.
- **Forbidden:** clear private names, previews, counts, draft values and candidates from both pixels and accessible text before explaining that access changed.
- **Stale:** keep a local draft or selection recoverable, show the newer server revision and block overwrite.
- **Cancel/retry:** distinguish a cancelled no-op from a completed partial result. For recovery, the published finding remains recovered, unresolved findings remain unchanged, and retry resumes only those unresolved findings from the recorded checkpoint.
- **Keyboard:** expose every pointer gesture through named controls, visible focus, `Enter` activation and reversible `Escape` cancellation.
- **Narrow:** preserve the primary decision and current preview; move secondary panes behind an explicit review step rather than compressing or clipping them.

## Browser evidence

The in-app browser captured and the audit inspected each accepted image during this work pass. The forbidden People capture was rejected once because blurred content still exposed names in accessible text; the model was corrected to remove that data structurally, then the state was recaptured and inspected.

1. `01-album-normal.png` — healthy: Invite opens a bounded review region with no recipient or role selected and no invitation sent.
2. `02-people-normal.png` — healthy: face region, proposed identity and correction sequence are legible.
3. `03-recovery-normal.png` — healthy: exact matches are distinguished from a filename-only blocked candidate.
4. `04-studio-normal.png` — healthy: recoverable local draft and newer current revision are presented side by side.
5. `05-tablet-normal.png` — healthy design reference: project rail, preview, inspector and timeline remain visible at 1024×768.
6. `06-album-empty.png` — healthy: no stale album contents remain behind the empty result.
7. `07-people-forbidden.png` — healthy: private content is structurally absent from the visual and accessibility tree.
8. `08-studio-stale.png` — healthy: Review changes opens a bounded comparison containing revisions 18 and 19 while overwrite stays blocked.
9. `09-recovery-retry.png` — healthy: Retry opens a two-row unresolved checkpoint; the already recovered finding is explicitly outside it.
10. `10-tablet-keyboard.png` — healthy: `Enter` opens a bounded keyboard review and moves `document.activeElement` to its visibly focused heading; `Escape` removes the review and restores focus to the real primary button.
11. `11-tablet-narrow.png` — healthy design reference: the 680×900 secondary-detail modal leaves the preview visible beneath an inert backdrop and keeps the native/physical-device limitation explicit.

## Accessibility and evidence limits

The review verifies semantic button/group labels, alert/status treatment, a keyboard alternative and responsive reflow. Entering keyboard state moves `document.activeElement` to the real primary button and applies its `:focus-visible` ring. `Enter` opens a structural review region and moves focus to its heading; `Escape` removes the region and returns focus to the primary button. DOM tests and the current-run browser check execute both transitions. It also verifies that the forbidden model omits private values instead of merely hiding them with CSS. A current-run browser keyboard check confirmed that the narrow review's native modal dialog kept focus off background controls during repeated `Tab` presses; `Escape` closed it and restored focus to the invoking `Narrow` control. This is prototype evidence only: screenshots cannot establish reading order in every assistive technology, announce dynamic updates, measure contrast precisely, prove touch targets on a device, or demonstrate Flutter semantics. Those checks remain with the downstream production and QA owners.

The template uses fictional local data and performs no album, identity, filesystem, project, render or cloud mutation. No screenshot proves API authorization, storage safety, native implementation, Freecut parity, physical-device behavior, screen-reader quality, media output or release readiness. Legacy production routes remain until their downstream action rows pass their own acceptance.
