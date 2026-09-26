# Native applications and release qualification

This workstream completes the Frameleaf phone and tablet applications and qualifies the whole product for release. It preserves existing upstream client connectivity, protocol and database identities while shipping separately identified Frameleaf apps. It is an implementation plan, not a statement that the redesign or release is complete.

Read the [main plan](00-implementation-plan.md), [agent execution contract](01-agent-execution.md), the native/release items in [the consolidated backlog](backlog.json), and [the native ownership map](native-issue-map.json) first. The backlog contains six native/release epics and 27 stories; the ownership map covers every committed inventory row plus every hashed dirty-only preservation requirement. Stable IDs are the handoff contract for agents and issue tracking; split large stories into linked implementation tasks without removing their acceptance requirements.

This bounded FL-25 slice restores the native/release preservation contract, not native application code. The consolidated backlog now points its native workstream rows to this guide and no longer marks the restored guide as pending. The library, Studio, delivery, brand and feature-ownership narratives remain independently reviewed or pending according to their own source records; this slice does not silently restore them.

## Verified starting point

The committed Flutter app is a substantial existing application, but the Frameleaf-specific native foundation remains outside this clean baseline:

- `mobile/frameleaf-parity.json` deterministically inventories 211 committed entrypoints: 59 native routes, 24 asset actions, 26 settings components, 64 web pages and 38 administrator settings. Source presence is not redesigned parity or device qualification.
- `mobile/frameleaf-preserved-dirty-evidence.json` separately records 16 hashed source rows found only in the preserved checkout: two Frameleaf Studio preview routes and 14 fork web routes. Those rows keep their requirements and issue ownership, but are explicitly `not-committed-not-qualified`.
- The combined preservation contract therefore has 227 rows without claiming that all 227 are committed, distinct screens, implemented, or available at runtime. `scripts/frameleaf-mobile-inventory.py --check` requires exact committed-source regeneration, exact ownership-map coverage, and continued separation of the 16 dirty-only rows.
- The inventory retains 16 migration gaps: unified discovery, guided faces, Shared Spaces, Takeout, classification, culling, memory stories, pets, enrichment, Library Care, preservation, documents, photo tools, AI video, native Studio and administration. All remain in scope.
- The preserved checkout also contains unreviewed shell, token, Studio-review, edit-round-trip, OAuth and transition-guide work. None of that app code is restored by this slice, and its historical tests do not establish committed behavior or readiness.
- Identity validators and a blank example contract are restored. They fail closed for upstream, example, debug or incomplete release identities; they do not provision signing, callbacks, store records, domains, credentials or a release build.

The user-supplied SVG kit under `design/frameleaf/brand-kit` is the committed artwork authority. Release identities, derived native assets, signing material, store listings, callback allowlisting and physical-device qualification remain owner-supplied gates. This planning pass validates the documentation, inventory, ownership and identity contracts only; it does not build, sign, publish or device-qualify an application.

## Delivery boundaries and dependencies

| Epic    | Scope                                                                 | Stories     | Main prerequisites                                                            |
| ------- | --------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| MOB-100 | Complete native library, settings and administration                  | MOB-101–107 | Shared tokens/session and additive contracts: FN-201, FN-203, FN-301          |
| MOB-200 | Full Flutter tablet Studio; phone review and restoration              | MOB-201–204 | STU-202/203/205 contracts; VID-090 proof before broad full-Studio integration |
| MOB-300 | Offline data, backup and operating-system integration                 | MOB-301–304 | Native session, discovery scope, separate identity and auth                   |
| REL-100 | Owned native identities, branding, attribution and rights             | REL-101–104 | Repository ownership plus explicit signing, domain and tool inputs            |
| QA-100  | Access, media, migration, accessibility and performance qualification | QA-101–105  | Implemented vertical slices and exact-candidate evidence                      |
| REL-200 | Repository automation, reproducible SDKs and distribution             | REL-201–203 | FN-101 baseline, FN-301 contracts and all applicable release gates            |

Stage numbers describe delivery position, not permission to bypass dependencies. Native library, administration, quick edits, backup and project review can proceed without a qualified GPU. Native full-Studio integration follows the early rendering go/no-go proof, `VID-090`. Final tablet Studio also requires the complete integrated HDR10/HLG and edited Dolby Vision chain, not just the early specimen. A missing Dolby tool or failed quality gate keeps full Studio unavailable while independently qualified library functionality remains usable.

### MOB-100: migrate every library and administration workflow

`MOB-101` extends `frameleaf_tokens.dart`, `workspace.provider.dart`, `tab_shell.page.dart` and routing into a complete native design system. Browse and Work share authenticated server/account, query, filters, sort, grouping, selected IDs, scroll anchor, open asset, playhead and draft/undo state. Timeline is a view over that session. Device rotation, split screen, app restoration and keyboard focus must preserve meaning. Density can remain device-specific; changing a layout cannot silently change a query or asset selection.

`MOB-102` implements native timeline/viewer and all source actions: zoom/pan, real video, slideshow, Info, metadata/location, favorite/rating, download/share, albums/stacks, classification marks, trash/restore and bulk actions. The quick editor retains source quality and unsupported recipes. Manual tagging preserves Info → People → Add → draw → assign with accessible numeric alternatives and correct preview-to-original transforms. Use actual face creation/reassign/delete contracts; the prototype's editable local boxes do not establish a server endpoint for arbitrary detected-box mutation. The preserved checkout's dirty-only `prototypes/frameleaf/docs/manual-face-tagging.md` audit distinguishes those cases; it is not restored or linked as committed evidence by this slice.

`MOB-103` consumes the structured discovery query in `server/src/controllers/search.controller.ts` and `discovery.dto.ts`: semantic, filename, description, OCR and full-path modes; contextual people/date/place/camera/lens/tag/media/state facets; removable zero-match chips; saved queries; map results; timestamped video moments. Cancel stale requests and bind pages, counts and selections to one query and access snapshot. Native navigation and app links restore the same query, not just its visible text.

`MOB-104` covers nested albums, collaborative Spaces and shared-link/partner workflows. Recipient previews, role editing, membership removal, add-all-matching counts/jobs and identity links use server authorization. Contributors retain originals; album links do not move personal folder placement. People and pets expose only accessible evidence, with private names kept independent. Guided face corrections and pet model changes preserve durable user decisions.

`MOB-105` and `MOB-106` make the fork's existing capabilities usable natively: classification sample previews and provenance; burst/duplicate culling with multiple keepers and undo; memories/event stories; OCR-grounded documents and correction evidence; enrichment dependency/jobs; Google Takeout staging and reconciliation; Library Care; preservation exports, checksum verification and restoration; selective photo tools, presets and external RAW round trips. A link to a desktop page or generated SDK model does not satisfy these stories. Server-staged work continues after the app exits and resumes from durable status.

`MOB-107` implements the full settings command center for phones and tablets. Audit `mobile/lib/pages/common/settings.page.dart`, `mobile/lib/widgets/settings/` and the server's user preferences/config DTOs. The preserved checkout also contains the dirty-only `docs/docs/developer/frameleaf-settings-coverage.md` ledger; it is pending separate review and is not restored or linked as committed evidence by this slice. Include profile, password/PIN, API keys, sessions, OAuth, protected content, notifications, sharing/recognition groups, supporter/attribution, local-device settings, and the complete authorized administrator surface: accounts/quotas/libraries, queues/concurrency, ML endpoints/RunPod, workflows, storage, backup/recovery, utilities and configuration transfer. Personal preferences are separate from device and server settings; hiding a navigation item is not authorization. Server-wide operations must not appear scoped merely because an administrator is inspecting one user's usage.

### MOB-200: full Studio in Flutter on tablets

The tablet application is a native Flutter editor over shared project and command contracts. It must not embed the web editor in a WebView or accept reduced tool parity because the controls are native. Phones retain library/admin, quick editing, restoration jobs and project review; full workspace controls are tablet/desktop work.

`MOB-201` implements the client of immutable revisions, optimistic/idempotent commands, renewable single-editor leases, review and pending-command recovery. Preserve the entire pinned Freecut envelope including compositions, expressions, keyframes and unknown graph fields. Assets/resources use server-derived authorized manifests; client filesystem paths and URLs cannot become worker inputs. Moving from quick editing to a project and back preserves source, active revision, playhead and recoverable draft history. A second editor, expired lease, revoked source or failed response must not silently overwrite a project.

`MOB-202` and `MOB-203` deliver native counterparts for every relevant row in `studio/freecut-feature-manifest.json`: multitrack timeline operations, nested compositions, preview layouts/scopes, effects, masks, transitions, text/fonts, transforms, keyframes/Compose/expressions, channel-aware audio, captions, import/export and baseline AI tools. Map each row to Flutter control, canonical command, preview/export implementation and tests. Pencil/touch gestures need discoverable keyboard and accessible alternatives. Ordinary Flutter layout tests alone cannot prove rendered tool parity.

`MOB-204` connects authenticated remote previews and durable render/restoration operations. Destination selection persists with the job: compatible local or LAN ML GPU first, explicit RunPod selection when wanted, and no silent cloud fallback. Show model/VRAM availability, queue/preparation/render/validation states, cancellation, reconnection and recovery. Faithful/Creative five-second comparisons retain original audio/timing; interpolation remains separate. Local compute availability does not imply full-Studio worker qualification.

Full Studio remains capability-gated until `STU-401–405`, `VID-202–204`, the relevant AI stories and native manifest rows are qualified. The existing unsigned diagnostic evidence, Metal float-readback probe and synthetic native encoder fixtures cannot admit a production worker. The pinned compositor's known 8-bit paths and stereo export limits must be resolved and tested end to end. The preserved checkout's dirty-only `docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md` contains the broader render and fresh Dolby metadata plan; it remains pending separate review and is not restored or linked as committed evidence by this slice.

### MOB-300: offline, backup and platform behavior

`MOB-301` audits Drift databases, sync streams, account switching and cached originals/thumbnails. Cache keys and pending work must include server/account scope and revalidate access; logout, lock, revocation and user removal purge the applicable metadata, names and previews. Offline behavior needs an explicit policy for protected media and stale authorization. The existing online-only Studio review must not accidentally become a persistent graph/source cache through generic application restoration.

`MOB-302` migrates backup selection, background schedules, retries, upload detail, duplicate handling and constrained-network behavior. Frameleaf is a separate application: it cannot inherit another app's sandbox, refresh tokens, OS permissions, local downloads or backup selection. Guide users through sign-in, limited/full photo permissions, reviewing albums and a dry-run upload summary. Existing server checksums and asset identity prevent repeat uploads. Never start backup or remove the old app automatically. Test both apps installed and running against the same server.

`MOB-303` covers foreground/background notifications, Android/iOS lifecycle, widgets, share extensions and deep links. Notification payloads, widget snapshots, OS task-switcher previews and share targets must obey current privacy. Links resolve the correct account/server and permission gate before exposing media. Reconcile pending jobs when resuming after force-stop, process death or extension execution; do not rely on an in-memory screen listener.

`MOB-304` covers local albums/media, download/export formats, motion photos, external sharing, file permissions, free-up-space and local trash. Deleting a local device copy is distinct from deleting the server original. Recheck verified backup before cleanup and handle partial download or permission loss without declaring completion. Preserve HEIC/RAW/Live Photo associations, capture metadata and correct download edit/original choices.

## Native identity and guided transition

`REL-101` uses `scripts/frameleaf-mobile-identity.py` and `mobile/frameleaf-identity.example.json` as a fail-closed verification contract for future Android manifests/Gradle and iOS targets/entitlements. The validator writes no build configuration and does not make the current application identities effective. The owner must supply:

| Input                                                                              | Why it is required                                      | Acceptance evidence                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Android application ID and signing certificate SHA-256; protected signing material | Separate install identity, owned signing and upgrades   | The exact APK/AAB yields the configured application ID and certificate digest; coinstallation and upgrade tested                   |
| iOS release/development bundle IDs, team ID and app group                          | Runner, ShareExtension and WidgetExtension provisioning | Signed extensions embedded under the submitted Runner carry configured IDs, Apple Distribution team and independently valid groups |
| Owned release/store/support/docs HTTPS URLs                                        | Customer links must reach Frameleaf destinations        | `FrameleafLinks` checks plus installed-app navigation; no inherited upstream purchase or distribution destination                  |
| Frameleaf callback/IdP allowlisting and domain ownership where used                | Simultaneous legacy and new-app OAuth                   | Both app callbacks tested with and without configured HTTP redirect overrides                                                      |
| Notification-provider configuration and store privacy/review inputs                | Deliverable platform services and accurate listing      | Authenticated device delivery, revocation behavior and owner-reviewed submission material                                          |

Pass identity configuration through an explicit `--config` path; the validator does not generate or install signing files. The clean Android build still hardcodes the upstream application ID and permits release fallback to debug signing, so it remains blocked until an implementation slice wires owned identity inputs. Android release and publishing verification requires the exact APK/AAB and derives its effective application ID and signing-certificate digest from that artifact; caller-supplied identifiers or keystore metadata are not substitutes. iOS verification resolves ShareExtension and WidgetExtension only as embedded `PlugIns` children of the submitted Runner and checks each signed bundle's `Info.plist` ID, structured Apple Distribution authority/team and signed application/team/group entitlements. Every group entitlement must be an independently valid non-placeholder `group.*` identifier. Environment strings and unrelated extension paths are not effective signing evidence, and generic/example identities remain prohibited. Debug `local.frameleaf.preview` is not a release identity. Preserve internal Kotlin/JNI package paths, generated API compatibility names, database keys and schema histories when they are unrelated to installation identity.

After owner-controlled configuration and signed artifacts exist, inspect the effective release identities from those exact artifacts:

```sh
python3 scripts/frameleaf-mobile-identity.py --config /path/to/owned-frameleaf-identity.json --platform android --verify-android --android-artifact /path/to/frameleaf-release.apk
python3 scripts/frameleaf-mobile-identity.py --config /path/to/owned-frameleaf-identity.json --platform ios --effective-ios --ios-app /path/to/Runner.app
```

Use an `.aab` path instead of the APK path when the candidate is an Android App Bundle. These commands verify evidence; they do not make the identifiers effective, sign artifacts or authorize publication.

`REL-102` reserves `frameleaf://` for navigation and `frameleaf-auth:///oauth-callback` for authentication, with a future configured HTTP redirect at `oauth.frameleafMobileRedirectUri` and `/api/oauth/frameleaf-mobile-redirect`. Those Frameleaf handlers are not present in this clean baseline. Their eventual implementation must keep legacy `app.immich:///oauth-callback`, `/api/oauth/mobile-redirect` and the old redirect override working for existing clients. A legacy-only redirect must produce actionable setup guidance rather than open the wrong app. Test IdP denial, stale state, cancelled browser auth, callback account mismatch, client certificates and password/PIN/session flows.

`REL-103` covers all customer surfaces, not only the app bar: launcher/adaptive icons, splash screens, widgets, extension names, permission prompts, notifications, share/export text, deep-link landing pages, store metadata/screenshots, support links, About and licenses. Keep the upstream-project attribution and required notices. There is no invented Frameleaf purchase service; support and activation interactions must use an explicitly owned service or explain their unavailability. Use the authoritative seven-SVG kit and hash manifest under `design/frameleaf/brand-kit` for future exports. The earlier `mobile/assets/frameleaf-mark.png` is a legacy input, not proof that every generated platform asset is correct. Preserve the supplied SVGs unchanged and record platform derivatives separately; dark/white wordmarks require suitable backgrounds in light mode.

`REL-104` records the owner-supplied worker address and installed CM Analyze/Metafier paths, supported host/GPU, tool versions, model licenses, fonts, codec/distribution terms and Dolby validation inputs. Track each missing input as a concrete blocked task. The Freecut license does not settle every dependency or model's distribution rights; use `studio/dependency-attribution.json` and the actual packaged artifacts. Do not certify an edited Dolby path using source RPU metadata or unsigned diagnostic JSON.

## Repository, SDK and release automation

The canonical GitHub repository is **Frameleaf/frameleaf-app**, whose default branch is literally **`fork/main`**. In the preserved checkout, `frameleaf` and `origin` reference Frameleaf, historical `fork` references `adamtaylor152/immich`, and `upstream` references `immich-app/immich`. Always freshly verify and fetch the explicit `frameleaf` remote; never push to `origin`, `fork` or upstream, and never silently create or rename a branch to `main`.

`REL-201` delivered the static workflow ownership slice in PR #112, but it did not qualify or publish native applications:

- Frameleaf repository/ref/event guards now protect integration, OpenAPI, Docker candidate and release-promotion workflows. Docker/release publication still requires exact-candidate hosted evidence and explicit authority for its consequences.
- Inherited mobile signing, SDK publication, documentation deployment and F-Droid publication workflows are manual-only disabled stubs. They contain no owned native signing/store configuration and do not prove a release channel.
- Container publication, GHCR pullability, release assets, deployment health, native signing, store submission and runtime/media qualification are separate evidence. Do not infer them from a merged workflow change or a passing job whose substantive path skipped.
- PR #112's administrator-review bypass and GitHub-authored merge committer remain governance findings for future merge controls; they are not rewritten or treated as native-release acceptance.

`REL-202` makes API generation serial and reproducible. Current pins are Node 24.21.0, pnpm 11.24.0, Java 21.0.2, OpenAPI Generator Java 7.25.0, its npm launcher 2.41.0, oazapfts 7.5.0 and Flutter 3.47.2. Use the checked-in `mise.toml`, `mobile/mise.toml` and `open-api/openapitools.json` as authority if pins change. Do not run parallel server builds that delete `dist` during API/SQL generation.

Existing commands from repository root, run sequentially after dependencies are installed:

```sh
pnpm --filter immich build
pnpm --filter immich exec node dist/bin/sync-open-api.js
mise run open-api-typescript
mise run open-api-dart
```

Then from `mobile/`:

```sh
mise run codegen
dart analyze --fatal-infos
flutter test
```

The aggregate `mise run open-api` already builds/synchronizes the server and both SDKs. The narrower commands above make the checkpoint order explicit. Flutter code generation also includes Drift migration/schema fixtures, Pigeon, translations and build_runner; inspect generated migration changes before accepting them.

`packages/sdk/src/fetch-client.ts` and the OpenAPI specification are tracked. `mobile/generated/openapi/` is ignored and regenerated using `open-api/bin/generate-dart-sdk.sh`. Keep compatibility adjustments in source schemas or checked-in generator patches, including `open-api/patch/studio_document.dart.patch`; never hand-edit generated Dart. Test top-level/nested nulls, arrays, expressions, unknown edit actions, scalar enums, defaults and binary upload requests through real generated clients. A warning-free schema generator does not replace Flutter compilation or transport testing.

`REL-203` creates owner-controlled signing and publishing with exact-SHA artifacts, provenance/SBOM/license manifests, schema/spec hashes, qualified media results and rollback instructions. Separate untrusted validation from protected signing environments. Rehearse release channels without publishing, then obtain the final owner-authorized distribution action. Library releases may retain Studio disabled; they cannot be described as the complete Studio release. Remove old UI and preview flags only after their replacement evidence passes.

## Qualification contract

| Gate                           | Required matrix and failure cases                                                                                                                                                                                                                  | Evidence owner                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Authorization and privacy      | Owner, recipient, Space roles, administrator, anonymous link, Locked elevation, sensitive/suppressed content, mixed-owner duplicate groups; revocation during search/export/render/sync; no names/counts/previews in caches, notifications or logs | QA-101; source services plus native/web consumers             |
| Media and restoration          | 4K/portrait rotation, SDR/10-bit SDR/HDR10/HLG/Dolby profiles, VFR/rational frame mapping, audio layouts, exact/fast trim, repeated edits, RAW/HEIC/Live Photos, interrupted/stale publication, ML temporal artifacts and unsupported model HDR    | QA-102 with VID/AI stories                                    |
| Real devices and accessibility | Low-memory phone, capable/limited tablets, iOS/Android versions in declared support matrix, touch/Pencil/keyboard, large text, screen readers, light/dark, contrast, reduced motion, RTL/localization, split screen and rotation                   | QA-103; measurements and reproducible fixtures                |
| Scale and connectivity         | Large libraries and albums, thumbnail memory/scroll budgets, huge selections, poor network/offline/process death, low storage, background limits, LAN-only/cloud-only/both/unavailable GPU, cancellation/reconnection                              | QA-103 plus MOB-300/STU/AI                                    |
| Migration and preservation     | Upgrade/rollback, coinstalled backup, existing upstream clients, missing private tables on official, handoff/return, pending leases/jobs, shared ownership, physical-dedup references, checksum-verified restore                                   | QA-104; actual disposable PostgreSQL/official-container lanes |
| Complete feature parity        | Each source action and manifest row → implemented control → authorization/command → visible result/error → meaningful test; no empty admin panels, fake jobs or route-only completion                                                              | QA-105; whole-plan release ledger                             |

Performance stories first record current baselines on named devices and representative library sizes, then set explicit budgets for startup, first useful content, query/render latency, scroll memory, background battery and preview response. Do not invent passing thresholds from a desktop simulator. Local collection of these measurements is distinct from sending telemetry: use operator/Frameleaf-owned infrastructure when checks are needed, preserve the user's outbound restrictions, and record collection/retention behavior.

The focused contract commands restored by this slice are:

```sh
python3 scripts/frameleaf-mobile-inventory.py --check
python3 scripts/frameleaf-mobile-inventory.py --check --preserved-source-root /path/to/read-only/preserved-checkout
python3 scripts/frameleaf-mobile-identity-test.py
node --test scripts/test-fork-roundtrip.test.mjs
```

For compatibility, `scripts/test-fork-roundtrip.sh`, `e2e/docker-compose.fork-roundtrip.yml` and `server/src/fork-schema/supported-versions.json` record local-synthetic evidence for the exact official v3.1.0 digest across origin-upgrade, current-fork-to-official and official-to-fork-return lanes; the manifest still requires an external production gate. `pnpm --filter immich-e2e test:fork-roundtrip` runs the integration harness. **Use only its disposable databases/volumes:** the script resets its compose volumes and state directory. Never point it at production media, databases or backups.

Keep active-state guards, lease/job pausing, private schema catalog integrity, original/reference ownership, privacy snapshots and physical deduplication intact. Rebranding must not rename compatibility-sensitive public database/API identities. Extending the supported official version requires new certification fixtures and a verified catalog/digest, not merely editing a version string.

The preserved-source-root command is an audit-time check for the recorded 16 source hashes; ordinary clean CI runs the first command without requiring the dirty checkout. Identity unit tests validate the fail-closed configuration contract only. Full Flutter checks become applicable after reviewed Frameleaf app code is committed; this slice deliberately does not restore a script that names absent implementation tests.

Final evidence is attached to the exact candidate, not a moving branch: workflow runs that actually executed, source/SDK/catalog hashes, signed-identity inspection, browser and device journeys, privacy/race fixtures, media output probes plus visual/audio comparison, accessibility/performance measurements, and owner-reviewed distribution inputs. Historical prototype tests, synthetic hardware checks and inventory counts remain useful context, but cannot substitute for any of those gates.
