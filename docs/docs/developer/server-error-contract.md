# Server error display contract (FL-328)

Audited integration base: `d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9`.
This packet covers the server producer and language-neutral consumer fixtures.
Native iOS/Android implementation, native tests and translated release approval
are excluded. Source integration into draft PR #140, independent authorization /
privacy review, exact-head hosted checks, and FC109/FC110 release review remain
separate gates. This document does not certify those gates.

## Requirement mapping

| Requirement                              | Committed baseline / packet evidence                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable settings paths and choices        | Reuse `web/src/lib/frameleaf/settings-coverage.contract.snap`: 312 admin setting leaves, including 38 leaves with enum/item-enum choices; `settings-coverage.ts` maps each path to its owning form, and `settings-coverage.spec.ts` detects drift against OpenAPI. No new descriptor service is needed.                                 |
| Queue/job labels and stable codes        | `server/src/enum.ts`, `server/src/dtos/job-run.dto.ts`, `web/src/lib/frameleaf/job-queues.ts` and `durable-runs.ts`; mappings below. Identifiers and commands are unchanged.                                                                                                                                                            |
| Known domain refusals                    | Setup, exchange, remote-auth, rate-limit, Cloud, worker and operation codes already exist. The packet preserves their fields and status; it adds display metadata in `GlobalExceptionFilter.fromError`.                                                                                                                                 |
| Missing general distinctions             | `server/src/utils/server-error-display.ts` maps HTTP status to a stable general code and distinguishes request/response Zod validation by exception type. It never reads English to decide a code.                                                                                                                                      |
| Allow-listed arguments and safe fallback | Only producer-owned counts/delays listed below enter `displayError.args`. Its explicit English fallback is fixed server copy, never legacy `message`, provider `data`, validation issues, or user content.                                                                                                                              |
| Exact producer / both consumer fixtures  | `server/test/fixtures/server-error-display-v1.json` contains exact producer payloads and a common normative consumer matrix for both native targets. `global-exception.filter.spec.ts` executes the producer fixtures. Native adoption and native fixture execution are excluded, not claimed passing.                                  |
| Account isolation / diagnostics          | The regression check covers separate arguments, content and correlation IDs across requests; errors are `Cache-Control: no-store`. Existing `running-job.service.spec.ts` tests account-scoped operations/exports and privileged queues. `onRouteError` logs status or fixed failure categories without raw bodies, messages or stacks. |
| Web parity / locale                      | Existing web handlers keep their response fields and refusal behavior. No locale negotiation is added; the display descriptor is identical for every UI locale. Client behavior and adoption rules follow below.                                                                                                                        |

## Wire shape and action semantics

Every writable JSON error handled by `GlobalExceptionFilter` adds:

```json
{
  "displayError": {
    "version": 1,
    "code": "http_unauthorized",
    "args": { "attemptsLeft": 2 },
    "fallback": { "locale": "en", "message": "Authentication is required for this request." }
  }
}
```

For this example, existing `code: "setup_code_invalid"` and `attemptsLeft: 2`
remain outside the descriptor. A domain-aware client translates that known
setup code with the same `attemptsLeft` argument. A client that lacks that
mapping uses the general descriptor or its explicit English fallback.

`displayError` is display metadata, never authority for authorization,
retry, destination selection, billing, idempotency or accounting. The original
HTTP status, `code`, `refusal`, `retryable`, retry-delay fields and headers keep
those meanings. The producer does not create a retry instruction from a 429 or
503 fallback. A missing resource remains indistinguishable from a resource the
account cannot access. User labels, file names, IDs and content are not translated.

Existing domain payloads and legacy `message` / validation `errors` remain for
compatibility; they are **not** the safe display contract. A new consumer must
not display or record arbitrary legacy text, provider objects, validation
issues, or unknown fields. The descriptor never copies those values. This
packet does not claim to sanitize every historical producer's legacy payload.
Unexpected non-HTTP errors retain the generic 500 response.

## General resource lookup codes

Resource IDs are these exact codes, scoped by contract version 1. Keep version
1 meanings and argument names stable; a breaking interpretation requires a new
version. A consumer must not manufacture keys by transforming English messages.

| HTTP status | Descriptor code             | English fallback                               |
| ----------- | --------------------------- | ---------------------------------------------- |
| 400         | `http_bad_request`          | This request could not be accepted.            |
| 401         | `http_unauthorized`         | Authentication is required for this request.   |
| 403         | `http_forbidden`            | This request is not permitted.                 |
| 404         | `http_not_found`            | The requested resource is unavailable.         |
| 409         | `http_conflict`             | This request conflicts with the current state. |
| 413         | `http_payload_too_large`    | This request is too large.                     |
| 422         | `http_unprocessable_entity` | This request could not be processed.           |
| 429         | `http_rate_limited`         | Too many requests. Try again later.            |
| 500         | `http_internal_error`       | An internal server error occurred.             |
| 502         | `http_bad_gateway`          | A required service is unavailable.             |
| 503         | `http_unavailable`          | This service is unavailable.                   |
| 504         | `http_gateway_timeout`      | A required service did not respond in time.    |
| Other       | `http_error`                | This request could not be completed.           |

`ZodValidationException` uses `request_validation_failed`; its status and fallback
remain 400. `ZodSerializationException` uses `response_validation_failed`; its
status and fallback remain 500. Validation paths, values and messages never
become interpolation arguments.

| Existing domain code | Allowed argument    | Value rule                               |
| -------------------- | ------------------- | ---------------------------------------- |
| `setup_code_invalid` | `attemptsLeft`      | Nonnegative safe integer, including zero |
| `rate_limited`       | `retryAfter`        | Nonnegative safe integer seconds         |
| `service-paused`     | `retryAfterSeconds` | Nonnegative safe integer seconds         |

Every other code gets an empty argument map. Strings, fractions, negative values,
non-finite numbers, unsafe integers, nested values, provider `args` / `data`, and
prototype property names are excluded. New argument distinctions need an
explicit producer-owned allow-list entry plus a fixture and privacy review.

## Consumer adoption rules

Both native resource pipelines can consume the same JSON matrix without
rewriting or executing native code in this repository. Each `consumer` vector
names the HTTP status, exact body, known domain-code set, and expected lookup,
arguments, fallback and refusal/retry semantics. The known/new/unknown/legacy
producer bodies are exact vectors; newer-version and pre-contract responses
have separate consumer vectors.

1. Apply existing authentication / refusal / retry handling from original
   fields and status. Changing UI language never authorizes a refused action.
2. Validate `displayError.version === 1` and its object shape. Copy only the
   allowed numeric arguments for a known domain code; ignore unknown keys.
3. Look up a known top-level domain code first, then a supported general
   descriptor code. Use exactly the same argument names and numeric values in
   every translation. Do not interpret an unknown code as a known domain refusal.
4. If the supported version lacks a translation, show its explicit `en`
   fallback as plain text. Do not label that text as translated into the UI locale.
5. For a missing/invalid descriptor, unsupported version or unusable fallback,
   show the client's generic localized error, with English baseline
   `This request could not be completed.` Never render legacy `message` or
   guess a code from it. Diagnostic collection uses correlation ID and HTTP
   status, not raw response payloads or account content.

Use FC104-110's existing extraction, resource generation, waves and review
pipeline for adoption. FC109/110 still gate every translated release. The fixture
is a handoff contract, not evidence of native rendering or human translation
acceptance.

## Existing settings and job mapping inventory

The settings coverage snapshot is the complete path/choice inventory; reuse it
rather than copying 312 paths into another registry. `server/src/dtos/config.dto.ts`
owns config visibility and validation. `system-config.dto.ts` retains the legacy
import path. `SETTINGS_LEAF_COVERAGE` and `PREFERENCE_LEAF_COVERAGE` distinguish
controls, credentials, credential state, fixed policy, server-managed values,
resource actions and save-protocol fields. Never turn credential paths or values
into resource strings.

`SETTINGS_AREAS` in `settings-areas.ts` owns stable area and section IDs; the host
maps area titles to `frameleaf_settings_area_<id>` and descriptions to that key
plus `_description` in `i18n/en.json`. `system-config-draft.ts` owns section-to-path
mapping, secret exclusion and server-managed fields. A settings label lives in
its owning form's client resources; field paths and enum values stay unchanged.
The snapshot also retains numeric bounds and enum/item-enum choices (for example
`ffmpeg.accel`, `ffmpeg.targetVideoCodec`, and Cloud routing values).

`QueueName`, `JobName`, `ManualJobName`, `QueueCommand`, `QueueJobStatus`, and
`QueueJobWorkerKind` in `server/src/enum.ts` own server identifiers and choices.
`JOB_QUEUES` is the existing complete queue-to-resource map: its `key` maps to
`frameleaf_jobs_queue_<key>` / `_description`. `manualJobKey` and `jobNameKey` map
unchanged identifiers to `frameleaf_jobs_manual_<snake_name>` / `_description`
and `frameleaf_jobs_name_<snake_name>`. Reuse those mappings and current
`i18n/en.json` entries; translating labels must not change start/force/refresh,
pause rules, queue counts, worker kinds or command values.

`JobRunStateSchema`, `JobRunOutcomeSchema`, and `JobRunReasonSchema` own the durable
run descriptor choices. `durable-runs.ts` maps these to
`frameleaf_job_runs_state_<state>`, `frameleaf_job_runs_outcome_<outcome>`
(`needsAttention` maps to `needs_attention`), and
`frameleaf_job_runs_reason_<reason>`. Waiting, retrying, paused, blocked,
unavailable, incomplete enumeration and missing dispatch are distinct;
translation must never turn unknown counts into zero or pending work into success.

| Existing error family              | Producer inventory / reusable mapping                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                              | `FrameleafSetupErrorCode` in `frameleaf-server-setup.dto.ts`, `setupRefusal` in `frameleaf-setup-gate.ts`: LAN-only, complete, required/invalid/replaced/locked code, invalid ticket, unavailable Cloud, already linked, invalid/used link token and failed link. These are separate refusal resources.                                                                                                                      |
| Token exchange                     | `FrameleafTokenExchangeErrorCode` in `frameleaf-auth.dto.ts`: not linked, sign-in off, no access, wrong audience, expired, replayed, invalid, email unverified, removed account and conflicting account. No translation may relax any check.                                                                                                                                                                                 |
| Remote authentication              | `frameleaf_sign_in_required` and `frameleaf_home_network_only`; `handle-error.ts` preserves sign-out/revoked-share behavior. No new sign-in instruction is inferred from a general descriptor.                                                                                                                                                                                                                               |
| Rate limiting                      | `rate_limited`, producer `tooManyRequests` in `rate-limit.guard.ts`; `Retry-After` is authoritative.                                                                                                                                                                                                                                                                                                                         |
| Cloud                              | `CloudErrorCode`, `errorEnvelopeSchema`, `MlAdmissionRefusal`, `refusalFromCloudError` and `pausedException`; keep hyphen/underscore spelling, explicit refusal, destination, idempotency and accounting decisions. `cloud-paused.ts` intentionally displays the staff-authored pause message whole in existing web behavior. That legacy exception is not permission for a new consumer to display arbitrary provider text. |
| iCloud                             | `icloud-sync.ts`'s existing `ERROR_KEYS` / `icloudErrorKey` maps known codes to `frameleaf_icloud_error_<key>`, unknown to `_generic`; provider timeout/failure maps to `_provider_unavailable`. Reuse the allow-list rather than rendering a raw provider error.                                                                                                                                                            |
| Media / Studio / import operations | Existing `errorCode` fields in media-operation, studio-preview/export/bundle, library, iCloud and takeout DTOs are domain identifiers; `error` text is not a resource key. `edit_render_failed`, `result_not_owned`, library-scan codes and the rendering/lease/recovery codes stay producer-owned. Unknown codes use the domain's generic display.                                                                          |
| Worker / workflow / bulk results   | `RestorationWorkerErrorCode`, `WorkflowIssueCode`, `WorkflowRunErrorCode`, `AssetIdErrorReason` and `BulkIdErrorReason` remain their DTO/enum-owned choices. They are not global HTTP exceptions and this packet does not rewrite their payloads.                                                                                                                                                                            |

## Locale and cache boundary

The server does not negotiate UI locale or inspect `Accept-Language` for this
contract. Its descriptor and explicit English fallback are deterministic across
UI language, storefront and Cloud/processing region. UI locale selection and
unsupported-locale fallback remain client-resource concerns (`i18n.ts` on web,
FC104-110 pipelines for native). Locale changes must not alter region, currency,
entitlements, stored identifiers, user content or Cloud destination selection.

All writable global JSON error responses use `Cache-Control: no-store` because
legacy payloads and remaining-attempt counts can be account/request scoped. There
is no language-dependent response or language cache to negotiate. A future
localized server response would need a separately reviewed unsupported-locale
policy and cache isolation before adoption; this packet chooses no negotiation.
