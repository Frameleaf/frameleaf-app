import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import {
  ICloudIdentityRepository,
  recordSyncIdentity,
  releaseSyncClaim,
} from 'src/repositories/icloud-identity.repository.js';
import { ICloudConnection, ICloudLibrary, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

const field = (value: unknown) => ({ value });
const ASSET = '32A01DD9-75DF-41B2-8773-80C153D73A5A';
const MASTER = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';

/** FL-296: iCloud source identities, written by the sync and read by the app's lookup (canonical source identity). */
describe(ICloudIdentityRepository.name, () => {
  let db: Kysely<DB>;
  let sync: ICloudSyncRepository;
  let sut: ICloudIdentityRepository;
  let connection: ICloudConnection;
  const library: ICloudLibrary = { area: 'private', zoneID: { zoneName: 'PrimarySync' } };
  const master = {
    recordName: MASTER,
    recordType: 'CPLMaster',
    fields: {
      filenameEnc: { value: 'IMG_0001.HEIC', type: 'STRING' },
      itemType: field('public.heic'),
      resOriginalRes: field({ size: 100, fileChecksum: MASTER }),
      resOriginalVidComplRes: field({ size: 50 }),
    },
  };
  const asset = (recordName = ASSET, masterName = MASTER) => ({
    recordName,
    recordType: 'CPLAsset',
    fields: {
      masterRef: field({ recordName: masterName }),
      assetDate: field(Date.parse('2026-06-01T10:00:00Z')),
      adjustmentType: field('com.apple.photo'),
      adjustmentTimestamp: field(1_780_000_000_000),
      resJPEGFullRes: field({ size: 80 }),
    },
  });

  /** Mark the resource of `role` imported as `assetId` with `sha256`, as the sync's commit does. */
  const commit = async (role: string, assetId: string, sha256: Buffer) => {
    await seedCanonicalAsset(db, { id: assetId, ownerId: connection.ownerId });
    const { rows } = await sql<{ id: string }>`
      UPDATE public.icloud_resource SET status = 'committed', "assetId" = ${assetId}::uuid, sha256 = ${sha256}
      WHERE "connectionId" = ${connection.id}::uuid AND role = ${role} RETURNING id
    `.execute(db);
    return rows[0].id;
  };

  beforeAll(async () => {
    db = await getKyselyDB();

    sync = new ICloudSyncRepository(db);
    sut = new ICloudIdentityRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await sql`TRUNCATE public.icloud_connection, public.icloud_source_identity, public.icloud_claim,
      asset, backup_device CASCADE`.execute(db);
    connection = (await sync.create((await seedCanonicalUser(db)).id, 'Photos', ICloudConfigSchema.parse({})))!;
    await sync.update(connection.id, connection.ownerId, { state: 'connected', accountHint: 'a•••@icloud.com' });
    connection.state = 'connected';
    await sync.savePage(connection.id, 'assets:library', 'library', [master, asset()], null, true);
    await sync.materialize(connection, 'library', library);
  });

  it('records what the sync committed, with its record names, and backfills past imports once', async () => {
    const original = randomUUID();
    const resourceId = await commit('original', original, Buffer.alloc(32, 1));
    await recordSyncIdentity(db, resourceId);
    const edit = randomUUID();
    await commit('edited-image', edit, Buffer.alloc(32, 2));
    // the edit was imported before identities existed: the backfill finds it, and only it
    await expect(sut.backfill()).resolves.toBe(1);
    await expect(sut.backfill()).resolves.toBe(0);

    const rows = await sut.identities(connection.ownerId, [ASSET]);
    expect(rows).toEqual([
      expect.objectContaining({
        assetId: original,
        cplAssetRecordName: ASSET,
        cplMasterRecordName: MASTER,
        role: 'original',
        editVersion: '',
        deliveredBy: `icloud-sync:${connection.id}`,
        matchStrength: 'exact',
      }),
      expect.objectContaining({
        assetId: edit,
        role: 'edit-render',
        editVersion: expect.stringMatching(/^1780000000000:[\da-f]{64}$/),
      }),
    ]);
    // another owner never sees them; a deleted asset's identity is not answered
    await expect(sut.identities(randomUUID(), [ASSET])).resolves.toEqual([]);
    await sql`UPDATE asset SET "deletedAt" = now() WHERE id = ${edit}::uuid`.execute(db);
    await expect(sut.identities(connection.ownerId, [ASSET])).resolves.toHaveLength(1);
  });

  it.each(['match', 'mismatch'] as const)(
    'invalidates a previous %s audit when the sync digest changes',
    async (result) => {
      const assetId = randomUUID();
      const resourceId = await commit('original', assetId, Buffer.alloc(32, 1));
      await recordSyncIdentity(db, resourceId);
      await sql`UPDATE public.icloud_source_identity
        SET "lastVerifiedAt" = '2026-06-01T10:00:00Z', "lastAuditResult" = ${result}, "appleFingerprint" = 'old-proof'
        WHERE "assetId" = ${assetId}::uuid`.execute(db);
      const replacement = Buffer.alloc(32, 2);
      await sql`UPDATE public.icloud_resource SET sha256 = ${replacement} WHERE id = ${resourceId}::uuid`.execute(db);
      await recordSyncIdentity(db, resourceId);
      expect(await sut.identities(connection.ownerId, [ASSET])).toEqual([
        expect.objectContaining({
          sha256: replacement,
          lastVerifiedAt: null,
          lastAuditResult: null,
          appleFingerprint: null,
        }),
      ]);
    },
  );

  it.each(['match', 'mismatch'] as const)(
    'preserves a previous %s audit when the sync digest is unchanged',
    async (result) => {
      const assetId = randomUUID();
      const resourceId = await commit('original', assetId, Buffer.alloc(32, 1));
      await recordSyncIdentity(db, resourceId);
      await sql`UPDATE public.icloud_source_identity
        SET "lastVerifiedAt" = '2026-06-01T10:00:00Z', "lastAuditResult" = ${result}, "appleFingerprint" = 'same-proof'
        WHERE "assetId" = ${assetId}::uuid`.execute(db);
      const before = await sut.identities(connection.ownerId, [ASSET]);
      await recordSyncIdentity(db, resourceId);
      expect(await sut.identities(connection.ownerId, [ASSET])).toEqual(before);
    },
  );

  it('ignores a null resource digest and rejects a null identity digest without changing old proof', async () => {
    const assetId = randomUUID();
    const resourceId = await commit('original', assetId, Buffer.alloc(32, 1));
    await recordSyncIdentity(db, resourceId);
    await sql`UPDATE public.icloud_source_identity
      SET "lastVerifiedAt" = '2026-06-01T10:00:00Z', "lastAuditResult" = 'match', "appleFingerprint" = 'same-proof'
      WHERE "assetId" = ${assetId}::uuid`.execute(db);
    const before = await sut.identities(connection.ownerId, [ASSET]);
    await sql`UPDATE public.icloud_resource SET sha256 = NULL WHERE id = ${resourceId}::uuid`.execute(db);
    await recordSyncIdentity(db, resourceId);
    expect(await sut.identities(connection.ownerId, [ASSET])).toEqual(before);
    await expect(
      sql`UPDATE public.icloud_source_identity SET sha256 = NULL WHERE "assetId" = ${assetId}::uuid`.execute(db),
    ).rejects.toMatchObject({ code: '23502' });
    expect(await sut.identities(connection.ownerId, [ASSET])).toEqual(before);
  });

  it('knows what the inventory holds, in scope or not, and what is still pending', async () => {
    await sync.savePage(connection.id, 'assets:other', 'other', [{ ...asset('OUTSIDE-1', MASTER) }], null, true);
    const items = await sut.inventory(connection.ownerId, [ASSET, 'OUTSIDE-1', 'UNKNOWN']);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: connection.id,
          cplAssetRecordName: ASSET,
          cplMasterRecordName: MASTER,
          inScope: true,
          pendingRoles: expect.arrayContaining(['original', 'live-motion']),
          pendingSince: expect.any(Date),
          masterFields: expect.objectContaining({ filenameEnc: expect.anything() }),
        }),
        expect.objectContaining({ cplAssetRecordName: 'OUTSIDE-1', inScope: false, pendingRoles: [] }),
      ]),
    );
    expect(items).toHaveLength(2);
    await expect(sut.inventory(randomUUID(), [ASSET])).resolves.toEqual([]);
  });

  it('uses the latest selected album inventory instead of historical resources after a scope change', async () => {
    const selected = '0B0B0B0B-75DF-41B2-8773-80C153D73A5A';
    await sync.savePage(connection.id, 'assets:library', 'library', [asset(selected)], null, true);
    const config = ICloudConfigSchema.parse({ albums: ['library:selected'] });
    await sync.update(connection.id, connection.ownerId, { config });
    const current = (await sync.get(connection.id, connection.ownerId))!;
    await sync.saveMembershipPage(connection.id, 'library', 'selected', [asset(selected)], randomUUID(), true);
    await expect(sync.materialize(current, 'library', library)).resolves.toBe(true);
    await sync.savePage(connection.id, 'inventory-complete', '', [], null, true);

    const { rows: resources } = await sql<{ sourceAssetId: string; current: boolean; status: string }>`
      SELECT "sourceAssetId", (source->>'current')::boolean AS current, status FROM public.icloud_resource
      WHERE "connectionId" = ${connection.id}::uuid AND "auditRequestId" IS NULL AND role = 'original'
      ORDER BY "sourceAssetId"
    `.execute(db);
    expect(resources).toEqual([
      { sourceAssetId: selected, current: true, status: 'pending' },
      { sourceAssetId: ASSET, current: false, status: 'pending' },
    ]);
    const otherOwner = (await seedCanonicalUser(db)).id;
    const other = (await sync.create(otherOwner, 'Other owner', ICloudConfigSchema.parse({})))!;
    await sync.savePage(other.id, 'assets:library', 'library', [master, asset()], null, true);
    await sync.materialize(other, 'library', library);
    await expect(sut.connections(connection.ownerId)).resolves.toEqual([
      expect.objectContaining({
        config: expect.objectContaining({ albums: ['library:selected'] }),
        lastCompleteInventoryAt: expect.any(Date),
      }),
    ]);
    const service = new ICloudIdentityService(sut, new IntegrityRepository(db), LoggingRepository.create());
    const coverage = await service.coverage({ user: { id: connection.ownerId } } as AuthDto, {
      deviceKey: randomUUID(),
      samples: [ASSET, selected].map((name) => ({
        cloudIdentifier: `${name}:001:${MASTER}`,
        originalFilename: 'IMG_0001.HEIC',
        creationDate: '2026-06-01T10:00:00Z',
      })),
    });
    expect(coverage.connections[0]).toMatchObject({ sampled: 2, matched: 1, covers: false });
    const items = await sut.inventory(connection.ownerId, [ASSET, selected]);
    expect(items).toHaveLength(2);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cplAssetRecordName: selected,
          inScope: true,
          pendingRoles: expect.arrayContaining(['original']),
        }),
        expect.objectContaining({ cplAssetRecordName: ASSET, inScope: false, pendingRoles: [] }),
      ]),
    );
    await expect(sut.inventory(randomUUID(), [ASSET, selected])).resolves.toEqual([]);
    await expect(sut.connections(randomUUID())).resolves.toEqual([]);
    await expect(sut.inventory(otherOwner, [ASSET, selected])).resolves.toEqual([
      expect.objectContaining({ connectionId: other.id, cplAssetRecordName: ASSET, inScope: true }),
    ]);
    await expect(sut.connections(otherOwner)).resolves.toEqual([expect.objectContaining({ id: other.id })]);
  });

  it('stops calling a role pending once it is finalized, or failed for good', async () => {
    await commit('original', randomUUID(), Buffer.alloc(32, 1));
    // committed is still the worker's to finish; finalized is done
    await sql`UPDATE public.icloud_resource SET status = 'finalized'
      WHERE "connectionId" = ${connection.id}::uuid AND role = 'original'`.execute(db);
    await sql`UPDATE public.icloud_resource SET status = 'failed'
      WHERE "connectionId" = ${connection.id}::uuid AND role = 'motion'`.execute(db);
    const [item] = await sut.inventory(connection.ownerId, [ASSET]);
    expect(item.pendingRoles).not.toContain('original');
    // a failed resource is not coming: the device keeps it
    expect(item.pendingRoles).not.toContain('live-motion');
  });

  it('backfills each Apple item that reused one asset', async () => {
    const original = randomUUID();
    await recordSyncIdentity(db, await commit('original', original, Buffer.alloc(32, 1)));
    // a duplicate in iCloud, imported before identities existed, reused the same asset
    const twin = '0B0B0B0B-75DF-41B2-8773-80C153D73A5A';
    await sql`
      INSERT INTO public.icloud_resource ("connectionId", "ownerId", "libraryKey", library, "sourceAssetId",
        "recordId", "resourceKey", role, fingerprint, source, "expectedSize", status, "assetId", sha256)
      SELECT "connectionId", "ownerId", "libraryKey", library, ${twin}, "recordId", "resourceKey", role, fingerprint,
        source, "expectedSize", status, "assetId", sha256
      FROM public.icloud_resource WHERE "connectionId" = ${connection.id}::uuid AND role = 'original'
    `.execute(db);
    await expect(sut.backfill()).resolves.toBe(1);
    await expect(sut.identities(connection.ownerId, [twin])).resolves.toEqual([
      expect.objectContaining({ assetId: original, role: 'original' }),
    ]);
  });

  it('describes the connections for the coverage probe, with when they stopped being healthy', async () => {
    let [described] = await sut.connections(connection.ownerId);
    expect(described).toMatchObject({
      id: connection.id,
      state: 'connected',
      accountHint: 'a•••@icloud.com',
      unhealthySince: null,
      lastCompleteInventoryAt: null,
    });
    await sync.update(connection.id, connection.ownerId, { state: 'reauthentication-required' });
    await sync.savePage(connection.id, 'inventory-complete', '', [], null, true);
    [described] = await sut.connections(connection.ownerId);
    expect(described.unhealthySince).toBeInstanceOf(Date);
    expect(described.lastCompleteInventoryAt).toBeInstanceOf(Date);
  });

  it('drops the identities of assets that are gone', async () => {
    const original = randomUUID();
    await recordSyncIdentity(db, await commit('original', original, Buffer.alloc(32, 1)));
    await sql`DELETE FROM asset WHERE id = ${original}::uuid`.execute(db);
    await expect(sut.removeOrphans()).resolves.toBe(1);
  });

  describe('claims', () => {
    const device = (key: string) => `device:${key}`;

    it("grants a free item, keeps a holder's own claim, and refuses another holder until it runs out", async () => {
      const [first] = await sut.claim(connection.ownerId, [ASSET], device('a'), 600);
      expect(first).toMatchObject({ cplAssetRecordName: ASSET, holder: device('a') });
      const [again] = await sut.claim(connection.ownerId, [ASSET], device('a'), 600);
      expect(again.id).toBe(first.id);
      const [other] = await sut.claim(connection.ownerId, [ASSET], device('b'), 600);
      expect(other).toMatchObject({ id: first.id, holder: device('a') });
      // another owner's claim on the same item is theirs alone
      const [elsewhere] = await sut.claim(randomUUID(), [ASSET], device('b'), 600);
      expect(elsewhere.holder).toBe(device('b'));

      await sql`UPDATE public.icloud_claim SET "expiresAt" = now() - interval '1 second'`.execute(db);
      const [taken] = await sut.claim(connection.ownerId, [ASSET], device('b'), 600);
      expect(taken.holder).toBe(device('b'));
      expect(taken.id).not.toBe(first.id);
      await expect(sut.claims(connection.ownerId, [ASSET])).resolves.toEqual([
        expect.objectContaining({ id: taken.id }),
      ]);
    });

    it("renews up to four hours from the first claim, and releases only the holder's own", async () => {
      const [claim] = await sut.claim(connection.ownerId, [ASSET], device('a'), 600);
      await sql`UPDATE public.icloud_claim SET "createdAt" = now() - interval '3 hours 59 minutes'`.execute(db);
      const [renewed] = await sut.renew(connection.ownerId, [claim.id], device('a'), 600);
      expect(renewed.expiresAt.getTime() - Date.now()).toBeLessThan(120_000);
      await expect(sut.renew(connection.ownerId, [claim.id], device('b'), 600)).resolves.toEqual([]);
      await expect(sut.release(connection.ownerId, [claim.id], device('b'))).resolves.toEqual([]);
      await expect(sut.release(connection.ownerId, [claim.id], device('a'))).resolves.toEqual([claim.id]);
    });

    it("makes the sync wait for a device, and lets its own claim go with the item's last resource", async () => {
      await sut.claim(connection.ownerId, [ASSET], device('a'), 600);
      await expect(sut.claimForSync(connection.ownerId, ASSET.toLowerCase(), connection.id)).resolves.toBeInstanceOf(
        Date,
      );
      await sql`DELETE FROM public.icloud_claim`.execute(db);
      await expect(sut.claimForSync(connection.ownerId, ASSET, connection.id)).resolves.toBeNull();

      // the item has an original, a Live Photo motion and an edit: the claim stays until all three are done
      const resourceId = await commit('original', randomUUID(), Buffer.alloc(32, 1));
      await releaseSyncClaim(db, resourceId);
      await expect(sut.claims(connection.ownerId, [ASSET])).resolves.toHaveLength(1);
      await sql`UPDATE public.icloud_resource SET status = 'finalized' WHERE "connectionId" = ${connection.id}::uuid`.execute(
        db,
      );
      await releaseSyncClaim(db, resourceId);
      await expect(sut.claims(connection.ownerId, [ASSET])).resolves.toEqual([]);
    });

    it('parks a resource the device holds without counting an attempt', async () => {
      const { rows } = await sql<{ id: string }>`
        UPDATE public.icloud_resource SET status = 'staging', "leaseToken" = gen_random_uuid(),
          "leaseExpiresAt" = now() + interval '1 minute' WHERE role = 'original' RETURNING id
      `.execute(db);
      const resource = (await sync.resource(rows[0].id))!;
      const until = new Date(Date.now() + 600_000);
      await sync.waitForClaim(resource, until);
      expect(await sync.resource(rows[0].id)).toMatchObject({
        status: 'pending',
        attempts: resource.attempts,
        leaseToken: null,
        lastError: 'icloud_claimed',
      });
    });

    it('records each role a device uploads under its claim, keeping the claim for the rest of the item', async () => {
      const [claim] = await sut.claim(connection.ownerId, [ASSET], device('a'), 600);
      const upload = async (role: 'original' | 'raw-alternate', byte: number) => {
        const assetId = randomUUID();
        await seedCanonicalAsset(db, { id: assetId, ownerId: connection.ownerId });
        const input = {
          ownerId: connection.ownerId,
          assetId,
          parsed: { cplAssetRecordName: ASSET, cplMasterRecordName: MASTER },
          cloudIdentifier: `${ASSET}:001:${MASTER}`,
          role,
          editVersion: '',
          sha256: Buffer.alloc(32, byte),
          claimId: claim.id,
          deviceKey: null,
          metadata: { originalFilename: 'IMG_0001.HEIC', creationDate: '2026-06-01T10:00:00.000Z' },
        };
        await sut.recordDevice(input);
        await sut.recordDevice(input);
        return assetId;
      };
      const original = await upload('original', 3);
      // the RAW is still on the way: the sync must not take the item now
      await expect(sut.claimForSync(connection.ownerId, ASSET, connection.id)).resolves.toBeInstanceOf(Date);
      const raw = await upload('raw-alternate', 4);
      await expect(sut.identities(connection.ownerId, [ASSET])).resolves.toEqual([
        expect.objectContaining({ assetId: original, deliveredBy: device('a'), matchStrength: 'corroborated' }),
        expect.objectContaining({ assetId: raw, role: 'raw-alternate', deliveredBy: device('a') }),
      ]);
      await expect(sut.release(connection.ownerId, [claim.id], device('a'))).resolves.toEqual([claim.id]);
      await expect(sut.claimForSync(connection.ownerId, ASSET, connection.id)).resolves.toBeNull();
    });

    it("knows the owner's backup devices", async () => {
      const key = randomUUID();
      await sql`INSERT INTO backup_device ("ownerId","deviceKey","displayName",model,platform,"appVersion","pendingCount") VALUES (${connection.ownerId}::uuid, ${key}::uuid, 'Phone','Test','ios','1',0)`.execute(
        db,
      );
      await expect(sut.ownsDevice(connection.ownerId, key)).resolves.toBe(true);
      await expect(sut.ownsDevice(randomUUID(), key)).resolves.toBe(false);
    });
  });
});
