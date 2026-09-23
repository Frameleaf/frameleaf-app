# Locked

Locked keeps photos and videos private without moving them anywhere. A locked item stays in its albums, stacks, favorites and tags; it is hidden from every view until you unlock your session with your PIN, and it is always listed in **Locked** for you once you have.

## One lock

Every locked item has exactly one lock, and the lock records why it was locked:

- **Moved from old Locked folder**: it was in the upstream Locked folder when the library was upgraded (see below).
- **Marked**: you locked it with **Mark Sensitive** in the selection bar or the viewer, a sensitive review in the information panel, an upload into Locked, or an older client's "Move to Locked folder".
- **Detected**: sensitive-content detection flagged it while **Hide detected NSFW assets** is on.

A lock is metadata. Locking never changes an item's albums, stack, favorites, tags, faces or its place in the timeline or archive, and unlocking returns it exactly where it was.

Stacks and live photos lock and unlock as a whole: locking one photo of a stack locks the whole stack, and the video part of a live photo is locked with its photo.

## Who sees a locked item

- **You, while your session is locked**: nothing. The item is left out of the timeline, albums, search, the map, memories, people, pets and downloads. Your own devices still sync it, marked locked.
- **You, after unlocking with your PIN**: **Locked** lists every locked item. Your timeline also shows the items you marked and the ones detection locked ("Revealed for this session"); items moved from the old Locked folder stay in Locked only. Albums show their locked members.
- **Partners, album and space members**: never, whatever their own session.
- **Shared links**: never.
- **Server jobs** (thumbnails, machine learning, backups, restorations): always. Background work is never skipped because an item is locked.

A locked photo is never an album, collection or space cover, a person's or pet's featured photo, a face thumbnail or a profile picture source. Locking one releases every such use; each falls back to another photo (Best Photos first), or to none.

## The Locked view

Open **Locked** after unlocking. It lists every locked item, newest first, with a filter: **All** (the default), **Moved from old Locked folder**, **Marked** and **Detected**. Each tile is badged **Locked** (moved from the old folder) or **Sensitive** (marked or detected).

Select items and choose **Unmark Sensitive** to unlock them. Unlocking a marked or detected item also records your review as safe, so running detection again never locks it again. You can still add locked items to albums, download them, change their date or location, or delete them permanently from Locked.

## Upgrading from an Immich library

The upgrade moves everything in the upstream Locked folder into the lock, so nothing that was private becomes visible and nothing disappears:

1. Every item in the Locked folder gets a lock with the reason **Moved from old Locked folder** and returns to the timeline as its place (the video part of a live photo stays hidden). It stays hidden until you unlock, and it is listed in Locked.
2. Every item you had marked sensitive gets a **Marked** lock.
3. Items flagged by detection get a **Detected** lock only if **Hide detected NSFW assets** was on in the saved settings; with it off they were never hidden, so they stay where they are. Turning the setting on later locks the unreviewed detections at that moment.
4. Stacks that were partly locked are locked as a whole, and the covers the locked photos held are replaced.

The migration (`2100000000320-AddAssetLock`) is safe to run again and changes nothing the second time. If **Hide detected NSFW assets** is set only in a configuration file, the upgrade cannot see it; run **NSFW Detection > All** once afterwards to lock the existing detections.

Going back to a release without lock records restores the upstream Locked folder: every locked item is set to `visibility = locked`, so it stays hidden there.

## For API clients

- `POST /assets/lock` and `POST /assets/unlock` (body `{ "ids": [...] }`) lock and unlock. Unlock needs a PIN-unlocked session; lock does not, since it only hides.
- `visibility: locked` is never stored. In requests it still means "lock" (`PUT /assets`, uploads), and asking for `visibility: locked` in timeline and search requests lists the Locked view. Responses report `visibility: locked` for a locked item.
- Time bucket requests with `visibility: locked` accept `lockReason` (`marked`, `detected` or `immich-locked-folder`) and return a `lockReason` array.
- Setting any other visibility on a locked item unlocks it first, as leaving the upstream Locked folder did.
