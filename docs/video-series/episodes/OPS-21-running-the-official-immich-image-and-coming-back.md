# OPS-21 · Running the official Immich image and coming back

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | Administrators on a compatibility-certified Frameleaf release who need to run the official Immich server for a while and return |
| Features demonstrated | Certified handoff and return, official ledger and Frameleaf's separate schema, dormant data, the exact certified image (ghcr.io/immich-app/immich-server:v3.1.0, never a floating tag), prerequisites (database backup and media snapshot IDs, maintenance mode, other containers stopped), completed backfills, the fixed order of commands, what changes while official Immich runs (Frameleaf-only features unavailable, privacy-hidden items can become visible, workflows stay in official tables), post-handoff checks, the return procedure, rollback boundary, older releases, the external production gate |
| Source docs | docs/docs/features/switching-between-fork-and-official.md, docs/docs/administration/upstream-handoff.md, docs/docs/features/revert-to-upstream.md, server/src/fork-schema/supported-versions.json |
| Capture checklist | Mostly DIAGRAM and CARD work on the dark canvas; no official Immich interface is captured. One TERMINAL showing the exact image reference and the `disable-maintenance-mode` admin command. The maintenance-mode screen of Frameleaf (Settings → Maintenance → Maintenance mode) for beat 5. Server label "frameleaf.home". |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Running the official Immich image and coming back · Running Frameleaf". TITLE "A certified round trip" with subheading "From Frameleaf to official Immich, and back". | A certified round trip | "Frameleaf is built on Immich. On a compatibility-certified release, you can run the exact official Immich image for a while and then come back, without losing Frameleaf's data." |
| 3 | 0:16–0:31 | DIAGRAM: a database cylinder "frameleaf.home database" split into two compartments that appear as named: "Official tables and migration ledger" (teal) and "Frameleaf's own schema" (green). When the VO says "dormant", the green compartment dims to 40% with a small "Dormant" chip. | Official ledger · Frameleaf schema · dormant, not deleted | "Here is why it works. Official migrations stay in the official ledger, and what Frameleaf adds lives in a separate schema of its own. While official Immich runs, that data stays dormant, not deleted." |
| 4 | 0:31–0:42 | TERMINAL: `ghcr.io/immich-app/immich-server:v3.1.0` typed alone. CALLOUT "Exact tag". Below it `:latest` and `:release` appear and are struck through. | TERMINAL; CALLOUT "Exact tag only" | "One official image is certified today: version 3.1.0, by its exact tag. Never swap in latest, release or any other floating tag." |
| 5 | 0:42–0:58 | CARD "Before you start": bullet 1 "Fresh database backup"; bullet 2 "Matching media snapshot, both with their real IDs"; bullet 3 "Maintenance mode on, every other container stopped". On bullet 3, SCREEN inset: Settings → Maintenance → Maintenance mode. | CARD | "Before you start, take a fresh database backup and a matching snapshot of your media, and note their real IDs. Keep both until you are safely back. Then turn on maintenance mode and stop every other container." |
| 6 | 0:58–1:17 | DIAGRAM: a numbered path, each step lighting green as named: "1 Check and finish backfills" → "2 Verify storage against backup and snapshot IDs" → "3 Preflight → report digest" → "4 Apply the locked cutover" → "5 Prepare the handoff · save its record". | The order is fixed | "The order is fixed. Check and finish the backfills. Verify storage against your backup and snapshot IDs. Run the preflight, which produces a report digest. Apply the cutover with that digest. Then prepare the handoff, and save the record it prints." |
| 7 | 1:17–1:28 | TERMINAL titled "One-off admin process · same Frameleaf image": `immich-admin disable-maintenance-mode` prints "Maintenance mode has been disabled." DIAGRAM inset: the Frameleaf server node stops; a node "Official Immich v3.1.0" (blue) starts against the same database. | TERMINAL; CALLOUT "Then start the exact official image" | "Stop Frameleaf, leave maintenance mode with a one-off admin command, and start the exact official image. Its normal startup applies its own pending migrations." |
| 8 | 1:28–1:43 | CARD "While official Immich runs": bullet 1 "Frameleaf-only features are unavailable"; bullet 2 "Items hidden only by Frameleaf's privacy filters can become visible"; bullet 3 "Workflows and plugins stay in official tables". | CARD | "While it runs, Frameleaf-only features are unavailable. Items hidden only by Frameleaf's own privacy filters can become visible in timelines, search, albums, sharing and the mobile apps. Review that before you hand off." |
| 9 | 1:43–1:54 | CARD "Check it": bullet 1 "Sign in, run an existing workflow"; bullet 2 "Upload, download and delete a test item"; bullet 3 "Compare database counts and media". | CARD | "Then check it: sign in, run an existing workflow, and upload, download and delete a test item, comparing counts as you go." |
| 10 | 1:54–2:09 | DIAGRAM: the return path right to left, steps lighting as named: "Maintenance on, official stopped" → "Prepare the return" → "Leave maintenance" → "Start Frameleaf, check status". The green schema compartment brightens back to full when the last step lights. | Coming back | "Coming back has the same shape. Turn on maintenance mode, stop official Immich, and run the return preparation. It validates the official ledger, reconciles Frameleaf's data, and switches features back on only when that finishes." |
| 11 | 2:09–2:22 | CARD "The rollback boundary": bullet 1 "Fails before the cutover commits: nothing changes"; bullet 2 "Fails after: restore database and media together"; bullet 3 "Never edit the migration ledger by hand". | CARD | "Know the rollback boundary. A failure before the cutover commits changes nothing. After it, restore the database and media checkpoints together. Never edit the migration ledger by hand." |
| 12 | 2:22–2:42 | CARD "Two cautions": bullet 1 "Certified in a synthetic test: repeat it on a copy of your own setup first"; bullet 2 "Older releases: convert first, or restore matched backups". | CARD | "Two cautions. The certification is a synthetic test, so repeat the whole sequence on a clean copy of your own setup first. And a database first opened by an older release must be converted by a compatibility release first, or restored from matched backups." |
| 13 | 2:42–2:45 | LOGO OUTRO; small credit line "Built on Immich" under the lockup | Guide: Handoff to official Immich and return | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf is built on Immich. On a compatibility-certified release, you can run the exact official Immich image for a while and then come back, without losing Frameleaf's data.

[pause]

Here is why it works. Official migrations stay in the official ledger, and what Frameleaf adds lives in a separate schema of its own. While official Immich runs, that data stays dormant, not deleted.

One official image is certified today: version 3.1.0, by its exact tag. Never swap in latest, release or any other floating tag.

[beat]

Before you start, take a fresh database backup and a matching snapshot of your media, and note their real IDs. Keep both until you are safely back. Then turn on maintenance mode and stop every other container.

The order is fixed. Check and finish the backfills. Verify storage against your backup and snapshot IDs. Run the preflight, which produces a report digest. Apply the cutover with that digest. Then prepare the handoff, and save the record it prints.

Stop Frameleaf, leave maintenance mode with a one-off admin command, and start the exact official image. Its normal startup applies its own pending migrations.

[pause]

While it runs, Frameleaf-only features are unavailable. Items hidden only by Frameleaf's own privacy filters can become visible in timelines, search, albums, sharing and the mobile apps. Review that before you hand off.

Then check it: sign in, run an existing workflow, and upload, download and delete a test item, comparing counts as you go.

[beat]

Coming back has the same shape. Turn on maintenance mode, stop official Immich, and run the return preparation. It validates the official ledger, reconciles Frameleaf's data, and switches features back on only when that finishes.

Know the rollback boundary. A failure before the cutover commits changes nothing. After it, restore the database and media checkpoints together. Never edit the migration ledger by hand.

[pause]

Two cautions. The certification is a synthetic test, so repeat the whole sequence on a clean copy of your own setup first. And a database first opened by an older release must be converted by a compatibility release first, or restored from matched backups.

[pause]

The written guide is linked below.

## Production notes

- Narration tone: careful and exact. This is the one episode allowed to name "official Immich" as the other system (style guide section 1). The opening line "Frameleaf is built on Immich" is the attribution the About dialog also carries.
- Certified image (upstream-handoff.md, supported-versions.json): exactly `ghcr.io/immich-app/immich-server:v3.1.0`, certification result "local-synthetic-passed" with an external production gate "required". Never `latest`, `release` or another floating tag. If `supported-versions.json` lists a newer certified tag at capture time, update beats 4 and 7 and this note together.
- Command order (upstream-handoff.md "Exact operator sequence"), mapped to the DIAGRAM in beat 6: 1 the backfill status, start, resume and verify commands; 2 storage verification start and resume with `--database-backup-id` and `--media-snapshot-id`; 3 preflight with `--format digest`; 4 apply with `--report-digest`; 5 the prepare-official command, whose canonical JSON names the exact image. The literal subcommand names carry an internal word the style guide keeps out of shot, so they stay in the written runbook and are not typed on screen. The runbook also requires interrupting and resuming the backfill worker and the storage verification once each.
- Only `immich-admin disable-maintenance-mode` is typed on screen (server-commands.md). The runbook runs it from a one-shot admin process using the same Frameleaf image while the Frameleaf server is stopped, so the TERMINAL shows the bare command without a `docker compose exec` prefix; the runbook does not spell out the Docker wrapper. It then starts the official image without changing the tag. Its normal boot applies every pending certified migration; verify the ledger is the full v3.1.0 manifest before API use.
- Visibility risk (revert-to-upstream.md): items hidden only by Frameleaf privacy filters can become visible through official timelines, search, albums, downloads, sharing and mobile clients. Workflow and plugin rows stay in the official tables and are not copied, translated or deleted.
- Return (upstream-handoff.md, return section): maintenance on, official stopped, the return preparation command (`fork-handoff prepare-fork --batch-size 100`), leave maintenance from a one-shot admin process, start Frameleaf with API and microservices workers, then the status command. Reconciliation archives orphaned sidecars, seeds defaults for new records, rebuilds indexes and activates features in the final transaction. A healthy maintenance ping is not success: maintenance must be off, workers healthy and workflows executable on a new asset.
- Rollback boundary: a failure before the checkpoint transaction commits rolls back; after it, restore both the database and media checkpoints. Never edit released migrations or ledger rows.
- Cautions (upstream-handoff.md danger box, revert-to-upstream.md): the repository certification is synthetic and does not certify an installation; repeat the complete sequence against a sanitized, production-shaped clone. Databases first opened by pre-compatibility releases must be restored from a matched pre-existing backup or converted by a compatibility release first; never point an official image at an unconverted database.
- The two source docs are titled with an internal word the style guide keeps out of the series, so the outro card uses a neutral title: `Guide: Handoff to official Immich and return`; producer links the handoff runbook. The outro carries the small "Built on Immich" credit line; it is not read aloud.
