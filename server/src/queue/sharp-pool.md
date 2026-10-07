# Sharp process isolation

`MediaRepository` delegates Sharp operations to `SharpProcessPool`.
Only the child imports Sharp/libvips and ThumbHash. Existing image processing
order, ICC conversion/preservation, EXIF stripping, orientation, develop detail
and geometry are retained. LibRaw fallback remains in the repository and uses
its existing supervised subprocess. Cancellation, pool capacity, child failure
and resource refusals never trigger a LibRaw fallback.

Still thumbnails use one child operation: decode once, then generate the hash,
thumbnail, preview and optional fullsize sequentially. Decoded pixels stay in
the child; only the hash and metadata return over IPC. Each finished stage
reports progress. Only an initial decode failure is eligible for RAW fallback;
an output failure fails the attempt without starting another renderer.

Each executor/API process has one lazy pool. A child accepts one operation at a
time and remains registered with the queue supervisor between operations. A
successful result releases task listeners/timers; it does not unregister the
PID. Cancellation and execution deadlines send SIGTERM, escalate to SIGKILL
using the existing cancellation grace, and await actual close before rejecting
the caller or freeing the slot. An unkillable OS process therefore retains its
slot; a timeout is never treated as proof of termination. Idle children retire
after 30 seconds. Module shutdown closes the pool. Child IPC disconnect also
exits the child; the existing parent supervisor owns hung children if an
executor cannot run its own cancellation code.

The initial opaque execution deadline and subsequent no-progress deadline use
validated `QUEUE_TIMING` settings, including nonqueue callers. Time in admission
counts against the initial deadline. Only completed native stages/cells and
completed operations report progress, in the submitting job/operation context.

| Setting                            |     Default |               Valid range |
| ---------------------------------- | ----------: | ------------------------: |
| `FRAMELEAF_SHARP_WORKERS`          |           2 |                       1–8 |
| `FRAMELEAF_SHARP_PENDING`          |           8 |                      0–64 |
| `FRAMELEAF_SHARP_MAX_BUFFER_BYTES` |       1 GiB | 64 MiB–2 GiB minus 1 byte |
| `FRAMELEAF_SHARP_PENDING_BYTES`    |       1 GiB |              64 MiB–4 GiB |
| `FRAMELEAF_SHARP_MAX_PIXELS`       | 200,000,000 |   1,000,000–1,000,000,000 |

The buffer bound applies to each IPC request/result, including raw buffers, and
to the decoded pixels retained inside a thumbnail batch. The
pending byte bound applies to aggregate queued arguments; active tasks are
bounded separately by worker count. Defaults allow a 100MP 16-bit RGB buffer
(600MB) and retain the existing 200MP artifact ceiling. Artifact operations keep
the lower of their previous ceiling and the configured pixel ceiling. A grid
has at most 1,024 cells and a canvas within the pixel ceiling. Straightening can
use an intermediate of up to twice that ceiling. Limits refuse explicitly;
they never resize a source to gain admission or overwrite an original.

These are process/admission/pixel/IPC bounds, not an OS RSS reservation. Native
code and IPC serialization can temporarily hold additional copies; use the
container's memory controls when selecting higher limits. Maximum-size images
and sustained-load throughput still require hosted qualification.

Temporary admission saturation uses `local-capacity` only for safe canonical
queue work. Existing dependency deferral refunds retry credit and retries
admission after 30 seconds. It does not introduce a new retry owner. Unsafe or
operation-owned jobs and direct callers receive an explicit refusal. Execution
timeouts remain actual failures, subject to the existing queue/operation policy.

Production runs the compiled sibling `sharp-worker.js` without an alias loader.
Hosted source tests use the existing `tsx` development dependency; the child's
two relative runtime imports are intentional so no application services,
database decorators or aliases load in its process. The fault fixture is test
only and is never exposed as a production operation.
