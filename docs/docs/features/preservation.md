# Preservation packages

A **preservation package** is an independent copy of your original files together with what your library knows about them: dates, places, your descriptions, ratings, favourites, archive, Locked records, albums and collections, tags, named people, edit recipes, Live Photo and stack links, document corrections and moment notes. Every file in it is checked when it is written and can be checked again at any time. A package can be restored into your library, on this server or another one.

Find it under **Settings → Originals & preservation** (administrators also see it under **Import & protection** in server settings), or from **Utilities → Preservation verification**.

A package is not a backup of the server. It does not contain accounts, sharing, shared spaces, server settings, pets, memories or Studio projects (Studio projects travel as project bundles). Keep your database backups and a separate copy of your originals as well.

## Export

1. Choose **Preview preservation manifest**.
2. **Include** — what to preserve: the whole library, your favourites, a range of dates the photos were taken, or chosen albums. Only your own items are ever included, never a partner's or a shared album's. **Include metadata and edit recipes** adds the metadata sidecars, albums, people, tags and edit recipes; **Include checksums and a manifest** is always on. **Include Locked items** is available only while your session is unlocked.
3. **Verify** — the server counts the selection, measures it and checks that it fits in one package (up to 100,000 items) and in the free space where packages are written. Nothing is written yet.
4. **Manifest** — what the package holds and, category by category, what a restoration brings back.
5. **Start export**.

The export is a durable job, listed in **Activity** and in the package list. Closing the page does not stop it. You can pause it, resume it or cancel it; a paused export carries on from the next item. Each original is copied into the package and checked against the checksum your library recorded for it; nothing is moved or linked, and your library's files are never changed. An item that fails is tried once more automatically; anything still failing is listed in the item report and can be retried with **Retry failed items**. A package whose items did not all copy is shown as **Incomplete**.

An item that became Locked after an export was started without Locked items is skipped, not copied.

## Verify

**Verify files** reads the package back: the manifest first, then every original and sidecar against its SHA-256, and reports each one as matching, missing or changed, plus any file the manifest does not account for. A package this server wrote is also compared with the record the server kept when it wrote it, so a rewritten manifest or index is reported as changed rather than believed.

A written package is **Not verified** until a verification says otherwise. A successful download is not a verified copy: verify the copy you keep elsewhere too, by uploading it or, for an administrator, naming it on the server.

## Download

**Download package** streams the package as one ZIP (`name.frameleaf-preservation.zip`); **Download manifest** downloads its manifest alone. A package that holds Locked items can only be downloaded from an unlocked session. While your session is locked, Locked items are left out of the item report, the restoration review and every count.

## Restore

Choose **Restore from a package**, or **Restore…** on a package.

1. **Package** — a package this server wrote, a package ZIP you upload (kept for three days), or, for an administrator, a package folder or ZIP on the server outside its media storage (read in place and never changed). Choose whether to restore edit recipes and what to do where the package and your library disagree.
2. **Check** — a review job verifies every file against the manifest and compares each original with your library. Nothing is written.
3. **Review** — each original is **new** to your library, **already in your library**, or **in your trash**. For originals you already have, the fields that differ (date taken, your description, location, rating, archive, edit recipe) are listed with your library's value and the package's; choose **Keep library** or **Use package** for each, or rely on the default.
4. **Restore** — the restore job adds the originals your library lacks and matches the ones it has.

The rules a restore keeps:

- **An existing original is never replaced and never copied twice.** Originals are matched by checksum. One in your trash is not added again: restore it from the trash first, then restore again.
- **Nothing is removed.** A favourite or a Locked record in the package is added; a restore never clears a favourite or unlocks anything. Items that were Locked are restored Locked, with the reason they were locked.
- **Your choices are kept.** They apply to items not yet restored. A restore that stops — paused, cancelled, interrupted — carries on from the items it had not finished, and never touches an item it already restored, so anything you changed on it since stays as you left it.
- **Nothing is created twice.** Albums, collections and people the package names are found again on a repeated restore of the same package: the original album when it is still yours, one an earlier restore created, or your only album with the same name in the same place. New ones are created only when none of those exists.
- Collections stay at the top level and albums nest in a collection one level deep.

**Download reconciliation report** saves every item of a restoration and what happened to it.

## What a restoration brings back

| Information                                                                                                                                                                                   | Restoration                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Original files, dates, places, your descriptions, ratings, favourites, archive, Locked records, albums and collections, tags, named people and their faces, edit recipes, Live Photos, stacks | Restored                                        |
| Document corrections, moment notes and transcripts                                                                                                                                            | Restored where your library has none of its own |
| Generated descriptions, generated moment captions, model and enrichment details, camera details                                                                                               | Kept as provenance only                         |
| Sharing and shared spaces, pets, memories, Studio projects                                                                                                                                    | Not included                                    |

**Generated metadata is never restored as yours.** A description a model generated is recorded with the restored item as provenance, not written as your description; the same goes for generated moment captions. Camera details come back from the original file itself when it is read.

Edited versions are rendered again from their recipes after the originals have been read. Unnamed faces are detected again; named people come back on their faces.

## The package format

| Path                                      | Contents                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                           | Format and version, package id and name, what was selected, counts, completeness, restoration support, and a SHA-256 for every index document |
| `assets.jsonl`                            | One line per original: its paths, byte count, SHA-1 and SHA-256, and the digest of its sidecar                                                |
| `albums.json`, `people.json`, `tags.json` | The albums and collections, named people and tags the originals belong to                                                                     |
| `originals/<id>.<ext>`                    | The original bytes                                                                                                                            |
| `metadata/<id>.json`                      | One sidecar per original                                                                                                                      |

Checksums detect damage and inconsistent copies; they do not authenticate a package against deliberate rewriting. Restore only packages from a source you trust. Entry names are confined to the package, symbolic links are refused, split archives are refused, and documents have size limits.
