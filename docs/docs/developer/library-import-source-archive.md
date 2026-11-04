# Protected source metadata archive

`LibrarySourceArchive` is an internal recovery store for qualified, credential-free source content that cannot all be represented in the destination. It preserves source table names, column names and scalar values separately from normalized destination records. It does not expose a public export, lifecycle command or Manager flow.

## Content and privacy

The version 1 codec retains text, arbitrary binary values, integers without precision loss, finite floating-point values including negative zero, booleans and null. Fields are sorted by column name before hashing. Text uses UTF-16LE base64 so embedded NUL and lone surrogates survive PostgreSQL JSONB storage. SQL JSON columns remain source text; the archive does not reinterpret their content.

Source schema admission and complete, credential-free projections remain mandatory adapter responsibilities. The codec rejects known credential column names, but that check cannot detect secrets inside opaque text or unknown columns. Never archive source sessions, API keys, password verifiers, public bearer links or whole unreviewed database rows. Qualified account credentials use the separate protected account machinery; compatible password preservation remains supported.

The archive lives in private recovery tables. Ordinary journal status does not return its records, and database diagnostics redact archive SQL parameters and error details. No public access endpoint is added. Administrative access to the destination database remains sensitive.

## Retention and verification

The caller first retains the reviewed manifest and destination plan, then supplies a descriptor containing the archive format, version, expected record count and ordered SHA256 chain. `begin` binds that descriptor to the existing operation and destination. Changed descriptors refuse instead of replacing retained facts.

`append` accepts 1–1,000 records at an explicit zero-based offset under the common import lock and write fence. Gaps, excess records and changed overlapping records refuse. Identical overlapping retries are safe, including after a committed page's acknowledgement is lost. Each page and its checkpoint commit together; an interrupted transaction retains neither.

`seal` revalidates reviewed inputs and independently checks the database record count, contiguous ordinals, each canonical record hash and the complete ordered hash chain through bounded pages. Only a complete matching archive becomes sealed. `verify` repeats the audit in a consistent read transaction. An individual `page` validates that page; it does not replace full verification.

The chain begins with SHA256 of the UTF-8 string `frameleaf-source-archive-v1`. Each step hashes the 32 previous digest bytes followed by the 32 digest bytes of the canonical record. Ordered contiguous ordinals make changed records, missing records and reordered records detectable against the independently supplied descriptor.

Records remain readable and verifiable after abandonment or activation; further writes refuse. There is no deletion method. The additive migration refuses downgrade while any archive header exists, including an empty archive.

## Integration boundary

The controller must obtain and retain a complete, consistently ordered source inventory, calculate its descriptor independently, retain unsupported metadata before activation, and reconcile normalized destination records separately. This store does not prove source completeness, permission equivalence, original-file integrity or writer fencing. It does not transfer files, activate a library or release regeneration work. Full controller/CLI/Manager integration and combined ten-source qualification remain outstanding.

Private bundle directories include the normalized import operation UUID. The parent directory entry is synced before credential-bearing files are written, so abrupt process termination, failed cleanup or a final directory-handle close failure leaves attributable private artifacts. Caught producer errors, including inventory iteration and archive-file close failures, remove only this incomplete bundle; they preserve earlier captures and never alter source media or migration journals. Callers must retain ownership of any surviving artifacts through recovery and validate the existing bundle seals and source authority before reuse; a directory name is not migration authority.

The common private bundle writer accepts sealed manifest versions 3, 4 and 5, matching its reader. Stack membership and Live Photo still/motion relationships remain in the sealed manifest and its fingerprint, alongside the independently bound file placements and owner inputs. Earlier unsealed versions and unknown versions are refused. This serialization support does not qualify a source adapter or authorize activation.
