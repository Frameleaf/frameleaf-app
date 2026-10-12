# Scheduled iCloud private-copy disposition

This source contract covers scheduled weekly recovery copies and validation inputs. It specifies
required custody, accounting and disposal behavior; it does not establish final implementation
acceptance or permission to enable the worker. Execution stays unavailable by default. No schema
migration, provider authority, manual recovery policy or physical-original trash policy is added.

## Recovery-copy custody

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

## Full validation-input reservation

The explicit full-size validation input has its own charge, separate from the staged source and
any recovery copy. Reserve its full expected size against both existing connection and global
budgets before creating its directory or file, copying bytes, or submitting the decoder. Check
the existing free-space watermark before copying as well. Source 10 plus input 10 reserves 20;
source 10 plus recovery 10 plus destination input 10 reserves 30. Disposing only the input leaves
10 or 20 respectively. Partial copying, settlement and cancellation never reduce that charge.

The existing verification JSON carries a purpose-authenticated `auditValidationInputs` envelope.
It binds the owner, request, operation and resource lease, whole-item claim, fresh source evidence,
stage, planned exclusive paths and actual private directory/input identities. Recovery-destination
inputs also bind the recovery generation. Persist the empty input's custody before writing, then
persist its final identity before decoder submission. Exclusive creation conflicts, failed closes
or failed identity writes retain the reservation; they do not establish an absent input.

Preliminary readonly work is covered by a durable work token before it starts. Finish that token
only after its reads and closes succeed, then reserve the input and persist its current work token
before input creation. Keep ownership until copying, decoder termination, delayed readonly/hash
and proof work, and every owned handle close actually finish. A refused or timed-out result may
return earlier, but cannot manufacture successful settlement. Normal-success publication must wait
for authenticated settlement and input disposal; a disposal or final-readonly-close failure must
prevent successful publication.

Each resource retains at most one current generation and one previous disposed receipt. Its
canonical decimal-string high-water mark advances with exact integer arithmetic and never resets
while the resource exists. This bounds history, without a lifetime validation-attempt cap.
Scheduled pause, resume, returned-attempt and deferral behavior remains supported. A new generation
requires committed disposal of the current one; source and recovery-destination inputs cannot
coexist as undisposed generations for the same resource.

## Input disposal, replay and restart

Input reservation and refund use the whole-item fence, then the global staging-budget fence,
then local owner/operation/request/claim/resource and sorted managed-path/reference fences.
Authenticated settled input disposal is local and credential independent; it does not require a
live Apple session or weekly grant, and can apply to a successful input. Recovery-copy terminal
cleanup above keeps its separate authority. Live replacement claims or leases, changed custody,
foreign generations and managed references refuse input unlink and retain the full charge. The
only self-reference exception is the exact resource, sequence and path nonce, never an entire
resource. Same-resource destination and other-generation references remain conflicts.

Unlink only the authenticated owned input after checking the parent, opened `NOFOLLOW` handle,
named inode, private permissions, exact size and absence of unexpected entries. Keep its generation
directory until the disposed receipt and exact input-byte subtraction commit together. If the
transaction rolls back after physical unlink, the settled generation and full charge remain; the
same authenticated generation may retry `ENOENT` only with unchanged owned parent and local
fences. Later empty-parent removal is idempotent and grants no refund authority. Recursive removal
is never input-disposal evidence.

Committed disposed replay never subtracts twice. A retained previous disposed receipt can
acknowledge its own generation without changing a successor's charge or record. An evicted or
foreign receipt cannot settle, refund or replace the current generation.

Restart discovery must find input envelopes independently of recovery receipts, promoted paths
and request outcomes, including source-only successful validation. It must make progress past
already disposed history to retained inputs. Only authenticated actual settlement permits local
disposal. Unknown, pending, malformed, unsealed or unsupported-version evidence remains private
and fully charged, even after cancellation, credential loss or a process restart. Housekeeping
must not resume an unknown decoder, infer it dead, or recursively remove its input.

Whole-row cleanup, finalization and connection deletion must retain undisposed or unknown input
evidence in quota-counted state. Recovery-copy subtraction preserves input bytes. A disposed
input alone never authorizes source or recovery deletion. All release paths must authenticate
disposal in the same resource transaction before zeroing charges or invoking physical cleanup.

Existing recovery and work receipt versions keep their meaning. An absent input envelope leaves
manual/non-scheduled behavior unchanged. Scheduled legacy work additionally needs authenticated
settled work with no pending tokens and consistent recovery/accounting before first input admission
or whole-row release. Absence alone does not prove that an old decoder has stopped. Do not backfill
ownership, reset generation marks, clear reservations or reclaim historical finalized/removed rows.

## Qualification and upgrade gates

Repository SQL results, service/mock results, final-head execution and activation are separate
claims. Qualify the final combined candidate after all lifecycle and release guards are present.
Prerequisite repository passes do not establish final service, restart or publication acceptance.

| Area | Required final-candidate evidence |
| --- | --- |
| Admission and quota | Actual source/destination copy refuses before creation and decoder submission at connection/global limits; full source/recovery/input sums and free-space refusal remain correct. |
| Concurrent accounting | Independent PostgreSQL sessions and exact blocking-lock witnesses cover identical nonce replay, distinct-resource connection/global contenders and item-before-budget order for allocation, recovery and disposal. |
| Disposal and retry | Hold actual post-unlink/pre-disposed-CAS work; a successor remains blocked; commit refunds exactly once; rollback retains charge and parent for same-generation retry. Live replacement claims and path references refuse unlink. |
| Service lifetime | Actual late decoder and readonly/hash/proof work and failed closes prevent settlement/publication; success disposes before publication; pause/resume/deferral continues beyond eight validations. |
| Restart and release | Source-only and terminal discovery progresses past disposed history; unknown/malformed work retains charge; every source/recovery/audit/sync/cascade release boundary preserves that evidence. |
| Compatibility | Surrounding manual audit, ordinary sync, recovery quota/cleanup and weekly consent suites pass; existing seals and historical records retain their meaning. |
| Delivery | Fresh whole-branch review and required exact-head hosted checks pass before an authorized release. Old-worker drain is separately verified before scheduled execution. |

Before enabling scheduled execution on an upgraded deployment, drain every old worker that can
create or clean these copies and verify its in-flight work has actually settled. Disabling new
admission, pausing an operation, a timeout or a container restart is not drain evidence. Preserve
unknown legacy custody and matching database/staging state for reviewed recovery. Old workers
cannot enforce the new input ledger, so mixed-version execution cannot establish this contract.

The reservation covers the explicit full-size input only. RAW renders, image decoder buffers,
native decoder scratch files and other transients can exceed it; complete decoder-peak accounting
is not claimed. Live Apple parse/fingerprint and resource-byte qualification, automatic provider
edit chronology, unknown restart-work recovery, device/native acceptance and production rollout
remain separate gates. Full weekly/adoption activation, manual recovery, retirement and physical
trash acceptance remain separately authorized.
