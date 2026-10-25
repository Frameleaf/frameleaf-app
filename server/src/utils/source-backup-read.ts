import { sql } from 'kysely';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';

export type SourceBackupRead = { operationId: string; claimTokenHash: Buffer };
/** An ordinary source read never inherits the instance backup's access to trashed originals. */
export const sourceBackupReadAuthority = (backup: SourceBackupRead) => sql<boolean>`EXISTS (
 SELECT 1 FROM media_operation op JOIN "user" actor ON actor.id=op."ownerId"
 WHERE op.id=${backup.operationId}::uuid AND op.kind=${MediaOperationKind.BuddyBackup}
 AND op.destination=${MediaOperationDestination.Local} AND op.snapshot->>'task'='backup'
 AND op.status IN (${MediaOperationStatus.Preparing},${MediaOperationStatus.Rendering},${MediaOperationStatus.Validating})
 AND op."claimToken" IS NOT NULL AND sha256(convert_to(op."claimToken"::text,'UTF8'))=${backup.claimTokenHash}
 AND op."claimExpiresAt">clock_timestamp() AND op."cancelRequestedAt" IS NULL AND op."pauseRequestedAt" IS NULL
 AND actor."isAdmin" AND actor."deletedAt" IS NULL
)`;
