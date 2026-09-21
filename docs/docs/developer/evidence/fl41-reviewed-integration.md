# FL-41 reviewed web/server integration

Issue: [FL-41](https://heroit.atlassian.net/browse/FL-41). This is a local qualification assembly, not a replacement for the issue-owned PRs, hosted acceptance, merge, publication or deployment. All mobile work remains deferred under the user's September 21 instruction.

## Source provenance

Assembly runtime commit: `39da25a85f7789909b2400149b574368e311302b`. Default-branch baseline: `a3b0cae7e785e31339353ad9b0a55cfb10d03f56`, including removal of mobile CI. Merge parents preserve the original reviewed commits:

| Issue | Reviewed input |
| --- | --- |
| FL-29 People filters | `79b7f9caa40e4c08fe3c09a75927dcf2984671ea` |
| FL-34 sensitive Locked view | `aabef632a6f1b1c5390a86a6a4cae265e634778e` |
| FL-39 versions and original-media bounds | `6cd128decbd9ef66f6b43c195ac3bbb582882559` |
| FL-84 reproducible engine build | `a7882dcf7de1f087a21c93a792c2946ddac4d66d` |
| FL-41 server/SDK validation | `83100cdaafe199658a51af5ddd3d6f009527720b` |

The 26/39/30/11/6 files changed exclusively by those respective inputs remain byte-identical. Shared changes preserve owner-only sensitive timelines, version APIs, original-media metadata, action-discriminated validation and the stronger no-Dart CI assertions. An independent bounded integration review approved the runtime assembly with no P0/P1/P2 findings, subject to refreshing the tracked-path golden. It did not repeat the individual feature audits.

## Local validation

Before the final original-bounds merge, combined checkpoint `a762277790d71eda5cfd62e84a82dc7301735105` passed 664 server tests, 131 web tests (one existing skip), three SDK transport tests, server/web TypeScript and Svelte checks.

After that merge, the changed paths passed 138 server controller/DTO/asset-service tests, seven video-editor tests, eight version-control tests and three SDK transport tests. Server build, SDK build, web TypeScript and Svelte checks passed; Svelte reported zero errors and warnings. These targeted checks qualify the delta locally; they do not claim a repeated full suite.

Server OpenAPI generation and oazapfts 7.5.0 regeneration are byte-identical to the merged sources:

- OpenAPI SHA-256: `62e8c76f21cc28a79c464cb5528921ba426b6a9bff3ceeab0f75896d04bce3b0`.
- SDK SHA-256: `c5b6359cce7efab60eba52a3fc757660d58db3481b8669061108ae46c13a3f93`.

All 313 existing operations remain, with five additional version operations. Existing operation fields and parameters remain identical except for optional `sensitiveOnly` query parameters on the two timeline endpoints. Existing schemas remain identical except for optional `originalVideo` on `AssetEditsResponseDto`; no existing required fields changed. This structural comparison does not replace hosted OpenAPI compatibility checks.

## Remaining qualification

Current-candidate GitHub Actions, combined PostgreSQL/media qualification and full authenticated application checks remain open. The original-bounds PostgreSQL regression could not run because the local Docker daemon was unavailable. Existing issue-specific limitations remain in their receipts. No mobile generator or application validation was reintroduced.

Issue-owned PRs and their monitoring owners remain unchanged. The assembly is unpushed, so its Smart Commit commands have no Jira ingestion receipt. FL-41 remains In Progress. Any merge/publication requires the existing explicit authorization procedure.
