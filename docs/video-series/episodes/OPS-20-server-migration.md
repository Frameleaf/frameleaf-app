# OPS-20 · Server migration

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators moving a person's library from an old server to a new one and retiring the old server safely |
| Features demonstrated | Settings → Storage & originals → Move or export your library, Prepare migration checklist ("Plan a library move": Source, Preflight, Review), per-person API keys with the required permissions, building the command-line tool, keys typed into the terminal, migrate --preflight, --dry-run, run with --serve (progress page, pause, resume, stop), resume by running the same command, ledger file, --retry-failed, --verify and the PASS line, Open audit report (verdict, originals transferred and verified by checksum, unresolved items), when to retire the source, what is not moved |
| Source docs | docs/docs/administration/server-migration.md, README.md (Server-to-Server Library Migration) |
| Capture checklist | Source server "old-server" and destination "frameleaf.home", both on the test network; Taylor signed in as administrator on frameleaf.home; Settings → Storage & originals → Move or export your library with the "Prepare migration checklist" button; the "Plan a library move" dialog at each stage; a laptop terminal in a Frameleaf source checkout; a completed test migration of Jamie's library from the sample data so the progress page, the resume line, the summary and the audit report show real numbers; the audit file `library-move.sqlite.audit.json`; API keys blurred everywhere; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:20 | LOWER-THIRD "Server migration · Running Frameleaf". DIAGRAM: node "old-server" (muted) on the left, node "frameleaf.home" (green) on the right, and a laptop node "Your computer" between them with teal arrows through it. | LOWER-THIRD | "To move a person's library from one server to another, Frameleaf uses a resumable migration command. It runs on a computer you control, copies everything over the API, and finishes with an audit you can check." |
| 3 | 0:20–0:37 | SCREEN: Settings → Storage & originals, section "Move or export your library". CURSOR clicks "Prepare migration checklist"; the dialog "Plan a library move" opens with the stage tabs Source, Preflight and Review, and the note "Nothing is ever deleted from the source server automatically." | CALLOUT "Prepare migration checklist"; CALLOUT "Source · Preflight · Review" | "Open Settings, then Storage & originals, then Move or export your library, and choose Prepare migration checklist. It walks through Source, Preflight and Review with the exact commands. The page never runs anything or deletes anything." |
| 4 | 0:37–0:53 | CARD "One person at a time": bullet 1 "That person's own API key on each server"; bullet 2 "Source: asset.read, asset.download, album.read, tag.read"; bullet 3 "Destination: asset.upload, asset.update, album.create, albumAsset.create, tag.create, tag.asset". A muted footer line: "Optional: stack and people permissions". | CARD | "Migrate one person at a time. Sign in as that person on each server and create an API key with the permissions the guide lists. An administrator's key would copy everything into the administrator's own account." |
| 5 | 0:53–1:09 | TERMINAL: `pnpm install --frozen-lockfile`, `pnpm --filter @immich/sdk build`, `pnpm --filter @immich/cli build`. Then `export IMMICH_FROM_URL=http://old-server:2283/api`, `export IMMICH_TO_URL=http://frameleaf.home:2283/api`, `read -rs IMMICH_FROM_KEY && export IMMICH_FROM_KEY` with the cursor waiting and nothing echoed, then the same for the destination key. | TERMINAL; CALLOUT "Keys typed, never shown" | "On your computer, build the command-line tool from the Frameleaf source. Set the two server addresses, then type each key when the terminal waits. Nothing is shown, and nothing lands in your shell history." |
| 6 | 1:09–1:22 | TERMINAL: `node packages/cli/dist/index.js migrate --preflight --ledger ./library-move.sqlite` prints the connection, permission and owner checks. Then the same command with `--dry-run` lists what would move and what the destination already holds. | TERMINAL; CALLOUT "Preflight: changes nothing"; CALLOUT "Dry run: never a pass" | "Preflight checks both connections, the key permissions and the owner on each side, and changes nothing. A dry run then lists what would move and what the destination already has." |
| 7 | 1:22–1:35 | TERMINAL: the run command with `--serve`. SPLIT: right, a browser on `http://127.0.0.1:2285` showing the progress page with Pause, Resume and Stop; CURSOR closes the tab while the terminal keeps counting. | CALLOUT "Progress page on your computer" | "Now run it. The serve option adds a progress page on your computer where you can pause, resume or stop. Closing that page does not stop the migration." |
| 8 | 1:35–1:47 | TERMINAL: `^C` interrupts the run; the same command is typed again and prints `Resuming: … assets already on B.` CALLOUT on the ledger file name `library-move.sqlite`. | CALLOUT "Same command, same ledger" | "If anything interrupts it, run the same command again. The ledger file skips everything already done, so keep it until the old server is retired." |
| 9 | 1:47–2:02 | TERMINAL: the command with `--retry-failed`, then with `--verify`. The summary prints Assets, Verified on B by checksum, Albums, Tags, Stacks and People, then `✅ PASS — every asset is present on SERVER B. SERVER A is safe to decommission.` HIGHLIGHT the PASS line. | TERMINAL; CALLOUT "PASS" | "Retry failed items once you have fixed the cause. Then verify: every original is checked on the destination by checksum, and a full pass ends with the PASS line." |
| 10 | 2:02–2:17 | SCREEN: the checklist at the Review stage. CURSOR clicks "Open audit report" and selects `library-move.sqlite.audit.json`. The "Migration audit report" opens: verdict "Pass", Originals with "Transferred" and "Verified by checksum", Unresolved items reading "No unresolved items." CALLOUT on the hint "The report is read in this browser only. It is not uploaded or saved." | CALLOUT "Open audit report"; CALLOUT "Pass" | "Back in the checklist, go to Review and choose Open audit report. The file is read in your browser only. Look for the Pass verdict, originals verified by checksum, and no unresolved items." |
| 11 | 2:17–2:31 | CARD "Retire the old server only when": bullet 1 "The latest verify shows Pass"; bullet 2 "Unresolved items are resolved or accepted"; bullet 3 "The new server is backed up, and the ledger and report are kept". | CARD | "Retire the old server only after a pass, with every unresolved item resolved or accepted, a backup of the new server, and the ledger and report kept as your record." |
| 12 | 2:31–2:42 | CARD "Not moved, or rebuilt": bullet 1 "Not moved: album sharing, comments, activity"; bullet 2 "Rebuilt on the new server: thumbnails, faces, search, places". | CARD | "Album sharing, comments and activity do not move. Thumbnails, faces, search and places are rebuilt by the new server's own jobs." |
| 13 | 2:42–2:45 | LOGO OUTRO; small credit line "Built on Immich" under the lockup | Next: OPS-21 · Running the official Immich image and coming back | "Next up: Running the official Immich image and coming back." |

## Voice-over (clean)

To move a person's library from one server to another, Frameleaf uses a resumable migration command. It runs on a computer you control, copies everything over the API, and finishes with an audit you can check.

[pause]

Open Settings, then Storage & originals, then Move or export your library, and choose Prepare migration checklist. It walks through Source, Preflight and Review with the exact commands. The page never runs anything or deletes anything.

Migrate one person at a time. Sign in as that person on each server and create an API key with the permissions the guide lists. An administrator's key would copy everything into the administrator's own account.

[beat]

On your computer, build the command-line tool from the Frameleaf source. Set the two server addresses, then type each key when the terminal waits. Nothing is shown, and nothing lands in your shell history.

Preflight checks both connections, the key permissions and the owner on each side, and changes nothing. A dry run then lists what would move and what the destination already has.

Now run it. The serve option adds a progress page on your computer where you can pause, resume or stop. Closing that page does not stop the migration.

[beat]

If anything interrupts it, run the same command again. The ledger file skips everything already done, so keep it until the old server is retired.

Retry failed items once you have fixed the cause. Then verify: every original is checked on the destination by checksum, and a full pass ends with the PASS line.

[pause]

Back in the checklist, go to Review and choose Open audit report. The file is read in your browser only. Look for the Pass verdict, originals verified by checksum, and no unresolved items.

Retire the old server only after a pass, with every unresolved item resolved or accepted, a backup of the new server, and the ledger and report kept as your record.

[beat]

Album sharing, comments and activity do not move. Thumbnails, faces, search and places are rebuilt by the new server's own jobs.

[pause]

Next up: Running the official Immich image and coming back.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. Build labels: section "Move or export your library" in Storage & originals, button "Prepare migration checklist", dialog "Plan a library move", stages "Source", "Preflight", "Review", button "Open audit report", report title "Migration audit report", verdict "Pass".
- Doc vs UI: server-migration.md and the README say to create keys under "Account settings → API keys" / "Account Settings → API Keys"; the current build has them in Settings → Access & security → API keys (OPS-22). The VO says only "create an API key".
- Permissions (server-migration.md table): source requires asset.read, asset.download, album.read, tag.read (optional stack.read, person.read); destination requires asset.upload, asset.update, album.create, albumAsset.create, tag.create, tag.asset (optional stack.create, person.create, person.reassign, face.read). `all` also works. Without the optional ones, stacks and people are skipped.
- Commands follow server-migration.md (environment variables and `read -rs`, never keys on the command line). The README still shows `--from-key` / `--to-key` arguments; do not show that form. The variable names and the `@immich/*` package filters are the tool's own; they appear on screen only and are not read aloud. Addresses use the sample server names over plain http on the test network.
- Output lines are from the CLI source (`packages/cli/src/commands/migrate/index.ts`): the summary block and "✅ PASS — every asset is present on SERVER B. SERVER A is safe to decommission." A pass with unresolved album, tag, stack or person items prints a different PASS line that asks you to resolve them first. `--verify` prints the same summary. Exit status 0 only for a pass.
- Progress page: `--serve` opens `http://127.0.0.1:2285` on the computer running the migration; closing it does not stop the run (server-migration.md step 5).
- Faces tip left out for time: for the best face results run once with `--no-faces`, wait for face detection on the destination, then `--retry-failed` to attach names (server-migration.md step 6).
- The audit report is refused if it contains credentials, file paths, contradictory counts, or is not a current report; capture a clean report from the verify command.
- Not migrated (server-migration.md "Retiring the source server"): album sharing, activity, comments and anything owned by another account. Rebuilt by the destination: thumbnails, faces, smart search and places.
- The outro names OPS-21 by its index title, which contains "official Immich"; that episode is the one allowed to name the other system. The outro carries the small "Built on Immich" credit line; it is not read aloud.
