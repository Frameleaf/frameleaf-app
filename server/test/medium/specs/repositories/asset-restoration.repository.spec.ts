import type { Kysely } from 'kysely';
import { AssetRestorationMode, AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import { MediaOperationDestination, MediaOperationKind, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import type { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

describe('restoration operation ownership', () => {
  it.each(['preview', 'full'] as const)(
    'guards %s stage writes by the current operation in PostgreSQL',
    async (stage) => {
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sut = new AssetRestorationRepository(db);
      const operations = ctx.get(MediaOperationRepository as never) as MediaOperationRepository;
      const kind = stage === 'preview' ? MediaOperationKind.RestorationPreview : MediaOperationKind.Restoration;
      const old = await operations.create({
        ownerId: user.id,
        kind,
        destination: MediaOperationDestination.Local,
        label: 'Old restoration',
        snapshot: {},
      });
      const next = await operations.create({
        ownerId: user.id,
        kind,
        destination: MediaOperationDestination.Local,
        label: 'New restoration',
        snapshot: {},
      });
      const running = stage === 'preview' ? AssetRestorationStatus.PreviewRendering : AssetRestorationStatus.Restoring;
      const done = stage === 'preview' ? AssetRestorationStatus.PreviewReady : AssetRestorationStatus.Restored;
      const column = stage === 'preview' ? 'previewOperationId' : 'fullOperationId';
      const row = await sut.create({
        assetId: asset.id,
        ownerId: user.id,
        status: running,
        mode: AssetRestorationMode.Faithful,
        workload: MlWorkload.RestorationFaithful,
        destinationKind: MlDestinationKind.Local,
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: asset.checksum,
        sourceWidth: 100,
        sourceHeight: 100,
        previewRegion: { x: 0, y: 0, w: 1, h: 1 },
      });
      try {
        // Initial preview admission can win before its API call records the operation link.
        await expect(
          sut.transition(row.id, [running], { status: running, [column]: old.id }, undefined, { stage, id: null }),
        ).resolves.toMatchObject({ [column]: old.id });
        const observed = await sut.get(row.id);
        await sut.update(row.id, { [column]: next.id, error: 'new operation state' });

        await expect(
          sut.transition(row.id, [running], { status: done, error: null }, undefined, { stage, id: observed![column] }),
        ).resolves.toBeUndefined();
        await expect(
          sut.transition(row.id, [running], { status: done }, undefined, { stage, id: null }),
        ).resolves.toBeUndefined();
        await expect(sut.get(row.id)).resolves.toMatchObject({
          status: running,
          [column]: next.id,
          error: 'new operation state',
        });

        await db.transaction().execute(async (tx) => {
          await expect(
            sut.transition(row.id, [running], { status: done, error: null }, tx, { stage, id: next.id }),
          ).resolves.toMatchObject({ status: done, [column]: next.id });
        });
        // Owner decisions keep the existing status-only transition contract.
        await expect(sut.transition(row.id, [done], { status: running })).resolves.toMatchObject({ status: running });
      } finally {
        await db.deleteFrom('asset_restoration').where('id', '=', row.id).execute();
        await db.deleteFrom('media_operation').where('id', 'in', [old.id, next.id]).execute();
        await db.deleteFrom('asset').where('id', '=', asset.id).execute();
        await db.deleteFrom('user').where('id', '=', user.id).execute();
      }
    },
  );
});
