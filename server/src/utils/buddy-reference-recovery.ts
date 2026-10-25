import { type Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import type { BuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { AssetStatus } from 'src/enum.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { lockChecksum } from 'src/repositories/physical-file.repository.js';
import { readBuddyAssetFidelity } from 'src/utils/buddy-backup-fidelity.js';
import { buddyFileHash, buddyRecoveryTarget } from 'src/utils/buddy-backup-recovery.js';
import { adoptBuddyReferenceOriginal } from 'src/utils/buddy-reference-adoption.js';
import { readBuddyReferenceOriginals } from 'src/utils/buddy-reference-originals.js';

/** Full-server recovery only: workers are stopped and snapshot sessions have already been revoked. */
export async function recoverBuddyReferenceOriginals(
  trx: Transaction<DB>,
  plan: BuddyRecovery,
  assert: () => Promise<void>,
) {
  const bindings = readBuddyReferenceOriginals(plan.manifest);
  const ids = Object.keys(bindings).sort();
  if (plan.manifest.version === 1) return;
  if (!trx.isTransaction || plan.scope !== 'server') throw new Error('Reference recovery requires server maintenance');
  await assert();
  if (await trx.selectFrom('session').select('id').executeTakeFirst())
    throw new Error('Reference recovery requires revoked snapshot sessions');
  const files = new Map(plan.files.map((file) => [file.path, file]));
  const verify = async (file: BuddyRecovery['files'][number]) => {
    await assert();
    const entry = files.get(file.path);
    if (entry?.sha256 !== file.sha256 || entry.size !== file.size)
      throw new Error('Reference recovery file closure is incomplete');
    await buddyRecoveryTarget(file.path, plan.manifest.storageRoots, []);
    const content = await buddyFileHash(file.path);
    if (content.sha256 !== file.sha256 || content.size !== file.size)
      throw new Error('Reference recovery original failed verification');
    await assert();
  };
  // Keep the global checksum-before-path order even when several originals share bytes.
  for (const hash of [...new Set(ids.map((id) => bindings[id].sourceEpoch.reference.sha256))].sort())
    await lockChecksum(trx, Buffer.from(hash, 'hex'));
  for (const id of ids) {
    const binding = bindings[id];
    const record = plan.manifest.library.assets[id];
    if (!record.owner || !record.type) throw new Error('Reference recovery asset identity changed');
    const file = record.files.find((entry) => entry.role === 'original')!;
    const asset = await trx
      .selectFrom('asset')
      .select('physicalOriginalFileId')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    await adoptBuddyReferenceOriginal(
      trx,
      {
        assetId: id,
        ownerId: record.owner,
        type: record.type,
        source: binding,
        file,
        physicalFileId: asset.physicalOriginalFileId ?? randomUUID(),
      },
      () => verify(file),
    );
    const state = readBuddyAssetFidelity(plan.manifest, id);
    if (state) {
      const interrupted = state.developRevisions
        .filter((revision) => ['queued', 'rendering'].includes(revision.status))
        .map((revision) => revision.id);
      if (interrupted.length > 0) {
        await assert();
        // Revoke snapshot render claims; this neither restarts work nor releases its filesystem owners.
        await sql`UPDATE public.asset_develop_revision SET status='saved',progress=0,error=NULL,
          attempts=0,"cancelRequested"=false,"renderAttemptId"=NULL,"renderGenerationId"=NULL,"isCurrent"=false
          WHERE "assetId"=${id}::uuid AND "ownerId"=${record.owner}::uuid
            AND id=ANY(${interrupted}::uuid[]) AND status IN ('queued','rendering')`.execute(trx);
      }
      await new BuddyBackupFidelityRepository(trx).publish({
        state,
        ownerId: record.owner,
        mode: 'replace',
        originalSha256: file.sha256,
        paths: new Map(state.files.map((file) => [file.path, file.path])),
        verify: async () => {
          for (const file of state.files) await verify(file);
        },
      });
    }
  }
  const outstanding = await trx
    .selectFrom('asset')
    .select('id')
    .where('status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
    .where('isOffline', '=', false)
    .where(sql<boolean>`lower("originalPath") LIKE 'frameleaf-source:%'`)
    .executeTakeFirst();
  if (outstanding) throw new Error('Reference recovery snapshot contains an uncaptured original');
  await assert();
}
