# Physical deduplication

Physical deduplication lets households keep one stored copy of a file that several accounts uploaded, while every account keeps its own library record. It is an administrator tool under **Administration > Physical deduplication**. Nothing about ownership changes: each asset keeps its owner, albums, favourites, descriptions, faces, stacks, shared links, Locked state and permissions. Only the file an asset's original points at changes.

## Before you start

- Keep an independent, verified backup. A shared original still needs protection against disk loss.
- In **Administration > Settings > Storage Template**, enable physical deduplication and save the **retained account**: the account whose originals are kept. A preview can use another account chosen on the page, but applying always uses the saved one.
- External-library files are never moved, linked or deleted.

## Prepare a preview

Choose the scan scope (all accounts, or one account's copies) and **Prepare preview plan**. The preview is a background scan; no file changes. It lists every exact copy next to the retained original it matches, grouped by retained original, with:

- the checksum (SHA-1 for older uploads, SHA-256 for newer ones) and size of the copy and of the retained original,
- how many assets point at the retained original now and after the plan,
- the decision for each copy: share the retained original, or skip, with the reason (external library, no exact copy in the retained account, already shared, size unavailable).

Each plan is named after a fingerprint of its evidence, for example `PD-1A2B3C4D`. Preparing a new preview replaces the plan with a new name.

The list holds the first 500 copies. When there are more, the totals still cover all of them, but the plan only applies the listed copies; prepare another plan afterwards for the rest (copies already shared are skipped then).

Another account's Locked media is never listed. Its copies are counted ("2 copies are another account's Locked media"), are part of the plan and are checked like every other copy; background work reaches Locked media, but its names, paths and thumbnails are shown only to its owner in an unlocked session. A copy whose retained original is another account's Locked media is hidden with it.

## Decide per group

Each group whose copies would share its retained original has **Share this original in the plan**. Clear it to leave that group as it is: its copies keep their own files.

## Mark the plan reviewed

**Mark plan reviewed** asks the server to check the plan against the library again. It is refused, and nothing changes, when:

- a newer preview replaced the plan on screen, or the plan was already applied (fully or partly);
- any copy or retained original in the plan was removed, trashed, moved to another account, or changed path, checksum or size;
- a copy already points at its retained original;
- the retained original gained or lost references since the preview.

The page then shows the current state; prepare a new plan. Changing a group's decision after the review asks for a new review.

## Apply the reviewed plan

**Apply reviewed plan** opens a confirmation with the plan's name, scope, retained account, the number of copies to share, the estimated space and the number of groups left as they are. Type `APPLY` and the plan's name exactly. The server repeats every review check and also refuses when:

- another plan is being applied (by anyone);
- the saved retained account changed, or the feature was turned off;
- the decisions differ from the reviewed ones, or the review is no longer valid (reviews are signed by the server and do not survive a server restart; review the plan again).

Only one plan is applied at a time: two administrators applying at the same moment cannot both start one. Applying is a durable background job. It is listed in Activity and the notifications panel of the administrator who applied it, and on the Physical deduplication page for every administrator. The administrator who applied it can pause, resume or stop it; it survives closing the browser and restarting the server, and carries on from the last copy it finished.

For each copy, in order, the job:

Every time the job starts or resumes, it checks that the administrator who applied it is still an administrator, that physical deduplication is still enabled and that the saved retained account is still the plan's; otherwise it stops.

1. reads the copy and its retained original again (owner, path, checksum, size and state), and leaves the copy alone if anything differs from the reviewed evidence; reference counts are checked when the plan is reviewed and applied, not per copy, since the plan itself changes them;
2. checks that the retained original's file is on disk and still hashes to the reviewed checksum and size (a retained original is checked once per run); without that, the copy is never removed;
3. checks that the copy's file still holds the reviewed bytes;
4. moves the copy's XMP sidecar to the copy's own upload folder, points the copy's asset at the retained original, and only then removes the copy's old file, and only while no asset or generated file still uses it;
5. points the copy's thumbnail, preview, full-size and encoded video at the retained original's, and removes its own while nothing else uses them.

Originals are never written to, and a retained original is never deleted. Asset rows are never removed or merged, so albums, faces, stacks, shared links and lock records keep pointing at the same assets.

The job records what happened to every copy (shared, already shared by an earlier attempt, left as it was, failed) and the bytes actually removed from disk. A copy that fails is retried once, after a short wait, before it is reported; a copy left alone because its evidence changed is not retried. A job that fails as a whole is also retried once automatically. Running a copy again after an interruption finishes what the interrupted attempt started and never applies it twice.

As soon as a job changes a file, the plan reads **Applied**, or **Partly applied** if its job then stops or fails. Such a plan cannot be reviewed or applied again, and Activity offers no **Retry** for it: prepare a new plan, which skips the copies already shared, and review and apply that.

**Review history** lists recent plans with who applied them and their counts.

## Rules for render workers

Physical deduplication, like bulk jobs, project bundles, enrichment plans, Library Care and imports, runs only on this server's own workers. A render worker can be enrolled only for Studio exports and previews, restorations and quick edits, and is never handed any other job, whatever its destination.
