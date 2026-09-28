# Durable media operations

This page describes the job contract every long-running, user-visible workload uses (FL-43, FL-104). It covers Studio renders and previews, still edits, restorations, bulk library changes, Studio bundles, enrichment plans, Library Care, iCloud and Google Photos imports, and physical deduplication. The row in `media_operation` is the job. Nothing about a running job lives in a browser tab, a timer or local storage.

Code: `server/src/repositories/media-operation.repository.ts` (every transition), `server/src/utils/media-operation.ts` (the rules, free of the database), `server/src/services/media-operation.service.ts` (the owner's API), `server/src/services/media-operation-sweep.service.ts` (recovery). Tests: `server/test/medium/specs/repositories/media-operation.repository.spec.ts` runs the lifecycle against a real database.

## What a job records

| Field                                                                        | Meaning                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownerId`                                                                    | The only account that may see or act on the job.                                                                                                                        |
| `kind`, `destination`, `snapshot`, `settings`, `projectId`, `revisionId`     | Immutable, written at submit. The snapshot binds the exact revision, inputs, engine, colour and output profile. A different destination or revision is a different job. |
| `status`, `progress`, `processedUnits`, `totalUnits`                         | Where the job stands, from counted work. `totalUnits` may grow while a job runs; progress never invents a number, and an unknown total is an indeterminate bar.         |
| `result`                                                                     | The one mutable document: what the job has done so far (per-item outcomes, resume cursor). A restarted job resumes from it.                                             |
| `media_operation_checkpoint`                                                 | Render chunks. A chunk is reused only when its input, history, config and seed digests all match.                                                                       |
| `resultAssetId`, `retryOfId`                                                 | Lineage: the asset a completed job published, and the job a retry copies.                                                                                               |
| `claimToken`, `claimedBy`, `claimExpiresAt`                                  | The lease. Every worker write carries the token and is a guarded `UPDATE`; a write under any other token changes nothing.                                               |
| `attempt`, `autoRetries`, `retryAt`, `cancelRequestedAt`, `pauseRequestedAt` | Recovery, retry, cancel and pause bookkeeping, described below.                                                                                                         |

## Statuses

| Status       | Meaning                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`     | Waiting for a worker. A job waiting for its automatic retry is queued with `retryAt` in the future and the failure it retries after.     |
| `preparing`  | Claimed; the worker is gathering inputs and checking admission.                                                                          |
| `rendering`  | The work itself.                                                                                                                         |
| `validating` | The output is being checked. Nothing is published before this, and a pause is not taken here: the output is about to be adopted.         |
| `completed`  | The output was adopted. Final.                                                                                                           |
| `cancelling` | The owner asked to stop a claimed job; the worker has not confirmed yet.                                                                 |
| `cancelled`  | Stopped. Final. `cancelAcknowledgedAt` is null when the worker never confirmed, which keeps an unreleased remote job visible to cleanup. |
| `failed`     | Failed after its automatic retry. Final.                                                                                                 |
| `paused`     | Held by its owner. No worker claims it.                                                                                                  |

Working stages only move forward (`preparing` → `rendering` → `validating`). A progress report that would move a job backwards is refused.

## Cancel

A queued or paused job is cancelled at once. A claimed job goes to `cancelling` and keeps its lease, because the worker holding it has to answer. Only the worker holding the current claim can acknowledge the cancel. A worker whose lease lapsed and whose job another worker has since claimed cannot settle it. If the worker never answers, recovery marks the job `cancelled` without an acknowledgement. A cancel is never retried.

A cancel that arrives while a runner is finishing wins if it lands before completion. The runner's completion is refused and it acknowledges the cancel. Restorations publish their files and complete in one transaction that holds the job's row. A cancel that arrives during publication waits and then finds a completed job.

## Pause

Only kinds that record where they have got to can pause: bulk, Studio export, restoration, enrichment plans, Library Care, iCloud sync, Google Photos import and physical deduplication. A queued job pauses at once. A running job keeps its lease and hands the claim back at its next checkpoint, giving its attempt back. Resume puts it back in the queue, and the next claim carries on from what it recorded.

## Retry and recovery

These are the owner's rules from September 22, 2026:

- **One automatic retry.** A failure reported by a worker, or a lapse treated as a failure, puts the job back in the queue once, after 30 seconds, with the error recorded. The next failure is reported. The owner can retry after that.
- **Resumable jobs may resume a lost claim twice first.** When a lease lapses, which means the worker died, the server restarted or the network went, the recovery sweep requeues a resumable kind (the same set that can pause) up to twice. A third lapse counts as a failure and gets the automatic retry. Kinds that would start again from nothing get no resumes; for them a lost claim is a failure straight away. Claims a runner hands back on purpose (a pause, a graceful shutdown, a planned requeue for an item retry) give their attempt back and are not counted.
- **One neutral recovery sweep.** `MediaOperationSweepService` judges every lapsed claim for every kind. Runners never recover their own kinds.
- **Manual retry** creates a new row that copies the snapshot and points at the old one with `retryOfId`. Bulk and enrichment retries cover only the unfinished items. Asking twice answers with the retry already queued, and a unique index (`media_operation_retryOfId_active_uq`) holds that when two requests race. A retry is checked like a new submission: a job over an item that is Locked now needs the unlocked session.

## Prior output

A failed, interrupted, cancelled or stale attempt never replaces a previous valid output:

- Outputs are written to scratch paths and adopted only in `validating`, under the current claim.
- `complete` is guarded by the claim and by `validating`, so a late worker cannot complete a job that another worker now holds or that has finished.
- A result asset must be a live asset of the job's owner. A worker that names anything else fails the job with `result_not_owned`.
- Checkpoint writes take a share lock on the job under the claim, so a lapsed worker cannot record or complete a chunk its replacement owns.

## Edits

Edits are rendered by the job queue, as they always were: `MediaService` renders a saved photo edit's previews and a video edit or export, and `AssetDevelopService` renders a photo version. Each render now also has a `media_operation` row of kind `quick_edit`, written when the render is queued (`server/src/utils/edit-operation.ts`, `server/src/utils/edit-operation-tracker.ts`):

| `settings.edit` | What renders                                                     | Queued by                                        | `revisionId`          |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| `photo_edit`    | The edited previews of a saved, cleared or restored photo edit   | Saving, clearing or restoring a photo's edits    | none                  |
| `photo_version` | A photo version: a develop recipe, or a file developed elsewhere | Saving with render, Render, bringing a file back | the develop revision  |
| `video_edit`    | A saved, cleared or restored video edit's master and proxy       | Saving, clearing or restoring a video's edits    | the requested version |
| `video_export`  | A video version rendered for download                            | Export                                           | the exported version  |

The row is local, owned by the photo's owner, labelled with the file name and points at the photo (`assetId`) and, when there is one, the version (`revisionId`). The snapshot records `executor: job_queue` and the job that renders it.

The row is held by the job queue, not by a worker that polls: `claimedBy` is `job-queue` while it waits with its job, and no polling worker or render worker is ever offered a row whose snapshot names that executor. The job carries the row's id. When it runs it takes a real claim (`beginJobQueueRun`): only a queued row the job queue holds, only once, so a second delivery of the same job, a delivery after a cancel, or one after the row finished does nothing. The run heartbeats every third of its five-minute lease, reports `rendering` and, for a photo version, its stages as progress, and moves to `validating` immediately before it publishes. Publication happens only if that step succeeds; otherwise the run stops without publishing and removes what it wrote. A run with nothing to publish, because the version was already rendered or a newer edit superseded it, completes with `result.outcome = nothing_published` and no result asset.

Recovery uses the same rules as every other kind. Edits cannot resume, so a lost claim is a failure and gets the one automatic retry. A failure the executor reports also gets it, except where retrying cannot help: a missing original or a version whose source changed. A retrying row goes back to the queue with no holder, and `MediaOperationSweepService` dispatches it to the job queue with its row once its retry time has come. The same pass dispatches a row still waiting with its job fifteen minutes after it was last touched, because the queue has evidently lost the job, and a manual retry. Photo versions under a row no longer requeue themselves or get requeued at startup by `AssetDevelopService`; the row's recovery does that.

What each edit can do:

| Edit            | Cancel                 | Retry                            | Pause |
| --------------- | ---------------------- | -------------------------------- | ----- |
| `photo_edit`    | No                     | After it failed                  | No    |
| `photo_version` | Yes, queued or running | After it failed or was cancelled | No    |
| `video_edit`    | No                     | After it failed                  | No    |
| `video_export`  | No                     | After it failed                  | No    |

- A photo version checks for a cancel between its stages and only makes the new version current at the end, so it can stop anywhere and the previous working version stays current. A cancel from Activity reaches the render at its next stage; a cancel from the editor cancels the row too.
- A photo edit's previews and a video edit's master render edits that are already saved. Stopping one would leave the saved edit showing stale previews, and the video encoder has no stop, so they cannot be cancelled. The server refuses the request and Activity does not offer it.
- A retry is a new row with the same snapshot, sent straight to the job queue. A photo edit renders the saved edit again, a photo version its revision (queued afresh, as Render does), a video edit the requested version and a video export its version. A retry of an item that is Locked now needs the unlocked session.
- Nothing pauses: every edit is a single render that starts from the beginning.

Prior output survives in each case: a video version's files are written under their own names and adopted by one transaction, a photo version becomes current only after `validating`, and a photo edit's asset files and dimensions change only after `validating`. A photo edit writes its preview files where the previous edit's previews were, so a failed run can leave them partly rewritten; the saved edit is rendered again by the automatic retry. Develop exports (a record that the original went out for development elsewhere) are not jobs: nothing is rendered.

## Reload and reconnect

Every client view is the server's last answer. Activity and the notifications panel poll while work is running. They ask again at once when the tab is shown, the browser comes back online or the websocket reconnects, so a reload or reconnect shows exactly where each job got to. While the server cannot be reached the last list stays on screen with a Reconnect control.

A job whose status, stage or progress changes through `MediaOperationRepository` sends `on_media_operation_update` with the job's id to its owner's sockets only (`MediaOperationEventService`). Activity answers it by asking for the list again, so what it shows is read through the same owner and Locked checks as any request; the event itself carries nothing else.

`GET /media-operations` lists unfinished jobs before finished ones, each newest first. Activity asks for the latest hundred, so every job still running is on that page however many jobs finished since it started.

## Privacy

- Every read and action is owner-scoped in the query. Another account's job answers "not found", like a job that does not exist.
- A session that has not unlocked the Locked folder never learns which of its jobs' items are Locked now. Asset ids are withheld. A job about a Locked item comes back with `withheld: true`, an empty `label` (the file name) and an empty detail snapshot; clients title it "Locked item". The job itself stays visible so the owner can pause or cancel it.
- Administrators get aggregates only (`GET /media-operations/statistics`: counts by kind, status and destination) and, in the notifications panel, server queue counts. No route shows an administrator another account's jobs, labels or media.
