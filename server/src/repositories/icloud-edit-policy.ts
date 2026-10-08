import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { EditPublication } from 'src/repositories/icloud-edit-authority.repository.js';
import { AssetStatus } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { requireEditFamilyCoverage, requireEditPublicationBinding } from 'src/repositories/icloud-edit-transaction.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { onStacksJoined } from 'src/utils/locked-stacks.js';
import { isLocked } from 'src/utils/locked.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';

export type EditPolicyReceipt = {
  formatVersion: 1;
  config: { epoch: number; digest: string };
  authority: { generation: number; holder: string; currentVersionId: string; versionId: string };
  proofs: { assetId: string; versionId: string; sha256: string; isOriginal: boolean }[];
  stack: { stackId: string; primaryAssetId: string; memberAssetIds: string[] };
  previousStack: { stackId: string; primaryAssetId: string; memberAssetIds: string[] } | null;
  trashedAssetIds: string[];
  effect: { effectId: string; streamEpoch: string; sequence: string };
};
function review(reason: string): never {
  throw new ConflictException(reason);
}
const stackReceipt = z
  .object({ stackId: z.uuid(), primaryAssetId: z.uuid(), memberAssetIds: z.array(z.uuid()).min(1).max(100) })
  .strict();
const receiptSchema = z
  .object({
    formatVersion: z.literal(1),
    config: z.object({ epoch: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    authority: z
      .object({
        generation: z.number().int().positive(),
        holder: z.string().min(1),
        currentVersionId: z.uuid(),
        versionId: z.uuid(),
      })
      .strict(),
    proofs: z
      .array(
        z
          .object({
            assetId: z.uuid(),
            versionId: z.uuid(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            isOriginal: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    stack: stackReceipt,
    previousStack: stackReceipt.nullable(),
    trashedAssetIds: z.array(z.uuid()).max(100),
    effect: z
      .object({ effectId: z.uuid(), streamEpoch: z.uuid(), sequence: z.string().regex(/^[1-9][0-9]{0,18}$/) })
      .strict(),
  })
  .strict();
function parsePolicyReceipt(value: unknown): EditPolicyReceipt | undefined {
  if (value === undefined) return;
  const result = receiptSchema.safeParse(value);
  if (!result.success) review('edit_policy_receipt_invalid');
  const receipt = result.data;
  if (
    new Set(receipt.stack.memberAssetIds).size !== receipt.stack.memberAssetIds.length ||
    !receipt.stack.memberAssetIds.includes(receipt.stack.primaryAssetId) ||
    new Set(receipt.proofs.map((p) => p.assetId)).size !== receipt.proofs.length ||
    new Set(receipt.trashedAssetIds).size !== receipt.trashedAssetIds.length
  )
    review('edit_policy_receipt_invalid');
  return receipt;
}

/** Immutable local publication order, never provider/source revision order. */
export async function loadLatestPolicyWithin(
  db: Kysely<DB>,
  ownerId: string,
  items: string[],
  decisionId?: string,
): Promise<EditPolicyReceipt | undefined> {
  if (items.length === 0) return;
  // Administrative baseline changes are not publication order. The latest immutable
  // owner-local publication touching this locked family supplies the existing stack fence.
  const prior = await db
    .selectFrom('icloud_edit_decision as d')
    .leftJoin('asset_local_effect as e', (join) =>
      join.onRef('e.effectId', '=', 'd.id').onRef('e.ownerId', '=', 'd.ownerId'),
    )
    .leftJoin('asset_local_effect_stream as stream', 'stream.ownerId', 'd.ownerId')
    .select([
      'd.id',
      'd.assetId',
      'd.versionId',
      'd.evidence',
      'e.bundle',
      'e.bundleSha256',
      sql<string>`e.sequence::text`.as('sequence'),
      'stream.streamEpoch',
    ])
    .where('d.ownerId', '=', ownerId)
    .where('d.item', 'in', items)
    .$if(!!decisionId, (q) => q.where('d.id', '=', decisionId!))
    .where('d.assetId', 'is not', null)
    .where(sql<boolean>`d.evidence ? 'publication'`)
    .orderBy(sql`CASE WHEN e.sequence IS NULL THEN 0 ELSE 1 END`)
    .orderBy('e.sequence', 'desc')
    .limit(1)
    .executeTakeFirst();
  const priorReceipt = prior ? parsePolicyReceipt(prior.evidence.publication) : undefined;
  if (
    prior &&
    (!priorReceipt ||
      !prior.bundle ||
      !prior.bundleSha256 ||
      !prior.bundleSha256.equals(createHash('sha256').update(canonicalJson(prior.bundle)).digest()) ||
      prior.bundle.ownerId !== ownerId ||
      prior.bundle.effectId !== prior.id ||
      prior.bundle.sequence !== prior.sequence ||
      prior.bundle.streamEpoch !== prior.streamEpoch ||
      !isDeepStrictEqual(prior.bundle.origin, { kind: 'publication', decisionId: prior.id }) ||
      priorReceipt.effect.effectId !== prior.id ||
      priorReceipt.effect.sequence !== prior.sequence ||
      priorReceipt.effect.streamEpoch !== prior.streamEpoch ||
      priorReceipt.authority.versionId !== prior.versionId ||
      priorReceipt.stack.primaryAssetId !== prior.assetId ||
      !isDeepStrictEqual(prior.bundle.stacks, [priorReceipt.stack]))
  )
    review('edit_policy_receipt_invalid');
  return priorReceipt;
}

/** Actual accepted ledger tuple plus original, device or sync receipt; never opaque-token order. */
export async function provenPolicyVersionsWithin(db: Kysely<DB>, ownerId: string, items: string[], ids: string[]) {
  if (items.length === 0 || ids.length === 0) return [];
  const result = await sql<{
    id: string;
    item: string;
    assetId: string;
    sha256: Buffer;
    isOriginal: boolean;
  }>`SELECT v.id,v.item,v."assetId",v.sha256,v."isOriginal" FROM icloud_edit_version v
    WHERE v."ownerId"=${ownerId}::uuid AND v.item=ANY(${items}::text[]) AND v.id=ANY(${ids}::uuid[])
    AND (EXISTS(SELECT 1 FROM icloud_source_identity i WHERE i."ownerId"=v."ownerId" AND i."assetId"=v."assetId"
      AND upper(i."cplAssetRecordName")=v.item AND i.sha256=v.sha256 AND i.role=CASE WHEN v."isOriginal" THEN 'original' ELSE 'edit-render' END)
      OR EXISTS(SELECT 1 FROM icloud_edit_decision d JOIN asset_upload_resource r ON r.id=d."resourceId" AND r."ownerId"=d."ownerId"
        WHERE d."ownerId"=v."ownerId" AND d.item=v.item AND d."versionId"=v.id AND d.channel='device' AND d."assetId"=v."assetId"
          AND r."resultAssetId"=d."assetId" AND r.state='published' AND r."verifiedChecksum"=v.sha256 AND d.evidence->>'sha256'=encode(v.sha256,'hex'))
      OR EXISTS(SELECT 1 FROM icloud_edit_decision d JOIN icloud_resource r ON r.id=d."resourceId" AND r."ownerId"=d."ownerId"
        WHERE d."ownerId"=v."ownerId" AND d.item=v.item AND d."versionId"=v.id AND d.channel='icloud-sync' AND d."assetId"=v."assetId"
          AND r."assetId"=d."assetId" AND r.status IN ('committed','finalized') AND r."auditRequestId" IS NULL
          AND r.role IN ('edited-image','edited-video') AND upper(r."sourceAssetId")=v.item AND r.sha256=v.sha256
          AND d.evidence->>'sha256'=encode(v.sha256,'hex')))`.execute(db);
  return result.rows;
}

const backrefLocks = new WeakMap<Transaction<DB>, Set<string>>();
/** Domain content/user/connection/current-resource locks precede this; all asset locks follow. */
export async function lockPolicyBackrefs(tx: Transaction<DB>, ownerId: string, item: string) {
  const binding = requireEditPublicationBinding(tx, item);
  const rows =
    binding.family.assetIds.length > 0
      ? (
          await sql<{
            id: string;
            sourceAssetId: string;
          }>`SELECT id,"sourceAssetId" FROM public.icloud_resource WHERE "ownerId"=${ownerId}::uuid AND "assetId"=ANY(${binding.family.assetIds}::uuid[]) ORDER BY id LIMIT 101 FOR UPDATE`.execute(
            tx,
          )
        ).rows
      : [];
  if (rows.length > 100) review('edit_family_too_large');
  if (rows.some((r) => !binding.family.items.includes(r.sourceAssetId.toUpperCase()))) review('edit_family_unstable');
  backrefLocks.set(tx, new Set(rows.map((r) => r.id)));
}

type EditPolicyTransition = Pick<
  EditPublication,
  'item' | 'generation' | 'holder' | 'versionId' | 'sha256' | 'policy' | 'decisionId'
> & {
  channel?: EditPublication['channel'];
  resourceId?: string;
  priorVersionId?: string;
  acceptedVictimAssetIds?: string[];
};

/** Private immutable decision basis. Local stream order is not provider revision order. */
export async function captureEditPolicyAcceptance(
  tx: Transaction<DB>,
  ownerId: string,
  item: string,
  sessionId: string,
  expectedPublicationId: string | null,
  incomingAssetId: string | null,
) {
  const binding = requireEditPublicationBinding(tx, item);
  await lockPolicyBackrefs(tx, ownerId, item);
  const authority = await tx
    .selectFrom('icloud_edit_authority')
    .selectAll()
    .where('ownerId', '=', ownerId)
    .where('item', '=', item)
    .executeTakeFirstOrThrow();
  const versions = await tx
    .selectFrom('icloud_edit_version')
    .selectAll()
    .where('ownerId', '=', ownerId)
    .where('item', '=', item)
    .orderBy('assetId')
    .limit(101)
    .execute();
  if (versions.length > 100) review('edit_family_too_large');
  const assets =
    binding.family.assetIds.length > 0
      ? await tx
          .selectFrom('asset')
          .select(['id', 'ownerId', 'status', 'deletedAt', 'stackId', 'visibility', isLocked().as('locked')])
          .where('id', 'in', binding.family.assetIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      : [];
  if (
    assets.length !== binding.family.assetIds.length ||
    assets.some((a) => a.ownerId !== ownerId || ![AssetStatus.Active, AssetStatus.Trashed].includes(a.status))
  )
    review('edit_evidence_unavailable');
  if (versions.some((v) => assets.every((a) => a.id !== v.assetId))) review('edit_family_unstable');
  const stackIds = [...new Set(assets.flatMap((a) => (a.stackId ? [a.stackId] : [])))].sort();
  const stacks =
    stackIds.length > 0
      ? await tx
          .selectFrom('stack')
          .select(['id', 'ownerId', 'primaryAssetId'])
          .where('id', 'in', stackIds)
          .orderBy('id')
          .forUpdate()
          .execute()
      : [];
  if (stacks.length !== stackIds.length || stacks.some((s) => s.ownerId !== ownerId))
    review('edit_manual_stack_conflict');
  const publication = await loadLatestPolicyWithin(tx, ownerId, binding.family.items);
  if ((publication?.effect.effectId ?? null) !== expectedPublicationId) review('edit_publication_stale');
  const receipts = await provenPolicyVersionsWithin(
    tx,
    ownerId,
    [item],
    versions.map((v) => v.id),
  );
  if (versions.some((v) => receipts.every((r) => r.id !== v.id))) review('edit_member_evidence_unproven');
  const backrefs = (
    await sql<{ id: string; assetId: string; source: { _sync?: { relations?: Record<string, unknown> } } }>`
    SELECT id,"assetId",source FROM icloud_resource WHERE "ownerId"=${ownerId}::uuid
      AND "assetId"=ANY(${assets.map((a) => a.id)}::uuid[]) AND status IN ('committed','finalized')
      ORDER BY id LIMIT 101`.execute(tx)
  ).rows;
  if (backrefs.length > 100) review('edit_family_too_large');
  const head = await AssetLocalEffectRepository.lockStreamHead(tx, ownerId);
  const epochs = await AssetLocalEffectRepository.sourceEpochs(
    tx,
    assets.map((a) => a.id),
  );
  const live = await currentAuth(tx, ownerId, sessionId, false);
  if (!live) throw new ForbiddenException('edit_owner_session_required');
  await assertLifecycleProofs(
    tx,
    live,
    versions.map((v) => ({
      assetId: v.assetId,
      sha256: v.sha256.toString('hex'),
      status: assets.find((a) => a.id === v.assetId)!.status as AssetStatus.Active | AssetStatus.Trashed,
    })),
  );
  return {
    formatVersion: 1,
    config: { epoch: binding.epoch!.epoch, digest: binding.epoch!.digest, trashEnabled: binding.epoch!.trashEnabled },
    authority: {
      generation: authority.generation,
      holder: authority.holder,
      currentVersionId: authority.currentVersionId,
      sourceIncarnation: authority.sourceIncarnation,
    },
    publicationId: expectedPublicationId,
    head,
    items: binding.family.items,
    assets: assets.map((a) => ({ ...a, deletedAt: a.deletedAt?.toISOString() ?? null })),
    stacks,
    versions: versions.map((v) => ({
      id: v.id,
      item: v.item,
      assetId: v.assetId,
      sha256: v.sha256.toString('hex'),
      isOriginal: v.isOriginal,
    })),
    backrefs: backrefs.map((r) => ({ id: r.id, assetId: r.assetId, relations: r.source._sync?.relations ?? null })),
    epochs,
    victimAssetIds: versions
      .filter(
        (v) =>
          !v.isOriginal &&
          v.assetId !== incomingAssetId &&
          assets.find((a) => a.id === v.assetId)!.status === AssetStatus.Active,
      )
      .map((v) => v.assetId)
      .sort(),
  };
}

/** Equality plus held row/counter locks fence intervening policy, including equal-state round trips. */
export async function assertEditPolicyAcceptance(
  tx: Transaction<DB>,
  ownerId: string,
  item: string,
  sessionId: string,
  accepted: unknown,
  incomingAssetId: string | null,
) {
  const expected = z
    .object({ formatVersion: z.literal(1), publicationId: z.uuid().nullable() })
    .passthrough()
    .safeParse(accepted);
  if (!expected.success) review('edit_supersede_requires_review');
  const current = await captureEditPolicyAcceptance(
    tx,
    ownerId,
    item,
    sessionId,
    expected.data.publicationId,
    incomingAssetId,
  );
  if (!isDeepStrictEqual(current, accepted)) review('edit_policy_acceptance_stale');
  return current;
}

export async function assertEditPolicyReceiptAccess(
  tx: Transaction<DB>,
  ownerId: string,
  sessionId: string,
  receipt: EditPolicyReceipt,
) {
  const live = await currentAuth(tx, ownerId, sessionId, false);
  if (!live) throw new ForbiddenException('edit_owner_session_required');
  const rows = await tx
    .selectFrom('asset')
    .select(['id', 'status'])
    .where(
      'id',
      'in',
      receipt.proofs.map((p) => p.assetId),
    )
    .execute();
  if (
    receipt.proofs.some((p) =>
      rows.every((r) => r.id !== p.assetId || ![AssetStatus.Active, AssetStatus.Trashed].includes(r.status)),
    )
  )
    review('edit_evidence_unavailable');
  await assertLifecycleProofs(
    tx,
    live,
    receipt.proofs.map((p) => ({
      ...p,
      status: rows.find((r) => r.id === p.assetId)!.status as AssetStatus.Active | AssetStatus.Trashed,
    })),
  );
}

/** Same-transaction private policy receipt; administrative bindings never imply provider order. */
export async function applyEditPolicyWithin(
  tx: Transaction<DB>,
  ownerId: string,
  publication: EditPolicyTransition,
  assetId: string,
  sessionId: string,
): Promise<EditPolicyReceipt> {
  const binding = requireEditPublicationBinding(tx, publication.item);
  const authority = await tx
    .selectFrom('icloud_edit_authority')
    .selectAll()
    .where('ownerId', '=', ownerId)
    .where('item', '=', publication.item)
    .executeTakeFirstOrThrow();
  if (authority.generation !== publication.generation || authority.holder !== publication.holder)
    review('edit_owner_stale');
  const versions = await tx
    .selectFrom('icloud_edit_version')
    .selectAll()
    .where('ownerId', '=', ownerId)
    .where('item', '=', publication.item)
    .orderBy('assetId')
    .limit(101)
    .execute();
  if (versions.length > 100) review('edit_family_too_large');
  const members = [...new Set([...versions.map((v) => v.assetId), assetId])].sort();
  if (members.length > 100) review('edit_family_too_large');
  if (versions.some((v) => !binding.family.assetIds.includes(v.assetId))) review('edit_family_unstable');
  // The admitted family prefix covers all pre-existing motion/stack/derived rows.
  // A newly created incoming row is already private to this writer transaction.
  const lockedIds = [...new Set([...binding.family.assetIds, assetId])].sort();
  const backrefs = (
    await sql<{
      id: string;
      sourceAssetId: string;
      assetId: string;
      source: { _sync?: { relations?: { stackId?: string; events?: unknown[] } & Record<string, unknown> } };
    }>`SELECT id,source,"sourceAssetId","assetId" FROM public.icloud_resource WHERE "ownerId"=${ownerId}::uuid AND "assetId"=ANY(${members}::uuid[]) AND status IN ('committed','finalized') ORDER BY id LIMIT 101`.execute(
      tx,
    )
  ).rows;
  if (
    backrefs.some(
      (r) =>
        !backrefLocks.get(tx)?.has(r.id) && !(publication.channel === 'icloud-sync' && r.id === publication.resourceId),
    )
  )
    review('edit_source_backrefs_changed');
  if (backrefs.length > 100) review('edit_family_too_large');
  if (backrefs.some((r) => !binding.family.items.includes(r.sourceAssetId.toUpperCase())))
    review('edit_family_unstable');
  const allAssets = await tx
    .selectFrom('asset')
    .select(['id', 'ownerId', 'status', 'deletedAt', 'stackId'])
    .where('id', 'in', lockedIds)
    .orderBy('id')
    .forUpdate()
    .execute();
  if (
    allAssets.length !== lockedIds.length ||
    allAssets.some(
      (a) => a.ownerId !== ownerId || (a.status !== AssetStatus.Active && a.status !== AssetStatus.Trashed),
    )
  )
    review('edit_evidence_unavailable');
  const assets = allAssets.filter((a) => members.includes(a.id));
  if (assets.length !== members.length) review('edit_family_unstable');
  const stackIds = [...new Set(assets.flatMap((a) => (a.stackId ? [a.stackId] : [])))].sort();
  if (stackIds.length > 1) review('edit_manual_stack_conflict');
  const stack =
    stackIds.length > 0
      ? await tx
          .selectFrom('stack')
          .selectAll()
          .where('id', '=', stackIds[0])
          .where('ownerId', '=', ownerId)
          .forUpdate()
          .executeTakeFirst()
      : undefined;
  const existingMembers = stack
    ? await tx.selectFrom('asset').select('id').where('stackId', '=', stack.id).orderBy('id').execute()
    : [];
  if (stack && existingMembers.some((a) => !members.includes(a.id))) review('edit_manual_stack_conflict');
  const priorReceipt = await loadLatestPolicyWithin(tx, ownerId, binding.family.items);
  const applied = priorReceipt ? [priorReceipt] : [];
  const sourceStates = backrefs
    .flatMap((r) => (r.source._sync?.relations?.stackId ? [r.source._sync.relations] : []))
    .map((state) => {
      const parsed = z
        .object({
          stackId: z.uuid(),
          appliedPrimaryAssetId: z.uuid(),
          memberAssetIds: z.array(z.uuid()).min(1).max(100),
        })
        .passthrough()
        .safeParse(state);
      if (!parsed.success || new Set(parsed.data.memberAssetIds).size !== parsed.data.memberAssetIds.length)
        review('edit_manual_stack_conflict');
      return parsed.data;
    });
  if (backrefs.some((r) => (r.source._sync?.relations?.events ?? []).length))
    review('edit_legacy_pending_effects_review');
  const fences = [
    ...applied.map((r) => r.stack),
    ...sourceStates.map((s) => ({
      stackId: s.stackId,
      primaryAssetId: s.appliedPrimaryAssetId,
      memberAssetIds: [...(s.memberAssetIds ?? [])].sort(),
    })),
  ];
  if (!stack && fences.length > 0) review('edit_manual_stack_conflict');
  if (
    stack &&
    (fences.length === 0 ||
      fences.some(
        (f) =>
          f.stackId !== stack.id ||
          f.primaryAssetId !== stack.primaryAssetId ||
          !isDeepStrictEqual(
            [...f.memberAssetIds].sort(),
            existingMembers.map((a) => a.id),
          ),
      ))
  )
    review('edit_manual_stack_conflict');
  // All waits precede the current session/PIN/privacy and byte proof checks.
  const live = await currentAuth(tx, ownerId, sessionId, true);
  if (!live) throw new ForbiddenException('edit_owner_session_required');
  const proofs = versions.map((v) => ({
    assetId: v.assetId,
    versionId: v.id,
    sha256: v.sha256.toString('hex'),
    isOriginal: v.isOriginal,
  }));
  await assertLifecycleProofs(
    tx,
    live,
    proofs.map((p) => ({
      ...p,
      status: assets.find((a) => a.id === p.assetId)!.status as AssetStatus.Active | AssetStatus.Trashed,
    })),
  );
  // Batch the same real receipt predicates, retaining the actual version/item/asset/digest tuple.
  const receipts = await provenPolicyVersionsWithin(
    tx,
    ownerId,
    [publication.item],
    versions.map((v) => v.id),
  );
  if (versions.some((v) => receipts.every((r) => r.id !== v.id))) review('edit_member_evidence_unproven');
  const incoming = await new IntegrityRepository(tx)
    .getSafetyQuery(live, [publication.sha256.toString('hex')])
    .where('asset.id', '=', assetId)
    .executeTakeFirst();
  if (!incoming) review('edit_evidence_unavailable');
  const trash =
    publication.policy === 'supersede'
      ? versions
          .filter(
            (v) =>
              !v.isOriginal &&
              v.assetId !== assetId &&
              assets.find((a) => a.id === v.assetId)!.status === AssetStatus.Active,
          )
          .map((v) => v.assetId)
          .sort()
      : [];
  if (publication.policy === 'supersede' && !isDeepStrictEqual(trash, publication.acceptedVictimAssetIds))
    review('edit_policy_acceptance_stale');
  if (trash.length > 0) {
    if (!binding.epoch!.trashEnabled) review('edit_trash_disabled');
    const shared = await tx
      .selectFrom('icloud_edit_authority as a')
      .innerJoin('icloud_edit_version as v', 'v.id', 'a.currentVersionId')
      .select('v.assetId')
      .where('a.ownerId', '=', ownerId)
      .where('a.item', '!=', publication.item)
      .where('v.assetId', 'in', trash)
      .execute();
    if (shared.length > 0) review('edit_shared_current_conflict');
    const privacy = live.hiddenContent ?? live.hideNsfwAssets;
    const changed = await new TrashRepository(tx).applyReviewedWithin(
      tx,
      ownerId,
      TrashReviewAction.Trash,
      trash,
      {
        lockedOwnerId: live.session?.hasElevatedPermission ? ownerId : undefined,
        privacy: typeof privacy === 'object' ? { hiddenContent: privacy } : privacy ? { excludeNsfw: true } : {},
      },
      (rows) => isDeepStrictEqual(rows.map((r) => r.id).sort(), trash),
    );
    if (!changed || changed.length !== trash.length) review('edit_evidence_unavailable');
  }
  const activeCount = versions.filter(
    (v) =>
      !v.isOriginal &&
      v.assetId !== assetId &&
      assets.find((a) => a.id === v.assetId)!.status === AssetStatus.Active &&
      !trash.includes(v.assetId),
  ).length;
  if (activeCount >= 20 && versions.every((v) => v.assetId !== assetId)) review('edit_capacity_reached');
  const stackId = stack?.id ?? randomUUID();
  if (stack) {
    const changed = await tx
      .updateTable('stack')
      .set({ primaryAssetId: assetId })
      .where('id', '=', stackId)
      .where('primaryAssetId', '=', stack.primaryAssetId)
      .returning('id')
      .execute();
    if (changed.length !== 1) review('edit_manual_stack_conflict');
  } else {
    await tx.insertInto('stack').values({ id: stackId, ownerId, primaryAssetId: assetId }).execute();
  }
  const hasLocked =
    (await tx.selectFrom('asset').select('id').where('id', 'in', members).where(isLocked('asset')).limit(1).execute())
      .length > 0;
  if (hasLocked) await AssetLocalEffectRepository.refuseRelevantLegacyInteractive(tx, ownerId, lockedIds);
  await tx.updateTable('asset').set({ stackId }).where('ownerId', '=', ownerId).where('id', 'in', members).execute();
  const newlyLocked = hasLocked ? await onStacksJoined(tx, [stackId]) : [];
  requireEditFamilyCoverage(tx, { items: [publication.item], assetIds: newlyLocked.filter((id) => id !== assetId) });
  const lockedCascade =
    newlyLocked.length > 0 ? await AssetLocalEffectRepository.selectLockedAdmissions(tx, newlyLocked) : undefined;
  const changedIds = [...new Set([assetId, ...trash, ...newlyLocked])].sort();
  const changedAssets = await tx
    .selectFrom('asset')
    .select(['id', 'status'])
    .where('ownerId', '=', ownerId)
    .where('id', 'in', changedIds)
    .orderBy('id')
    .execute();
  if (changedAssets.length !== changedIds.length) review('edit_family_unstable');
  const effect = await new AssetLocalEffectRepository(tx).append(tx, ownerId, publication.decisionId, {
    origin: { kind: 'publication', decisionId: publication.decisionId },
    assets: changedAssets.map((a) => ({
      assetId: a.id,
      status: a.status as AssetStatus.Active | AssetStatus.Trashed,
      revoke: trash.includes(a.id),
    })),
    stacks: [{ stackId, primaryAssetId: assetId, memberAssetIds: members }],
    ...(lockedCascade && { lockedCascade }),
  });
  const finalAuth = await currentAuth(tx, ownerId, sessionId, false);
  if (!finalAuth) throw new ForbiddenException('edit_owner_session_required');
  await assertLifecycleProofs(
    tx,
    finalAuth,
    [...proofs, { assetId, sha256: publication.sha256.toString('hex') }].map((proof) => ({
      ...proof,
      status: (trash.includes(proof.assetId)
        ? AssetStatus.Trashed
        : (assets.find((a) => a.id === proof.assetId)?.status ?? AssetStatus.Active)) as
        AssetStatus.Active | AssetStatus.Trashed,
    })),
  );
  for (const row of backrefs) {
    const state = row.source._sync?.relations;
    if (!state) continue;
    const next = {
      ...state,
      stackId,
      appliedPrimaryAssetId: assetId,
      memberAssetIds: members,
      events: [],
      localPublication: { effectId: effect.effectId, streamEpoch: effect.streamEpoch, sequence: effect.sequence },
    };
    const changed =
      await sql`UPDATE icloud_resource SET source=jsonb_set(source,'{_sync,relations}',${next}::jsonb,true)
      WHERE id=${row.id}::uuid AND "ownerId"=${ownerId}::uuid AND source#>'{_sync,relations}'=${state}::jsonb`.execute(
        tx,
      );
    if (changed.numAffectedRows !== 1n) review('edit_manual_stack_conflict');
  }
  return {
    formatVersion: 1,
    config: { epoch: binding.epoch!.epoch, digest: binding.epoch!.digest },
    authority: {
      generation: publication.generation,
      holder: publication.holder,
      currentVersionId: publication.priorVersionId ?? authority.currentVersionId,
      versionId: publication.versionId,
    },
    proofs: [
      ...proofs,
      ...(proofs.some((p) => p.assetId === assetId)
        ? []
        : [
            {
              assetId,
              versionId: publication.versionId,
              sha256: publication.sha256.toString('hex'),
              isOriginal: false,
            },
          ]),
    ],
    stack: { stackId, primaryAssetId: assetId, memberAssetIds: members },
    trashedAssetIds: trash,
    previousStack: stack
      ? { stackId: stack.id, primaryAssetId: stack.primaryAssetId, memberAssetIds: existingMembers.map((a) => a.id) }
      : null,
    effect: { effectId: effect.effectId, streamEpoch: effect.streamEpoch, sequence: effect.sequence },
  };
}

/** Same privacy/byte oracle for every member, grouped only by actual lifecycle state. */
async function assertLifecycleProofs(
  tx: Transaction<DB>,
  auth: AuthDto,
  proofs: { assetId: string; sha256: string; status: AssetStatus.Active | AssetStatus.Trashed }[],
) {
  for (const status of [AssetStatus.Active, AssetStatus.Trashed] as const) {
    const group = proofs.filter((p) => p.status === status);
    if (group.length === 0) continue;
    const rows = await new IntegrityRepository(tx)
      .getLifecycleSafetyQuery(
        auth,
        status,
        group.map((p) => p.sha256),
      )
      .where('asset.id', 'in', [...new Set(group.map((p) => p.assetId))])
      .execute();
    if (group.some((p) => rows.every((r) => !(r.id === p.assetId && r.sha256 === p.sha256))))
      review('edit_evidence_unavailable');
  }
}
