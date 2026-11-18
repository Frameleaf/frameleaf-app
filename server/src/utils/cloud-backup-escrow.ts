/**
 * Key escrow (FL-164, CLD-302; Frameleaf Cloud BAK-002 "Escrow"): in server key mode only, the bucket key
 * wrapped under an administrator's passphrase and stored with Frameleaf Cloud as an opaque blob. The
 * wrapping itself is shared with Manager's Server Backup and lives in `@frameleaf/backup-core`.
 */
export {
  ESCROW_BLOB_VERSION,
  ESCROW_MIN_PASSPHRASE,
  ESCROW_SCRYPT,
  escrowPassphraseProblem,
  scryptDerive,
  unwrapBucketKey,
  wrapBucketKey,
} from '@frameleaf/backup-core';
