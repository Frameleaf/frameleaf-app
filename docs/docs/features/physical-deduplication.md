# Universal Storage

Frameleaf automatically reuses stored originals across managed libraries when their content matches. Each account keeps its own asset records, albums, favourites, metadata, faces, edits, stacks, sharing permissions and Locked state. External-library files remain outside managed storage.

Each library is charged the full logical size of its media even when several libraries share a stored file. Physical storage usage measures the bytes actually stored.

Unedited generated files can share the original's primary asset's derivatives. Regenerating a copy keeps those shared paths, including older derivatives whose physical-file registration is still pending. Edited outputs remain independent.

Deleting a library record does not remove a file another record still references. If a primary asset is removed, another referencing asset can take over storage responsibility.

## File Trash

Administrators can open **Settings > Utilities > File trash** to review stored originals no library still references. The list shows file names, sizes and the last owning account.

Restore returns a file to its last library. Files whose account has been deleted cannot be restored there. Permanent deletion asks for confirmation.

New uploads need no plan: matching content is reused when it is stored. Copies stored before universal storage can still be merged from **Settings > Storage & originals > Physical deduplication**, which previews a plan for the account you pick on the page before anything is applied.

Keep an independent, verified backup: reusing one stored file does not protect it against disk loss.
