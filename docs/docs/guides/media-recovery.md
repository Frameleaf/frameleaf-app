# Recover missing or corrupt media

Use **Utilities → Review missing media** and **Utilities → Review corrupt media** to investigate files Frameleaf can no longer read. If the same original is available in iCloud, [iCloud Photos Sync](icloud-photos-sync.md) can also provide a validated recovery copy.

A missing-file report means Frameleaf cannot access the file it expects. It does not prove somebody deleted it. Storage moves, unavailable storage, permissions, and changed paths can also make a file unreadable.

## Start with storage access

Before changing a photo, check whether the affected storage is available. Ask your administrator to check mounts and permissions if many files disappear at once. Restoring access to the existing files may be sufficient; creating duplicates or deleting findings does not fix unavailable storage.

Keep existing backups and recovery copies until you can open the recovered media. Review tools apply to your authorized assets; shared physical storage does not grant access to another user's library.

## Locate a file that moved or was renamed

1. Open the missing-media review tool under **Utilities** and run a scan.
2. Review the affected assets and use **Locate** to search for candidates in the configured library/storage locations.
3. Review the result. A candidate is accepted for relinking only when its actual content hash matches the expected media. Names and extensions can change without changing that identity.
4. Apply the validated relink where offered, then open the asset to verify access. Uncertain candidates remain for review.

Filenames and directories are not reliable identity. For example, a storage migration can rename `IMG_1234.JPG` and move it into dated folders while keeping identical bytes. Locate can recognize those bytes without the old name. Matching filenames, similar thumbnails, or equal video durations cannot authorize a relink.

The search uses configured locations and bounded scans; it does not search every disk or arbitrary server path. If Locate finds nothing, the file may be outside that scope or there may be no trustworthy saved content hash. A path-derived hash is not a content hash.

## Recover a matching copy from iCloud

1. Have the administrator enable iCloud sync, then [connect your Apple account](icloud-photos-sync.md#connect-and-choose-photos).
2. Select a library or album containing the original, save the settings, and choose **Run now**.
3. The server downloads the required resource, computes content hashes, and validates the actual media. A matching database checksum does not make a damaged destination healthy.
4. If recovery is safe, the connector repairs the existing asset while keeping its ID and associations. Applicable health findings become resolved without requiring another full-library scan.
5. Refresh progress and use **Recent verified results → View media** to open it. Follow the resolved history links to review the finding.

The downloaded file must match the saved expected content. Re-encoded, resized, or edited versions have different bytes and cannot automatically stand in for a missing original simply because they show the same scene. A valid Apple-edited version can instead be an independent member of a Stack.

If only a Live Photo movie is damaged, it can recover independently of the still. Repairing one resource does not mean every related original, edit, or movie has been repaired.

## Managed and external libraries

Managed assets are stored by Frameleaf. External-library assets refer to files you manage separately.

External recovery is off by default. **Allow damaged external-library matches to become managed assets** permits a verified matching copy to be stored under Frameleaf's management while retaining the existing asset identity. The original external path is not overwritten. Without that setting, a damaged external match remains a review item and the staged recovery copy is preserved.

Importing hidden Apple media and recovery involving Locked/suppressed destinations require the applicable privacy permission. The internally hidden movie component of an ordinary Live Photo is different from a private Locked asset.

## Understand corruption results

| Result                    | Meaning and next step                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Missing or unreadable     | Check storage availability and permissions, then locate or recover a matching copy.                                                      |
| Confirmed corruption      | The file failed supported media validation or differs from its saved content checksum. Recover a matching good original where available. |
| Unsupported RAW or format | The decoder cannot validate it. This is not a confirmed-corruption result.                                                               |
| Validation timeout        | The check did not finish. Ask the administrator whether a longer timeout is appropriate for the file.                                    |
| Requires review           | Identity, privacy, external recovery, or another safety condition prevented automatic completion. Inspect the reason.                    |
| Resolved                  | The applicable finding has been resolved. Open the asset and verify the expected media.                                                  |

The corrupt-media tool can move revalidated corrupt assets to the Trash after its PIN and typed-confirmation flow. That is not a recovery action. iCloud sync does not automatically restore intentionally trashed assets. Review the destination's current state before retrying a recovery.

## Why do the counts differ?

Different screens count different things:

| Screen or count                  | What it includes                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible photo/video statistics   | Visible assets in the statistics scope; server totals exclude native hidden motion assets, and user totals also apply visibility/privacy filters. |
| Media Health scan                | Assets in the scan scope, including native hidden Live Photo motion components.                                                                   |
| iCloud logical photos and videos | Source photos/videos discovered or represented in the selected scope.                                                                             |
| iCloud file resources            | Individual originals, edits, RAW alternatives, and Live Photo components.                                                                         |
| Orphaned files                   | Physical files that the reporting tool cannot associate with the references it checks, including derivatives and sidecars.                        |

For example, one visible Live Photo can account for one logical photo and two file resources. Its hidden movie can be checked by Media Health even when excluded from the visible-photo total. Compare matching scopes and filters before interpreting a difference as lost photos.

## What about orphaned transcodes and XMP files?

An orphan report is not a deletion list. A transcode contains different bytes from the original video, and an XMP sidecar is a separate metadata file; neither can be identified using the original media's hash.

Regenerating metadata does not by itself reconcile every old path or prove that every reported orphan is disposable. The iCloud connector recovers matching media resources; it does not purge orphan files or automatically reconnect arbitrary transcodes and XMP sidecars.

Ask the administrator to reconcile reported paths against the database, storage configuration, and shared-file references before removing anything. A large orphan count needs that investigation rather than a blanket cleanup.
