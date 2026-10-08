import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { ICloudIdentityController } from 'src/controllers/icloud-identity.controller.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudEditBaselineSchema, ICloudEditSuccessorSchema } from 'src/dtos/icloud-identity.dto.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm, Permission, SharedLinkType } from 'src/enum.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import {
  AssetUploadResource,
  AssetUploadResourceRepository,
} from 'src/repositories/asset-upload-resource.repository.js';
import { BackupDeviceRepository } from 'src/repositories/backup-device.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudEditAuthorityRepository } from 'src/repositories/icloud-edit-authority.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';
import { ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRecoveryRepository } from 'src/repositories/media-recovery.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { ICloudAuditService } from 'src/services/icloud-audit.service.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { canonicalTestContext, expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

const ITEM = '32A01DD9-75DF-41B2-8773-80C153D73A5A';
const identifier = `${ITEM}:001:AQohY6yKZR0+tXlMi9FUQ82zySGo`;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** Canonical migration clone + actual repository transactions. Starts at the separately verified-byte boundary. */
describe('administrative iCloud edit authority', () => {
  let db: Kysely<DB>;
  let edits: ICloudEditAuthorityRepository;
  let identities: ICloudIdentityRepository;
  let uploads: AssetUploadResourceRepository;
  beforeAll(async () => {
    db = await getKyselyDB();
    await expectCanonicalTables(db, [
      'icloud_edit_authority',
      'icloud_edit_version',
      'icloud_edit_alias',
      'icloud_edit_decision',
    ]);
    edits = new ICloudEditAuthorityRepository(db);
    identities = new ICloudIdentityRepository(db);
    uploads = new AssetUploadResourceRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  async function fixture() {
    const ctx = canonicalTestContext(db);
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
    const deviceKey = randomUUID();
    await new BackupDeviceRepository(db).register(user.id, {
      deviceKey,
      displayName: 'fixture',
      model: 'fixture',
      platform: 'fixture',
      appVersion: '1',
      pendingCount: 0,
      lastSuccessfulBackupAt: null,
    });
    const sha256 = digest(randomUUID());
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await identities.recordDevice({
      ownerId: user.id,
      assetId: asset.id,
      parsed: { cplAssetRecordName: ITEM, cplMasterRecordName: 'AQohY6yKZR0+tXlMi9FUQ82zySGo' },
      cloudIdentifier: identifier,
      role: 'original',
      editVersion: '',
      sha256,
      claimId: null,
      deviceKey,
      metadata: {},
    });
    const receipt = await sql<{
      id: string;
    }>`SELECT id FROM public.icloud_source_identity WHERE "ownerId"=${user.id}::uuid AND "assetId"=${asset.id}::uuid`.execute(
      db,
    );
    const baseline = ICloudEditBaselineSchema.parse({
      requestId: randomUUID(),
      expectedGeneration: 0,
      receiptId: receipt.rows[0].id,
      holder: { kind: 'device', id: deviceKey },
      sourceIncarnation: randomUUID(),
      nativeVersion: 'original-baseline',
    });
    const authority = await edits.baseline(auth, baseline);
    const [claim] = await identities.claim(user.id, [ITEM], `device:${deviceKey}`, 600);
    return { ctx, user, auth, deviceKey, asset, baseline, authority, claim };
  }
  it('discovers actual receipt facts separately from administrative authority without extending elevation', async () => {
    const f = await fixture();
    const snapshot = await edits.discover(f.auth, f.asset.id);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].receipts).toEqual([
      expect.objectContaining({
        receiptId: f.baseline.receiptId,
        assetId: f.asset.id,
        sha256: f.asset.checksum.toString('hex'),
        role: 'original',
        nativeVersion: '',
        suggestedAdministrativeLabel: 'administrative-original',
      }),
    ]);
    expect(snapshot.items[0].authority).toEqual(
      expect.objectContaining({
        evidenceType: 'administrative',
        generation: f.authority.generation,
        versionId: f.authority.versionId,
      }),
    );
    await expect(edits.discover({ ...f.auth, session: undefined }, f.asset.id)).rejects.toThrow(
      'edit_owner_session_required',
    );
    await db.updateTable('asset').set({ status: AssetStatus.Trashed }).where('id', '=', f.asset.id).execute();
    await expect(edits.discover(f.auth, f.asset.id)).rejects.toThrow('edit_evidence_unavailable');
  });
  it('refuses oversized discovery instead of returning a silently truncated receipt set', async () => {
    const f = await fixture();
    for (let count = 0; count < 100; count++) {
      const item = randomUUID().toUpperCase();
      await identities.recordDevice({
        ownerId: f.user.id,
        assetId: f.asset.id,
        parsed: { cplAssetRecordName: item, cplMasterRecordName: 'AQohY6yKZR0+tXlMi9FUQ82zySGo' },
        cloudIdentifier: item + ':001:AQohY6yKZR0+tXlMi9FUQ82zySGo',
        role: 'original',
        editVersion: '',
        sha256: f.asset.checksum,
        claimId: null,
        deviceKey: f.deviceKey,
        metadata: {},
      });
    }
    await expect(edits.discover(f.auth, f.asset.id)).rejects.toThrow('edit_evidence_too_large');
  });
  async function resource(
    f: Awaited<ReturnType<typeof fixture>>,
    token: string,
    checksum: Buffer = digest(randomUUID()),
  ) {
    const row = await uploads.create(randomUUID(), f.user.id, {
      checksum,
      contentType: 'image/jpeg',
      size: 4,
      metadata: {
        filename: 'render.jpg',
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
        sourceIdentity: {
          kind: 'icloud',
          cloudIdentifier: identifier,
          role: 'edit-render',
          editVersion: token,
          deviceKey: f.deviceKey,
          claimId: f.claim.id,
        },
      },
    });
    // The real PG writer tests begin at the durable verification boundary, as the existing live-photo suite.
    return db
      .updateTable('asset_upload_resource')
      .set({
        state: 'verified',
        offset: 4,
        verifiedChecksum: checksum,
        legacyChecksum: Buffer.alloc(20, 7),
        finalPath: `/private/${row.id}/render.jpg`,
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const prepared = (row: AssetUploadResource) => ({
    asset: {
      ownerId: row.ownerId!,
      libraryId: null,
      checksum: row.verifiedChecksum!,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      originalPath: row.finalPath!,
      originalFileName: 'render.jpg',
      type: AssetType.Image,
      fileCreatedAt: new Date(),
      fileModifiedAt: new Date(),
      localDateTime: new Date(),
      visibility: AssetVisibility.Timeline,
    },
    lock: undefined,
  });
  const publish = (row: AssetUploadResource) =>
    uploads.locked(row.id, row.ownerId!, (tx, current) => uploads.publish(tx, current, prepared(current)));
  const decision = (
    f: Awaited<ReturnType<typeof fixture>>,
    row: AssetUploadResource,
    expectedVersionId = f.authority.versionId,
    policy: 'keep' | 'supersede' = 'keep',
  ) =>
    ICloudEditSuccessorSchema.parse({
      requestId: randomUUID(),
      expectedGeneration: f.authority.generation,
      expectedVersionId,
      channel: 'device',
      resourceId: row.id,
      policy,
    });

  it('serves real authenticated HTTP discovery and both decisions with strict serialization and live PG fences', async () => {
    const f = await fixture(),
      row = await resource(f, 'http-token');
    const authService = newMediumService(AuthService, {
      database: db,
      real: [CryptoRepository, SessionRepository, UserRepository, ApiKeyRepository, SharedLinkRepository],
      mock: [LoggingRepository],
    }).sut;
    const relations = new ICloudRelationsService(new ICloudRelationsRepository(db), {
      emit: async () => {},
    } as unknown as EventRepository);
    const identityService = new ICloudIdentityService(
      identities,
      new IntegrityRepository(db),
      LoggingRepository.create(),
      relations,
    );
    const http = await controllerSetup(ICloudIdentityController, [
      { provide: ICloudIdentityService, useValue: identityService },
      { provide: ICloudAuditService, useValue: {} },
      { provide: AuthService, useValue: authService },
    ]);
    try {
      const uri = '/icloud-sync/edits/evidence';
      const unauthenticated = await request(http.getHttpServer()).get(uri).query({ assetId: f.asset.id }).expect(401);
      expect(unauthenticated.headers['cache-control']).toBe('private, no-store');
      await request(http.getHttpServer())
        .get(uri)
        .set('Authorization', 'Bearer invalid')
        .query({ assetId: f.asset.id })
        .expect(401);
      const apiKey = randomUUID();
      await new ApiKeyRepository(db).create({
        name: 'fixture',
        userId: f.user.id,
        key: digest(apiKey),
        permissions: [Permission.All],
      });
      const apiDenied = await request(http.getHttpServer())
        .get(uri)
        .set('x-api-key', apiKey)
        .query({ assetId: f.asset.id })
        .expect(403);
      expect(apiDenied.headers['cache-control']).toBe('private, no-store');
      for (const [path, body] of [
        ['baseline', f.baseline],
        ['successor', decision(f, row)],
      ] as const) {
        await request(http.getHttpServer())
          .post('/icloud-sync/edits/' + path)
          .set('x-api-key', apiKey)
          .send(body)
          .expect(403);
      }
      const shareKey = Buffer.from(randomUUID());
      await db
        .insertInto('shared_link')
        .values({
          userId: f.user.id,
          key: shareKey,
          type: SharedLinkType.Individual,
          allowUpload: true,
          albumId: null,
          description: null,
          expiresAt: null,
          password: null,
          slug: null,
        })
        .execute();
      for (const [path, body] of [
        ['baseline', f.baseline],
        ['successor', decision(f, row)],
      ] as const) {
        await request(http.getHttpServer())
          .post('/icloud-sync/edits/' + path)
          .set('x-immich-share-key', shareKey.toString('base64url'))
          .send(body)
          .expect(403);
      }
      const sharedDenied = await request(http.getHttpServer())
        .get(uri)
        .set('x-immich-share-key', shareKey.toString('base64url'))
        .query({ assetId: f.asset.id })
        .expect(403);
      expect(sharedDenied.headers['cache-control']).toBe('private, no-store');
      const token = f.auth.session!.id;
      const rejected = await request(http.getHttpServer())
        .get(uri)
        .set('Authorization', 'Bearer ' + token)
        .query({ assetId: f.asset.id, includePrivate: true })
        .expect(400);
      expect(rejected.headers['cache-control']).toBe('private, no-store');
      await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '2 minutes' WHERE id=${token}::uuid`.execute(
        db,
      );
      const before = await db
        .selectFrom('session')
        .select('pinExpiresAt')
        .where('id', '=', token)
        .executeTakeFirstOrThrow();
      const found = await request(http.getHttpServer())
        .get(uri)
        .set('Authorization', 'Bearer ' + token)
        .query({ assetId: f.asset.id })
        .expect(200);
      expect(found.headers['cache-control']).toBe('private, no-store');
      expect(found.body).toMatchObject({
        complete: true,
        admissionGuaranteed: false,
        items: [expect.objectContaining({ authority: expect.objectContaining({ evidenceType: 'administrative' }) })],
      });
      expect(await db.selectFrom('session').select('pinExpiresAt').where('id', '=', token).executeTakeFirst()).toEqual(
        before,
      );
      expect(JSON.stringify(found.body)).not.toMatch(/"(?:originalPath|finalPath|metadata|token|fileName)"\s*:/);
      await request(http.getHttpServer())
        .post('/icloud-sync/edits/baseline')
        .set('Authorization', 'Bearer ' + token)
        .send(f.baseline)
        .expect(200, f.authority);
      await request(http.getHttpServer())
        .post('/icloud-sync/edits/successor')
        .set('Authorization', 'Bearer ' + token)
        .send({ ...decision(f, row), providerRevision: 1 })
        .expect(400);
      const accepted = await request(http.getHttpServer())
        .post('/icloud-sync/edits/successor')
        .set('Authorization', 'Bearer ' + token)
        .send(decision(f, row))
        .expect(200);
      expect(accepted.body.evidenceType).toBe('administrative');
      await db.deleteFrom('session').where('id', '=', token).execute();
      await request(http.getHttpServer())
        .get(uri)
        .set('Authorization', 'Bearer ' + token)
        .query({ assetId: f.asset.id })
        .expect(401);
    } finally {
      await http.close();
    }
  });
  it('requires an explicit successor decision; opaque unequal tokens never imply chronological order', async () => {
    const f = await fixture();
    const row = await resource(f, 'arbitrary-new-token');
    await expect(publish(row)).rejects.toThrow('edit_successor_decision_required');
    expect((await uploads.get(row.id, f.user.id)).state).toBe('verified');
    const dto = decision(f, row);
    const accepted = await edits.successor(f.auth, dto);
    expect(accepted.evidenceType).toBe('administrative');
    expect(await edits.successor(f.auth, dto)).toEqual(accepted);
    const committed = await publish(row);
    expect(committed.state).toBe('published');
    const authority = await db
      .selectFrom('icloud_edit_authority')
      .selectAll()
      .where('ownerId', '=', f.user.id)
      .executeTakeFirstOrThrow();
    expect(authority.currentVersionId).toBe(accepted.versionId);
    const receipt = await db
      .selectFrom('icloud_edit_decision')
      .selectAll()
      .where('id', '=', dto.requestId)
      .executeTakeFirstOrThrow();
    expect(receipt.assetId).toBe(committed.resultAssetId);
    expect(
      (
        await db
          .selectFrom('asset')
          .select('checksum')
          .where('id', '=', committed.resultAssetId!)
          .executeTakeFirstOrThrow()
      ).checksum,
    ).toEqual(row.verifiedChecksum);
  });
  it.each(['active', 'locked', 'trashed'] as const)(
    'refuses unrelated identical-byte device target %s without accepted binding',
    async (state) => {
      const f = await fixture();
      const row = await resource(f, 'unbound');
      await edits.successor(f.auth, decision(f, row));
      const { asset: unrelated } = await f.ctx.newAsset({
        ownerId: f.user.id,
        checksum: row.verifiedChecksum!,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
      if (state === 'locked') {
        await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${unrelated.id}::uuid,'marked')`.execute(db);
      } else if (state === 'trashed') {
        await db
          .updateTable('asset')
          .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
          .where('id', '=', unrelated.id)
          .execute();
      }
      await expect(publish(row)).rejects.toThrow('edit_bound_asset_required');
      expect((await uploads.get(row.id, f.user.id)).resultAssetId).toBeNull();
      expect(
        await db.selectFrom('icloud_edit_version').select('id').where('ownerId', '=', f.user.id).execute(),
      ).toHaveLength(1);
      expect(
        (await db.selectFrom('asset').select('status').where('id', '=', unrelated.id).executeTakeFirstOrThrow()).status,
      ).toBe(state === 'trashed' ? AssetStatus.Trashed : AssetStatus.Active);
    },
  );
  it.each(['locked', 'trashed', 'changed-bytes'] as const)(
    'rechecks accepted existing device target after %s',
    async (state) => {
      const f = await fixture();
      const first = await resource(f, 'same');
      const accepted = await edits.successor(f.auth, decision(f, first));
      const published = await publish(first);
      const next = await resource(f, 'same', first.verifiedChecksum!);
      await edits.successor(f.auth, decision(f, next, accepted.versionId));
      const assetId = published.resultAssetId!;
      if (state === 'locked') {
        await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${assetId}::uuid,'marked')`.execute(db);
      } else if (state === 'trashed') {
        await db
          .updateTable('asset')
          .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
          .where('id', '=', assetId)
          .execute();
      } else {
        await db
          .updateTable('asset')
          .set({ checksum: digest('changed bytes') })
          .where('id', '=', assetId)
          .execute();
      }
      await expect(publish(next)).rejects.toThrow('edit_evidence_unavailable');
      expect((await uploads.get(next.id, f.user.id)).resultAssetId).toBeNull();
      expect(
        (
          await db
            .selectFrom('icloud_edit_authority')
            .select('currentVersionId')
            .where('ownerId', '=', f.user.id)
            .executeTakeFirstOrThrow()
        ).currentVersionId,
      ).toBe(accepted.versionId);
    },
  );
  it('refuses baseline replay after the same receipt is upserted to different verified bytes', async () => {
    const f = await fixture();
    const changed = digest('changed actual receipt bytes');
    await db.updateTable('asset').set({ checksum: changed }).where('id', '=', f.asset.id).execute();
    await identities.recordDevice({
      ownerId: f.user.id,
      assetId: f.asset.id,
      parsed: { cplAssetRecordName: ITEM, cplMasterRecordName: 'AQohY6yKZR0+tXlMi9FUQ82zySGo' },
      cloudIdentifier: identifier,
      role: 'original',
      editVersion: '',
      sha256: changed,
      claimId: null,
      deviceKey: f.deviceKey,
      metadata: {},
    });
    // Same-ID digest refresh as sync receipt upserts; the receipt itself was produced by the real repository.
    await sql`UPDATE public.icloud_source_identity SET sha256=${changed} WHERE id=${f.baseline.receiptId}::uuid`.execute(
      db,
    );
    expect(
      (
        await sql<{
          id: string;
        }>`SELECT id FROM public.icloud_source_identity WHERE \"ownerId\"=${f.user.id}::uuid`.execute(db)
      ).rows[0].id,
    ).toBe(f.baseline.receiptId);
    await expect(edits.baseline(f.auth, f.baseline)).rejects.toThrow('edit_decision_conflict');
    expect(
      (
        await db
          .selectFrom('icloud_edit_version')
          .select('sha256')
          .where('id', '=', f.authority.versionId)
          .executeTakeFirstOrThrow()
      ).sha256,
    ).toEqual(f.asset.checksum);
  });
  it('refreshes an actual item lease after discovery waits on the final asset fence', async () => {
    const f = await fixture();
    await resource(f, 'lease-wait');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.connection().execute((connection) =>
      connection.transaction().execute(async (tx) => {
        await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    await identities.renew(f.user.id, [f.claim.id], 'device:' + f.deviceKey, 3);
    const pending = edits.discover(f.auth, f.asset.id);
    try {
      await vi.waitFor(async () => {
        const waits = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%asset%'`.execute(
          db,
        );
        expect(waits.rows[0].count).toBeGreaterThan(0);
      });
      await vi.waitFor(
        async () => {
          const expiry = await sql<{
            expired: boolean;
          }>`SELECT "expiresAt"<=clock_timestamp() AS expired FROM public.icloud_claim WHERE id=${f.claim.id}::uuid`.execute(
            db,
          );
          expect(expiry.rows[0].expired).toBe(true);
        },
        { timeout: 4000, interval: 25 },
      );
    } finally {
      release.resolve();
      await blocker;
    }
    const snapshot = await pending;
    expect(snapshot.items[0].claims).toEqual([]);
    expect(snapshot.items[0].incoming).toEqual([
      expect.objectContaining({ nativeVersion: 'lease-wait', claimLive: false }),
    ]);
  });
  it.each(['baseline', 'successor', 'discovery'] as const)(
    'refuses %s after PIN expires during the evidence asset lock wait',
    async (kind) => {
      const f = await fixture();
      const row = await resource(f, 'pin-wait');
      await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${f.asset.id}::uuid,'marked')`.execute(db);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = db.connection().execute((connection) =>
        connection.transaction().execute(async (tx) => {
          await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=${f.auth.session!.id}::uuid`.execute(
        db,
      );
      const dto =
        kind === 'baseline' ? { ...f.baseline, requestId: randomUUID(), expectedGeneration: 1 } : decision(f, row);
      const pending = (
        kind === 'discovery'
          ? edits.discover(f.auth, f.asset.id)
          : kind === 'baseline'
            ? edits.baseline(f.auth, dto as typeof f.baseline)
            : edits.successor(f.auth, dto as ReturnType<typeof decision>)
      )
        .then(() => {})
        .catch((error: Error) => error);
      try {
        await vi.waitFor(async () => {
          const waits = await sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%asset%'`.execute(
            db,
          );
          expect(waits.rows[0].count).toBeGreaterThan(0);
        });
        await vi.waitFor(
          async () => {
            const expired = await sql<{
              expired: boolean;
            }>`SELECT "pinExpiresAt"<=clock_timestamp() AS expired FROM session WHERE id=${f.auth.session!.id}::uuid`.execute(
              db,
            );
            expect(expired.rows[0].expired).toBe(true);
          },
          { timeout: 3000, interval: 25 },
        );
      } finally {
        release.resolve();
        await blocker;
      }
      expect((await pending)?.message).toBe('edit_evidence_unavailable');
      expect(
        await db.selectFrom('icloud_edit_decision').select('id').where('id', '=', dto.requestId).execute(),
      ).toHaveLength(0);
      expect(
        (
          await db
            .selectFrom('icloud_edit_authority')
            .select('generation')
            .where('ownerId', '=', f.user.id)
            .executeTakeFirstOrThrow()
        ).generation,
      ).toBe(1);
    },
  );
  it('refuses first publication after takeover but settles the already committed result', async () => {
    const f = await fixture();
    const first = await resource(f, 'first');
    const firstDecision = decision(f, first);
    const accepted = await edits.successor(f.auth, firstDecision);
    const committed = await publish(first);
    const second = await resource(f, 'second');
    await edits.successor(f.auth, decision(f, second, accepted.versionId));
    await identities.release(f.user.id, [f.claim.id], `device:${f.deviceKey}`);
    const replacement = randomUUID();
    await new BackupDeviceRepository(db).register(f.user.id, {
      deviceKey: replacement,
      displayName: 'replacement',
      model: 'fixture',
      platform: 'fixture',
      appVersion: '1',
      pendingCount: 0,
      lastSuccessfulBackupAt: null,
    });
    const next = await edits.baseline(f.auth, {
      ...f.baseline,
      requestId: randomUUID(),
      expectedGeneration: 1,
      holder: { kind: 'device', id: replacement },
      sourceIncarnation: randomUUID(),
    });
    expect(next.generation).toBe(2);
    expect(await edits.baseline(f.auth, f.baseline)).toEqual(f.authority);
    expect(await edits.successor(f.auth, firstDecision)).toEqual(accepted);
    await expect(publish(second)).rejects.toThrow('edit_owner_stale');
    const token = randomUUID();
    expect(await uploads.claimIngestion(first.id, f.user.id, token)).toBeDefined();
    expect((await uploads.completeIngestion(first.id, f.user.id, token)).ingested).toBe(true);
    expect((await uploads.get(first.id, f.user.id)).resultAssetId).toBe(committed.resultAssetId);
    expect(
      (
        await db
          .selectFrom('icloud_edit_authority')
          .select('currentVersionId')
          .where('ownerId', '=', f.user.id)
          .executeTakeFirstOrThrow()
      ).currentVersionId,
    ).toBe(next.versionId);
  });
  it('holds the same item fence through first publication while a baseline decision waits', async () => {
    const f = await fixture();
    const row = await resource(f, 'held');
    await edits.successor(f.auth, decision(f, row));
    const { promise: atFence, resolve: entered } = Promise.withResolvers<void>();
    const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
    const publishing = uploads.locked(row.id, f.user.id, async (tx, current) => {
      await edits.publication(tx, f.user.id, 'device', row.id);
      entered();
      await barrier;
      return uploads.publish(tx, current, prepared(current));
    });
    await atFence;
    const takeover = edits.baseline(f.auth, { ...f.baseline, requestId: randomUUID(), expectedGeneration: 1 });
    try {
      await vi.waitFor(async () => {
        const waiting = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'`.execute(db);
        expect(waiting.rows[0].count).toBeGreaterThan(0);
      });
    } finally {
      release();
    }
    expect((await publishing).state).toBe('published');
    expect((await takeover).generation).toBe(2);
  });
  it('fences every publication asset and exact digest after the final sorted asset wait', async () => {
    const f = await fixture();
    const checksum = digest(randomUUID());
    const { asset } = await f.ctx.newAsset({
      ownerId: f.user.id,
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const proofs = [
      { assetId: f.asset.id, sha256: f.asset.checksum },
      { assetId: asset.id, sha256: checksum },
    ].sort((a, b) => a.assetId.localeCompare(b.assetId));
    const check = (bindings = proofs) => db.transaction().execute((tx) => edits['ownedAssets'](tx, f.auth, bindings));
    expect((await check()).user.id).toBe(f.user.id);
    await expect(
      check([
        { ...proofs[0], sha256: proofs[1].sha256 },
        { ...proofs[1], sha256: proofs[0].sha256 },
      ]),
    ).rejects.toThrow('edit_evidence_unavailable');
    await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${proofs[0].assetId}::uuid,'marked')`.execute(db);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.connection().execute((connection) =>
      connection.transaction().execute(async (tx) => {
        await tx.selectFrom('asset').select('id').where('id', '=', proofs[1].assetId).forUpdate().execute();
        entered.resolve();
        await release.promise;
      }),
    );
    await entered.promise;
    await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=${f.auth.session!.id}::uuid`.execute(
      db,
    );
    const pending = check()
      .then(() => {})
      .catch((error: Error) => error);
    try {
      await vi.waitFor(async () => {
        const waits = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%asset%'`.execute(
          db,
        );
        expect(waits.rows[0].count).toBeGreaterThan(0);
      });
      await vi.waitFor(
        async () => {
          const expired = await sql<{
            expired: boolean;
          }>`SELECT "pinExpiresAt"<=clock_timestamp() AS expired FROM session WHERE id=${f.auth.session!.id}::uuid`.execute(
            db,
          );
          expect(expired.rows[0].expired).toBe(true);
        },
        { timeout: 3000, interval: 25 },
      );
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await pending)?.message).toBe('edit_evidence_unavailable');
    expect(
      await db.selectFrom('icloud_edit_version').select('id').where('ownerId', '=', f.user.id).execute(),
    ).toHaveLength(1);
  });
  it('enforces twenty active retained edit assets across actual sequential first publications', async () => {
    const f = await fixture();
    let current = f.authority.versionId;
    let last!: AssetUploadResource;
    for (let index = 0; index < 20; index++) {
      const row = await resource(f, `edit-${index}`);
      last = row;
      const accepted = await edits.successor(f.auth, decision(f, row, current));
      await publish(row);
      const token = randomUUID();
      await uploads.claimIngestion(row.id, f.user.id, token);
      await uploads.completeIngestion(row.id, f.user.id, token);
      current = accepted.versionId;
    }
    const excess = await resource(f, 'edit-21');
    await edits.successor(f.auth, decision(f, excess, current));
    await expect(publish(excess)).rejects.toThrow('edit_capacity_reached');
    expect(
      await db.selectFrom('icloud_edit_version').selectAll().where('ownerId', '=', f.user.id).execute(),
    ).toHaveLength(21); // 20 edits + original baseline
    expect((await uploads.get(excess.id, f.user.id)).state).toBe('verified');
    const replay = await resource(f, 'edit-19', last.verifiedChecksum!);
    expect((await edits.successor(f.auth, decision(f, replay, current))).versionId).toBe(current);
    expect((await publish(replay)).resultStatus).toBe('duplicate');
    expect(
      await db.selectFrom('icloud_edit_version').selectAll().where('ownerId', '=', f.user.id).execute(),
    ).toHaveLength(21);
  });
  it('refuses foreign/missing session evidence and changed replay payload without mutating authority', async () => {
    const f = await fixture();
    await expect(edits.baseline({ ...f.auth, session: undefined }, f.baseline)).rejects.toThrow(
      'edit_owner_session_required',
    );
    await expect(edits.baseline(f.auth, { ...f.baseline, nativeVersion: 'other' })).rejects.toThrow(
      'edit_decision_conflict',
    );
    const { user } = await f.ctx.newUser();
    await expect(edits.baseline({ ...f.auth, user } as AuthDto, f.baseline)).rejects.toThrow(
      'edit_evidence_unavailable',
    );
    expect(
      (
        await db
          .selectFrom('icloud_edit_authority')
          .select('generation')
          .where('ownerId', '=', f.user.id)
          .executeTakeFirstOrThrow()
      ).generation,
    ).toBe(1);
  });
  it('uses current sync health and the actual 72-hour boundary for automatic administrative handover', async () => {
    const f = await fixture(),
      sync = new ICloudSyncRepository(db);
    const connection = (await sync.create(f.user.id, 'fixture', ICloudConfigSchema.parse({ includeEdits: true })))!;
    await sync.update(connection.id, f.user.id, { state: 'connected' });
    await identities.release(f.user.id, [f.claim.id], 'device:' + f.deviceKey);
    const authority = await edits.baseline(f.auth, {
      ...f.baseline,
      requestId: randomUUID(),
      expectedGeneration: 1,
      holder: { kind: 'icloud-sync', id: connection.id },
      sourceIncarnation: randomUUID(),
    });
    const next = { ...f.baseline, requestId: randomUUID(), expectedGeneration: authority.generation };
    await expect(edits.baseline(f.auth, { ...next, takeOver: true })).rejects.toThrow('edit_owner_held');
    await sync.update(connection.id, f.user.id, { state: 'error' });
    await sql`UPDATE public.icloud_connection SET "unhealthySince"=clock_timestamp()-interval '71 hours' WHERE id=${connection.id}::uuid`.execute(
      db,
    );
    expect(
      (await edits.discover(f.auth, f.asset.id)).items[0].holders.find(
        (h) => h.holder === 'icloud-sync:' + connection.id,
      )?.automaticTakeoverEligible,
    ).toBe(false);
    await expect(edits.baseline(f.auth, next)).rejects.toThrow('edit_owner_held');
    await sql`UPDATE public.icloud_connection SET "unhealthySince"=clock_timestamp()-interval '73 hours' WHERE id=${connection.id}::uuid`.execute(
      db,
    );
    expect(
      (await edits.discover(f.auth, f.asset.id)).items[0].holders.find(
        (h) => h.holder === 'icloud-sync:' + connection.id,
      )?.automaticTakeoverEligible,
    ).toBe(true);
    expect((await edits.baseline(f.auth, next)).generation).toBe(3);
    expect((await edits.baseline(f.auth, next)).generation).toBe(3);
  });
  it('does not accept same-token different-byte rendering or silently substitute keep for supersede', async () => {
    const f = await fixture();
    const first = await resource(f, 'A');
    const accepted = await edits.successor(f.auth, decision(f, first));
    await publish(first);
    const changed = await resource(f, 'A');
    await expect(edits.successor(f.auth, decision(f, changed, accepted.versionId))).rejects.toThrow(
      'edit_render_conflict',
    );
    const next = await resource(f, 'B');
    await edits.successor(f.auth, decision(f, next, accepted.versionId, 'supersede'));
    await expect(publish(next)).rejects.toThrow('edit_supersede_requires_review');
    expect(
      (await db.selectFrom('asset').select('status').where('id', '=', f.asset.id).executeTakeFirstOrThrow()).status,
    ).toBe('active');
  });
  it('uses real sync recovery commit and file digests, with decision refusal and post-takeover settlement', async () => {
    const f = await fixture();
    const sync = new ICloudSyncRepository(db);
    const recovery = new MediaRecoveryRepository(db);
    const connection = (await sync.create(f.user.id, 'fixture', ICloudConfigSchema.parse({ includeEdits: true })))!;
    await sync.update(connection.id, f.user.id, { state: 'connected' });
    await identities.release(f.user.id, [f.claim.id], `device:${f.deviceKey}`);
    expect(await identities.claimForSync(f.user.id, ITEM, connection.id)).toBeNull();
    const baseline = await edits.baseline(f.auth, {
      ...f.baseline,
      requestId: randomUUID(),
      expectedGeneration: 1,
      holder: { kind: 'icloud-sync', id: connection.id },
      sourceIncarnation: randomUUID(),
    });
    const body = Buffer.from('actual isolated file digest boundary');
    const field = (value: unknown) => ({ value });
    const master = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';
    await sync.savePage(
      connection.id,
      'assets:library',
      'library',
      [
        {
          recordName: master,
          recordType: 'CPLMaster',
          fields: {
            filenameEnc: field('source.jpg'),
            itemType: field('public.jpeg'),
            resOriginalRes: field({ size: body.length }),
          },
        },
        {
          recordName: ITEM,
          recordType: 'CPLAsset',
          fields: {
            masterRef: field({ recordName: master }),
            adjustmentType: field('com.apple.photo'),
            adjustmentTimestamp: field(1),
            resJPEGFullRes: field({ size: body.length }),
            resJPEGFullFileType: field('public.jpeg'),
          },
        },
      ],
      null,
      true,
    );
    await sync.materialize({ ...connection, state: 'connected' }, 'library', {
      area: 'private',
      zoneID: { zoneName: 'PrimarySync' },
    });
    const directory = await mkdtemp(join(tmpdir(), 'fl296-owned-edit-'));
    const path = join(directory, 'render.jpg');
    try {
      await writeFile(path, body);
      const logger = LoggingRepository.create();
      const integrity = new MediaIntegrityService(
        new StorageRepository(logger),
        new CryptoRepository(),
        new MediaRepository(logger),
      );
      const verifyFinal = () =>
        integrity.validate({ path, originalFileName: 'render.jpg', type: AssetType.Image, deep: false });
      const verified = await verifyFinal();
      if (verified.status !== 'healthy') {
        throw new Error('fixture_actual_digest_failed');
      }
      const leaseToken = randomUUID();
      const source =
        await sql<ICloudResource>`UPDATE public.icloud_resource SET status='validated',sha256=${verified.sha256},sha1=${verified.sha1},
        "leaseToken"=${leaseToken}::uuid,"leaseExpiresAt"=clock_timestamp()+interval '1 hour'
        WHERE "connectionId"=${connection.id}::uuid AND role='edited-image' RETURNING *`.execute(db);
      expect(source.rows).toHaveLength(1);
      const resource = source.rows[0];
      const authority = { resourceId: resource.id, leaseToken, ownerId: f.user.id, includeHidden: false };
      const reservation = await recovery.reserve({ ...authority, verified, outcome: 'imported', proposedPath: path });
      expect(reservation).toBeDefined();
      const commit = () =>
        recovery.commit({
          ...authority,
          reservation: reservation!,
          verified,
          originalFileName: 'render.jpg',
          type: AssetType.Image,
          verifyFinal,
        });
      expect(await commit()).toEqual({ outcome: 'needs-review', reason: 'edit_successor_decision_required' });
      const accepted = await edits.successor(
        f.auth,
        ICloudEditSuccessorSchema.parse({
          requestId: randomUUID(),
          expectedGeneration: baseline.generation,
          expectedVersionId: baseline.versionId,
          channel: 'icloud-sync',
          resourceId: resource.id,
        }),
      );
      // Actual candidate lookup/reservation, then status/lock races: identical bytes are not an accepted binding.
      const { asset: unrelated } = await f.ctx.newAsset({
        ownerId: f.user.id,
        originalPath: path,
        checksum: verified.sha256,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
      await db
        .insertInto('asset_exif')
        .values({ assetId: unrelated.id, fileSizeInByte: verified.sizeInBytes })
        .onConflict((oc) => oc.column('assetId').doUpdateSet({ fileSizeInByte: verified.sizeInBytes }))
        .execute();
      const candidate = (await recovery.findCandidates(f.user.id, verified, unrelated.id)).find(
        (row) => row.id === unrelated.id,
      )!;
      expect(candidate.matchesContent).toBe(true);
      // Reset only this owned verified fixture's first reservation; reserve the real candidate through production API.
      await sql`UPDATE public.icloud_resource SET \"expectedTarget\"=NULL,\"promotedPath\"=NULL WHERE id=${resource.id}::uuid`.execute(
        db,
      );
      const reuseReservation = await recovery.reserve({
        ...authority,
        verified,
        candidate,
        outcome: 'reused',
        proposedPath: path,
      });
      expect(reuseReservation?.target.assetId).toBe(unrelated.id);
      await sql`UPDATE public.icloud_resource SET \"assetId\"=${unrelated.id}::uuid WHERE id=${resource.id}::uuid`.execute(
        db,
      );
      for (const state of ['active', 'locked', 'trashed'] as const) {
        if (state === 'locked') {
          await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${unrelated.id}::uuid,'marked')`.execute(db);
        } else if (state === 'trashed') {
          await db
            .updateTable('asset')
            .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
            .where('id', '=', unrelated.id)
            .execute();
        }
        const currentCandidate = (await recovery.findCandidates(f.user.id, verified, unrelated.id)).find(
          (row) => row.id === unrelated.id,
        )!;
        expect(
          await recovery.commitVerifiedReuse({ ...authority, candidate: currentCandidate, verified, verifyFinal }),
        ).toEqual({ outcome: 'needs-review', reason: 'edit_bound_asset_required' });
        expect(
          await recovery.commit({
            ...authority,
            reservation: reuseReservation!,
            verified,
            originalFileName: 'render.jpg',
            type: AssetType.Image,
            verifyFinal,
          }),
        ).toEqual({ outcome: 'needs-review', reason: 'edit_bound_asset_required' });
        expect(
          await db.selectFrom('icloud_edit_version').select('id').where('id', '=', accepted.versionId).execute(),
        ).toHaveLength(0);
      }
      // Remove only the isolated unrelated fixture after proving refusal: recovery refuses new import while any managed match remains.
      await db.deleteFrom('asset').where('id', '=', unrelated.id).execute();
      // Restore the original genuine new-asset reservation.
      await sql`UPDATE public.icloud_resource SET \"assetId\"=NULL,\"expectedTarget\"=${reservation!.target}::jsonb,\"promotedPath\"=${reservation!.promotedPath} WHERE id=${resource.id}::uuid`.execute(
        db,
      );
      const result = await commit();
      expect(result.outcome).toBe('imported');
      expect(
        (
          await db
            .selectFrom('icloud_edit_version')
            .selectAll()
            .where('id', '=', accepted.versionId)
            .executeTakeFirstOrThrow()
        ).sha256,
      ).toEqual(verified.sha256);
      // A healthy source is protected even with manual takeOver.
      await expect(
        edits.baseline(f.auth, { ...f.baseline, requestId: randomUUID(), expectedGeneration: 2, takeOver: true }),
      ).rejects.toThrow('edit_item_claimed');
      const syncClaim = (await identities.claims(f.user.id, [ITEM]))[0];
      await identities.release(f.user.id, [syncClaim.id], `icloud-sync:${connection.id}`);
      await expect(
        edits.baseline(f.auth, { ...f.baseline, requestId: randomUUID(), expectedGeneration: 2, takeOver: true }),
      ).rejects.toThrow('edit_owner_held');
      await sync.update(connection.id, f.user.id, { state: 'error' });
      await expect(
        edits.baseline(f.auth, { ...f.baseline, requestId: randomUUID(), expectedGeneration: 2 }),
      ).rejects.toThrow('edit_owner_held');
      const next = await edits.baseline(f.auth, {
        ...f.baseline,
        requestId: randomUUID(),
        expectedGeneration: 2,
        takeOver: true,
      });
      expect(next.generation).toBe(3);
      expect((await commit()).reason).toBe('lease_changed'); // Existing disconnected-source first-commit admission remains refused.
      await sync.update(connection.id, f.user.id, { state: 'connected' });
      expect((await commit()).reason).toBe('already_committed');
      // The existing finalizer drains the immutable committed result rather than republishing it.
      const committed = (await sync.resource(resource.id))!;
      await sync.clearOutbox(committed);
      let cleanup = 0;
      expect(
        await sync.finalize(committed, () => {
          cleanup++;
          return Promise.resolve();
        }),
      ).toBe(true);
      expect(cleanup).toBe(1);
      expect(
        (
          await db
            .selectFrom('icloud_edit_authority')
            .select('currentVersionId')
            .where('ownerId', '=', f.user.id)
            .executeTakeFirstOrThrow()
        ).currentVersionId,
      ).toBe(next.versionId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
