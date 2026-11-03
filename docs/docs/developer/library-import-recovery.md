# Library import recovery records

The shared migration workflow is under development. `ImportTransferJournal` is an internal Manager record store; it does not copy, move or adopt files and is not exposed by a command or UI. The existing import command is unchanged. All ten source families still require combined qualification before release.

The journal uses Manager's existing private SQLite database, synchronous durable writes and single active operation lock. A run is bound to immutable manifest and reviewed-plan SHA256 fingerprints. Mutation requires its active `import` operation; an interrupted operation retains that ownership. Each transfer records its source and destination root IDs and relative paths, original byte count/checksum, mode, source filesystem identity and destination device. Paths are validated without accessing them. Relocation across different recorded devices is refused; actual mount identity must still be independently verified by the worker.

The transfer lifecycle is `intent` → `verified` → `rollback-intent` → `rolled-back`. Intent is committed before a filesystem effect. Verification and rollback completion require matching byte counts and SHA256 receipts. Duplicate file intents must match exactly, and two records cannot claim the same destination root/path. Forward intent cannot be replayed once rollback or cancellation begins. Transactions serialize competing journal instances; this does not replace the operation controller's responsibility to run one filesystem worker. A crash with only intent leaves the effect ambiguous: the worker must reconcile actual source/destination files and verify bytes through the recorded paths before marking completion or beginning reversal.

If the worker verifies that no forward effect occurred, `cancelIntent` records a separate terminal `cancelled` state. Its receipt requires the unchanged source filesystem identity, matching bytes/checksum and confirmed destination absence. It does not manufacture successful forward verification. These assertions must come from the fenced filesystem worker, which also checks temporary files and aliases; the journal performs no filesystem inspection itself.

Before activation, `sealPlan` persists the complete reviewed versioned plan: source identity/revision/schema, destination identity, explicit owner ID mappings, absolute storage roots with device/inode identities, and the full physical-file transfer inventory. Its SHA256 must match the run's reviewed-plan fingerprint. Existing intents must match that inventory; subsequent intents cannot add or change files. Owner mappings cannot merge source accounts into one destination account, including differently cased spellings of the same UUID. Valid mappings retain their reviewed spelling and fingerprint. The plan contains no connection credentials or source authentication material. Root validation checks syntax and recorded identities, not actual mounts.

`recordVerification` retains matching expected/actual SHA256 receipts for records, relationships and permissions, bound to the manifest and plan fingerprints, plus a durable regeneration run ID. The controller must produce these digests from complete, independently reconciled canonical inventories and verify that the regeneration run exists; this record store does not query the destination database or schedule work. Changed receipts are refused. All planned files must be present and verified before recording reconciliation or starting writers, including after restart. A rollback or cancellation invalidates readiness even when earlier reconciliation evidence remains retained.

`writersStarting` records a conservative boundary before starting destination writers. It requires the sealed plan, complete verified transfer inventory and reconciliation receipt, and prevents any subsequent ordinary transfer or rollback transition, even if starting writers later fails or loses its acknowledgement. This marker is not activation authorization: the controller must also establish current source/destination fencing and verify actual records, permissions and scheduling. Post-boundary recovery requires a separate procedure. `review` exposes the retained plan and reconciliation evidence for recovery, including after abandonment.

`abandon` marks the run without deleting transfer records or releasing the existing operation lock. It performs no media cleanup. Read access to recovery records remains available after abandonment. The controller must retain recovery evidence and require a fresh destination rather than automatically restarting the source.

## Remaining integration

Qualified roots, physical containment, symlinks/hardlinks, aliases, source changes, non-overwriting filesystem operations, source/restart fencing, low-space checks, file fsync and mount validation belong to the transfer worker and are not proved by journal receipts alone. Controller integration of destination ID mappings, protected metadata archives, account/privacy reconciliation, Server lifecycle commands, Manager review/progress/recovery UI and end-to-end interruption acceptance remains outstanding. Journal unit tests exercise real SQLite restart, competing instances, immutable plans, checksums, collisions, operation ownership, abandonment and the write boundary; they do not qualify media relocation.

## Internal verified-copy worker

`copyImportFiles` consumes existing copy intents on Linux. The controller must supply reviewed root mappings and their recorded device/inode identities, a private destination namespace exclusive to this operation, one filesystem worker, and fenced source and destination writers. Resume is permitted only within that previously prepared namespace. These prerequisites are not established by a `resume` flag or by a matching file prefix; controller integration must prove them before exposing this worker.

The worker opens roots and parent directories through Linux descriptors without following symlinks, rejects submount changes and checks the source's recorded identity. Destination roots must be private to their owner and parent directories must already exist. Fresh files use exclusive creation, while resumed files must contain an exact prefix of the unchanged original. Only missing tail bytes are appended; mismatching content is retained and refused. Source files are never modified or removed. Destination hardlinks and links to the original are refused. File offsets above JavaScript's maximum safe integer are refused rather than rounded.

Completion checks original and destination SHA256 values, stable filesystem identities, current directory entries and root identities. The destination file and containing directory are synced before journal verification is recorded. Cleanup attempts every acquired handle even if another close fails. A failed copy retains its intent and partial file for reconciliation.

Native synthetic checks passed on the pinned Manager Node 22.23.4 ARM64 Linux image: independent original bytes, restart with a partial prefix, collisions, mismatches, symlinks, hardlinks, changed roots/sources and injected close failure. A separate isolated 128 MiB tmpfs probe produced kernel `ENOSPC`, retained a 6,123,520-byte prefix and the original, then resumed to the verified 33,554,432-byte destination after space was freed. This evidence covers the copy primitive, not full migration acceptance.

The worker is not wired to a command, API or UI. Capacity preflight, durable root/namespace preparation, fencing/controller integration, cancellation, owner/library fanout, database relationships and regeneration remain outstanding. Adoption and copy-mode rollback are not implemented here. The separate relocation primitive below also remains internal. No expanded import support is released by this stage.

## Complete bundle file ownership

Every physical file in manifest versions 1 through 5 must be referenced by at least one logical photo with a known source owner. This includes originals, sidecars and companions. Parsing and fingerprinting refuse an unreferenced file with `FILE_OWNER_RELATIONSHIP_REQUIRED`; bundle verification refuses it before accessing the filesystem. An archive-only file needs an explicit ownership contract before it can enter this inventory. Empty inventories and source users without photos remain valid, and valid owned inventories retain their existing fingerprints.

Multiple photos may retain a relationship to the same source file without merging their owners. Structural links do not prove source ownership, permission equivalence or safe destination storage/deduplication; adapters and the controller must independently qualify those boundaries. The selected-file byte verifier remains independent of bundle ownership, and the photo writer still refuses unsupported sidecars or companions until their destination handling is implemented.

## Server journal and startup fence

`LibraryImportJournal` records a generic import in the destination's canonical PostgreSQL database. Its immutable binding includes the Manager operation ID, manifest and reviewed-plan SHA256 values, and source family, version, identity, revision and schema fingerprint. Unknown binding fields are refused. Initial admission reuses canonical fresh-destination checks and permits one unused setup administrator with [scoped setup records](#destination-setup-account); a journal from `import-immich` blocks starting another source. Import qualification, canonical schema preflight and source/service fencing remain controller obligations.

The generic journal and `import-immich` use the same database advisory lock. A competing importer is refused before it writes. Source-to-destination mappings retain entity kind, source ID, destination ID and the expected converted-record fingerprint. Source IDs must already distinguish any owner/library namespaces used by the adapter. The destination write callback and its mapping commit in one transaction. Retrying a committed mapping skips that write; changed fingerprints or destination IDs require separate review instead of silently overwriting metadata. These records do not themselves perform conversion or authorize cross-owner deduplication.

API and worker initialization checks both journal families after migrations. A generic run in `copying`, `verifying` or `abandoned` state keeps startup blocked. Abandonment retains every mapping; the schema downgrade refuses to remove any recovery records. Read-only status remains available. This internal stage has no generic activation method, public command or UI: full canonical writing, record/relationship/permission reconciliation, durable regeneration scheduling, transfer rollback and controlled activation must be integrated before expanded import support can be offered.

Synthetic PostgreSQL tests cover connection restart, lost commit acknowledgement, transaction failure between destination writing and mapping, competing writers, changed inputs, fresh-destination and setup-administrator admission and refusal cases, startup fencing, abandonment and downgrade retention. They exercise journal and transaction behavior; they do not qualify a complete source migration or power-loss durability.

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

## Destination setup account

The generic Server journal can begin on an unused destination with exactly one active, non-deleted setup administrator whose account is not awaiting a claim. Admission retains only that administrator, its private cluster group, its destination sessions, preferences and preference-change history, and its self-authored account-creation audit records. Other users, orphan groups, existing albums/media, prior library activity and user-deletion history still refuse admission. The existing `import-immich` command retains its completely empty destination requirement.

This permits `createImportedOwner` to preserve qualified source passwords after setup. Journal replay does not recreate a committed owner, overwrite the setup account, merge matching email addresses or transfer source sessions/administration. A database with no administrator can still establish an internal journal, but creating imported owners requires the destination administrator first. Source eligibility, explicit mappings, service/restart fencing, verification and the activation boundary remain separate controller requirements.

## Internal managed-photo writer

`CanonicalAssetWriter` binds the full source manifest and Manager reviewed plan to the retained operation before deriving owner IDs or destination paths. Manager plan fingerprints remain compatible, including valid UUID spelling. Changed source identity, owners, file inventories or destination identity refuse binding.

Each photo write verifies its selected destination files through Linux descriptor containment, SHA256 and the reviewed root device/inode. Within the journal transaction it resolves the operation's committed owner mapping, locks the owner quota and sorted physical paths, inserts fresh physical files, the explicitly selected primary and every additional original, source metadata and initial quota charges. Existing paths are never upserted. Capture instants and timezone-derived wall clocks retain PostgreSQL microsecond precision; imported source values are locked against stale embedded metadata regeneration. A lost commit acknowledgement reuses the committed photo identity and does not repeat the write or charge.

This internal stage accepts image/video originals with authoritative capture time/timezone and explicit original names. It refuses Locked media, sidecars/companions, titles, unknown timezones, incomplete trash state, path collisions and unresolved owner/checksum conflicts. Duplicate relationship resolution, other metadata and relationship writers, protected source archives, durable regeneration scheduling and activation reconciliation remain required before complete migrations. The writer does not establish source qualification, service fencing or transfer completion, and exposes no new public command or UI. Native database tests mock filesystem verification; a separate pinned Linux probe exercises actual file hashing, root identity, link containment and invalid inventory refusal.

## Imported tag intent

The canonical photo writer preserves explicit tag paths in the destination owner's namespace, together with the native parent hierarchy, ancestor closures and photo memberships. The reviewed manifest supplies destination-native paths; adapters must independently distinguish source hierarchies from flat names containing `/`. Empty, duplicate, NUL-containing or noncanonical paths refuse preparation rather than being silently normalized. Unicode and case remain unchanged. Tag nodes are shared only within their explicit destination owner. An existing different parent refuses the write.

Tag rows, memberships, metadata locks, quota charges and the photo mapping commit in the same transaction. Replay preserves the committed result; quota or write failure leaves no partial tag state. Both populated and explicitly empty source tag arrays are stored and locked, so stale embedded values cannot replace them during metadata extraction. Native database checks exercise the real repository's locked-property behavior and independent readback after this reprocessing. Durable job scheduling and full worker acceptance remain separate requirements.

Asset reconciliation version 2 includes the stored tag array and lock, exact owner/name/parent/color defaults, every self/ancestor closure and every photo/tag membership in its private digest. Missing, extra, reparented, renamed or cross-owner records refuse verification. The report exposes counts and a digest, not tag names. Existing imports without tag intent retain their previous metadata behavior and must still have no unexpected tag records. Source tag colors and other richer tag properties require a dedicated preservation contract; they are not inferred from path strings.

## Internal album writer

`CanonicalAlbumWriter` consumes source roles only after an adapter and the controller establish equivalent or stricter destination permissions. Manifest structure and its completeness assertions are not independent permission evidence. The writer binds the same full reviewed plan and manifest, resolves every owner/member and photo through this operation's committed mappings, verifies photo ownership, refuses Locked destinations and commits the album, owner/viewer/editor grants, photo memberships and journal mapping together. Missing mappings or interrupted writes leave no partial album or grants. Reconnection recovers the committed album identity. Empty private albums are retained.

New album activities remain disabled until source comments and activity permissions have a preservation contract. Source album hierarchies, public links, source-specific restrictions, unsupported metadata archives and complete activation reconciliation remain separate work. The native checks use the real access repository to verify viewer/editor distinctions, private-photo separation and unrelated-user refusal; filesystem verification is mocked only while preparing synthetic photo records. These checks establish internal destination behavior, not source permission equivalence or completed migration support.

## Independent album readback

`reconcileImportedAlbums` is an internal, read-only check of the current album writer's results. It binds the complete manifest and reviewed destination plan to the retained operation, requires the `verifying` phase, and takes the shared import advisory lock inside one repeatable-read, read-only database transaction. The controller must still keep source and destination services fenced; the advisory lock coordinates cooperating import operations.

Readback compares the exact album mappings and converted-record fingerprints with actual album names, owner/member roles and photo memberships. It verifies mapped owners, member account eligibility and the ownership and unlocked state of attached photos. Missing or additional albums, grants or memberships refuse reconciliation. The current writer does not import covers, hierarchy, album descriptions or other display metadata, so their destination defaults must remain unchanged. Unexpected public links or shared-space references are refused.

The result contains operation-bound counts and a deterministic, credential-free album digest. It is deliberately a separate album evidence format, not Manager's complete verification receipt. It does not verify owner credentials/profile data, unused photo records, original bytes, quotas, regeneration scheduling or source permission equivalence, and it cannot activate a migration. Full record, relationship and permission reconciliation remains required before destination writers start.

## Independent photo and original readback

`reconcileImportedAssets` independently reads the current managed-photo writer's destination records in a repeatable-read, read-only transaction under the shared import lock, in the `verifying` phase. The complete supplied prepared-photo inventory must match the manifest and every committed photo fingerprint, including media type, modified time and original filenames. It compares actual ownership, visibility/trash state, microsecond capture/local/modified clocks, manual EXIF values and locks, primary and additional original references/names, physical paths/checksums/sizes and mapped-owner quota totals. Missing or additional photos/files and changed owner mappings are refused. Every referenced original is rehashed through the reviewed Linux root identity and descriptor-contained file verifier.

The credential-free result is separate photo/original evidence, not a complete activation receipt. The controller must retain and qualify the prepared source inventory, keep writers fenced, reconcile owner profiles/credentials and other relationships, verify all transfer records and schedule regeneration before activation. Unsupported fields and source qualification remain subject to their existing refusal gates. Database tests mock filesystem verification; the underlying Linux verifier retains its separate filesystem qualification. This internal readback adds no public lifecycle command or Manager activation flow.

Manifest version 3 seals each photo's media type, microsecond modified timestamp and per-original filenames into the manifest fingerprint before its first write. Original names must cover exactly that photo's original file IDs and remain safe basenames. The writer refuses supplied preparation values that differ from those sealed fields. Version 1 and 2 parsing and fingerprints remain compatible for existing internal consumers; their separate prepared inventories still require protected retention and qualification. Source qualification, review/fencing and activation requirements apply to every manifest version.

Manifest version 4 additionally seals [explicit stack relationships](library-import-stacks.md). Its writer and independent readback preserve the selected primary and exact same-owner membership; incompatible visibility or effective album access refuses grouping. Legacy manifest versions retain their existing behavior.

Manifest version 5 additionally seals [explicit Live Photo relationships](library-import-live-photos.md). Both original assets retain their own bytes, ownership and recovery records; imported regeneration preserves the selected motion reference.

## Internal owner intent and readback

`CanonicalOwnerWriter` binds the complete manifest and destination plan before deriving source names and explicit destination owner UUIDs. It normalizes the privately supplied email and derives the owner mapping fingerprint itself, including the qualified password capability, source-login evidence and explicit password/claim disposition. A missing password capability never silently selects a claim. Replay refuses changed email, credentials or disposition; account creation and its separate private group commit atomically with the mapping, without email-based account merging or source administration.

This destination primitive accepts only independently qualified, enabled local-password owners with full access to their own library and no required second factor, external identity or other login restrictions. Missing or additional restrictions, including forced password-change policies, refuse until equivalent behavior is qualified. Explicit permitted claims cover an unavailable local verifier. Disabled, restricted, MFA-required, external-only or unknown cases refuse until equivalent destination behavior is qualified. Validating these supplied facts does not independently establish them: adapters and the controller must qualify the source snapshot and retain the private expected owner inventory for recovery. Password capabilities stay outside the public manifest and reports. Richer profiles, PIN preservation and other source restrictions remain separate preservation work; the existing import command remains compatible.

`reconcileImportedOwners` independently checks current mappings, canonical private owner fingerprints, identities, non-admin status, separate groups, password/null equality and claim/password-change flags in a repeatable-read, read-only transaction under the import lock, during `verifying`. Imported owners must not have sessions, API keys, Frameleaf identity links, OAuth IDs, password links, PINs, user metadata, sharing credentials or partner-sharing rows at this pre-activation stage. Imported album grants are checked independently against the complete manifest by album reconciliation; valid imported grants must survive owner verification. Frameleaf-specific identity/session tables must remain empty, matching fresh-destination admission, including orphaned or unexpected administrator links. The existing eligible bootstrap administrator and its local destination sessions remain separate. The report contains aggregate counts and a digest of non-secret identity/group/claim state, never credentials or credential-derived mapping fingerprints. It is owner evidence only; full content/permission reconciliation, fencing, durable regeneration and activation remain separate requirements.

## Consistent verification lifecycle

Owner, photo and album readback share `beginLibraryImportReadback`. Before its first query snapshot, it obtains a non-waiting shared lock on the recovery table, then establishes read-only repeatable-read isolation and acquires the existing importer advisory lock. A concurrent lifecycle update or importer refuses verification. The table lock prevents an abandonment commit from becoming invisible behind an earlier snapshot; readback remains unable to write destination data. Controllers still need current fencing, complete reconciliation and durable regeneration before activation.

## Retained reviewed inputs

`retainReviewedImportInputs` stores the complete validated manifest and reviewed destination plan together on the Server's existing recovery row. It checks the operation, source, both fingerprints and destination identity under the common import lock. Identical retries retain the first inventory; changed inputs and corrupted retained inputs refuse instead of being overwritten. `loadReviewedImportInputs` reads a consistent snapshot and revalidates the retained structures and fingerprints on every recovery. Ordinary journal status does not include names, metadata or storage paths from these inputs.

Retention is allowed during copying or verification. Abandoned and activated runs remain readable for recovery but reject retention writes. The additive migration permits existing runs with no retained inputs; attempting to load one explicitly refuses. Downgrade refuses to discard retained inventories. Historical migrations and the frozen baseline remain unchanged.

This internal store does not establish source completeness or privacy, perform a transfer, or authorize activation. The controller must retain these reviewed inputs before relying on journal-only recovery. Private owner inputs have the separate internal store described below; the controller must integrate both stores. Legacy prepared photo inventories still require protected retention. Credential-free unsupported source metadata has a separate [protected content archive](library-import-source-archive.md); its complete source inventory and controller integration remain required. Credentials are refused in the manifest and plan; compatible password preservation remains supported through the separate qualified account machinery. Full lifecycle/CLI/Manager integration and all-source qualification remain required.

## Private owner recovery inputs

`retainPrivateOwnerInputs` retains the complete reviewed owner inventory separately from the public manifest and plan. It reuses their bound transaction and explicit account mappings, normalizes email addresses, rejects collisions and stores each owner intent with its protected password capability. The archive contains source algorithm settings and the destination-policy protected verifier, never the raw source verifier, plaintext passwords, sessions or API keys. Recovery restores the capability only for the original operation and source/destination account IDs; it does not require access to source credentials again. Public status and reviewed-input loaders do not return this archive or its checksum, and database error diagnostics redact the recovery table's parameters and error details.

Identical retries preserve the first normalized inventory. Changes to owner intent, login evidence, credentials or claim disposition refuse. Recovery verifies the private inventory checksum and revalidates every owner against the retained manifest and destination plan. Abandoned and activated runs retain read access for recovery, while further retention writes refuse. Paired storage constraints and a downgrade guard prevent partial records and accidental removal of retained account inputs.

This is an internal recovery primitive. The controller must retain the reviewed inputs and private account inventory before writing owners. The source adapter must independently qualify login restrictions and the frozen snapshot; parsing supplied evidence does not establish its accuracy. Unsupported metadata archival, PIN preservation, lifecycle/CLI/Manager integration and complete source qualification remain required before activation.

## Held regeneration preparation

`JobRepository.prepareImportedLibraryWork` revalidates the retained version 3, 4 or 5 manifest and destination plan against the exact verifying journal. It checks complete source-to-destination photo mappings, distinct canonical photo identities, explicit owner mappings, media types and eligible personal-library rows. The common importer lock and journal row remain held while one database transaction captures every regeneration stage and its prepared marker. Interruption rolls the entire preparation back; recovery reuses the deterministic run identity and audits retained membership without replacing missing or altered snapshots.

The `library-import-derived` run retains metadata extraction, asset thumbnails, search embeddings, face detection, video encoding for videos and missing person thumbnails. Person thumbnail selections use each owner's own imported photos, including shared person groups. Face detection retains imported identities, and metadata extraction recognizes both generic runs and existing `import-immich` recovery runs, including shared active job memberships, so stale embedded face tags do not overwrite imported assignments. Imported capture/local/modified clocks remain unchanged; other manually imported metadata continues to use its existing EXIF locks. Generic preparation schedules no automatic identical-file merging.

All six stage headers, including empty stages, remain captured and held in `enumerating` state, with no executions and enumeration unfinished. Preparing again does not release them, start destination writers or authorize activation. Public run selection contains operation/destination IDs, reviewed fingerprints and preparation state; private names, source IDs, paths and credentials remain outside it. Complete content, permission, file and source reconciliation, durable activation, the public command and Manager integration still require their separate controller work and combined qualification.

## Shared-original placements

Reviewed plan version 2 separates source physical files from destination transfers. Each transfer has a unique `id` and required `sourceAssetId`/`sourceFileId`, identifying exactly one photo/file relationship in the manifest. Every relationship requires exactly one placement. The source path, byte count and SHA256 must match the manifest; all placements for one source file must retain the same root, path, filesystem identity, size and checksum. Resolved absolute destination paths and transfer IDs remain unique. Manager and Server use the same ordered wire fields and fingerprint fixture.

When several photos reference one source original, every placement must use verified copy mode. Adoption or relocation cannot safely provide separate managed originals for those references, so preflight refuses either mode before effects. Copies retain distinct destination paths and physical rows, including across owners; each owner is charged for their own originals. A shared auxiliary original can belong to separate photos within one owner when their primary checksums differ. Binding refuses same-owner duplicate primary checksums with an explicit duplicate-review requirement rather than silently merging metadata or failing midway through database writes. The controller must perform this binding before allowing transfers. Reviewed duplicate normalization and retention of every source relationship remain part of the unfinished full migration workflow.

The asset transaction stores each version 2 transfer ID, converted-record hash and allocated physical-file ID in the existing operation mapping table together with the photo, metadata, original references and quota. Reconnection reuses committed photo writes without duplicating files or charges. Independent asset readback verifies the complete placement mapping, destination path, canonical photo, byte inventory and owner accounting. File verification uses unique placement IDs even when source file IDs are shared. Manager retains both relationship IDs in its existing durable transfer receipts, including across restart and separate rollback transitions.

Version 1 plan serialization, fingerprints and successful single-reference writes remain unchanged. Version 1 binding now refuses shared source references because it has no way to identify independent placements. This internal contract adds no public import command, Manager activation flow or source compatibility claim. Source qualification, full duplicate review, protected unsupported metadata, fencing, space review and combined acceptance are still required before release.
