# Whisper diagnostic timing scope

The hosted Studio engine workflow requests actual inference on `whisper-timing.wav`, using the
existing approved `onnx-community/whisper-tiny_timestamped` revision
`517244293732ee2d58139af5814231b7e6830a0d` and the worker's bundled transformers.js 3.8.1 package.
Missing preparation, stale exact row approvals, excluded hosted/local use, changed bundled runtime
bytes, unapproved download requests, missing genuine pipeline disposal, or word/pause oracle drift
fail the diagnostic. Downloads are bodyless GET/HEAD requests at the generated policy's exact
approved revision. Hugging Face's download service can redirect to its storage; the report retains
the requested approved origin and the final response origin, not signed query credentials. Only the
committed speech fixture enters inference; no customer audio is uploaded.

The fresh random cache child is removed on creation, inference and disposal failure as well as
success. The supplied cache parent is preserved. Lifecycle tests use stubs to exercise these error
paths and do not establish real inference. Hosted timing is bounded to a 12-minute step; abrupt
runner cancellation can prevent process cleanup, and its ephemeral hosted filesystem then expires.

The retained report is diagnostic evidence, not production worker acceptance. It binds fixture,
timing evidence, runtime entry, owner-approved rows, model revision and hosted source/run identity.
Downloaded payload hashes and byte lengths are **observed**, with `approvedPayloadDigest: null`.
They must be reviewed through the existing approval process before production byte admission can
pass. `verifyResourceBytes` and generated policy are untouched and continue to reject absent
approved per-file digests. Reports state
`productionAcceptance: blocked-missing-approved-payload-digests` even when diagnostic timing passes.
No observed digest is copied into approval files or certified receipts. Failures before pipeline
setup can produce no diagnostic report; the failed job is authoritative, and artifact retention
warns about that absence without substituting a passing result.

FL-111 remains open across this finite acceptance matrix:

1. Reviewed per-file model payload digests and real production byte admission; browser Whisper
   worker inference using its actual WASM/WebGPU runtime and disposal path.
2. Every other pinned and supplemental model, voice and runtime row in the authoritative resource
   inventory, with its own rights admission, genuine output and download/cache behavior.
3. Download progress, cancellation, retry, partial-cache recovery and memory/resource bounds.
4. Project artifact persistence, reopening, relinking missing models/media and offline project
   bundle/export/import behavior.
5. Privacy and network refusal across browser workers, including customer-data paths and blocked
   resources; diagnostic bodyless-download assertions do not replace that matrix.
6. Full browser/editor workflows, backend selection, captions and transcription integration with
   real project editing and timeline behavior.

This packet changes no rights approval, model selection, distribution gate or production policy.
