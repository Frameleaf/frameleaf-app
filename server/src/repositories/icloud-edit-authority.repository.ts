import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ICloudIdentityRow } from 'src/repositories/icloud-identity.repository.js';
import type { ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ICloudEditBaselineDto,
  ICloudEditEvidenceResponseDto,
  ICloudEditSuccessorDto,
} from 'src/dtos/icloud-identity.dto.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import {
  applyEditPolicyWithin,
  assertEditPolicyAcceptance,
  assertEditPolicyReceiptAccess,
  captureEditPolicyAcceptance,
  loadLatestPolicyWithin,
  lockPolicyBackrefs,
} from 'src/repositories/icloud-edit-policy.js';
import { requireEditPublicationBinding, withEditFamilyTransaction } from 'src/repositories/icloud-edit-transaction.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { DB } from 'src/schema/index.js';
import { parseCloudIdentifier } from 'src/utils/icloud-identity.js';

function conflict(code: string): never {
  throw new ConflictException(code);
}
/** Return only fixed authority codes; never forward parser/provider details. */
export function editAuthorityReviewReason(error: unknown): string | undefined {
  const codes = [
    'edit_baseline_unproven',
    'edit_successor_decision_required',
    'edit_owner_stale',
    'edit_version_stale',
    'edit_evidence_changed',
    'edit_evidence_unavailable',
    'edit_render_conflict',
    'edit_capacity_reached',
    'edit_supersede_requires_review',
    'edit_policy_acceptance_stale',
    'edit_trash_disabled',
    'edit_shared_current_conflict',
    'edit_manual_stack_conflict',
    'edit_source_backrefs_changed',
    'edit_member_evidence_unproven',
    'edit_family_too_large',
    'edit_family_unstable',
    'edit_legacy_pending_effects_review',
    'edit_policy_receipt_invalid',
    'edit_owner_session_required',
    'edit_item_claimed',
    'edit_owner_unavailable',
    'edit_publication_already_committed',
    'edit_bound_asset_required',
    'edit_alias_conflict',
    'edit_publication_stale',
    'edit_administrative_policy_transition_required',
  ];
  return (error instanceof ConflictException || error instanceof ForbiddenException) && codes.includes(error.message)
    ? error.message
    : undefined;
}
type Source = {
  item: string;
  holder: string;
  nativeVersion: string;
  sha256: Buffer;
  claimId: string | null;
  sourceIncarnation?: string;
  generation?: number;
};
export type EditPublication = {
  channel: 'device' | 'icloud-sync';
  resourceId: string;
  decisionId: string;
  versionId: string;
  item: string;
  holder: string;
  nativeVersion: string;
  sourceIncarnation: string;
  generation: number;
  sha256: Buffer;
  existingAssetId: string | null;
  policy: 'keep' | 'supersede';
  acceptedVictimAssetIds?: string[];
};

/** Owner decisions are administrative acceptance of specific evidence, never Apple chronology. */
export class ICloudEditAuthorityRepository {
  constructor(private db: Kysely<DB>) {}

  /** Bounded owner-session discovery; no cached authority/elevation is serialized as permission. */
  async discover(auth: AuthDto, assetId: string): Promise<ICloudEditEvidenceResponseDto> {
    if (!auth.session || auth.apiKey || auth.sharedLink) throw new ForbiddenException('edit_owner_session_required');
    const { rows: hints } = await sql<{
      cplAssetRecordName: string;
    }>`SELECT "cplAssetRecordName" FROM public.icloud_source_identity WHERE "ownerId"=${auth.user.id}::uuid AND "assetId"=${assetId}::uuid ORDER BY id LIMIT 101`.execute(
      this.db,
    );
    if (hints.length > 100) conflict('edit_evidence_too_large');
    return this.db.transaction().execute(async (tx) => {
      const items = await lockICloudItemClaims(
        tx,
        auth.user.id,
        hints.map((row) => row.cplAssetRecordName),
      );
      const live = await this.session(tx, auth);
      const selector = await new IntegrityRepository(tx)
        .getSafetyQuery(live)
        .where('asset.id', '=', assetId)
        .executeTakeFirst();
      if (!selector?.sha256) conflict('edit_evidence_unavailable');
      const { rows: refreshed } = await sql<{
        cplAssetRecordName: string;
      }>`SELECT "cplAssetRecordName" FROM public.icloud_source_identity WHERE "ownerId"=${auth.user.id}::uuid AND "assetId"=${assetId}::uuid ORDER BY id LIMIT 101`.execute(
        tx,
      );
      if (refreshed.length > 100 || refreshed.some((row) => !items.includes(row.cplAssetRecordName.toUpperCase())))
        conflict('edit_evidence_changed');
      const result: ICloudEditEvidenceResponseDto['items'] = [];
      const proofs: { assetId: string; sha256: Buffer }[] = [{ assetId, sha256: Buffer.from(selector.sha256, 'hex') }];
      const privateIncoming = new Set<string>();
      const incomingClaims = new Map<string, string | null>();
      for (const item of items) {
        const { rows: receipts } =
          await sql<ICloudIdentityRow>`SELECT * FROM public.icloud_source_identity WHERE "ownerId"=${auth.user.id}::uuid AND upper("cplAssetRecordName")=${item} AND role IN ('original','edit-render') ORDER BY id LIMIT 101 FOR SHARE`.execute(
            tx,
          );
        if (receipts.length > 100) conflict('edit_evidence_too_large');
        const authority = await tx
          .selectFrom('icloud_edit_authority as a')
          .innerJoin('icloud_edit_version as v', 'v.id', 'a.currentVersionId')
          .select([
            'a.generation',
            'a.currentVersionId as versionId',
            'a.holder',
            'a.sourceIncarnation',
            'v.assetId',
            'v.sha256',
          ])
          .where('a.ownerId', '=', auth.user.id)
          .where('a.item', '=', item)
          .where('v.ownerId', '=', auth.user.id)
          .where('v.item', '=', item)
          .executeTakeFirst();
        const devices = await tx
          .selectFrom('backup_device')
          .select('deviceKey')
          .where('ownerId', '=', auth.user.id)
          .where('deletedAt', 'is', null)
          .orderBy('deviceKey')
          .limit(101)
          .forShare()
          .execute();
        const { rows: connections } = await sql<{
          id: string;
          state: string;
          unhealthySince: Date | null;
        }>`SELECT id,state,"unhealthySince" FROM public.icloud_connection WHERE "ownerId"=${auth.user.id}::uuid ORDER BY id LIMIT 101 FOR SHARE`.execute(
          tx,
        );
        if (devices.length > 100 || connections.length > 100) conflict('edit_evidence_too_large');
        const { rows: claims } = await sql<{
          claimId: string;
          holder: string;
          expiresAt: Date;
        }>`SELECT id AS "claimId",holder,"expiresAt" FROM public.icloud_claim WHERE "ownerId"=${auth.user.id}::uuid AND "cplAssetRecordName"=${item} AND "expiresAt">clock_timestamp() ORDER BY id LIMIT 101 FOR SHARE`.execute(
          tx,
        );
        const deviceRows = await tx
          .selectFrom('asset_upload_resource')
          .selectAll()
          .where('ownerId', '=', auth.user.id)
          .where('state', 'in', ['verified', 'published'])
          .where(sql<string>`upper(metadata#>>'{sourceIdentity,cloudIdentifier}')`, 'like', item + ':%')
          .orderBy('id')
          .limit(101)
          .forShare()
          .execute();
        const { rows: syncRows } =
          await sql<ICloudResource>`SELECT * FROM public.icloud_resource WHERE "ownerId"=${auth.user.id}::uuid AND "auditRequestId" IS NULL AND upper("sourceAssetId")=${item} AND role IN ('edited-image','edited-video') AND sha256 IS NOT NULL AND status IN ('validated','promoted','needs-review','committed','finalized','reused') ORDER BY id LIMIT 101 FOR SHARE`.execute(
            tx,
          );
        if (claims.length > 100 || deviceRows.length + syncRows.length > 100) conflict('edit_evidence_too_large');
        const incoming: ICloudEditEvidenceResponseDto['items'][number]['incoming'] = [];
        for (const [channel, rows] of [
          ['device', deviceRows],
          ['icloud-sync', syncRows],
        ] as const) {
          for (const row of rows) {
            const source = await this.source(tx, auth.user.id, channel, row.id);
            if (!source || source.item !== item) continue;
            const fresh = await this.session(tx, auth);
            if (
              channel === 'icloud-sync' &&
              !fresh.session?.hasElevatedPermission &&
              (row as (typeof syncRows)[number]).source.isHidden !== undefined &&
              (row as (typeof syncRows)[number]).source.isHidden !== false
            )
              continue;
            if (
              channel === 'device'
                ? devices.every((d) => source.holder !== 'device:' + d.deviceKey)
                : connections.every((c) => source.holder !== 'icloud-sync:' + c.id || c.state === 'disconnected')
            )
              continue;
            const mapped =
              channel === 'device'
                ? (row as (typeof deviceRows)[number]).resultAssetId
                : (row as (typeof syncRows)[number]).assetId;
            if (mapped) proofs.push({ assetId: mapped, sha256: source.sha256 });
            if (
              channel === 'icloud-sync' &&
              (row as (typeof syncRows)[number]).source.isHidden !== undefined &&
              (row as (typeof syncRows)[number]).source.isHidden !== false
            )
              privateIncoming.add(row.id);
            incomingClaims.set(row.id, source.claimId);
            incoming.push({
              channel,
              resourceId: row.id,
              holder: source.holder,
              nativeVersion: source.nativeVersion,
              sha256: source.sha256.toString('hex'),
              state:
                channel === 'device'
                  ? (row as (typeof deviceRows)[number]).state
                  : (row as (typeof syncRows)[number]).status,
              claimLive: claims.some((c) => c.claimId === source.claimId && c.holder === source.holder),
              administrativeDecisionRequired: true,
            });
          }
        }
        proofs.push(
          ...receipts.map((r) => ({ assetId: r.assetId, sha256: r.sha256 })),
          ...(authority ? [{ assetId: authority.assetId, sha256: authority.sha256 }] : []),
        );
        const now = await sql<{
          eligible: boolean;
          id: string;
        }>`SELECT id,("unhealthySince" IS NOT NULL AND "unhealthySince"<=clock_timestamp()-interval '72 hours' AND state<>'connected') AS eligible FROM icloud_connection WHERE "ownerId"=${auth.user.id}::uuid`.execute(
          tx,
        );
        result.push({
          item,
          receipts: receipts.map((r) => ({
            receiptId: r.id,
            assetId: r.assetId,
            sha256: r.sha256.toString('hex'),
            role: r.role as 'original' | 'edit-render',
            nativeVersion: r.editVersion,
            suggestedAdministrativeLabel: r.role === 'original' ? 'administrative-original' : null,
            deliveredBy: r.deliveredBy,
          })),
          authority: authority
            ? {
                ...authority,
                currentPublicationId: (await loadLatestPolicyWithin(tx, auth.user.id, [item]))?.effect.effectId ?? null,
                sha256: authority.sha256.toString('hex'),
                evidenceType: 'administrative',
              }
            : null,
          holders: [
            ...devices.map((d) => ({
              holder: 'device:' + d.deviceKey,
              state: 'registered',
              unhealthySince: null,
              automaticTakeoverEligible: false,
            })),
            ...connections.map((c) => ({
              holder: 'icloud-sync:' + c.id,
              state: c.state,
              unhealthySince: c.unhealthySince ? new Date(c.unhealthySince).toISOString() : null,
              automaticTakeoverEligible: now.rows.some((n) => n.id === c.id && n.eligible),
            })),
          ],
          claims: claims.map((c) => ({ ...c, expiresAt: new Date(c.expiresAt).toISOString() })),
          incoming,
        });
      }
      // No asset lock precedes source/holder waits; all output assets share one sorted lock pass.
      for (const id of [...new Set(proofs.map((p) => p.assetId))].sort())
        await tx
          .selectFrom('asset')
          .select('id')
          .where('id', '=', id)
          .where('ownerId', '=', auth.user.id)
          .forShare()
          .execute();
      for (const proof of proofs) await this.ownedAsset(tx, auth, proof.assetId, proof.sha256);
      const finalAuth = await this.session(tx, auth);
      const { rows: finalEligibility } = await sql<{
        id: string;
        eligible: boolean;
      }>`SELECT id,("unhealthySince" IS NOT NULL AND "unhealthySince"<=clock_timestamp()-interval '72 hours' AND state<>'connected') AS eligible FROM public.icloud_connection WHERE "ownerId"=${auth.user.id}::uuid ORDER BY id LIMIT 101`.execute(
        tx,
      );
      if (finalEligibility.length > 100) conflict('edit_evidence_too_large');
      for (const item of result) {
        for (const holder of item.holders)
          if (holder.holder.startsWith('icloud-sync:'))
            holder.automaticTakeoverEligible = finalEligibility.some(
              (c) => 'icloud-sync:' + c.id === holder.holder && c.eligible,
            );
        // Row locks protect ownership, but lease/PIN time still advances during the asset wait.
        const { rows: freshClaims } = await sql<{
          claimId: string;
          holder: string;
          expiresAt: Date;
        }>`SELECT id AS "claimId",holder,"expiresAt" FROM public.icloud_claim WHERE "ownerId"=${auth.user.id}::uuid AND "cplAssetRecordName"=${item.item} AND "expiresAt">clock_timestamp() ORDER BY id LIMIT 101`.execute(
          tx,
        );
        if (freshClaims.length > 100) conflict('edit_evidence_too_large');
        item.claims = freshClaims.map((c) => ({ ...c, expiresAt: new Date(c.expiresAt).toISOString() }));
        for (const row of item.incoming)
          row.claimLive = freshClaims.some(
            (c) => c.claimId === incomingClaims.get(row.resourceId) && c.holder === row.holder,
          );
        if (!finalAuth.session?.hasElevatedPermission)
          item.incoming = item.incoming.filter((row) => !privateIncoming.has(row.resourceId));
      }
      return { complete: true, admissionGuaranteed: false, items: result };
    });
  }
  private async session(tx: Transaction<DB>, auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new ForbiddenException('edit_owner_session_required');
    }
    const live = await currentAuth(tx, auth.user.id, auth.session.id, true);
    if (!live) {
      throw new ForbiddenException('edit_owner_session_required');
    }
    return live;
  }
  private async ownedAsset(tx: Transaction<DB>, auth: AuthDto, assetId: string, sha256: Buffer) {
    // Acquire the owned asset lock first: elevation may expire while this waits.
    await tx
      .selectFrom('asset')
      .select('id')
      .where('id', '=', assetId)
      .where('ownerId', '=', auth.user.id)
      .forShare()
      .execute();
    const live = await this.session(tx, auth);
    const asset = await new IntegrityRepository(tx)
      .getSafetyQuery(live, [sha256.toString('hex')])
      .where('asset.id', '=', assetId)
      .where('asset.ownerId', '=', auth.user.id)
      .forShare('asset')
      .executeTakeFirst();
    if (!asset) {
      conflict('edit_evidence_unavailable');
    }
    // Do not serialize elevation as a future worker's protected-media grant.
    return live;
  }
  /** Lock the complete publication proof set before reading live authorization once after every asset wait. */
  private async ownedAssets(tx: Transaction<DB>, auth: AuthDto, proofs: { assetId: string; sha256: Buffer }[]) {
    const ids = [...new Set(proofs.map((proof) => proof.assetId))].sort();
    if (ids.length === 0) conflict('edit_evidence_unavailable');
    await tx
      .selectFrom('asset')
      .select('id')
      .where('id', 'in', ids)
      .where('ownerId', '=', auth.user.id)
      .orderBy('id')
      .forShare()
      .execute();
    const live = await this.session(tx, auth);
    const assets = await new IntegrityRepository(tx)
      .getSafetyQuery(
        live,
        proofs.map((proof) => proof.sha256.toString('hex')),
      )
      .where('asset.id', 'in', ids)
      .where('asset.ownerId', '=', auth.user.id)
      .orderBy('asset.id')
      .forShare('asset')
      .execute();
    if (
      proofs.some((proof) =>
        assets.every((asset) => !(asset.id === proof.assetId && asset.sha256 === proof.sha256.toString('hex'))),
      )
    ) {
      conflict('edit_evidence_unavailable');
    }
    return live;
  }
  private async holder(tx: Transaction<DB>, ownerId: string, holder: string) {
    const result = holder.startsWith('device:')
      ? await sql`SELECT 1 FROM public.backup_device WHERE "ownerId"=${ownerId}::uuid AND "deviceKey"=${holder.slice(7)}::uuid AND "deletedAt" IS NULL FOR SHARE`.execute(
          tx,
        )
      : await sql`SELECT 1 FROM public.icloud_connection WHERE "ownerId"=${ownerId}::uuid AND id=${holder.slice(12)}::uuid AND state<>'disconnected' FOR SHARE`.execute(
          tx,
        );
    if (result.rows.length !== 1) {
      conflict('edit_owner_unavailable');
    }
  }
  private async request(
    tx: Transaction<DB>,
    ownerId: string,
    requestId: string,
    evidence: Record<string, unknown>,
    sessionId: string,
  ) {
    const row = await tx.selectFrom('icloud_edit_decision').selectAll().where('id', '=', requestId).executeTakeFirst();
    if (!row) {
      return;
    }
    if (
      row.ownerId !== ownerId ||
      !isDeepStrictEqual(row.evidence.request, evidence.request) ||
      ['holder', 'nativeVersion', 'sha256', 'receipt'].some(
        (key) => !isDeepStrictEqual(row.evidence[key], evidence[key]),
      )
    ) {
      conflict('edit_decision_conflict');
    }
    if (row.kind === 'baseline') {
      const receipt = evidence.receipt as { item: string; assetId: string; sha256: string; role: string } | undefined;
      if (row.evidence.publication && !(await loadLatestPolicyWithin(tx, ownerId, [row.item], row.id)))
        conflict('edit_policy_receipt_invalid');
      const version = await tx
        .selectFrom('icloud_edit_version')
        .selectAll()
        .where('id', '=', row.versionId)
        .where('ownerId', '=', ownerId)
        .executeTakeFirst();
      if (
        !receipt ||
        !version ||
        version.item !== receipt.item ||
        version.assetId !== receipt.assetId ||
        version.sha256.toString('hex') !== receipt.sha256 ||
        version.isOriginal !== (receipt.role === 'original')
      )
        conflict('edit_decision_conflict');
    }
    if (row.kind === 'successor' && row.assetId) {
      const version = await tx
        .selectFrom('icloud_edit_version')
        .selectAll()
        .where('id', '=', row.versionId)
        .where('ownerId', '=', ownerId)
        .where('item', '=', row.item)
        .executeTakeFirst();
      const receipt = await loadLatestPolicyWithin(tx, ownerId, [row.item], row.id);
      if (
        !version ||
        version.assetId !== row.assetId ||
        version.sha256.toString('hex') !== row.evidence.sha256 ||
        !receipt ||
        typeof row.evidence.sessionId !== 'string'
      )
        conflict('edit_decision_conflict');
      await assertEditPolicyReceiptAccess(tx, ownerId, sessionId, receipt);
    }
    return {
      decisionId: row.id,
      generation: row.generation,
      versionId: row.versionId,
      evidenceType: 'administrative' as const,
    };
  }
  async baseline(auth: AuthDto, dto: ICloudEditBaselineDto) {
    const hint = await sql<{
      item: string;
    }>`SELECT "cplAssetRecordName" AS item FROM public.icloud_source_identity WHERE id=${dto.receiptId}::uuid AND "ownerId"=${auth.user.id}::uuid`.execute(
      this.db,
    );
    if (!hint.rows[0]) {
      conflict('edit_evidence_unavailable');
    }
    const item = hint.rows[0].item.toUpperCase();
    const holder = `${dto.holder.kind}:${dto.holder.id}`;
    const baseEvidence = { type: 'administrative', ...dto, request: { ...dto }, sessionId: auth.session?.id };
    const execute = async (tx: Transaction<DB>) => {
      if (!dto.intent) await lockICloudItemClaims(tx, auth.user.id, [item]);
      await this.session(tx, auth);
      const receipt = await sql<{
        assetId: string;
        sha256: Buffer;
        item: string;
        role: string;
      }>`SELECT "assetId",sha256,role,"cplAssetRecordName" AS item
        FROM public.icloud_source_identity WHERE id=${dto.receiptId}::uuid AND "ownerId"=${auth.user.id}::uuid
          AND role IN ('original','edit-render') FOR SHARE`.execute(tx);
      if (!receipt.rows[0] || receipt.rows[0].item.toUpperCase() !== item) {
        conflict('edit_evidence_unavailable');
      }
      const evidence = {
        ...baseEvidence,
        receipt: {
          id: dto.receiptId,
          item,
          assetId: receipt.rows[0].assetId,
          role: receipt.rows[0].role,
          sha256: receipt.rows[0].sha256.toString('hex'),
        },
      };
      if (dto.intent) {
        if (receipt.rows[0].role !== 'original') conflict('edit_original_required');
        await lockPolicyBackrefs(tx, auth.user.id, item);
        const family = requireEditPublicationBinding(tx, item).family;
        if (family.assetIds.length > 0)
          await tx
            .selectFrom('asset')
            .select('id')
            .where('id', 'in', family.assetIds)
            .orderBy('id')
            .forUpdate()
            .execute();
      }
      await this.ownedAsset(tx, auth, receipt.rows[0].assetId, receipt.rows[0].sha256);
      const replay = await this.request(tx, auth.user.id, dto.requestId, evidence, auth.session!.id);
      if (replay) {
        return replay;
      }
      if (dto.intent) {
        const publication = await loadLatestPolicyWithin(
          tx,
          auth.user.id,
          requireEditPublicationBinding(tx, item).family.items,
        );
        if (!publication || publication.effect.effectId !== dto.intent.expectedPublicationId)
          conflict('edit_publication_stale');
      }
      await this.holder(tx, auth.user.id, holder);
      const prior = await tx
        .selectFrom('icloud_edit_authority')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('item', '=', item)
        .forUpdate()
        .executeTakeFirst();
      const claim = await sql<{
        holder: string;
      }>`SELECT holder FROM public.icloud_claim WHERE "ownerId"=${auth.user.id}::uuid
        AND "cplAssetRecordName"=${item} AND "expiresAt">clock_timestamp() FOR UPDATE`.execute(tx);
      if (claim.rows.some((row) => row.holder !== holder)) {
        conflict('edit_item_claimed');
      }
      if ((prior?.generation ?? 0) !== dto.expectedGeneration) {
        conflict('edit_owner_stale');
      }
      if (prior?.holder !== holder && prior?.holder.startsWith('icloud-sync:')) {
        const connection = await sql<{ state: string; eligible: boolean }>`SELECT state,
          ("unhealthySince" IS NOT NULL AND "unhealthySince"<=clock_timestamp()-interval '72 hours') AS eligible
          FROM public.icloud_connection WHERE id=${prior.holder.slice(12)}::uuid AND "ownerId"=${auth.user.id}::uuid FOR SHARE`.execute(
          tx,
        );
        if (
          !connection.rows[0] ||
          connection.rows[0].state === 'connected' ||
          (!dto.takeOver && !connection.rows[0].eligible)
        ) {
          conflict('edit_owner_held');
        }
      }
      const policyAcceptance =
        dto.intent?.retention === 'supersede'
          ? await captureEditPolicyAcceptance(
              tx,
              auth.user.id,
              item,
              auth.session!.id,
              dto.intent.expectedPublicationId,
              receipt.rows[0].assetId,
            )
          : undefined;
      // Existing assets are bound explicitly by the owner. No synthetic source-equivalence claim.
      const existing = await tx
        .selectFrom('icloud_edit_version')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('item', '=', item)
        .where('assetId', '=', receipt.rows[0].assetId)
        .executeTakeFirst();
      if (existing && !existing.sha256.equals(receipt.rows[0].sha256)) {
        conflict('edit_evidence_changed');
      }
      const originals = await tx
        .selectFrom('icloud_edit_version')
        .select('assetId')
        .where('ownerId', '=', auth.user.id)
        .where('item', '=', item)
        .where('isOriginal', '=', true)
        .execute();
      const isOriginal = receipt.rows[0].role === 'original';
      if (isOriginal && originals.some((row) => row.assetId !== receipt.rows[0].assetId)) {
        conflict('edit_original_conflict');
      }
      if (!isOriginal && originals.length !== 1) {
        conflict('edit_original_required');
      }
      if (!existing && !isOriginal) {
        await this.capacity(tx, auth.user.id, item);
      }
      const versionId = existing?.id ?? randomUUID();
      const alias = await tx
        .selectFrom('icloud_edit_alias')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('item', '=', item)
        .where('holder', '=', holder)
        .where('sourceIncarnation', '=', dto.sourceIncarnation)
        .where('nativeVersion', '=', dto.nativeVersion)
        .executeTakeFirst();
      if (alias && alias.versionId !== versionId) {
        conflict('edit_alias_conflict');
      }
      if (!existing) {
        await tx
          .insertInto('icloud_edit_version')
          .values({
            id: versionId,
            ownerId: auth.user.id,
            item,
            assetId: receipt.rows[0].assetId,
            sha256: receipt.rows[0].sha256,
            isOriginal,
          })
          .execute();
      }
      if (!alias) {
        await tx
          .insertInto('icloud_edit_alias')
          .values({
            ownerId: auth.user.id,
            item,
            holder,
            sourceIncarnation: dto.sourceIncarnation,
            nativeVersion: dto.nativeVersion,
            versionId,
          })
          .execute();
      }
      const generation = (prior?.generation ?? 0) + 1;
      await tx
        .insertInto('icloud_edit_decision')
        .values({
          id: dto.requestId,
          ownerId: auth.user.id,
          item,
          kind: 'baseline',
          generation,
          versionId,
          evidence,
          channel: null,
          resourceId: null,
          assetId: receipt.rows[0].assetId,
          events: [{ type: 'local-relations' }],
        })
        .execute();
      await tx
        .insertInto('icloud_edit_authority')
        .values({
          ownerId: auth.user.id,
          item,
          generation,
          holder,
          sourceIncarnation: dto.sourceIncarnation,
          currentVersionId: versionId,
          baselineDecisionId: dto.requestId,
        })
        .onConflict((oc) =>
          oc.columns(['ownerId', 'item']).doUpdateSet({
            generation,
            holder,
            sourceIncarnation: dto.sourceIncarnation,
            currentVersionId: versionId,
            baselineDecisionId: dto.requestId,
          }),
        )
        .execute();
      if (dto.intent) {
        if (!prior) conflict('edit_baseline_unproven');
        const publication = await applyEditPolicyWithin(
          tx,
          auth.user.id,
          {
            item,
            generation,
            holder,
            versionId,
            sha256: receipt.rows[0].sha256,
            policy: dto.intent.retention,
            decisionId: dto.requestId,
            priorVersionId: prior.currentVersionId,
            acceptedVictimAssetIds: policyAcceptance?.victimAssetIds,
          },
          receipt.rows[0].assetId,
          auth.session!.id,
        );
        if (dto.intent.retention === 'supersede')
          await assertEditPolicyReceiptAccess(tx, auth.user.id, auth.session!.id, publication);
        const saved = await tx
          .updateTable('icloud_edit_decision')
          .set({ evidence: { ...evidence, ...(policyAcceptance && { policyAcceptance }), publication } })
          .where('id', '=', dto.requestId)
          .where('ownerId', '=', auth.user.id)
          .where('kind', '=', 'baseline')
          .where('versionId', '=', versionId)
          .where(sql<boolean>`NOT (evidence ? 'publication')`)
          .returning('id')
          .execute();
        if (saved.length !== 1) conflict('edit_decision_conflict');
      }
      await this.ownedAsset(tx, auth, receipt.rows[0].assetId, receipt.rows[0].sha256);
      return { decisionId: dto.requestId, generation, versionId, evidenceType: 'administrative' as const };
    };
    return dto.intent
      ? withEditFamilyTransaction(this.db, auth.user.id, { items: [item], assetIds: [] }, execute, true)
      : this.db.transaction().execute(execute);
  }

  /** Read immutable source hints before taking the item prefix; re-read under resource lock. */
  async itemHint(db: Kysely<DB>, ownerId: string, channel: 'device' | 'icloud-sync', resourceId: string) {
    if (channel === 'device') {
      const row = await db
        .selectFrom('asset_upload_resource')
        .select(['metadata', 'state'])
        .where('id', '=', resourceId)
        .where('ownerId', '=', ownerId)
        .executeTakeFirst();
      const identity = row?.metadata.sourceIdentity;
      if (identity?.role !== 'edit-render') {
        return null;
      }
      const parsed = parseCloudIdentifier(identity.cloudIdentifier);
      if (!parsed || !identity.deviceKey) {
        if (row?.state === 'published') {
          return null;
        }
        conflict('edit_baseline_unproven');
      }
      return parsed.cplAssetRecordName.toUpperCase();
    }
    const result = await sql<{
      item: string;
    }>`SELECT upper("sourceAssetId") AS item FROM public.icloud_resource WHERE id=${resourceId}::uuid
      AND "ownerId"=${ownerId}::uuid AND "auditRequestId" IS NULL AND role IN ('edited-image','edited-video')`.execute(
      db,
    );
    return result.rows[0]?.item ?? null;
  }
  async source(
    db: Kysely<DB>,
    ownerId: string,
    channel: 'device' | 'icloud-sync',
    resourceId: string,
  ): Promise<Source | undefined> {
    if (channel === 'device') {
      const row = await db
        .selectFrom('asset_upload_resource')
        .selectAll()
        .where('id', '=', resourceId)
        .where('ownerId', '=', ownerId)
        .executeTakeFirst();
      const identity = row?.metadata.sourceIdentity;
      const parsed = identity && parseCloudIdentifier(identity.cloudIdentifier);
      if (!row || identity?.role !== 'edit-render') {
        return;
      }
      if (!parsed || !identity.deviceKey || !row.verifiedChecksum) {
        conflict('edit_baseline_unproven');
      }
      return {
        item: parsed.cplAssetRecordName.toUpperCase(),
        holder: `device:${identity.deviceKey}`,
        nativeVersion: identity.editVersion!,
        sha256: row.verifiedChecksum,
        claimId: identity.claimId ?? null,
      };
    }
    const rows = await sql<Source>`SELECT upper(r."sourceAssetId") AS item,'icloud-sync:'||r."connectionId" AS holder,
      coalesce(r.source->'assetFields'->'adjustmentTimestamp'->>'value','')||':'||r.fingerprint AS "nativeVersion", r.sha256,
      (SELECT c.id FROM public.icloud_claim c WHERE c."ownerId"=r."ownerId" AND c."cplAssetRecordName"=upper(r."sourceAssetId")
        AND c.holder='icloud-sync:'||r."connectionId" AND c."expiresAt">clock_timestamp()) AS "claimId"
      FROM public.icloud_resource r WHERE r.id=${resourceId}::uuid AND r."ownerId"=${ownerId}::uuid
        AND r."auditRequestId" IS NULL AND r.role IN ('edited-image','edited-video') AND r.sha256 IS NOT NULL`.execute(
      db,
    );
    return rows.rows[0];
  }
  async successor(auth: AuthDto, dto: ICloudEditSuccessorDto) {
    const hint = await this.source(this.db, auth.user.id, dto.channel, dto.resourceId);
    if (!hint) {
      conflict('edit_evidence_unavailable');
    }
    const execute = async (tx: Transaction<DB>) => {
      await lockICloudItemClaims(tx, auth.user.id, [hint.item]);
      await this.session(tx, auth);
      const authority = await tx
        .selectFrom('icloud_edit_authority')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('item', '=', hint.item)
        .forUpdate()
        .executeTakeFirst();
      if (!authority) {
        conflict('edit_baseline_unproven');
      }
      const source = await this.source(tx, auth.user.id, dto.channel, dto.resourceId);
      if (!source || !isDeepStrictEqual(source, hint)) {
        conflict('edit_evidence_changed');
      }
      // Resource lock follows the item prefix and holder. Publication rechecks this digest/state.
      if (dto.channel === 'device') {
        const resource = await tx
          .selectFrom('asset_upload_resource')
          .selectAll()
          .where('id', '=', dto.resourceId)
          .where('ownerId', '=', auth.user.id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !resource ||
          !['verified', 'published'].includes(resource.state) ||
          !resource.verifiedChecksum?.equals(source.sha256)
        ) {
          conflict('edit_evidence_unavailable');
        }
      } else {
        const resource =
          await sql`SELECT id FROM public.icloud_resource WHERE id=${dto.resourceId}::uuid AND "ownerId"=${auth.user.id}::uuid
          AND (status IN ('validated','promoted','committed','finalized') OR (status='needs-review' AND "lastError" IN ('edit_baseline_unproven','edit_successor_decision_required','edit_owner_stale','edit_version_stale','edit_capacity_reached'))) AND sha256=${source.sha256} FOR UPDATE`.execute(
            tx,
          );
        if (resource.rows.length !== 1) {
          conflict('edit_evidence_unavailable');
        }
      }
      const version = await tx
        .selectFrom('icloud_edit_version')
        .selectAll()
        .where('id', '=', dto.expectedVersionId)
        .where('ownerId', '=', auth.user.id)
        .where('item', '=', source.item)
        .executeTakeFirstOrThrow();
      const evidence = {
        type: 'administrative',
        ...dto,
        request: { ...dto },
        holder: source.holder,
        nativeVersion: source.nativeVersion,
        sha256: source.sha256.toString('hex'),
        sourceIncarnation: authority.sourceIncarnation,
        sessionId: auth.session?.id,
      };
      const replay = await this.request(tx, auth.user.id, dto.requestId, evidence, auth.session!.id);
      if (replay) {
        return replay;
      }
      await this.ownedAsset(tx, auth, version.assetId, version.sha256);
      await this.holder(tx, auth.user.id, authority.holder);
      if (authority.generation !== dto.expectedGeneration || authority.holder !== source.holder) {
        conflict('edit_owner_stale');
      }
      if (authority.currentVersionId !== dto.expectedVersionId) {
        conflict('edit_version_stale');
      }
      await this.claim(tx, auth.user.id, source);
      const alias = await tx
        .selectFrom('icloud_edit_alias')
        .innerJoin('icloud_edit_version as version', 'version.id', 'icloud_edit_alias.versionId')
        .select(['version.id', 'version.assetId', 'version.sha256'])
        .where('icloud_edit_alias.ownerId', '=', auth.user.id)
        .where('icloud_edit_alias.item', '=', source.item)
        .where('holder', '=', source.holder)
        .where('sourceIncarnation', '=', authority.sourceIncarnation)
        .where('nativeVersion', '=', source.nativeVersion)
        .executeTakeFirst();
      if (alias && !alias.sha256.equals(source.sha256)) {
        conflict('edit_render_conflict');
      }
      const reuse = dto.reuseVersionId
        ? await tx
            .selectFrom('icloud_edit_version')
            .selectAll()
            .where('id', '=', dto.reuseVersionId)
            .where('ownerId', '=', auth.user.id)
            .where('item', '=', source.item)
            .executeTakeFirst()
        : undefined;
      if (dto.reuseVersionId && (!reuse || !reuse.sha256.equals(source.sha256) || (alias && alias.id !== reuse.id))) {
        conflict('edit_render_conflict');
      }
      if (reuse) {
        await this.ownedAsset(tx, auth, reuse.assetId, reuse.sha256);
      }
      if (!alias && !reuse) {
        const existing = await tx
          .selectFrom('icloud_edit_version')
          .select('id')
          .where('ownerId', '=', auth.user.id)
          .where('item', '=', source.item)
          .where('sha256', '=', source.sha256)
          .execute();
        if (existing.length > 0) {
          conflict('edit_existing_render_review_required');
        }
      }
      const policyAcceptance =
        dto.policy === 'supersede'
          ? await captureEditPolicyAcceptance(
              tx,
              auth.user.id,
              source.item,
              auth.session!.id,
              dto.expectedPublicationId!,
              reuse?.assetId ?? alias?.assetId ?? null,
            )
          : undefined;
      const versionId = alias?.id ?? reuse?.id ?? randomUUID();
      await tx
        .insertInto('icloud_edit_decision')
        .values({
          id: dto.requestId,
          ownerId: auth.user.id,
          item: source.item,
          kind: 'successor',
          generation: authority.generation,
          versionId,
          evidence: { ...evidence, ...(policyAcceptance && { policyAcceptance }) },
          channel: dto.channel,
          resourceId: dto.resourceId,
          assetId: null,
          events: [],
        })
        .execute();
      if (dto.channel === 'icloud-sync') {
        await sql`UPDATE public.icloud_resource SET status='retry', "lastError"=NULL,"nextAttemptAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
          WHERE id=${dto.resourceId}::uuid AND "ownerId"=${auth.user.id}::uuid AND status='needs-review'`.execute(tx);
      }
      await this.ownedAsset(tx, auth, version.assetId, version.sha256);
      if (reuse) {
        await this.ownedAsset(tx, auth, reuse.assetId, reuse.sha256);
        await this.ownedAsset(tx, auth, version.assetId, version.sha256);
      }
      return {
        decisionId: dto.requestId,
        generation: authority.generation,
        versionId,
        evidenceType: 'administrative' as const,
      };
    };
    return dto.policy === 'supersede'
      ? withEditFamilyTransaction(this.db, auth.user.id, { items: [hint.item], assetIds: [] }, execute, true)
      : this.db.transaction().execute(execute);
  }
  /** Must be called under the item prefix before any asset/quota publication. */
  async publication(
    tx: Transaction<DB>,
    ownerId: string,
    channel: 'device' | 'icloud-sync',
    resourceId: string,
  ): Promise<EditPublication | undefined> {
    const source = await this.source(tx, ownerId, channel, resourceId);
    if (!source) {
      return;
    }
    await lockPolicyBackrefs(tx, ownerId, source.item);
    const authority = await tx
      .selectFrom('icloud_edit_authority')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('item', '=', source.item)
      .forUpdate()
      .executeTakeFirst();
    if (!authority) {
      conflict('edit_baseline_unproven');
    }
    const decision = await tx
      .selectFrom('icloud_edit_decision')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('channel', '=', channel)
      .where('resourceId', '=', resourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!decision) {
      conflict('edit_successor_decision_required');
    }
    const evidence = decision.evidence;
    if (decision.assetId) {
      conflict('edit_publication_already_committed');
    }
    if (
      decision.generation !== authority.generation ||
      authority.holder !== source.holder ||
      evidence.sourceIncarnation !== authority.sourceIncarnation
    ) {
      conflict('edit_owner_stale');
    }
    if (evidence.expectedVersionId !== authority.currentVersionId) {
      conflict('edit_version_stale');
    }
    if (
      evidence.sha256 !== source.sha256.toString('hex') ||
      evidence.nativeVersion !== source.nativeVersion ||
      evidence.holder !== source.holder
    ) {
      conflict('edit_evidence_changed');
    }
    await this.holder(tx, ownerId, source.holder);
    await this.claim(tx, ownerId, source);
    const live =
      typeof evidence.sessionId === 'string' ? await currentAuth(tx, ownerId, evidence.sessionId, true) : undefined;
    if (!live) {
      throw new ForbiddenException('edit_owner_session_required');
    }
    const prior = await tx
      .selectFrom('icloud_edit_version')
      .selectAll()
      .where('id', '=', authority.currentVersionId)
      .where('ownerId', '=', ownerId)
      .where('item', '=', source.item)
      .executeTakeFirstOrThrow();
    await this.ownedAsset(tx, live, prior.assetId, prior.sha256);
    const alias = await tx
      .selectFrom('icloud_edit_alias')
      .innerJoin('icloud_edit_version as version', 'version.id', 'icloud_edit_alias.versionId')
      .select(['version.id', 'version.assetId', 'version.sha256'])
      .where('icloud_edit_alias.ownerId', '=', ownerId)
      .where('icloud_edit_alias.item', '=', source.item)
      .where('holder', '=', source.holder)
      .where('sourceIncarnation', '=', authority.sourceIncarnation)
      .where('nativeVersion', '=', source.nativeVersion)
      .executeTakeFirst();
    if (alias && (!alias.sha256.equals(source.sha256) || alias.id !== decision.versionId)) {
      conflict('edit_render_conflict');
    }
    const canonical = await tx
      .selectFrom('icloud_edit_version')
      .selectAll()
      .where('id', '=', decision.versionId)
      .where('ownerId', '=', ownerId)
      .where('item', '=', source.item)
      .executeTakeFirst();
    if (canonical && !canonical.sha256.equals(source.sha256)) {
      conflict('edit_render_conflict');
    }
    if (canonical) {
      await this.ownedAsset(tx, live, canonical.assetId, canonical.sha256);
    }
    // Explicit accepted policy and local stream head must still match before any publication mutation.
    let acceptedVictimAssetIds: string[] | undefined;
    if (evidence.policy === 'supersede') {
      const accepted = await assertEditPolicyAcceptance(
        tx,
        ownerId,
        source.item,
        evidence.sessionId as string,
        evidence.policyAcceptance,
        canonical?.assetId ?? null,
      );
      acceptedVictimAssetIds = accepted.victimAssetIds;
    } else if (evidence.policy !== 'keep') conflict('edit_supersede_requires_review');
    if (!canonical && evidence.policy === 'keep') {
      await this.capacity(tx, ownerId, source.item);
    }
    return {
      channel,
      resourceId,
      decisionId: decision.id,
      versionId: decision.versionId,
      item: source.item,
      holder: source.holder,
      nativeVersion: source.nativeVersion,
      sourceIncarnation: authority.sourceIncarnation,
      generation: authority.generation,
      sha256: source.sha256,
      existingAssetId: canonical?.assetId ?? null,
      policy: evidence.policy,
      ...(acceptedVictimAssetIds && { acceptedVictimAssetIds }),
    };
  }
  /** Asset, ledger/current authority and immutable resource receipt share the writer transaction. */
  async published(
    tx: Transaction<DB>,
    ownerId: string,
    publication: EditPublication,
    assetId: string,
    created: boolean,
  ) {
    const source = await this.source(tx, ownerId, publication.channel, publication.resourceId);
    if (
      !source ||
      source.item !== publication.item ||
      source.holder !== publication.holder ||
      !source.sha256.equals(publication.sha256)
    ) {
      conflict('edit_evidence_changed');
    }
    await this.claim(tx, ownerId, source);
    const decision = await tx
      .selectFrom('icloud_edit_decision')
      .selectAll()
      .where('id', '=', publication.decisionId)
      .where('ownerId', '=', ownerId)
      .executeTakeFirstOrThrow();
    const sessionId = decision.evidence.sessionId;
    const live = typeof sessionId === 'string' ? await currentAuth(tx, ownerId, sessionId, true) : undefined;
    if (!live) {
      throw new ForbiddenException('edit_owner_session_required');
    }
    if (publication.existingAssetId ? publication.existingAssetId !== assetId || created : !created) {
      conflict('edit_bound_asset_required');
    }
    const prior = await tx
      .selectFrom('icloud_edit_authority as authority')
      .innerJoin('icloud_edit_version as version', 'version.id', 'authority.currentVersionId')
      .select(['version.assetId', 'version.sha256'])
      .where('authority.ownerId', '=', ownerId)
      .where('authority.item', '=', publication.item)
      .executeTakeFirstOrThrow();
    await this.ownedAssets(tx, live, [
      { assetId, sha256: publication.sha256 },
      { assetId: prior.assetId, sha256: prior.sha256 },
    ]);
    const bound = await tx
      .selectFrom('icloud_edit_version')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('item', '=', publication.item)
      .where('assetId', '=', assetId)
      .executeTakeFirst();
    if (bound && !bound.sha256.equals(publication.sha256)) {
      conflict('edit_render_conflict');
    }
    if (bound && bound.id !== publication.versionId) {
      conflict('edit_render_conflict');
    }
    // Policy, reversible status/stack changes and its immutable local effect share
    // this first-publication transaction. Supersede admission is still separately gated.
    const policyReceipt = await applyEditPolicyWithin(tx, ownerId, publication, assetId, sessionId as string);
    // Time continues during the policy's asset/counter waits. A failed final guard
    // throws so every policy mutation rolls back; it never acknowledges partial DML.
    const finalSource = await this.source(tx, ownerId, publication.channel, publication.resourceId);
    if (
      !finalSource ||
      finalSource.item !== publication.item ||
      finalSource.holder !== publication.holder ||
      finalSource.nativeVersion !== publication.nativeVersion ||
      !finalSource.sha256.equals(publication.sha256)
    )
      conflict('edit_evidence_changed');
    await this.holder(tx, ownerId, publication.holder);
    await this.claim(tx, ownerId, finalSource);
    if (!(await currentAuth(tx, ownerId, sessionId as string, false)))
      throw new ForbiddenException('edit_owner_session_required');
    const freshResource =
      publication.channel === 'device'
        ? await sql`SELECT id FROM asset_upload_resource WHERE id=${publication.resourceId}::uuid AND "ownerId"=${ownerId}::uuid
          AND state='verified' AND "expiresAt">clock_timestamp() AND "verifiedChecksum"=${publication.sha256}`.execute(
            tx,
          )
        : await sql`SELECT id FROM icloud_resource WHERE id=${publication.resourceId}::uuid AND "ownerId"=${ownerId}::uuid
          AND status IN ('validated','promoted','committed') AND "leaseToken" IS NOT NULL AND "leaseExpiresAt">clock_timestamp() AND sha256=${publication.sha256}`.execute(
            tx,
          );
    if (freshResource.rows.length !== 1) conflict('edit_evidence_unavailable');
    if (publication.policy === 'supersede')
      await assertEditPolicyReceiptAccess(tx, ownerId, sessionId as string, policyReceipt);
    const versionId = publication.versionId;
    if (!bound) {
      await tx
        .insertInto('icloud_edit_version')
        .values({
          id: versionId,
          ownerId,
          item: publication.item,
          assetId,
          sha256: publication.sha256,
          isOriginal: false,
        })
        .execute();
    }
    await tx
      .insertInto('icloud_edit_alias')
      .values({
        ownerId,
        item: publication.item,
        holder: publication.holder,
        sourceIncarnation: publication.sourceIncarnation,
        nativeVersion: publication.nativeVersion,
        versionId,
      })
      .onConflict((oc) => oc.columns(['ownerId', 'item', 'holder', 'sourceIncarnation', 'nativeVersion']).doNothing())
      .execute();
    const current = await tx
      .updateTable('icloud_edit_authority')
      .set({ currentVersionId: versionId })
      .where('ownerId', '=', ownerId)
      .where('item', '=', publication.item)
      .where('generation', '=', publication.generation)
      .where('holder', '=', publication.holder)
      .where('currentVersionId', '=', policyReceipt.authority.currentVersionId)
      .returning('item')
      .execute();
    if (current.length !== 1) {
      conflict('edit_owner_stale');
    }
    const settled = await tx
      .updateTable('icloud_edit_decision')
      .set({
        assetId,
        versionId,
        evidence: { ...decision.evidence, publication: policyReceipt },
        events: [{ type: 'local-relations' }],
      })
      .where('id', '=', publication.decisionId)
      .where('ownerId', '=', ownerId)
      .where('assetId', 'is', null)
      .returning('id')
      .execute();
    if (settled.length !== 1) conflict('edit_decision_conflict');
  }

  private async capacity(tx: Transaction<DB>, ownerId: string, item: string) {
    const retained = await sql<{ id: string; active: boolean; original: boolean }>`SELECT a.id,
      (a.status='active' AND a."deletedAt" IS NULL) AS active, v."isOriginal" AS original
      FROM public.icloud_edit_version v JOIN public.asset a ON a.id=v."assetId" AND a."ownerId"=v."ownerId"
      WHERE v."ownerId"=${ownerId}::uuid AND v.item=${item} ORDER BY a.id FOR UPDATE OF a`.execute(tx);
    if (retained.rows.filter((row) => row.active && !row.original).length >= 20) {
      conflict('edit_capacity_reached');
    }
  }
  private async claim(tx: Transaction<DB>, ownerId: string, source: Source) {
    const result =
      await sql`SELECT 1 FROM public.icloud_claim WHERE "ownerId"=${ownerId}::uuid AND "cplAssetRecordName"=${source.item}
      AND holder=${source.holder} AND id=${source.claimId}::uuid AND "expiresAt">clock_timestamp() FOR UPDATE`.execute(
        tx,
      );
    if (result.rows.length !== 1) {
      conflict('edit_owner_stale');
    }
  }
}
