# iCloud Photos Health-Aware Recovery Implementation Plan

> Execute in this task with bounded subagents for independent transport, validation and schema work. The user requested implementation of the attached specification.

**Goal:** One-way server-side iCloud Photos ingestion with verified same-asset recovery of missing/corrupt media.
**Architecture:** Pinned Rclone API Go bridge, fork-owned durable manifest/leases, TypeScript staging and health resolver, owner-scoped web controls. Source rendition identity is independent of shared original byte identity.
**Tech stack:** NestJS, Kysely/PostgreSQL, BullMQ, Svelte, Go 1.26, Rclone v1.75.1 at 687d264b689b8c49a67e2e52a8a5e0caa01c04ce.
**Spec:** ../specs/2026-09-19-icloud-health-recovery.md

## Constraints
- No cloud writes/deletes, filesystem mirroring, browser media relay or credential-bearing jobs.
- Source identity uses account/zone/record/resource/version. Content identity uses verified SHA-256/content SHA-1; sha1Path is never content.
- Keep verified recovery bytes until durable commit and follow-up dispatch. Preserve owner, asset ID, relationships, privacy, lifecycle and local edit history.
- Fork feature state remains dormant during official operation. Every write respects schema state and recovery/cutover reservations.
- Exact live Apple acceptance remains separate from redacted fixtures.

## 1. Pinned real transport
Files: icloud-bridge/{go.mod,go.sum,main.go,api.md,Dockerfile,*_test.go}.
Interfaces: POST /v1/auth (explicit challenges), /v1/inventory (one raw page), /v1/download (fresh descriptor and streamed bytes), GET /v1/capabilities and /health.
- [x] Test raw page identities, duplicate album names, refreshed resource descriptors, authentication states and hostile endpoints.
- [x] Implement with Rclone exported Session.Request, not GetPhotos materialization.
- [x] Pin/test Go dependencies and rootless TLS deployment; retain license attribution.

## 2. Persistent manifest and schema authority
Files: fork-schema/migrations/0000000000090-ICloudSync.ts, catalog/handoff, repositories/icloud-sync.repository.ts.
Interfaces: connection, run, record, resource, album, membership and checkpoint tables. Token checked resource leases and durable pendingJobs.
- [x] Test migration reruns/roundtrip and public-deletion reconciliation.
- [x] Atomically persist provider page plus work before cursor advancement.
- [x] Test lease replay, paused connections and staging reservation limits with 500000 synthetic records.

## 3. Typed validation and recovery
Files: services/media-integrity.service.ts, services/media-recovery.service.ts, repositories/media-recovery.repository.ts; media-health service/repository integration.
Interfaces: validate({path,originalFileName,type,expected,deep}) returns healthy with hashes/stat evidence or missing/unreadable/corrupt/unsupported/timeout/transient. Resolver returns import-new/reuse-healthy/repair-existing/preserve-trashed/needs-review/retry.
- [x] Reproduce saved-hash matching missing and corrupt originals, path-hash exclusion and same-duration nonmatches.
- [x] Promote to private generated managed path; verify final bytes; CAS locked target generation and lifecycle; atomically update original/physical/checksum/quota/health/pending jobs.
- [x] Test corruption with changed current hash, shared paths, external opt-in, stale scan/trash, quota and every crash boundary.

## 4. Worker pipeline, metadata and source resources
Files: services/icloud-sync.service.ts, repositories/icloud-transport.repository.ts, dtos/icloud-sync.dto.ts, controllers/icloud-sync.controller.ts, job/registration types.
- [x] Test encrypted sessions and path/URL boundaries before worker implementation.
- [x] Reconcile every mapped destination before skip, reserve/stream/hash/validate bounded staging, resolve/recover/import, persist mapping and retry state.
- [x] Reconcile complete album snapshots with source membership provenance, Live Photo IDs and source resource roles.
- [x] Integrate source-render serving independent of native edit files; test two source records with equal originals/distinct edits and Apple revert/local edits.

## 5. Web and deployment
Files: web utilities route/navigation/translations, generated SDK/OpenAPI, deployment Compose and feature documentation.
- [x] Provide owner-only setup/challenges/selection/run controls and persistent distinct counts with accessible components.
- [x] Test API permissions and web auth/error/recovery display; generate SDK from actual controller.
- [x] Document encrypted key/session backup, ADP web access/reauthorization, staging and rootless ownership, unsupported fidelity cases and recovery audit.

## 6. Acceptance
- [x] Central real-database test stages valid original -> repairs same ID -> verifies served bytes and preserved associations -> resolved active findings -> second run healthy reuse.
- [x] Run focused formatting/lint/typecheck/unit/medium/schema/API/web/Go tests and record exact commands/results.
- [x] Inspect final diff, GitNexus detect_changes, and distinguish implemented, fixture-verified and live-unverified outcomes.

## Delivery evidence

See [verification report](2026-09-19-icloud-health-recovery-verification.md) for exact local checks and concrete unsupported/live-unverified cases. Checked implementation tasks do not imply production acceptance.
