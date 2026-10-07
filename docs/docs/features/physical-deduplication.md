# Universal Storage

Frameleaf automatically reuses stored originals across managed libraries when their content matches. Each account keeps its own asset records, albums, favourites, metadata, faces, edits, stacks, sharing permissions and Locked state. External-library files remain outside managed storage.

Each library is charged the full logical size of its media even when several libraries share a stored file. Physical storage usage measures the bytes actually stored.

Unedited generated files can share the original's primary asset's derivatives. Regenerating a copy keeps those shared paths, including older derivatives whose physical-file registration is still pending. Edited outputs remain independent.

Deleting a library record does not remove a file another record still references. If a primary asset is removed, another referencing asset can take over storage responsibility.

## File Trash

Administrators can open **Settings > Utilities > File trash** to review stored originals no library still references. The list shows file names, sizes and the last owning account.

Restore returns a file to its last library. Files whose account has been deleted cannot be restored there. Permanent deletion asks for confirmation.

Universal storage requires no retained-account selector or preview, review and apply plan. The former physical-deduplication administration route opens the file-trash utility.

Keep an independent, verified backup: reusing one stored file does not protect it against disk loss.
