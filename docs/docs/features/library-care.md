# Library Care

Library Care is the **Library Care** entry at the bottom of the library rail. It opens **Utilities**: the repair queues first, then every utility grouped as Organize, Repair, Import, Automate and Connect.

## Repair queues

The queues count what is waiting, read with your own privacy: another account's Locked media is never counted, and your own only after you unlock your session.

- **Missing originals**: findings whose original can no longer be opened, and how many already have a verified exact copy.
- **Damaged media & RAW**: confirmed damage, suspected damage and unsupported RAW, counted together and reviewed apart.
- **Duplicate groups**: groups waiting in Duplicate review.
- **Import review**: imported iCloud Photos items that need a decision.
- **Metadata still to read**: items whose details have not been read yet.

Missing media and Damaged media are administrator tools.

## Scans

**Scan again** checks every item of your library: whether its original is there, and whether it reads back intact. The scan is a background job listed in Activity and in the notifications panel. It records where it has got to after every small batch, so you can pause it, resume it, cancel it, close the browser or restart the server, and it carries on from where it stopped. A scan that fails is retried once automatically before the failure is reported; the scan bar shows the last scan, a running one and a failure.

## Missing media

1. Select findings and choose **Locate originals**. Pick the search locations: library storage, your external libraries, and for administrators the recovery locations the operator configured. **Search selected locations** looks for exact copies by checksum, never by name, as a background job.
2. Each candidate shows where it was found, whether its checksum is an exact match and whether it decodes. When a copy was found in more than one place, choose one and **Save candidate choices**.
3. **Relink verified matches** reviews the fixed selection and relinks each item to its verified copy. A copy in library storage or the item's own external library is linked where it is. A copy in a recovery location is first copied into library storage; the recovery location is only ever read.

## Damaged media

Unsupported RAW and suspected damage are kept until validation confirms a problem. Only **Confirmed damaged** findings can be replaced or moved to the trash.

- **Recover from a verified copy** replaces confirmed damage with a copy whose checksum matches the original exactly and that decodes. You confirm that you reviewed the evidence. The copy is published into library storage without replacing any file, and the damaged file is kept where it was, recorded on the finding.
- **Trash confirmed damage** needs you to type `MOVE CORRUPT MEDIA TO TRASH`, your PIN when your account has one, and evidence from the last day. Each item is checked again when it is moved; an item that no longer fails is kept.

Relinks, recoveries and moves to the trash run as background jobs with the same pause, cancel and automatic retry, and each affected row shows a small loader until the job has answered for it. Every file is read and verified again at the moment of change; a finding that changed since you reviewed it is reported instead of applied.

## Accounts and privacy

Everyone reviews their own findings. An administrator can also choose one other account, or all accounts. Another account's Locked media is never listed, counted or changed, and its thumbnails are not shown. Background work can always reach Locked media, as for every server job.

## Recovery locations

Recovery locations are configured by the operator with `FRAMELEAF_RECOVERY_ROOTS`, for example `Verified backup=/mnt/backup/photos;/mnt/photos/recovered`. Mount them read-only if you can. A candidate must still be a regular file inside its location when it is recovered; a link that leads outside it is refused.
