# Locked

Locked keeps photos and videos private without moving them anywhere. A locked item stays in its albums, stacks, favorites and tags; it is hidden from every view until you unlock your session with your PIN, and it is always listed in **Locked** for you once you have.

## Unlocking

Set a six-digit PIN in the Locked section of your account settings first. Then use the **Locked** button in the top bar, or open **Locked** in the sidebar and choose **Unlock collection**, and enter your PIN. The button changes to **Revealed** while your session is unlocked.

Locked content hides again when you leave the browser tab, after one hour, or when you choose **Hide Locked content**. Unlocking another app or device does not unlock this one: each session asks for your PIN.

## One lock

Every locked item has exactly one lock, and the lock records why it was locked:

- **Moved from old Locked folder**: it was in the Locked folder of a library you brought into Frameleaf with the [offline importer](../administration/import-immich.md). It stays hidden until you unlock, and it is listed in Locked.
- **Marked**: you locked it with **Mark Sensitive** in the selection bar or the viewer, a sensitive review in the information panel, or an upload into Locked.
- **Detected**: sensitive-content detection flagged it while **Hide flagged photos until unlocked** is on.

A lock is metadata. Locking never changes an item's albums, stack, favorites, tags, faces or its place in the timeline or archive, and unlocking returns it exactly where it was.

Stacks and live photos lock and unlock as a whole: locking one photo of a stack locks the whole stack, and the video part of a live photo is locked with its photo.

## Who sees a locked item

- **You, while your session is locked**: nothing. The item is left out of the timeline, albums, search, the map, memories, people, pets and downloads. Your own devices still sync it, marked locked.
- **You, after unlocking with your PIN**: **Locked** lists every locked item. Everywhere else, every locked item (marked, detected or moved from the old Locked folder) and every item your Locked rules hide behaves exactly like any other item ("Revealed for this session", see below). Albums show their locked members.
- **Partners**: a partner you share your library with receives your locked items, and the items your Locked rules hide, as their own copies, already locked. Only their own PIN reveals them, and until they set a PIN those copies stay hidden (the web app offers to set one). When you lock or unlock an item later, their copy follows. Your PIN never unlocks their Locked view, and theirs never unlocks yours. See [Partner sharing](./partner-sharing.md).
- **Album and space members**: never, whatever their own session.
- **Shared links**: never.
- **Server jobs** (thumbnails, machine learning, backups, restorations): always. Background work is never skipped because an item is locked. A bulk change you queue without unlocking skips any item that was locked after you queued it.

### Locked rules and what you shared

A Locked rule (the people, pets and tags you chose in the Locked rules of your security settings) hides matching items from your own sessions until you unlock. It also stops you from sharing them item by item: a matching item cannot be shared with a person, and a person you already shared it with stops seeing it, and cannot preview or export it in their Studio projects, for as long as the rule applies.

A Locked rule does not take back what you shared on purpose. An item you put in a shared album or space, or include in a shared link, stays visible there, even while it matches one of your Locked rules. To stop sharing such an item, remove it from the album or link, or lock the item itself: a locked item never reaches album or space members or shared links. Partners are different: their copies of items your rules hide arrive locked, as described above.

### Tag names

Anyone you share an item with (album or space members, partners, people you shared the item with, and shared links that show metadata) sees the tags you put on it, including a tag you use in a Locked rule. People's names work differently: everyone sees only the names they gave.

Clearing cached photos on sign-in and sign-out relies on the browser's `Clear-Site-Data` header, which browsers honour only over HTTPS (or `localhost`). On a plain-HTTP connection a shared browser can keep showing the previous person's cached thumbnails until they expire.

## Revealed for this session

Once you unlock with your PIN, the items you marked, the ones detection locked, the ones moved from the old Locked folder and the ones your Locked rules hide behave like any other item, everywhere, for you:

- **Search**: smart, metadata, text-in-photo (OCR) and Ask search find them, and facets, counts, the histogram and the places and suggestions lists include them.
- **Library views**: the timeline, the archive, Explore, memories, people and pets, Best Photos, duplicates, albums, the map, tags and folders show and count them.
- **Actions**: bulk actions (favorite, archive, add to album, change date or location, delete) and downloads work on them, and **Studio** can place them in a project, use one as a project's poster and export them.

They still never reach anybody else: album and space members, administrators and shared links never see them, and partners only ever hold their own locked copies, whatever their own session. Sharing a revealed item is not offered, and a revealed item never becomes an album cover, a featured photo or a profile picture, because those show whatever the session.

When the session locks again, they keep every place and association they have (albums, stacks, tags, people, memories, Studio projects and posters) but show nowhere, as before.

### Memories

Memories are made from locked items too, like any other item. A memory that holds even one item hidden from your session (locked, or hidden by your Locked rules) is hidden entirely while the session is locked: its title, date, cover, places and counts, in the memories list, Explore's "Days to revisit" and the memories rail, and so are its exports. Once you unlock, it shows normally with all its photos. Because the whole memory is hidden, a title or place made from a locked photo never shows while locked.

### Studio

With the session unlocked you can place any of your locked items in a Studio project like any other item, preview it, export it and make one the project's poster. When the session locks:

- The project keeps its references. Your editor hides those clips entirely, rather than showing them as missing media, and saving keeps them in the project; they come back when you unlock.
- A poster whose item is locked stays set, but the project shows its placeholder instead, and the item is not served through it. It shows again when you unlock.
- An export is judged by its sources as they are now: one made from a locked item, or from an item locked after the export was rendered, is hidden, with its library item, its download and any share of it, and it shows again when you unlock. Its library item takes the lock of its sources, and loses it again once its last locked source is unlocked. An export you locked yourself stays locked until you unlock it, whatever happens to its sources.
- A Studio bundle (the project file you download) made while unlocked carries your revealed items' files when you include media. Such a bundle is hidden, like those items, while the session is locked. Made while locked, it carries a locked item as a bare reference only.

A locked photo is never an album, collection or space cover, a person's or pet's featured photo, a face thumbnail or a profile picture source. Locking one releases every such use; each falls back to another photo (Best Photos first), or to none.

## The Locked view

Open **Locked** after unlocking. It lists every locked item, newest first, together with the items your Locked rules hide (the people, pets and tags you chose in the Locked rules of your security settings), with a filter: **All** (the default), **Moved from old Locked folder**, **Marked** and **Detected**. The three reasons narrow the view to locks, so rule matches are listed under **All** only. Each tile is badged **Locked** (moved from the old folder) or **Sensitive** (marked, detected or matched by a rule).

Select items and choose **Unmark Sensitive** to unlock them. A rule match has no lock to remove: it leaves Locked when you change your Locked rules. Unlocking also records your review as safe, so running detection again never locks the item again. You can still add locked items to albums, download them, change their date or location, or delete them permanently from Locked.

## For API clients

- `POST /assets/lock` and `POST /assets/unlock` (body `{ "ids": [...] }`) lock and unlock. Unlock needs a PIN-unlocked session; lock does not, since it only hides.
- `visibility: locked` is never stored. In requests it still means "lock" (`PUT /assets`, uploads), and asking for `visibility: locked` in timeline and search requests lists the Locked view. Responses report `visibility: locked` for a locked item.
- Time bucket requests with `visibility: locked` and no `lockReason` also list the caller's Locked-rule matches; those keep their stored visibility (`timeline` or `archive`) and have no `lockReason`.
- Time bucket requests with `visibility: locked` accept `lockReason` (`marked`, `detected` or `frameleaf-locked-folder`). The `lockReason` array comes back with them, and with every other time bucket request of a PIN-unlocked session, which reveals your marked and detected items.
- In a PIN-unlocked session, any other requested visibility (`timeline`, `archive`, in time buckets, search bodies and structured `filter`s alike) also matches your own marked and detected items with that stored visibility, reported as `visibility: locked`. Nobody else's locked items ever match.
- Setting any other visibility never unlocks: the item stays locked and only its stored visibility changes. Only `POST /assets/unlock` unlocks.
- A partner's copy of a locked item (or of an item the sharer's Locked rules hide) is locked in the partner's own library, and only the partner's PIN-unlocked session reveals it.
