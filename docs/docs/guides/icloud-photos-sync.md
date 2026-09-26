# iCloud Photos Sync

Import your iCloud Photos library into Frameleaf from **Utilities → iCloud Photos Sync**. Downloads run on the server and continue when you close the browser. You can import available Apple edits, preserve Live Photos, and recover matching Frameleaf files that are missing or damaged.

This is a one-way import. It does not write changes back to Apple or delete Frameleaf photos when you delete them from iCloud. Disconnecting leaves your imported Frameleaf photos in place.

## Before you start

Your administrator must enable the connector using the [server setup guide](icloud-photos-server-setup.md). If the page says sync is not enabled, account sign-in alone cannot enable it. Use an HTTPS address for Frameleaf.

Have your Apple account password and a trusted Apple device available. Enable **Access iCloud Data on the Web** on that device. Advanced Data Protection may require you to approve web access again when it expires. This connector supports trusted-device verification codes; SMS verification is not supported.

The implementation has passed local protocol, database, and web tests. A live Apple-account sync has not yet been verified. Start with a small album before selecting a large library.

## Connect and choose photos

1. Open **Utilities → iCloud Photos Sync**.
2. Enter a **Connection name**, such as “Personal iCloud”, and select **Add connection**.
3. Enter your **Apple account email** and password, then select **Sign in to iCloud**.
4. If prompted, enter the six-digit code from your trusted device and select **Verify code**. If device approval is required, approve access on your device, then select **Check device approval**.
5. Select **Load libraries and albums**. If the inventory is incomplete, load it again before relying on the selection. Filter albums by name if needed.
6. Select the libraries and albums you want. Leaving libraries unselected includes all supported libraries; leaving albums unselected includes all supported photos and videos within the selected libraries, including items outside albums. Albums retain their identity when renamed.
7. Choose your settings, select **Save**, then **Run now**.

Passwords and verification codes clear after submission. The server stores an encrypted session so you do not have to enter them for every run. **Check saved session** checks whether that access is still valid.

## Choose import settings

| Setting                                                                  | What it does                                                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Import available Apple-edited versions and stack them with originals** | Imports available finished edits as separate assets in a Stack with the original. Enabled by default.                                                              |
| **Import hidden source media**                                           | Includes Apple Hidden media. Requires an unlocked elevated Frameleaf session when saving. Imported hidden media uses Locked privacy. Off by default.               |
| **Allow damaged external-library matches to become managed assets**      | Allows a verified recovery copy to become Frameleaf-managed media while preserving the existing asset ID. It does not overwrite the external file. Off by default. |
| **Interval (hours)**                                                     | Sets the interval between scheduled runs; default 24 hours.                                                                                                        |
| **Concurrent downloads**                                                 | Sets the number of concurrent downloads for this connection; default 1, maximum 4, also subject to server limits.                                                  |
| **Staging budget (bytes)**                                               | Reserves space for downloads and recovery copies; default 20 GiB (`21474836480` bytes). This is separate from your account's media quota.                          |

Save changed settings before running. If you reduce the selection, downloaded recovery copies may remain in staging until they can be safely finalized. They still count toward capacity.

## What happens to existing photos?

The connector compares file contents using hashes. A renamed file can still be the same photo; matching names alone do not establish a match. An initial download may be necessary to identify an exact duplicate.

| Existing Frameleaf media                                                           | Result                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Same content and healthy file                                                      | Reuses the existing asset instead of importing another copy.                                                              |
| Matching saved content hash, but missing, corrupt, unreadable, or offline media    | Downloads and validates the matching resource, then repairs the existing asset when safe. Its ID and associations remain. |
| No matching content                                                                | Imports a new asset.                                                                                                      |
| Intentionally trashed asset                                                        | Leaves it in Trash; sync does not restore it automatically.                                                               |
| Damaged external-library match without managed-recovery permission                 | Requires review and retains the recovery copy.                                                                            |
| Uncertain identity, unsupported media, or conflicting privacy/relationship choices | Requires review rather than claiming success.                                                                             |

A database checksum alone is not enough to skip recovery: the connector verifies the destination file. A previously imported photo can therefore be fetched again if its Frameleaf copy later becomes missing or corrupt. Failed validation never counts as a repair.

See [Recover missing or corrupt media](media-recovery.md) for the full workflow and how to review results.

## Apple edits and Stacks

When edit import is enabled, an available Apple-edited photo or video becomes a separate Frameleaf asset grouped with its original using **Stacks**. Open the Stack to view its members and access the original. The current Apple edit can become the displayed member when that does not override your manual Stack choice or local work.

For example, an original photo and Apple's cropped version appear together in a Stack. A later Apple edit adds another available version. Reverting in Apple removes the current edit preference; it does not delete your original, older imported versions, or independent Frameleaf edits.

Apple's finished image/video is imported; its adjustment recipe is not converted into Frameleaf editing instructions. Separate Apple photos that share identical original bytes keep their source relationships and distinct edits, although their original may reuse one destination asset.

Up to **20 distinct retained Apple edit versions per source photo** can be admitted. A new version above that ceiling requires review; existing versions are preserved. Repeatedly choosing Retry does not bypass the limit. Ask your administrator for help reviewing retained versions before removing anything.

## Live Photos and RAW alternatives

A Live Photo contains a still image, such as JPG or HEIC, and a short movie. The connector uses Apple source identities to link these through Frameleaf's native Live Photo relationship. The movie becomes the still's motion component rather than a separate timeline item.

If only the movie is missing or corrupt, the connector can recover that component without replacing the healthy still. General pairing of files already imported outside this connector remains available under **Utilities → Relink live photos**.

Available original and RAW alternatives are preserved as their own resources. An available JPEG preview is not substituted for an original HEIC or RAW file. Unsupported decoding is reported for review.

## Albums and metadata

Source album names, nesting, and memberships are kept where reliable source information is available. Connections have their own album organization, and albums with identical names retain separate identities. Existing or repaired assets can receive their source album memberships without another import.

A complete source inventory can remove a membership managed by that connection. It does not remove an independently managed membership or delete your local albums. Source album deletion does not delete destination photos.

Favorites, hidden status, and capture dates are supported. Metadata locks and tracked local changes remain authoritative; missing source data does not erase destination values. On the first sync of an existing asset, a source favorite can replace Frameleaf's default false value because an earlier untracked manual false cannot be distinguished from that default. Later comparisons use the saved sync history.

Source captions, locations, and timezone fields are not currently supported by the verified adapter. Existing extracted or locally entered values are preserved. Unhiding a photo in Apple does not automatically remove a Frameleaf privacy choice.

## Monitor, pause, and resume

Choose **Refresh** to read saved progress. Counts survive closing the page or restarting the server; they are not a live animation of each download.

| Control                  | Use it to                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **Run now**              | Start or continue work using saved settings.                                                       |
| **Pause**                | Stop further work while preserving resumable state.                                                |
| **Resume**               | Continue a paused connection with a saved Apple session.                                           |
| **Cancel current run**   | Stop current work while retaining imported assets and resumable recovery state.                    |
| **Retry failures**       | Retry failed or reviewable work after addressing its cause.                                        |
| **Reconcile and rescan** | Rebuild the source inventory and recheck mappings. This is not a delete-and-reimport operation.    |
| **Disconnect account**   | Stop the connection and remove its saved Apple session after confirmation. Imported assets remain. |

**Logical photos and videos** and **File resources** are different totals. One Live Photo has a still and movie; an edited photo or RAW pair may have additional resources. Imported, reused, repaired, staged, and review counts describe different stages or outcomes and should not be added together as a total number of photos.

**Recent verified results** links to **View media** and resolved missing/corrupt history. **Committed; follow-up pending** means the database change has been saved but follow-up work remains. Authentication challenges, incomplete inventories, and deferred repairs are not completed imports.

## Troubleshooting

| What you see                                         | What to do                                                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync is not enabled                                  | Ask your administrator to complete [server setup](icloud-photos-server-setup.md).                                                                                            |
| Device approval or sign-in required                  | Approve on your trusted device or sign in again. Use **Check saved session** to check access.                                                                                |
| Waiting to retry or rate limited                     | Allow the retry delay. Do not create extra connections to bypass it.                                                                                                         |
| Incomplete inventory                                 | Load the inventory again. Do not treat missing entries as deleted photos.                                                                                                    |
| Reserved staging bytes outside the current selection | Reselect and retry if that source version is still available; otherwise ask the administrator to review retained copies and capacity. Do not empty staging manually.         |
| `staging_retained_capacity`                          | Retained recovery copies are using the available budget. Reselection/recovery or more capacity is needed; the files are preserved.                                           |
| `reserved_import_content_match`                      | Another upload created matching media after sync reserved a new asset. Ask the administrator to reconcile the retained copies. Retry alone does not change that reservation. |
| `retained_edit_limit`                                | The retained edit-version limit was reached. Review existing versions before deciding whether anything can be removed.                                                       |
| `icloud_finalization_failed`                         | Follow-up work repeatedly failed. Ask the administrator to resolve the queue/storage problem, then use **Retry failures**.                                                   |
| Unsupported or requires review                       | Check the scope below and the recovery guide. A timeout or unsupported decoder is not proof that a file is corrupt.                                                          |

## Supported media and limits

- Supports exposed originals, original Live Photo motion components, RAW alternatives, and available full-size Apple-rendered image/video edits.
- Shared sync libraries are distinct from Apple Shared Albums. Shared Albums (`CMM-*`), Apple sharing permissions, and Smart Album semantics are unsupported.
- Edited Live Photo pairing, Apple adjustment rendering, and all special slow-motion/HDR edit behavior are not supported. Do not assume these formats reproduce every Apple effect.
- At most 100 libraries and 10,000 albums per connection are supported. Larger inventories fail explicitly. The selector shows up to 200 matching albums at once; filtering helps find others.
- Interrupted downloads restart from the beginning. A run resumes its saved work, but individual file transfers do not resume from a byte offset.
- Sync does not delete orphaned transcodes or XMP sidecars. See [why health and orphan counts differ](media-recovery.md#why-do-the-counts-differ).

Administrator details for backups, encryption keys, storage, and decoder timeouts are in [server setup](icloud-photos-server-setup.md).
