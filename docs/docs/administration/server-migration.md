# Server-to-server migration

Moving a person's library from one server to another is done with the
resumable migration command of the command-line tool. It runs on a computer
you control, copies over the API, and finishes with an audit you review in
**Settings → Storage & originals → Move or export your library** before you retire the
source server.

The web app never runs a migration, never asks for API keys and never deletes
anything. It shows the exact commands below and opens the audit report
read-only, in your browser only. Nothing is ever deleted from the source server
automatically: retiring it is always your decision.

:::note Not a web runner
Starting a migration from the browser is deliberately not offered. Any future
web runner needs its own authenticated, durable execution design; it must not
call shell commands from the web app.
:::

## How it works

1. **Preflight** checks both connections, API key permissions, the owner on
   each side and any existing ledger. It changes nothing.
2. **Dry run** lists what would move and what the destination already holds.
   It writes nothing to the destination and never counts as a pass.
3. **Run** copies originals, then albums (with their collections), tags,
   stacks and people. Every finished item is committed to a local ledger file,
   so an interrupted run resumes when you run the same command again.
4. **Retry** tries failed originals again, adds them to their albums and tags,
   and reattaches names to faces.
5. **Verify** checks every original on the destination by checksum, without
   contacting the source, and writes the audit report you open in the
   migration checklist's Review stage.

## Before you start

Migrate one person at a time. You need an API key **for that person on both
servers**: an API key can only read and write the library of the account it
belongs to, so an administrator's key would copy the library into the
administrator's own account.

Sign in as the person on each server, open **Account settings → API keys**, and
create a key with these permissions (or `all`):

| Server      | Required                                                                                       | Optional                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Source      | `asset.read`, `asset.download`, `album.read`, `tag.read`                                       | `stack.read`, `person.read`                                     |
| Destination | `asset.upload`, `asset.update`, `album.create`, `albumAsset.create`, `tag.create`, `tag.asset` | `stack.create`, `person.create`, `person.reassign`, `face.read` |

Without the optional permissions, stacks and people are skipped and everything
else still moves. If the account does not exist on the destination yet, create
it first and sign in as that person to create the key.

## 1. Build the command-line tool

On the computer that will run the migration, from a checkout of the Frameleaf
source:

```bash
pnpm install --frozen-lockfile
pnpm --filter @immich/sdk build
pnpm --filter @immich/cli build
```

It needs network access to both servers and only a little free disk: each
original is streamed to a temporary folder next to the ledger and removed as
soon as it is uploaded.

## 2. Provide the keys in the terminal

Keep keys out of the web app, your shell history and any saved page. Set the
two server addresses, then type each key when the terminal waits for input
(nothing is shown while you type):

```bash
export IMMICH_FROM_URL=https://old-server.example/api
export IMMICH_TO_URL=https://new-server.example/api
read -rs IMMICH_FROM_KEY && export IMMICH_FROM_KEY
read -rs IMMICH_TO_KEY && export IMMICH_TO_KEY
```

The variable names are the tool's own and cannot be renamed. Every command
below reads them; none takes a key as an argument.

## 3. Preflight

```bash
node packages/cli/dist/index.js migrate --preflight --ledger ./library-move.sqlite
```

It stops with an error naming any missing required permission, warns when the
two accounts have different email addresses (everything is owned by the
destination account), and describes the ledger. A new ledger is not created by
preflight. If an existing ledger was recorded for a different pair of servers,
use a separate `--ledger` path.

## 4. Dry run

```bash
node packages/cli/dist/index.js migrate --dry-run --ledger ./library-move.sqlite
```

The dry run fills the ledger with the source inventory and asks the
destination which originals it already has. Its audit report is marked as a dry
run and never shows a pass.

## 5. Run, and resume after any interruption

```bash
node packages/cli/dist/index.js migrate --ledger ./library-move.sqlite --serve
```

`--serve` adds a progress page on `http://127.0.0.1:2285` on the computer
running the migration, where you can pause, resume or stop. Closing it does not
stop the migration.

If the run stops (Ctrl+C, a reboot, a dropped connection), run **the same
command** again. The ledger skips everything already done. Keep the ledger
file until you have retired the source server.

Albums, tags and stacks are only marked complete once every one of their photos
is on the destination. If an original failed, its albums stay pending and the
report lists them until the original arrives.

## 6. Retry failed items

```bash
node packages/cli/dist/index.js migrate --ledger ./library-move.sqlite --retry-failed
```

Use it after fixing the cause of failures listed in the report (a corrupt or
missing original on the source, a timeout). For the best face results, run once
with `--no-faces`, wait for the destination to finish face detection, then run
`--retry-failed` to attach names.

## 7. Verify before retiring the source

```bash
node packages/cli/dist/index.js migrate --verify --ledger ./library-move.sqlite
```

Verification only needs the destination variables. It re-checks every original
recorded in the ledger against the destination by checksum and writes
`./library-move.sqlite.audit.json`. It refuses a destination other than the one
the ledger was written for. It does not look for photos added to the source
after the run; run step 5 again to pick those up, then verify.

A ledger that has only been used for dry runs verifies as a dry run and never
as a pass: run step 5 first. `--verify` takes no other migration options.

The exit status is `0` only for a pass, `2` for anything else and `1` for an
error, so verification can be scripted.

## Review the audit report

Open **Settings → Storage & originals → Move or export your library** and choose
**Prepare migration checklist**. Continue through Source and Preflight to Review,
choose **Open audit report**, then select `library-move.sqlite.audit.json`. The file is
read in your browser only; it is not uploaded or saved, and closing the report
discards it.

| Section              | What it shows                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict              | **Pass** only when the audit checked every original, none is missing or failed, and every one was verified. **Incomplete**, **Audit incomplete** (the audit was stopped) and **Dry run** are never a pass.                         |
| Owners               | The source account read from and the destination account that owns everything migrated.                                                                                                                                            |
| Originals            | **Transferred**: the ledger records the original on the destination. **Verified by checksum**: found on the destination by this audit. Only verified originals count. Missing and failed originals are listed as unresolved items. |
| Albums               | Albums complete out of the total, and how many are top level or inside a collection.                                                                                                                                               |
| Tags, people, stacks | Tags assigned, names attached to faces, and stacks recreated, each out of the total.                                                                                                                                               |
| Physical references  | New uploads, originals that matched a file the destination already held, and Live Photo pairs linked.                                                                                                                              |
| Unresolved items     | Every original, album, tag, stack or person still outstanding, with its reason. Filter by type or name.                                                                                                                            |

The report is refused, and nothing is shown, if it contains credentials (an API
key, a token, a password in a server address) or file paths from either
computer in its details, if its counts contradict each other or its own verdict, or if it is
not a current audit report. Album, tag, person and file names are shown as they
are, even when they look like a path. The command-line tool never writes
credentials or paths into details; run the verify command again for a clean file.

## Retiring the source server

Retire the source only when all of these hold:

- the latest verify report shows **Pass**;
- every unresolved item is resolved, or you have accepted it (for example a
  person whose name could not be attached because a photo has several faces);
- you have a backup of the destination; and
- you have kept the ledger file and the final report as your record.

Album sharing, activity, comments and anything owned by another account are not
migrated. Thumbnails, faces, smart search and places are rebuilt by the
destination's own jobs.

:::caution Evidence, not certification
The report proves what reached the destination for this run. It does not
certify a server version or compatibility release; those gates are separate.
:::
