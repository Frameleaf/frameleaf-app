# Library import recovery records

The shared migration workflow is under development. `ImportTransferJournal` is an internal Manager record store; it does not copy, move or adopt files and is not exposed by a command or UI. The existing import command is unchanged. All ten source families still require combined qualification before release.

The journal uses Manager's existing private SQLite database, synchronous durable writes and single active operation lock. A run is bound to immutable manifest and reviewed-plan SHA256 fingerprints. Mutation requires its active `import` operation; an interrupted operation retains that ownership. Each transfer records its source and destination root IDs and relative paths, original byte count/checksum, mode, source filesystem identity and destination device. Paths are validated without accessing them. Relocation across different recorded devices is refused; actual mount identity must still be independently verified by the worker.

The transfer lifecycle is `intent` → `verified` → `rollback-intent` → `rolled-back`. Intent is committed before a filesystem effect. Verification and rollback completion require matching byte counts and SHA256 receipts. Duplicate file intents must match exactly, and two records cannot claim the same destination root/path. Forward intent cannot be replayed once rollback or cancellation begins. Transactions serialize competing journal instances; this does not replace the operation controller's responsibility to run one filesystem worker. A crash with only intent leaves the effect ambiguous: the worker must reconcile actual source/destination files and verify bytes through the recorded paths before marking completion or beginning reversal.

If the worker verifies that no forward effect occurred, `cancelIntent` records a separate terminal `cancelled` state. Its receipt requires the unchanged source filesystem identity, matching bytes/checksum and confirmed destination absence. It does not manufacture successful forward verification. These assertions must come from the fenced filesystem worker, which also checks temporary files and aliases; the journal performs no filesystem inspection itself.

Before activation, `sealPlan` persists the complete reviewed versioned plan: source identity/revision/schema, destination identity, explicit owner ID mappings, absolute storage roots with device/inode identities, and the full physical-file transfer inventory. Its SHA256 must match the run's reviewed-plan fingerprint. Existing intents must match that inventory; subsequent intents cannot add or change files. Owner mappings cannot merge source accounts into one destination account. The plan contains no connection credentials or source authentication material. Root validation checks syntax and recorded identities, not actual mounts.

`recordVerification` retains matching expected/actual SHA256 receipts for records, relationships and permissions, bound to the manifest and plan fingerprints, plus a durable regeneration run ID. The controller must produce these digests from complete, independently reconciled canonical inventories and verify that the regeneration run exists; this record store does not query the destination database or schedule work. Changed receipts are refused. All planned files must be present and verified before recording reconciliation or starting writers, including after restart. A rollback or cancellation invalidates readiness even when earlier reconciliation evidence remains retained.

`writersStarting` records a conservative boundary before starting destination writers. It requires the sealed plan, complete verified transfer inventory and reconciliation receipt, and prevents any subsequent ordinary transfer or rollback transition, even if starting writers later fails or loses its acknowledgement. This marker is not activation authorization: the controller must also establish current source/destination fencing and verify actual records, permissions and scheduling. Post-boundary recovery requires a separate procedure. `review` exposes the retained plan and reconciliation evidence for recovery, including after abandonment.

`abandon` marks the run without deleting transfer records or releasing the existing operation lock. It performs no media cleanup. Read access to recovery records remains available after abandonment. The controller must retain recovery evidence and require a fresh destination rather than automatically restarting the source.

## Remaining integration

Qualified roots, physical containment, symlinks/hardlinks, aliases, source changes, non-overwriting filesystem operations, source/restart fencing, low-space checks, file fsync and mount validation belong to the transfer worker and are not proved by journal receipts alone. Destination ID mappings, protected metadata archives, account/privacy reconciliation, Server lifecycle commands, Manager review/progress/recovery UI and end-to-end interruption acceptance remain outstanding. Journal unit tests exercise real SQLite restart, competing instances, immutable plans, checksums, collisions, operation ownership, abandonment and the write boundary; they do not qualify media relocation.

## Internal verified-copy worker

`copyImportFiles` consumes existing copy intents on Linux. The controller must supply reviewed root mappings and their recorded device/inode identities, a private destination namespace exclusive to this operation, one filesystem worker, and fenced source and destination writers. Resume is permitted only within that previously prepared namespace. These prerequisites are not established by a `resume` flag or by a matching file prefix; controller integration must prove them before exposing this worker.

The worker opens roots and parent directories through Linux descriptors without following symlinks, rejects submount changes and checks the source's recorded identity. Destination roots must be private to their owner and parent directories must already exist. Fresh files use exclusive creation, while resumed files must contain an exact prefix of the unchanged original. Only missing tail bytes are appended; mismatching content is retained and refused. Source files are never modified or removed. Destination hardlinks and links to the original are refused. File offsets above JavaScript's maximum safe integer are refused rather than rounded.

Completion checks original and destination SHA256 values, stable filesystem identities, current directory entries and root identities. The destination file and containing directory are synced before journal verification is recorded. Cleanup attempts every acquired handle even if another close fails. A failed copy retains its intent and partial file for reconciliation.

Native synthetic checks passed on the pinned Manager Node 22.23.4 ARM64 Linux image: independent original bytes, restart with a partial prefix, collisions, mismatches, symlinks, hardlinks, changed roots/sources and injected close failure. A separate isolated 128 MiB tmpfs probe produced kernel `ENOSPC`, retained a 6,123,520-byte prefix and the original, then resumed to the verified 33,554,432-byte destination after space was freed. This evidence covers the copy primitive, not full migration acceptance.

The worker is not wired to a command, API or UI. Capacity preflight, durable root/namespace preparation, fencing/controller integration, cancellation, owner/library fanout, database relationships and regeneration remain outstanding. Adoption and copy-mode rollback are not implemented here. The separate relocation primitive below also remains internal. No expanded import support is released by this stage.

## Internal reversible-relocation worker

`relocateImportFiles` and `rollbackImportRelocations` consume existing relocation
intents. They are not exposed by a command, API or UI. The controller must bind
absolute root paths and device/inode identities into its reviewed
plan; keep source services and every restart mechanism fenced; and run one worker.
Source and destination roots must share a device and mount ID. Mount IDs are
captured after validating the planned root identities, checked throughout one worker
run, and reacquired for a resumed process; they are not durable filesystem
identifiers. Changed planned device/inode identities require separate storage
recovery. The destination namespace must remain private and exclusive to this operation. Unknown roots,
changed mount identities, unsafe path components, symlinks, multiple hardlinks,
changed originals and filename collisions refuse the operation.

The Manager image builds a small Linux helper that calls `renameat2` with
`RENAME_NOREPLACE` directly through inherited directory descriptors. It has no
copy, unlink or non-atomic replacement fallback. Unsupported kernels/filesystems,
cross-mount moves and existing destination entries are refused. The helper checks
regular-file identity before and after the move and syncs both directories. The
Node worker independently verifies original inode, size, modification time and
SHA256; rechecks directory entries and mount identities; syncs the file/directories;
and only then writes durable completion. Rename changes inode change time, so
resumed moved files are checked through the journal's destination path with their
original device/inode, modification time and byte hash.

A move failure can have an ambiguous effect: retain intent and both recorded paths.
Never delete either side or silently overwrite a conflict. Forward resume reconciles
a present source or a moved destination. Rollback persists its own intent before the
reverse move; it can recover a forward effect without its verification checkpoint
and a reverse effect without its completion checkpoint. An unchanged, unapplied
intent becomes `cancelled`. Destination writers prevent ordinary rollback even if
their startup acknowledgement was lost. Abandonment retains media and recovery
records; post-boundary recovery still requires a separate procedure.

Native synthetic ARM64 Linux tests cover forward/reverse inode-preserving moves,
durable journal reopen, interrupted checkpoints, source/destination collisions,
changed originals, symlinks, hardlinks, private roots, mount changes and the write
boundary. Fault injection against the actual helper verifies refusal when atomic
rename is unavailable. An independent isolated kernel syscall denial probe also
retains the source and leaves the destination absent. These checks use generated
bytes only; they do not qualify every storage filesystem or a complete migration.
A separate generated-volume probe terminated the process after a move but before
its verification checkpoint. Fresh containers resumed verification and rolled back,
preserving the original inode and bytes. Mount IDs happened to match in that probe;
a separate renumbering fault test covers reacquisition. Full host reboot and
filesystem-identity rebinding remain unqualified.

Linux unit tests compile the current helper with a C compiler in private temporary
storage. The compiler is present only in the image build stage; production uses
the installed helper.

Capacity and namespace preparation, authenticated fencing, complete source
inventories, owner/library fanout, in-place adoption, original source metadata
archives, destination reconciliation, Server lifecycle commands, Manager journeys
and combined ten-source acceptance remain outstanding. Remote/object/encrypted
sources require a separately qualified plaintext staging export; a matching device
number alone does not establish such qualification. No expanded adapter support,
release or deployment is authorized by this primitive.
