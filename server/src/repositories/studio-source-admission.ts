import { ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetStatus, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetLocalEffectRepository, SourceEpoch } from 'src/repositories/asset-local-effect.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { DB } from 'src/schema/index.js';
import { checkAccess } from 'src/utils/access.js';
import { getLockedOwnerId, isLockedAssetRow } from 'src/utils/locked-visibility.js';
import { isRevealedLockReason } from 'src/utils/locked.js';
import { STUDIO_MAX_REFERENCES, isStudioUuid } from 'src/utils/studio-resources.js';

export type InteractiveAdmissionOwner = { ownerId: string; streamEpoch: string | null; sequence: string };
export type InteractiveAdmissionView = {
  actorId: string;
  sessionId: string | null;
  owners: InteractiveAdmissionOwner[];
};
export type InteractiveAdmissionSource = InteractiveAdmissionOwner & { assetId: string };

/** Adds an epoch fence to an already-authorized server-derived snapshot; grants no access itself. */
export async function holdSourceAdmission(
  db: Kysely<DB>,
  snapshot: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  const value = snapshot.sourceEpochs;
  // Historical snapshots retain their original representation; worker reads re-resolve their sources.
  if (value === undefined) {
    if (snapshot.kind === 'studio-preview' || snapshot.kind === 'studio-preview-stream')
      throw new ConflictException('studio_source_admission_changed');
    return;
  }
  const refuse = (): never => {
    throw new ConflictException('studio_source_admission_changed');
  };
  if (!db.isTransaction || !Array.isArray(value) || value.length > STUDIO_MAX_REFERENCES) refuse();
  const epochs = value as SourceEpoch[];
  if (
    epochs.some(
      (row) =>
        !row ||
        !isStudioUuid(row.assetId) ||
        !isStudioUuid(row.ownerId) ||
        typeof row.epoch !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(row.epoch),
    )
  )
    refuse();
  const ids = [...new Set(epochs.map((row) => row.assetId))].sort();
  if (ids.length !== epochs.length) refuse();
  if (ids.length === 0) return;
  const assets = await db
    .selectFrom('asset')
    .select(['id', 'ownerId', 'status', 'deletedAt'])
    .where('id', 'in', ids)
    .orderBy('id')
    .forShare()
    .execute();
  if (
    assets.length !== ids.length ||
    assets.some(
      (a) =>
        a.status !== AssetStatus.Active ||
        a.deletedAt !== null ||
        epochs.every((e) => e.assetId !== a.id || e.ownerId !== a.ownerId),
    )
  )
    refuse();
  const current = await AssetLocalEffectRepository.sourceEpochs(db, ids);
  if (
    current.length !== epochs.length ||
    current.some((row) =>
      epochs.every((e) => e.assetId !== row.assetId || e.ownerId !== row.ownerId || e.epoch !== row.epoch),
    )
  )
    refuse();
  const interactive = snapshot.kind === 'studio-preview' || snapshot.kind === 'studio-preview-stream';
  if (!interactive) return;
  const valueView = snapshot.interactiveAdmissionView;
  const owners = [...new Set(epochs.map((row) => row.ownerId))].sort();
  if (valueView === undefined) {
    // Historical interactive admissions are never relabelled across an affected owner stream.
    const rows = await db
      .selectFrom('asset_local_effect_stream')
      .select('nextSequence')
      .where('ownerId', 'in', owners)
      .execute();
    if (rows.some((row) => BigInt(row.nextSequence) > 1n)) refuse();
    return;
  }
  const view = valueView as InteractiveAdmissionView;
  if (
    !view ||
    !isStudioUuid(view.actorId) ||
    !view.sessionId ||
    !isStudioUuid(view.sessionId) ||
    (actorId && actorId !== view.actorId) ||
    !Array.isArray(view.owners) ||
    view.owners.length !== owners.length
  )
    refuse();
  for (const ownerId of owners) {
    const bound = view.owners.filter((row) => row?.ownerId === ownerId);
    if (
      bound.length !== 1 ||
      typeof bound[0].sequence !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(bound[0].sequence) ||
      (bound[0].streamEpoch !== null && !isStudioUuid(bound[0].streamEpoch))
    )
      refuse();
    const initialized =
      await sql`INSERT INTO asset_local_effect_stream("ownerId","streamEpoch") VALUES(${ownerId}::uuid,${randomUUID()}::uuid) ON CONFLICT("ownerId") DO NOTHING RETURNING "ownerId"`.execute(
        db,
      );
    if (initialized.rows.length === 1)
      await sql`INSERT INTO asset_local_effect_cursor("ownerId") VALUES(${ownerId}::uuid)`.execute(db);
  }
  const streams = await db
    .selectFrom('asset_local_effect_stream')
    .selectAll()
    .where('ownerId', 'in', owners)
    .orderBy('ownerId')
    .forShare()
    .execute();
  if (
    streams.length !== owners.length ||
    streams.some((row) => {
      const bound = view.owners.find((b) => b.ownerId === row.ownerId)!;
      return (
        BigInt(row.nextSequence) - 1n !== BigInt(bound.sequence) ||
        (bound.streamEpoch !== null && bound.streamEpoch !== row.streamEpoch) ||
        (bound.streamEpoch === null && bound.sequence !== '0')
      );
    })
  )
    refuse();
  // All asset/counter waits precede actual acting-session, privacy and revealed-lock admission.
  const live = await currentAuth(db, view.actorId, view.sessionId!, true);
  if (!live) refuse();
  const rows = await new AssetRepository(db).getByIds(ids);
  const allowed = await checkAccess(new AccessRepository(db), {
    auth: live!,
    permission: Permission.AssetRead,
    ids: new Set(ids),
  });
  const reasons = await new AssetRepository(db).getLockReasons(ids);
  const revealed = new Set(reasons.filter((row) => isRevealedLockReason(row.reason)).map((row) => row.assetId));
  if (
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        !allowed.has(row.id) ||
        row.deletedAt !== null ||
        row.status !== AssetStatus.Active ||
        row.isOffline ||
        (isLockedAssetRow(row) && (row.ownerId !== getLockedOwnerId(live!) || !revealed.has(row.id))),
    )
  )
    refuse();
}
