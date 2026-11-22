# Frameleaf Cloud contract fixtures

Copied byte for byte from `Frameleaf/frameleaf-cloud`, `packages/contracts/fixtures/backup/`, at commit
`2a7196a9` on branch `aj/FC-286-backup-machines` (FC-284 and FC-286, not merged when copied).

| File | SHA-256 |
| --- | --- |
| `capability-repository-upload.json` | `19779b163029c660b491e500228f76bf7ad6359d514d0551875ac8d5bf46775c` |
| `lease.json` | `99fad84cc5533127a0a9edd3763c3f1ca7e48d21a330f04b394a12d5fc190755` |

`test/cloud-link.test.ts` pins these hashes and reads both files with Manager's own validators. When
Cloud changes a shape, copy the new file, update the hash here and in the test, and fix the validator.
