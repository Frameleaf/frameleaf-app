# Edit a batch in another application

Select your still photos and choose **Edit in another app** from the selection menu. Create a batch, then prepare its originals. Preparation is saved per photo, so you can close the page and resume later at **Manage external editor batches** in the Versions panel.

The ZIP includes the available, prepared originals, their permitted associated XMP sidecars, and `frameleaf-roundtrip.json`. Check the included and excluded counts and each photo’s status before downloading. Originals are never overwritten. Exported filenames carry stable Frameleaf export identifiers; keep those identifiers when saving edited files if your editor allows it.

Choose the returned files or a folder. Review the matches and skipped files, map renamed or ambiguous files to a batch photo, and confirm before importing. The manifest is a hint for people and applications, never authority to choose another account’s photo. Frameleaf checks the saved batch relationships, current access, original checksum, supported image format, image decoding, transferred checksum, and storage quota on the server.

Every distinct returned checksum has its own confirmation and version in the batch. Retrying the same bytes reuses that version, including after a restart. You can review a corrected file in the same batch without deleting earlier versions. Failed previews can be retried from the stored master. Browser file selections do not survive reopening: choose the local files again when needed, then review the matches again.

A returned version becomes current only after its preview renders successfully, while the original and access remain valid and the working selection has not changed since confirmation. If the working selection changed—even if it was later restored—the returned version stays in Versions, inactive, with an explanation. Other photos and earlier completed versions remain available when an item fails. Cancelling stops unfinished work and cleans its staging; completed versions are retained.

## API contract

Batch routes are additive; single-photo export and import routes remain supported. A missing `GET /develop-batches/capabilities` route (HTTP 404 or 405) means the server is older. Authentication, permission and network failures must be reported separately.

| Operation                              | Route                                               |
| -------------------------------------- | --------------------------------------------------- |
| Capabilities                           | `GET /develop-batches/capabilities`                 |
| Create durable selection               | `POST /develop-batches`                             |
| List owner batches                     | `GET /develop-batches`                              |
| Status and return history              | `GET /develop-batches/{id}`                         |
| Prepare/resume one original            | `POST /develop-batches/{id}/items/{itemId}/prepare` |
| Versioned manifest                     | `GET /develop-batches/{id}/manifest`                |
| Stream originals and sidecars          | `GET /develop-batches/{id}/download`                |
| Review candidate mappings              | `POST /develop-batches/{id}/match`                  |
| Confirm mappings and working selection | `POST /develop-batches/{id}/confirm`                |
| Import/resume a return                 | `POST /develop-batches/{id}/items/{itemId}/import`  |
| Cancel unfinished work                 | `POST /develop-batches/{id}/cancel`                 |

The list endpoint returns up to 50 owner batch summaries with `itemCount` and `nextCursor`; pass that opaque batch ID as `cursor` to fetch the next page. Fetch a selected batch by ID for its complete item and return history. Prepare and import return the updated item, which clients merge into their saved batch status; retrieve full batch status to resume or refresh. The status includes `includeSidecars` for cross-device review.

Import is multipart with `confirmationId`, `renditionChecksum`, and an optional `file`. A new return requires the file. A failed render with a retained master can be retried without uploading it again. Confirmation binds the batch item, checksum and working selection; clients must use the returned confirmation identifier. Same-checksum retries retain the first confirmation.

Item and return `errorCode` values are stable reasons for client localization. Clients should recognize `source_unavailable`, `credential_unavailable`, `source_changed`, `current_revision_changed`, `batch_cancelled`, `develop_batch_quota`, `transfer_checksum`, `import_rejected`, `render_failed` and `export_failed`, with a generic fallback for unknown codes. Unavailable source names, checksums and return details are redacted from owner status; unrelated available items can still be prepared, imported and retried. ZIP manifests describe exactly the included prepared originals and explicitly identify excluded items by opaque batch-item identifier and reason.
