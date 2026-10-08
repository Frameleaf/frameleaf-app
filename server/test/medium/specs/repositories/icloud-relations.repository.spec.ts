import { Kysely, RawBuilder, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudEditBaselineSchema, ICloudEditSuccessorSchema } from 'src/dtos/icloud-identity.dto.js';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm, JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim } from 'src/queue/types.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { BackupDeviceRepository } from 'src/repositories/backup-device.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudEditAuthorityRepository } from 'src/repositories/icloud-edit-authority.repository.js';
import { ICloudIdentityRepository, recordSyncIdentity } from 'src/repositories/icloud-identity.repository.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { initializeEffectiveConfig } from 'src/utils/config.js';
import {
  canonicalTestContext,
  seedCanonicalAlbum,
  seedCanonicalAsset,
  seedCanonicalUser,
} from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud source-owned Stack and Live Photo reconciliation (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let service: ICloudRelationsService;
  const emit = vi.fn().mockResolvedValue(undefined);
  beforeAll(async () => {
    db = await getKyselyDB();

    service = new ICloudRelationsService(new ICloudRelationsRepository(db), { emit } as unknown as EventRepository);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(() => {
    emit.mockClear();
  });
  const rows = <T>(query: RawBuilder<T>) => query.execute(db).then((result) => result.rows);
  const first = <T>(query: RawBuilder<T>) => rows(query).then((result) => result[0]);
  async function context() {
    const connectionId = randomUUID(),
      ownerId = randomUUID();
    await seedCanonicalUser(db, { id: ownerId });
    await sql`INSERT INTO public.icloud_connection(id,"ownerId",label,state) VALUES(${connectionId}::uuid,${ownerId}::uuid,'Photos','connected')`.execute(
      db,
    );
    const { session } = await canonicalTestContext(db).newSession({ userId: ownerId });
    const user = await db.selectFrom('user').selectAll().where('id', '=', ownerId).executeTakeFirstOrThrow();
    return {
      connectionId,
      ownerId,
      auth: { user, session: { ...session, hasElevatedPermission: false } } as AuthDto,
      sourceIncarnation: randomUUID(),
    };
  }
  async function asset(ownerId: string, type = 'IMAGE') {
    const id = randomUUID();
    await seedCanonicalAsset(db, {
      id,
      ownerId,
      type: type as AssetType,
      originalPath: '/original/immutable',
      checksum: createHash('sha256').update(id).digest(),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    return id;
  }
  async function resource(
    ctx: Awaited<ReturnType<typeof context>>,
    role: string,
    assetId: string,
    logical = 'logical',
    accept = true,
  ) {
    const id = randomUUID();
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(${id}::uuid,${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}',${logical},${logical},${role},${role},${id},${{ current: true }}::jsonb,3,'finalized',${assetId}::uuid)`.execute(
      db,
    );
    const owned = await db
      .selectFrom('asset')
      .select('checksum')
      .where('id', '=', assetId)
      .where('ownerId', '=', ctx.ownerId)
      .executeTakeFirst();
    if (owned) {
      await sql`UPDATE public.icloud_resource SET sha256=${owned.checksum} WHERE id=${id}::uuid`.execute(db);
      await recordSyncIdentity(db, id);
      if (accept && ['original', 'edited-image', 'edited-video'].includes(role)) await acceptResource(ctx, id);
    }
    return id;
  }
  async function acceptResource(ctx: Awaited<ReturnType<typeof context>>, id: string) {
    const mapped = await first(sql<{
      assetId: string;
      item: string;
      nativeVersion: string;
    }>`SELECT "assetId",upper("sourceAssetId") AS item,
      CASE WHEN role='original' THEN 'administrative-original' ELSE coalesce(source->'assetFields'->'adjustmentTimestamp'->>'value','')||':'||fingerprint END AS "nativeVersion" FROM public.icloud_resource WHERE id=${id}::uuid`);
    const authority = await db
      .selectFrom('icloud_edit_authority')
      .select('generation')
      .where('ownerId', '=', ctx.ownerId)
      .where('item', '=', mapped.item)
      .executeTakeFirst();
    const discovery = await new ICloudEditAuthorityRepository(db).discover(ctx.auth, mapped.assetId);
    const receipt = discovery.items
      .find((item) => item.item === mapped.item)!
      .receipts.find((receipt) => receipt.assetId === mapped.assetId)!;
    await new ICloudEditAuthorityRepository(db).baseline(
      ctx.auth,
      ICloudEditBaselineSchema.parse({
        requestId: randomUUID(),
        expectedGeneration: authority?.generation ?? 0,
        receiptId: receipt.receiptId,
        holder: { kind: 'icloud-sync', id: ctx.connectionId },
        sourceIncarnation: ctx.sourceIncarnation,
        nativeVersion: mapped.nativeVersion,
      }),
    );
  }
  async function finish(ctx: { connectionId: string; ownerId: string }) {
    await new ICloudRelationsRepository(db).enqueuePending();
    for (let count = 0; count < 10; count++) {
      if (await service.reconcile(ctx.connectionId, ctx.ownerId)) {
        return;
      }
    }
    throw new Error('unbounded relations');
  }
  async function setup() {
    const ctx = await context(),
      original = await asset(ctx.ownerId),
      edited = await asset(ctx.ownerId);
    const originalResource = await resource(ctx, 'original', original);
    const editResource = await resource(ctx, 'edited-image', edited);
    return { ...ctx, original, edited, originalResource, editResource };
  }

  it.each([
    'matching',
    'manual-primary',
    'changed-receipt',
    'explicit-original-revert',
    'explicit-sync-original-revert',
    'explicit-original-supersede',
    'explicit-sync-original-supersede',
    'administrative-only',
  ] as const)(
    'C2 advances all actual source backrefs atomically and local reconciliation preserves the published policy: %s',
    async (caseName) => {
      await initializeEffectiveConfig({
        configRepo: new ConfigRepository(),
        metadataRepo: new SystemMetadataRepository(db),
        logger: LoggingRepository.create(),
      });
      const ctx = await context(),
        item = randomUUID().toUpperCase(),
        original = await asset(ctx.ownerId),
        edited = await asset(ctx.ownerId);
      const originalResource = await resource(ctx, 'original', original, item);
      await resource(ctx, 'edited-image', edited, item);
      await finish(ctx);
      const stack = await db
        .selectFrom('stack')
        .selectAll()
        .where('ownerId', '=', ctx.ownerId)
        .executeTakeFirstOrThrow();
      const edits = new ICloudEditAuthorityRepository(db),
        identities = new ICloudIdentityRepository(db),
        uploads = new AssetUploadResourceRepository(db);
      const deviceKey = randomUUID();
      await new BackupDeviceRepository(db).register(ctx.ownerId, {
        deviceKey,
        displayName: 'fixture',
        model: 'fixture',
        platform: 'fixture',
        appVersion: '1',
        pendingCount: 0,
        lastSuccessfulBackupAt: null,
      });
      await new ICloudSyncRepository(db).update(ctx.connectionId, ctx.ownerId, { state: 'disconnected' });
      await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '2 minutes' WHERE id=${ctx.auth.session!.id}::uuid`.execute(
        db,
      );
      const discovery = await edits.discover(ctx.auth, edited),
        receipt = discovery.items.find((i) => i.item === item)!.receipts.find((r) => r.assetId === edited)!;
      const old = await db
        .selectFrom('icloud_edit_authority')
        .selectAll()
        .where('ownerId', '=', ctx.ownerId)
        .where('item', '=', item)
        .executeTakeFirstOrThrow();
      const authority = await edits.baseline(
        ctx.auth,
        ICloudEditBaselineSchema.parse({
          requestId: randomUUID(),
          expectedGeneration: old.generation,
          receiptId: receipt.receiptId,
          holder: { kind: 'device', id: deviceKey },
          sourceIncarnation: randomUUID(),
          nativeVersion: 'administrative-device-baseline',
          takeOver: true,
        }),
      );
      const [claim] = await identities.claim(ctx.ownerId, [item], 'device:' + deviceKey, 600);
      const checksum = createHash('sha256').update('incoming real policy fixture byte boundary').digest();
      const row = await uploads.create(randomUUID(), ctx.ownerId, {
        checksum,
        contentType: 'image/jpeg',
        size: 4,
        metadata: {
          filename: 'render.jpg',
          fileCreatedAt: new Date(),
          fileModifiedAt: new Date(),
          sourceIdentity: {
            kind: 'icloud',
            cloudIdentifier: `${item}:001:AQohY6yKZR0+tXlMi9FUQ82zySGo`,
            role: 'edit-render',
            editVersion: 'incoming-opaque',
            deviceKey,
            claimId: claim.id,
          },
        },
      });
      // Same canonical durable verified-byte fixture boundary as the device writer suite;
      // original source rows above use the existing finalized-source compatibility fixture.
      await db
        .updateTable('asset_upload_resource')
        .set({
          state: 'verified',
          offset: 4,
          verifiedChecksum: checksum,
          legacyChecksum: Buffer.alloc(20, 7),
          finalPath: '/private/owned/render.jpg',
        })
        .where('id', '=', row.id)
        .execute();
      await edits.successor(
        ctx.auth,
        ICloudEditSuccessorSchema.parse({
          requestId: randomUUID(),
          expectedGeneration: authority.generation,
          expectedVersionId: authority.versionId,
          channel: 'device',
          resourceId: row.id,
          policy: 'keep',
        }),
      );
      const published = await uploads.locked(row.id, ctx.ownerId, (tx, current) =>
        uploads.publish(tx, current, {
          asset: {
            ownerId: ctx.ownerId,
            libraryId: null,
            checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
            originalPath: current.finalPath!,
            originalFileName: 'render.jpg',
            type: AssetType.Image,
            fileCreatedAt: new Date(),
            fileModifiedAt: new Date(),
            localDateTime: new Date(),
            visibility: AssetVisibility.Timeline,
          },
          lock: undefined,
        }),
      );
      const source = await first(
        sql<{
          source: { _sync?: { relations?: unknown } };
        }>`SELECT source FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
      );
      expect(source.source._sync?.relations).toMatchObject({
        stackId: stack.id,
        appliedPrimaryAssetId: published.resultAssetId,
        memberAssetIds: expect.arrayContaining([original, edited, published.resultAssetId!]),
        events: [],
      });
      await new ICloudSyncRepository(db).update(ctx.connectionId, ctx.ownerId, { state: 'connected' });
      await finish(ctx);
      expect(
        (await db.selectFrom('stack').select('primaryAssetId').where('id', '=', stack.id).executeTakeFirstOrThrow())
          .primaryAssetId,
      ).toBe(published.resultAssetId);
      expect(
        (
          await first(
            sql<{
              source: { _sync?: { relations?: unknown } };
            }>`SELECT source FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
          )
        ).source._sync?.relations,
      ).toMatchObject({ status: 'applied', appliedPrimaryAssetId: published.resultAssetId });
      switch (caseName) {
        case 'administrative-only': {
          const snapshot = (await edits.discover(ctx.auth, original)).items.find((i) => i.item === item)!;
          await edits.baseline(
            ctx.auth,
            ICloudEditBaselineSchema.parse({
              requestId: randomUUID(),
              expectedGeneration: authority.generation,
              receiptId: snapshot.receipts.find((r) => r.assetId === original)!.receiptId,
              holder: { kind: 'device', id: deviceKey },
              sourceIncarnation: randomUUID(),
              nativeVersion: 'administrative-only-original-watermark',
            }),
          );
          await finish(ctx);
          expect(
            (await db.selectFrom('stack').select('primaryAssetId').where('id', '=', stack.id).executeTakeFirstOrThrow())
              .primaryAssetId,
          ).toBe(published.resultAssetId);
          expect(
            (
              await first(
                sql<{
                  source: { _sync?: { relations?: unknown } };
                }>`SELECT source FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
              )
            ).source._sync?.relations,
          ).toMatchObject({
            status: 'needs-review',
            reason: 'edit_administrative_policy_transition_required',
            events: [],
          });
          expect(
            await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', ctx.ownerId).execute(),
          ).toHaveLength(1);

          break;
        }
        case 'explicit-original-revert':
        case 'explicit-sync-original-revert':
        case 'explicit-original-supersede':
        case 'explicit-sync-original-supersede': {
          const retention = caseName.endsWith('supersede') ? 'supersede' : 'keep';
          const snapshot = (await edits.discover(ctx.auth, original)).items.find((i) => i.item === item)!;
          const originalReceipt = snapshot.receipts.find((r) => r.assetId === original)!;
          const publication = snapshot.authority!.currentPublicationId;
          const request = ICloudEditBaselineSchema.parse({
            requestId: randomUUID(),
            expectedGeneration: authority.generation,
            receiptId: originalReceipt.receiptId,
            holder: caseName.startsWith('explicit-sync-original-')
              ? { kind: 'icloud-sync', id: ctx.connectionId }
              : { kind: 'device', id: deviceKey },
            sourceIncarnation: randomUUID(),
            nativeVersion: 'explicit-original-revert',
            intent: { kind: 'original-revert', expectedPublicationId: publication, retention },
          });
          if (caseName.startsWith('explicit-sync-original-'))
            await identities.release(ctx.ownerId, [claim.id], 'device:' + deviceKey);
          await expect(
            edits.baseline(ctx.auth, {
              ...request,
              requestId: randomUUID(),
              expectedGeneration: request.expectedGeneration - 1,
            }),
          ).rejects.toThrow('edit_owner_stale');
          await expect(
            edits.baseline(ctx.auth, {
              ...request,
              requestId: randomUUID(),
              intent: { ...request.intent!, expectedPublicationId: randomUUID() },
            }),
          ).rejects.toThrow('edit_publication_stale');
          await expect(
            edits.baseline(ctx.auth, {
              ...request,
              requestId: randomUUID(),
              intent: { ...request.intent!, retention: 'supersede', expectedPublicationId: randomUUID() },
            }),
          ).rejects.toThrow('edit_publication_stale');
          expect(
            await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', ctx.ownerId).execute(),
          ).toHaveLength(1);
          const reverted = await edits.baseline(ctx.auth, request);
          expect(reverted.versionId).toBe(
            (
              await db
                .selectFrom('icloud_edit_version')
                .select('id')
                .where('ownerId', '=', ctx.ownerId)
                .where('assetId', '=', original)
                .where('isOriginal', '=', true)
                .executeTakeFirstOrThrow()
            ).id,
          );
          expect(
            (await db.selectFrom('stack').select('primaryAssetId').where('id', '=', stack.id).executeTakeFirstOrThrow())
              .primaryAssetId,
          ).toBe(original);
          expect(
            await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', ctx.ownerId).execute(),
          ).toHaveLength(2);
          expect(await edits.baseline(ctx.auth, request)).toEqual(reverted);
          expect(
            await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', ctx.ownerId).execute(),
          ).toHaveLength(2);
          await finish(ctx);
          expect(
            (
              await first(
                sql<{
                  source: { _sync?: { relations?: unknown } };
                }>`SELECT source FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
              )
            ).source._sync?.relations,
          ).toMatchObject({ status: 'applied', appliedPrimaryAssetId: original });
          expect(
            await db
              .selectFrom('asset')
              .select('id')
              .where('ownerId', '=', ctx.ownerId)
              .where('status', '=', AssetStatus.Trashed)
              .execute(),
          ).toHaveLength(retention === 'supersede' ? 2 : 0);
          if (retention === 'supersede') {
            const victims = [edited, published.resultAssetId!].sort();
            expect(
              (
                await db
                  .selectFrom('asset')
                  .select('id')
                  .where('ownerId', '=', ctx.ownerId)
                  .where('status', '=', AssetStatus.Trashed)
                  .orderBy('id')
                  .execute()
              ).map((row) => row.id),
            ).toEqual(victims);
            expect(
              (await db.selectFrom('asset').select('status').where('id', '=', original).executeTakeFirstOrThrow())
                .status,
            ).toBe(AssetStatus.Active);
            expect((await new TrashRepository(db).restoreAll(victims, ctx.auth)).sort()).toEqual(victims);
            await finish(ctx);
            expect(
              await db
                .selectFrom('asset')
                .select('id')
                .where('ownerId', '=', ctx.ownerId)
                .where('status', '=', AssetStatus.Trashed)
                .execute(),
            ).toHaveLength(0);
            expect(
              (
                await db
                  .selectFrom('stack')
                  .select('primaryAssetId')
                  .where('id', '=', stack.id)
                  .executeTakeFirstOrThrow()
              ).primaryAssetId,
            ).toBe(original);
            // Receipt replay acknowledges the old policy; it must not re-Trash restored renders.
            expect(await edits.baseline(ctx.auth, request)).toEqual(reverted);
            expect(
              await db
                .selectFrom('asset')
                .select('id')
                .where('ownerId', '=', ctx.ownerId)
                .where('status', '=', AssetStatus.Trashed)
                .execute(),
            ).toHaveLength(0);
            expect(
              await db.selectFrom('icloud_edit_version').select('id').where('ownerId', '=', ctx.ownerId).execute(),
            ).toHaveLength(3);
          }

          break;
        }
        case 'manual-primary':
        case 'changed-receipt': {
          if (caseName === 'manual-primary')
            await db.updateTable('stack').set({ primaryAssetId: original }).where('id', '=', stack.id).execute();
          else
            await db
              .updateTable('asset_upload_resource')
              .set({ verifiedChecksum: Buffer.alloc(32, 9) })
              .where('id', '=', row.id)
              .execute();
          // A genuine changed source inventory signature makes the local drain eligible again.
          await sql`UPDATE public.icloud_resource SET fingerprint=fingerprint||'-changed' WHERE id=${originalResource}::uuid`.execute(
            db,
          );
          await finish(ctx);
          const rejected = await first(
            sql<{
              source: { _sync?: { relations?: unknown } };
            }>`SELECT source FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
          );
          expect(rejected.source._sync?.relations).toMatchObject({
            status: 'needs-review',
            reason: caseName === 'manual-primary' ? 'local_stack_override' : 'edit_member_evidence_unproven',
            events: [],
          });
          expect(
            (await db.selectFrom('stack').select('primaryAssetId').where('id', '=', stack.id).executeTakeFirstOrThrow())
              .primaryAssetId,
          ).toBe(caseName === 'manual-primary' ? original : published.resultAssetId);
          expect(
            await db.selectFrom('asset_local_effect').select('effectId').where('ownerId', '=', ctx.ownerId).execute(),
          ).toHaveLength(1);

          break;
        }
        // No default
      }
    },
  );
  it('serves the current source edit through a real Stack, retains original and old edits, and handles revert', async () => {
    const ctx = await setup();
    await finish(ctx);
    const created = await first(
      sql<{
        id: string;
        primaryAssetId: string;
      }>`SELECT id,"primaryAssetId" FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`,
    );
    expect(created.primaryAssetId).toBe(ctx.edited);
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${created.id}::uuid`)).toHaveLength(2);
    const newer = await asset(ctx.ownerId);
    await sql`UPDATE public.icloud_resource SET source=jsonb_set(source,'{current}','false') WHERE id=${ctx.editResource}::uuid`.execute(
      db,
    );
    const newerResource = await resource(ctx, 'edited-image', newer);
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${created.id}::uuid`)).toEqual({
      primaryAssetId: newer,
    });
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${created.id}::uuid`)).toHaveLength(3);
    await sql`UPDATE public.icloud_resource SET source=jsonb_set(source,'{current}','false') WHERE id=${newerResource}::uuid`.execute(
      db,
    );
    await acceptResource(ctx, ctx.originalResource); // Explicit administrative revert; removal is not source ordering.
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${created.id}::uuid`)).toEqual({
      primaryAssetId: ctx.original,
    });
    expect(
      await rows(
        sql`SELECT id FROM asset WHERE "stackId"=${created.id}::uuid AND "originalPath"='/original/immutable'`,
      ),
    ).toHaveLength(3);
    await finish(ctx);
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
  });
  it('preserves local primary preferences while adding a new source rendition', async () => {
    const ctx = await setup();
    await finish(ctx);
    const stack = await first(sql<{ id: string }>`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`);
    await sql`UPDATE stack SET "primaryAssetId"=${ctx.original}::uuid WHERE id=${stack.id}::uuid`.execute(db);
    await sql`UPDATE public.icloud_resource SET source=jsonb_set(source,'{current}','false') WHERE id=${ctx.editResource}::uuid`.execute(
      db,
    );
    const newer = await asset(ctx.ownerId);
    await resource(ctx, 'edited-image', newer);
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${stack.id}::uuid`)).toEqual({
      primaryAssetId: ctx.original,
    });
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${stack.id}::uuid`)).toHaveLength(3);
  });
  it('keeps distinct logical source provenance when original bytes share one destination asset', async () => {
    const ctx = await setup();
    await finish(ctx); // Establish an accepted first family's real source-owned primary before adding a conflicting family.
    const secondEdit = await asset(ctx.ownerId);
    await resource(ctx, 'original', ctx.original, 'second-logical');
    await resource(ctx, 'edited-image', secondEdit, 'second-logical');
    await finish(ctx);
    const stack = await first(sql<{ id: string }>`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`);
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${stack.id}::uuid`)).toHaveLength(3);
    expect(
      await rows(
        sql`SELECT DISTINCT "sourceAssetId" FROM public.icloud_resource WHERE "connectionId"=${ctx.connectionId}::uuid`,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        sql`SELECT id FROM public.icloud_resource WHERE "connectionId"=${ctx.connectionId}::uuid AND source#>>'{_sync,relations,stackId}'=${stack.id}`,
      ),
    ).toHaveLength(2);
  });
  it('refuses a finalized legacy edit even when another member has accepted authority', async () => {
    const ctx = await context(),
      original = await asset(ctx.ownerId),
      edit = await asset(ctx.ownerId);
    const originalResource = await resource(ctx, 'original', original);
    await resource(ctx, 'edited-image', edit, 'logical', false);
    await finish(ctx);
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(0);
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
      ),
    ).toEqual({ reason: 'edit_member_evidence_unproven' });
  });
  it('preserves conflicting applied source back-references and the actual stack primary for review', async () => {
    const ctx = await setup();
    await finish(ctx);
    const secondOriginal = await resource(ctx, 'original', ctx.original, 'second');
    const secondEdit = await resource(ctx, 'edited-image', await asset(ctx.ownerId), 'second');
    await finish(ctx);
    const stack = await first(
      sql<{
        id: string;
        primaryAssetId: string;
      }>`SELECT id,"primaryAssetId" FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`,
    );
    await sql`UPDATE public.icloud_resource SET source=jsonb_set(source,'{_sync,relations,appliedPrimaryAssetId}',to_jsonb(${ctx.original}::text)) WHERE id=${secondOriginal}::uuid`.execute(
      db,
    );
    await acceptResource(ctx, secondEdit);
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${stack.id}::uuid`)).toEqual({
      primaryAssetId: stack.primaryAssetId,
    });
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason,source#>>'{_sync,relations,appliedPrimaryAssetId}' AS primary FROM public.icloud_resource WHERE id=${secondOriginal}::uuid`,
      ),
    ).toEqual({ reason: 'source_stack_provenance_conflict', primary: ctx.original });
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,appliedPrimaryAssetId}' AS primary FROM public.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ primary: ctx.edited });
  });
  it('refuses a fresh ambiguous shared family without choosing a primary from row order', async () => {
    const ctx = await setup(),
      edit = await asset(ctx.ownerId);
    await resource(ctx, 'original', ctx.original, 'second-logical');
    await resource(ctx, 'edited-image', edit, 'second-logical');
    await finish(ctx);
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(0);
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason FROM public.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ reason: 'shared_edit_primary_ambiguous' });
  });
  it('admits an actual durable local job and reconciles an authority-only revert without inventory changes', async () => {
    const ctx = await setup();
    await finish(ctx);
    const stack = await first(sql<{ id: string }>`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`);
    await acceptResource(ctx, ctx.originalResource);
    const repository = new ICloudRelationsRepository(db),
      store = new SqlQueueStore(db),
      workerId = randomUUID();
    await store.initialize([QueueName.BackgroundTask], workerId);
    expect(await repository.enqueuePending()).toBeGreaterThan(0);
    const durable = await db
      .selectFrom('job')
      .selectAll()
      .where('name', '=', JobName.ICloudRelations)
      .where(sql<string>`data->>'id'`, '=', ctx.connectionId)
      .execute();
    expect(durable).toHaveLength(1);
    expect(durable[0]).toMatchObject({ safeToRetry: true, sensitive: true, state: 'pending' });
    const run = (claim: QueueClaim) =>
      queueExecution.run(
        {
          claim,
          signal: new AbortController().signal,
          progress: () => {},
          followups: [],
          adoptions: [],
          buffering: true,
          progressUnits: 0,
        },
        () => service.handleLocalRelations(claim.data as { id: string; ownerId: string }),
      );
    let own: QueueClaim | undefined;
    for (let count = 0; count < 100 && !own; count++) {
      const claimed = await store.claim(QueueName.BackgroundTask, workerId);
      for (const job of claimed) {
        if (job.data.id === ctx.connectionId) {
          own = job;
          break;
        }
        expect(await run(job)).toBe(JobStatus.Success);
        expect(await store.complete(job, [])).toBe(true);
      }
    }
    expect(own).toBeDefined();
    if (!own) throw new Error('local drain not admitted');
    expect(own.name).toBe(JobName.ICloudRelations);
    emit.mockRejectedValueOnce(new Error('fixture event delivery failed'));
    await expect(run(own)).rejects.toThrow('fixture event delivery failed');
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    expect(
      await first(
        sql`SELECT jsonb_array_length(source#>'{_sync,relations,events}') AS count FROM public.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ count: 1 });
    expect(await store.fail(own, 'event delivery failed')).toBe(true);
    expect(await db.selectFrom('job').select(['state', 'data']).where('id', '=', own.id).executeTakeFirst()).toEqual({
      state: 'pending',
      data: {},
    });
    const stale = own;
    let replacement: QueueClaim | undefined;
    await vi.waitFor(
      async () => {
        replacement = (await store.claim(QueueName.BackgroundTask, workerId)).find((job) => job.id === stale.id);
        expect(replacement).toBeDefined();
      },
      { timeout: 35_000, interval: 250 },
    ); // Production queue's real 30-second failure backoff.
    expect(replacement!.token).not.toBe(stale.token);
    expect(replacement!.data).toEqual({});
    await expect(run(stale)).rejects.toThrow('edit_relations_claim_lost');
    expect(await store.complete(stale, [])).toBe(false);
    own = replacement!;
    expect(await run(own)).toBe(JobStatus.Success);
    expect(await store.complete(own, [])).toBe(true);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${stack.id}::uuid`)).toEqual({
      primaryAssetId: ctx.original,
    });
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${stack.id}::uuid`)).toHaveLength(2);
    expect(await db.selectFrom('job').select('state').where('id', '=', own.id).executeTakeFirst()).toEqual({
      state: 'completed',
    });
    await acceptResource(ctx, ctx.editResource);
    await repository.enqueuePending();
    const cancelled = (await store.claim(QueueName.BackgroundTask, workerId))[0];
    expect(cancelled.name).toBe(JobName.ICloudRelations);
    // A real queue row cancellation fences publication even before the executor's abort signal arrives.
    await sql`UPDATE job SET "cancelRequestedAt"=clock_timestamp(),"cancelReason"='request' WHERE id=${cancelled.id}::uuid AND token=${cancelled.token}::uuid`.execute(
      db,
    );
    await expect(run(cancelled)).rejects.toThrow('edit_relations_claim_lost');
    expect(await store.complete(cancelled, [])).toBe(false);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${stack.id}::uuid`)).toEqual({
      primaryAssetId: ctx.original,
    });
  }, 60_000);
  it('links still/movie by source identity using the existing hook without replacing either asset', async () => {
    const ctx = await context(),
      still = await asset(ctx.ownerId),
      motion = await asset(ctx.ownerId, 'VIDEO');
    await resource(ctx, 'original', still);
    await resource(ctx, 'motion', motion);
    await finish(ctx);
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${still}::uuid`)).toEqual({
      livePhotoVideoId: motion,
    });
    expect(await first(sql`SELECT visibility FROM asset WHERE id=${motion}::uuid`)).toEqual({ visibility: 'hidden' });
    expect(emit).toHaveBeenCalledWith('AssetHide', { assetId: motion, userId: ctx.ownerId });
    expect(await rows(sql`SELECT id FROM asset WHERE id=ANY(${[still, motion]}::uuid[])`)).toHaveLength(2);
    await finish(ctx);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('preserves manual stacks and manual motion memberships and records review diagnostics', async () => {
    const ctx = await setup(),
      manual = await first(
        sql<{
          id: string;
        }>`INSERT INTO stack("ownerId","primaryAssetId") VALUES(${ctx.ownerId}::uuid,${ctx.original}::uuid) RETURNING id`,
      );
    await sql`UPDATE asset SET "stackId"=${manual.id}::uuid WHERE id=${ctx.original}::uuid`.execute(db);
    const motion = await asset(ctx.ownerId, 'VIDEO');
    await resource(ctx, 'motion', motion);
    await seedCanonicalAlbum(db, { ownerId: ctx.ownerId }, [motion]);
    await finish(ctx);
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${ctx.original}::uuid`)).toEqual({
      livePhotoVideoId: null,
    });
    expect(await rows(sql`SELECT 1 FROM album_asset WHERE "assetId"=${motion}::uuid`)).toHaveLength(1);
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,status}' AS status FROM public.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ status: 'needs-review' });
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    expect(await first(sql`SELECT "stackId" FROM asset WHERE id=${ctx.edited}::uuid`)).toEqual({ stackId: null });
  });
  it('survives event dispatch failure without duplicating a committed stack', async () => {
    const ctx = await setup();
    emit.mockRejectedValueOnce(new Error('event temporarily unavailable'));
    await expect(service.reconcile(ctx.connectionId, ctx.ownerId)).rejects.toThrow('event temporarily unavailable');
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    await finish(ctx);
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    expect(
      await first(
        sql`SELECT source#>'{_sync,relations,events}' AS events FROM public.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ events: [] });
  });
  it('rejects foreign targets and will not match a movie from another logical source', async () => {
    const ctx = await context(),
      still = await asset(ctx.ownerId),
      foreign = await asset(randomUUID(), 'VIDEO');
    const originalResource = await resource(ctx, 'original', still);
    await resource(ctx, 'motion', foreign);
    await finish(ctx);
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${still}::uuid`)).toEqual({
      livePhotoVideoId: null,
    });
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
      ),
    ).toEqual({ reason: 'resource_owner_or_trash_changed' });
    await expect(service.reconcile(ctx.connectionId, randomUUID())).rejects.toThrow('icloud_connection_not_found');
  });
  it.each(['failed', 'unsupported', 'needs-review', 'preserve-trashed', 'pending', 'retry'])(
    'does not let a %s rendition starve other families',
    async (status) => {
      const ctx = await setup();
      await sql`UPDATE public.icloud_resource SET status=${status},"assetId"=NULL WHERE id=${ctx.editResource}::uuid`.execute(
        db,
      );
      const otherOriginal = await asset(ctx.ownerId),
        otherEdit = await asset(ctx.ownerId);
      await resource(ctx, 'original', otherOriginal, 'other');
      await resource(ctx, 'edited-image', otherEdit, 'other');
      await finish(ctx);
      const terminal = !['pending', 'retry'].includes(status);
      expect(
        await first(
          sql`SELECT source#>>'{_sync,relations,status}' AS status FROM public.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
        ),
      ).toEqual({ status: terminal ? 'needs-review' : 'pending' });
      expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    },
  );
  it.each(['locked', 'archive'])('preserves existing %s motion visibility', async (visibility) => {
    const ctx = await context(),
      still = await asset(ctx.ownerId),
      motion = await asset(ctx.ownerId, 'VIDEO');
    const originalResource = await resource(ctx, 'original', still);
    await resource(ctx, 'motion', motion);
    await sql`UPDATE asset SET visibility=${visibility} WHERE id=${motion}::uuid`.execute(db);
    await finish(ctx);
    expect(await first(sql`SELECT visibility FROM asset WHERE id=${motion}::uuid`)).toEqual({ visibility });
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${still}::uuid`)).toEqual({
      livePhotoVideoId: null,
    });
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason FROM public.icloud_resource WHERE id=${originalResource}::uuid`,
      ),
    ).toEqual({ reason: 'motion_visibility_override' });
    expect(emit).not.toHaveBeenCalled();
  });
});
