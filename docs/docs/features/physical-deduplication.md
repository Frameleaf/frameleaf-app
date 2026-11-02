# Universal Storage

Frameleaf automatically reuses stored originals across managed libraries when their content matches. Each account keeps its own asset records, albums, favourites, metadata, faces, edits, stacks, sharing permissions and Locked state. External-library files remain outside managed storage.

Each library is charged the full logical size of its media even when several libraries share a stored file. Physical storage usage measures the bytes actually stored.

Unedited generated files can share the original's primary asset's derivatives. Regenerating a copy keeps those shared paths, including older derivatives whose physical-file registration is still pending. Edited outputs remain independent.

Deleting a library record does not remove a file another record still references. If a primary asset is removed, another referencing asset can take over storage responsibility.

## Unused files

The server owner (the first administrator account) can open **Settings > Library care > Unused files** to review stored originals no photo uses any more. Other administrators and members don't see it. The list shows file names, sizes, the library each file was last in, and how much space they hold together.

Restore returns a file to its last library. Files whose account has been deleted cannot be restored there. **Empty Unused files** deletes every file in it from the drive for good and gives the space back; it asks first and says how much space comes back.

New uploads need no plan: matching content is reused when it is stored.

## Identical files

Frameleaf also checks the whole server for identical files, with no account to pick. Files are identical when their SHA-256 and size, read from disk, match. A check reads every managed original again and then:

- **Across people**, every person keeps their own photo, and all of them point at one file: the oldest copy. The other copies move to Unused files once nothing uses them. Each photo still shows its own folder.
- **Inside one library**, two identical photos become one. The oldest is kept, and it takes the other's albums, tags, favourite, rating and description. The other goes to the Trash as a duplicate decision that you can undo. A photo with edits, a stack, shares, face corrections or a different Locked state is left for Duplicate review instead.
- **Orphaned files** in the storage folders that no photo points at are recovered for the owner of their folder, into an album called **Recovered Media**. Content the owner already has, and damaged files, go to Unused files.

The check runs by itself after every library import (see [One-time offline import](../administration/import-immich.md)). No check deletes a file, and external libraries are never touched. Every merge is listed under **Merged for you** in Duplicate review, where it can be undone: an undone link restores that photo's own file from Unused files. A link or merge that was undone is never redone automatically. **Settings > Library care > Duplicates** shows the space saved, when the files were last checked, **Check again**, and any files the check had to skip.

Keep an independent, verified backup: reusing one stored file does not protect it against disk loss.
