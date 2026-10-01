import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import * as icloud from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import * as identity from 'src/fork-schema/migrations/0000000000213-ICloudSourceIdentity.js';
import { ICloudIdentityRepository, recordSyncIdentity } from 'src/repositories/icloud-identity.repository.js';
import { ICloudConnection, ICloudLibrary, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

const field = (value: unknown) => ({ value });
const ASSET = '32A01DD9-75DF-41B2-8773-80C153D73A5A';
const MASTER = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';

/** FL-296: iCloud source identities, written by the sync and read by the app's lookup (fork migration 0213). */
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
    await sql`INSERT INTO asset (id, "ownerId") VALUES (${assetId}::uuid, ${connection.ownerId}::uuid)`.execute(db);
    const { rows } = await sql<{ id: string }>`
      UPDATE immich_fork.icloud_resource SET status = 'committed', "assetId" = ${assetId}::uuid, sha256 = ${sha256}
      WHERE "connectionId" = ${connection.id}::uuid AND role = ${role} RETURNING id
    `.execute(db);
    return rows[0].id;
  };

  beforeAll(async () => {
    db = await getKyselyDB();
    // a focused schema, as the iCloud sync repository spec uses
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    await sql`CREATE SCHEMA immich_fork`.execute(db);
    await sql`CREATE TABLE immich_fork.state (id integer PRIMARY KEY,phase text)`.execute(db);
    await sql`INSERT INTO immich_fork.state VALUES (1,'active')`.execute(db);
    await sql`CREATE TABLE immich_fork.migration_audit (name text,status text)`.execute(db);
    await sql`CREATE TABLE asset (id uuid PRIMARY KEY,"ownerId" uuid,"deletedAt" timestamptz)`.execute(db);
    await icloud.up(db);
    await identity.up(db);
    sync = new ICloudSyncRepository(db);
    sut = new ICloudIdentityRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await sql`TRUNCATE immich_fork.icloud_connection, immich_fork.icloud_source_identity, asset CASCADE`.execute(db);
    connection = (await sync.create(randomUUID(), 'Photos', ICloudConfigSchema.parse({})))!;
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
          pending: true,
          pendingSince: expect.any(Date),
          masterFields: expect.objectContaining({ filenameEnc: expect.anything() }),
        }),
        expect.objectContaining({ cplAssetRecordName: 'OUTSIDE-1', inScope: false, pending: false }),
      ]),
    );
    expect(items).toHaveLength(2);
    await expect(sut.inventory(randomUUID(), [ASSET])).resolves.toEqual([]);
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
});
