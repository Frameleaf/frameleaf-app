# Frameleaf implementation plan

Status: implementation backlog, not a release or a claim of completed parity. Prepared from the working tree on September 19, 2026. Repository: https://github.com/Frameleaf/frameleaf-app. Jira project: FL. Confluence space: FR at https://heroit.atlassian.net/wiki/spaces/FR/overview.

## Read this first

Frameleaf will be a complete photo and video library with a restrained, dark-first creative workspace and a full Freecut-based Studio. Existing Immich and fork capabilities must survive the redesign. The current React prototype is design evidence; production remains Svelte, NestJS/PostgreSQL, Python ML, and native Flutter. Rewriting production as the prototype is not approved.

This plan supersedes chronological planning notes where they conflict. Explicit subsequent owner decisions take precedence. The source audits remain the preservation baseline; historical checkmarks are not release evidence. Read the [agent execution instructions](01-agent-execution.md), then the assigned issue and its source paths in the consolidated backlog.

The initial FL-25 baseline slice deliberately restored only the reviewed execution core. Later bounded slices restored the library/administration, Studio/rendering and native/release preservation contracts without importing or accepting the dirty application implementation. The native/release narrative and ownership map in `04-native-and-release.md` and `native-issue-map.json` inventory committed and hashed dirty-only evidence without claiming implementation or qualification. This slice restores the brand-asset contract in `06-brand-assets.md`; it preserves source identity without claiming production or native integration. Delivery sequencing and feature-ownership records remain independently reviewed or pending according to their current source state. Their absence must not be interpreted as reduced product scope or permission to start a dependency early.

The restored machine-readable records are:

- `backlog.json`: stable work IDs, dependencies, source paths, acceptance and tests.
- `jira-map.json`: the corresponding external Jira issue identities once published.
- `confluence-mirror.json`: documentation source hashes and destination page IDs. Most entries are historical receipts; the restored 00/01 entries record the current read-back verification explicitly.
- [`08-reproducibility.md`](08-reproducibility.md): the fail-closed join across source anchors, backlog/Jira identities and graph, Confluence receipts, and action-ledger evidence.

The latest audit covers **84 web route directories**, not 84 missing features. The Freecut manifest has **210 source-derived entries**. Native inventory has **227 entries**, largely pending redesign, not 227 finished native screens. Every number is an inventory size, never a completion percentage.

## Verified starting point

The preserved dirty checkout remains under the earlier repository directory name. At inspection HEAD was `91d5dfe0f829d15d122c1a8b2bbc474fc195dbaf` with substantial tracked and untracked work beyond HEAD. The checkpoint hash therefore does not identify all current work. Preserve that checkout as read-only evidence and establish a reviewed baseline before parallel production implementation.

This restoration worktree was created from freshly fetched `Frameleaf/frameleaf-app` literal branch `fork/main` at `4bedc0c4d384f365ee5c29739ce201cc114fdd85`. In the preserved dirty checkout, `fork` still points to `adamtaylor152/immich`, `frameleaf` and `origin` point to `Frameleaf/frameleaf-app`, and `upstream` points to `immich-app/immich`. The repository move is already done. This plan does not request another transfer, an implicit branch rename, or a push. Keep the prohibition on `origin` pushes and all upstream writes. Immediately before any future task worktree, fetch the verified `frameleaf` remote and use that exact fetched SHA rather than reusing this historical baseline.

The preserved dirty-checkout evidence includes the following unreviewed implementation. It is not present in a clean `fork/main` worktree unless separately reviewed and delivered:

- A standalone interactive prototype with Timeline/Browse/Work, photographed People, improved filters, Explore, sample viewer/slideshow, settings command center, utilities and local manual face tagging. The last recorded gate is 400 prototype tests and a successful build, not production integration.
- An opt-in Svelte shell and Flutter foundations. Existing application surfaces are retained; changing shell branding does not migrate their workflows.
- Fork-owned Studio project/revision/lease structures and real project-review APIs. These are not a complete editor, renderer, preview service or export service.
- Existing reliable-video/restoration/discovery/sharing/import/enrichment implementations from earlier work. Inspect and integrate them; do not duplicate them because their new UI is missing. Verify each acceptance criterion against real behavior.
- Freecut provenance and the 210-row feature manifest pinned at `4d62e8082c5eb387a96275bcbd323d28f6e41a62` are restored as preservation metadata. The vendor source, dirty diagnostics and measured GPU/encoder claims remain outside the accepted clean slice; full Studio, restoration, HDR and Dolby Vision qualification remain false.
- Schema handoff and physical-deduplication safeguards that must remain intact.

## Product requirements that must not drift

### Identity and presentation

Use Frameleaf throughout customer-facing web, native apps, PWA, emails, installation, help and release assets. Retain “Built on Immich” attribution in README/About and required notices. Preserve compatibility-sensitive protocol paths, database identities and released migration semantics. New native app IDs and signing are separate from upstream identities. Do not rename every internal `immich` occurrence mechanically.

The user-supplied seven-SVG kit in `design/frameleaf/brand-kit` is the authoritative artwork. Preserve originals and record platform derivatives; earlier generated PNGs are references, not release masters. Follow the committed [design handoff](https://github.com/Frameleaf/frameleaf-app/blob/2fbab9c61f948edf392fad88167a51180fa9d8db/design/frameleaf/README.md), [brand preservation contract](06-brand-assets.md), manifest and file hashes for actual variants, theme contrast and platform export requirements. Source preservation does not establish web/native integration or release qualification.

Apply the approved three-pane design with photography dominant, compact neutral surfaces and fine separators, refined on September 24, 2026 to an Apple Photos–style language: the Apple system font (SF Pro) with bundled Inter as the fallback, continuous (squircle) corners, restrained frosted materials, spring motion that becomes crossfades under Reduce Motion, and squircle people photos. The decisions and their production owners are in the [interaction requirements](https://github.com/Frameleaf/frameleaf-app/blob/claude/frameleaf-implementation/design/frameleaf/INTERACTION-REQUIREMENTS.md) and [prototype to production](09-prototype-to-production.md#september-24-apple-style-refinements). Green/teal/blue identify focus, selection and meaningful state; a reserved indigo sparkle marks AI-produced content. Light mode is equally usable. Primary destinations are Library, Studio and Activity; settings form a separate command center. User text must describe the task, without implementation words such as fork, DTO or worker-admission proof unless a technical control requires them.

### Library continuity and feature preservation

Timeline, Browse and Work share scope, structured query, filters, sorting, grouping, selection, open asset, scroll anchor, playback and draft/undo history. Layout is per-device; viewport changes collapse panels without changing the chosen layout. Timeline day rows fill their available image area. Grid/list/detail/compare/map/video-moment views must preserve the query.

Retain the fork's semantic, filename, description, OCR and full-path searches; people/date/place/camera/lens/tag/media/state filters; contextual counts; searchable dropdowns; zero-match removable chips; URLs and navigation restoration. Distinguish saved smart queries, snapshot albums and filter presets. Support scoped “select all matching” with a fixed operation set and visible count.

Preserve every viewer and Info action, album lifecycle and sharing action, upload/backup operation, people-management workflow, public/authentication flow, administrator control, and utility. A linked page, toast, sample card or generated client is not action parity. Manual face tagging must retain Info → People → Add → draw → assign; existing detected-face editing is a separate required workflow.

### Privacy and ownership

“Mark Sensitive” / “Unmark Sensitive” changes classification. Assets stay in their albums. Locked is a filtered timeline plus the existing session elevation/unlock concept; do not invoke the separate upstream relocation-to-Locked action for new marks. Preserve hiding configuration, evidence and manual-review provenance. Verify the documented active-sidecar privacy-projection gap before relying on immediate filtering.

All queries, counts, facets, thumbnails, identities, maps, exports, background jobs, caches and derived evidence enforce current access. Duplicates are visible only to the signed-in owner, including aggregate counts and history. Account feature preferences and hidden navigation are not module ACLs. Projects and Spaces never implicitly grant access to unrelated private originals. Revocation must affect cached and in-flight results.

### Command center and operations

Provide nested settings, server overview with version/storage/recovery, scoped analytics, multi-account/library management, rich queue controls and concurrency, endpoint/RunPod configuration, activity and utilities. Keep logical asset bytes, deduplicated physical originals and filesystem capacity distinct. Own-service version checks are allowed; arbitrary external checks/telemetry are not. The update address is deployment configuration, never an editable/exposed customer setting.

Keep utilities in Settings, including owner-only Trash and duplicates, large files, Live Photo pairing, geolocation, iCloud import, missing/damaged media and workflows. No repeated generic permission/scope banners. Duplicate culling uses immediate undoable actions and multiple keepers/stacking for bursts; ordinary review must not require a confirmation for each group. Permanent deletion remains deliberately confirmed.

### Quick editing, Studio and restoration

Keep quick Trim/Rotate/Crop/Adjust/Audio usable without a Studio GPU. Edited masters are independent of playback proxy settings, derive from originals and preserve resolution/timing/audio/color unless explicitly changed. Fast trim shows actual keyframe boundaries; precise trim is distinct. Save version, Export and Revert remain different actions.

Full desktop/tablet Studio retains the complete pinned Freecut graph and every manifest feature, with React bundled into the Svelte app behind explicit platform adapters. Native tablets use native Flutter controls over shared project APIs, not a website wrapper. Phones receive library/admin, quick editing, restoration and project review.

Projects have immutable revisions, idempotent optimistic commands, a renewable single-editor lease, review/comments and local pending-command recovery. A qualified local/LAN worker provides browser/native parity, authenticated preview sessions and durable exports. A CUDA ML endpoint alone is insufficient proof of render capability. Never silently upload a local job to RunPod; persist explicit destination selection.

Restoration defaults to Faithful, supports Creative, preserves originals/provenance, previews five seconds, starts at 2× with a default 4K cap and displays time/size/cloud cost estimates with uncertainty. RealBasicVSR and SeedVR2 require model/license/hardware/temporal-quality qualification. Anime4K and RIFE remain distinct; interpolation is explicitly chosen. SDR-only models reject incompatible HDR masters or create an explicitly selected SDR derivative.

### Quality and release commitments

Complete Studio release requires high-precision 10-bit SDR, HDR10, HLG and edited Dolby Vision. The full chain must render edited pictures, generate fresh metadata with administrator-installed CM Analyze, validate XML/frame coverage with Metafier, generate/validate RPU through a qualified pinned dovi_tool adapter, encode HEVC Main10 and package correctly signalled Profile 8.1 with HDR10 fallback. License/tool access, XML interop, VFR mapping and device playback are proof gates. A failed proof leaves that capability and the complete Studio release blocked; it does not silently reduce scope or reuse inappropriate source metadata.

Preserve channel-aware audio, rational timebases, VFR mappings, source profiles, fonts, LUTs and model versions. Fail incompatible exports before rendering. Interrupted, stale, unauthorized or cancelled jobs never replace a valid result. Use frozen snapshots, safe checkpoints, validation and atomic publication.

Selective photo adjustments, presets and external RAW workflows remain in the implementation backlog. Optional S3 storage remains a later architecture evaluation described by a dirty-checkout object-storage ADR that is not restored in this slice; preserve local storage, deduplication, rollback and verified migration when that work is reviewed and added. Full RAW development and professional multitrack features beyond the agreed Freecut baseline are not silently added to this release.

## Delivery order and gates

The original six stages remain valid, with independent foundational work progressing alongside rendering proofs. Do not interpret stage numbers as permission to start a dependent feature early.

| Stage                               | Deliverable                                                                                                                                       | Gate to progress                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1 — Baseline and preservation       | Reviewed working-tree baseline; all routes/actions/settings/Freecut/native requirements mapped to backlog; approved high-risk interaction designs | No orphan requirement, ambiguous owner or “implemented” status based solely on a mockup              |
| 2 — Rendering proofs                | Authenticated remote preview, representative compositing, precision/color/audio chain and complete edited Dolby proof                             | Reproducible fixtures and hardware/tool evidence; capability remains false on failure                |
| 3 — Product foundation              | Production tokens/components, shell/public/auth layouts, shared session/query contracts, capability and job interfaces, separate app identities   | Real API/auth boundary tests, rollback flag, portable build, no sample data in production            |
| 4 — Library and native migration    | Every existing workflow migrated in vertical slices, including all admin/utilities and owned-library permissions                                  | Per-action source→new UI→API→tests evidence; large-library and offline qualification                 |
| 5 — Complete Studio and restoration | Full pinned Freecut parity, native tablet controls, durable projects/jobs, local/LAN/RunPod, quick continuity                                     | Every manifest row has web/native/command/preview/export evidence; Stage2 gates passed               |
| 6 — Qualification and release       | Compatibility, privacy, quality, accessibility, performance, signing and distribution                                                             | Exact-candidate CI and real-device/browser matrix; documented rollback; owner-authorized publication |

Library/quick-edit releases can be delivered while Studio is disabled, provided they pass their own migration gates and are not described as complete Studio releases. Owner approval is needed for any change to the agreed complete-Studio scope, not for routine reversible engineering choices inside an assigned issue.

## First implementation wave

1. Establish the baseline and preserve uncommitted work; reconcile repository identity, branch protections and existing pipeline destinations without publishing.
2. Establish the feature/action ledger and automated completeness checks; make all 84 routes, settings leaves, 210 Freecut entries and native entries traceable to issues.
3. Reproduce sensitive-classification projection and edited-master quality behavior with real fixtures; repair confirmed faults before exposing redesigned controls.
4. Implement shared production query/session/components and access-aware capabilities, then one complete album→filter→select→viewer→Info/manual-face→quick-edit→return vertical slice.
5. Run Linux/GPU remote-preview and Dolby toolchain proof work independently. Record missing hardware/tool inputs as specific blocked issues while library development continues.
6. Expand by dependency order, moving complete workflows rather than accumulating disconnected mocked screens.

The backlog contains acceptance-sized implementation packages, not estimates or invented dates. When a package cannot fit one reviewable change, create linked child tasks with unchanged parent acceptance; do not call a broad epic complete after scaffolding. Jira status and evidence track execution; the repo plan defines the technical contract.

## Frameleaf Cloud workstream

The `cloud` workstream (Plan IDs `CLD-*`, Jira epics CLD-E01 to CLD-E04) adds the optional Frameleaf account link, license certificates and supporter keys, Frameleaf sign-in, remote access through a per-server certificate and a blind relay, the Frameleaf Cloud processing destination that replaces the previous GPU-provider integration, and cloud backup to one dedicated bucket per server. Its contract is the [Frameleaf Cloud integration guide](15-frameleaf-cloud-integration.md) and the approved design record is `docs/superpowers/specs/2026-09-24-frameleaf-cloud-design.md`. Everything in it is opt-in: a server with no account and no license keeps every existing feature, the cloud base address is deployment configuration rather than a setting, and every item is `planned-not-qualified` until its own acceptance evidence exists. The cloud services themselves are planned in Jira project FC and Confluence space FC.

## Definition of ready and done

Ready requires named source routes/actions, current implementation inspected, agreed behavior, prerequisites resolved or explicitly isolated, data ownership and API contracts identified, and test fixtures available. An agent can start investigation work when hardware/vendor inputs are absent, but cannot certify the dependent result.

Done requires actual production behavior, relevant server/web/native/API tests, updated parity rows and docs, error/cancel/retry/revocation coverage where applicable, meaningful visual/accessibility evidence for changed flows, and a reviewed diff. Generated clients derive from source schemas. Prototype tests and local synthetic GPU checks must be reported separately. The parent remains open while any required child capability is missing or blocked.

## Documentation and issue maintenance

The repository is the source-controlled technical record. Confluence mirrors approved plan, audits, design documents, reference features and historical handoffs, with source paths and hashes. New snapshots do not overwrite unrelated user-authored pages. Links between mirrored pages should resolve inside Confluence; non-mirrored source paths remain explicit repository references. Local screenshots/recordings are referenced by path until published through an approved artifact mechanism; do not present missing remote images as embedded evidence.

Jira issues use stable plan IDs in their summary and labels. Parent epics and blocker links carry execution structure; the local map prevents duplicate creation. Keep user-authored edits when syncing an existing issue. This is a one-time mirror/backlog initialization, not a scheduled automation. Future agents update the affected source page, destination page and checksum when instructed, and report any synchronization conflict.
