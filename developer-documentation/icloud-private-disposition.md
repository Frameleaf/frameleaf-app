# Scheduled iCloud private-copy disposition

This is a source contract for failed scheduled weekly recovery work. It is not full FL-296
acceptance or permission to enable the worker. Execution stays unavailable by default. No
schema migration, provider authority, manual recovery policy or physical-original trash policy
is added.

The server reserves a second full expected-size copy against the existing global and connection
staging budgets before creating it. The resource verification JSON retains the existing receipt
fields and adds a typed generation, planned exclusive paths, owner, operation/resource lease
epochs and whole-item claim. An exclusive `O_EXCL | O_NOFOLLOW` handle supplies the actual
device, inode, uid and current size before copying or promotion. Server-authenticated receipts
bind that ownership. A hash, operation snapshot, client payload or existing destination is not
ownership. `EEXIST` never grants ownership of the destination.

Pending work is durable before copying, decoder preparation or readonly checks. Settlement
requires the actual decoder, delayed readonly work and owned handle/input cleanup to complete.
An immediate timeout result does not settle it. A failed final ownership write or file close
leaves the generation pending and charged. Restart never infers that an unobserved decoder is
dead. Legacy generations, preparation failures without complete settlement, and restart-pending
generations remain private and charged for later reviewed recovery.

Credential-independent housekeeping accepts only terminal failed/stale/cancelled requests and
the original authenticated generation. It holds owner, operation, whole-item, resource
and managed path/reference fences. It refuses committed resources, published assets, reused
destinations, outboxes, replacement claims, other recovery reservations, physical-file records and
all existing managed/buddy/protected/version references. It opens only the named owned inode
with `NOFOLLOW` and checks the directory and opened/named identities before unlinking. These
are managed-writer fences; they do not claim global filesystem atomicity against external writers.

Claim creation/replacement and terminal cleanup share a transaction fence for owner plus
uppercase CPLAsset name. Still and motion roles use the same whole-item name. The fence is
taken before claim-writer rows or cleanup owner/operation/resource
locks; multi-item writers sort canonical names. Cleanup also locks the canonical claim row
regardless of id or expiry before checking for a live replacement and holds both fences through
unlink and byte settlement. The shared fence covers absent-row insertion, while the row lock
also serializes renewal/release. Hosted concurrent contracts use PostgreSQL backend blocking
locks as their witness, with cleanup paused after authority checks and before real unlink.

Charge decreases only after actual unlink or same-generation `ENOENT`. The disposition receipt
is server authenticated. A database rollback after unlink retains charge and the old generation,
so a later retry can finish without fabricating freed bytes or deleting a replacement inode.
Source staging is removed only after copy disposition and independently authenticated source
ownership and work settlement. Publication/destination registry/proof/outbox transactions keep
their existing authority and rollback behavior.

The hosted PostgreSQL/filesystem contracts exercise real producers and seals, credential loss,
idempotent restart, `EEXIST`, forged owner/generation JSON, inode and claim replacement, reference
refusal, unlink failure, database rollback after unlink, ownership persistence failure, and late
decoder settlement. Negative decoder/fault injections are not genuine successful provider work.
The canonical adaptation still requires PostgreSQL/filesystem execution in the shared test slot.

Remaining qualification includes hosted exact-head checks and independent review, genuine
source-descriptor mismatch and rollback evidence through the whole weekly worker, unknown
restart/pending-generation recovery, and complete transient decoder-input peak quota accounting.
This packet reserves the second recovery copy; it does not claim to reserve every transient
decoder copy. Full weekly activation, manual recovery, retirement and physical-trash acceptance
remain separate gates.
