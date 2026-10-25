import { Kysely, sql } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetVisibility, DocumentEditAction } from 'src/enum.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import {
  type DocumentEdit,
  DocumentEditConflictError,
  DocumentRepository,
} from 'src/repositories/document.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => database?.destroy());

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new DocumentRepository(database) };
};

describe(DocumentRepository.name, () => {
  it('fences decisions against original and crop changes and rolls failed writes back', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { resource } = await bindSourceReference(database, asset);
    const source = (await sut.readSource(asset.id))!;
    const values = {
      assetId: asset.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'retained-total',
      sourceText: null,
      editedById: user.id,
    };
    await database
      .updateTable('photo_source_resource')
      .set({ version: 'e'.repeat(64) })
      .where('id', '=', resource.id)
      .execute();
    await expect(sut.withSource(source, (repo) => repo.create(values))).rejects.toBeInstanceOf(
      DocumentEditConflictError,
    );
    const next = (await sut.readSource(asset.id))!;
    await ctx
      .get(AssetEditRepository)
      .replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }], 'save', {
        ownerId: next.ownerId,
        path: next.revision.originalPath as string,
        checksum: Buffer.from(next.checksum, 'hex'),
        reference: { resourceId: resource.id, version: 'e'.repeat(64), sha256: 'd'.repeat(64) },
      });
    await expect(sut.withSource(next, (repo) => repo.create(values))).rejects.toBeInstanceOf(DocumentEditConflictError);
    const current = (await sut.readSource(asset.id))!;
    await expect(
      sut.withSource(current, async (repo) => {
        await repo.create(values);
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect(await sut.getEdits(asset.id)).toEqual([]);
    await expect(
      database.transaction().execute(async (tx) =>
        new DocumentRepository(tx).withSource(current, async (repo) => {
          await repo.create(values);
          await tx
            .updateTable('asset')
            .set({ fileModifiedAt: new Date(Date.now() + 60_000) })
            .where('id', '=', asset.id)
            .execute();
        }),
      ),
    ).rejects.toBeInstanceOf(DocumentEditConflictError);
    expect(await sut.getEdits(asset.id)).toEqual([]);
    expect(await sut.readSource(asset.id)).toEqual(current);
    await database.updateTable('asset').set({ isEdited: false }).where('id', '=', asset.id).execute();
    await expect(sut.withSource(current, (repo) => repo.create(values))).rejects.toBeInstanceOf(
      DocumentEditConflictError,
    );
  });
  it('permits cached-text decisions without minting or requiring original-read authority', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { resource } = await bindSourceReference(database, asset);
    const {
      rows: [source],
    } = await sql<{ photoSessionId: string }>`SELECT s."photoSessionId" FROM photo_source_resource r
      JOIN photo_source_run run ON run.id=r."runId" JOIN photo_source s ON s.id=run."sourceId" WHERE r.id=${resource.id}::uuid`.execute(
      database,
    );
    await database.deleteFrom('session').where('id', '=', source.photoSessionId).execute();
    const snapshot = (await sut.readSource(asset.id))!;
    const created = await sut.withSource(snapshot, (repo) =>
      repo.create({
        assetId: asset.id,
        key: 'field:total',
        action: DocumentEditAction.Correct,
        value: 'cached correction',
        sourceText: null,
        editedById: user.id,
      }),
    );
    expect(await sut.getEdits(asset.id)).toEqual([created]);
  });
  it('refuses cached-text publication after its owner is deleted', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const source = (await sut.readSource(asset.id))!;
    await database.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();
    await expect(
      sut.withSource(source, (repo) =>
        repo.create({
          assetId: asset.id,
          key: 'field:total',
          action: DocumentEditAction.Correct,
          value: 'denied',
          sourceText: null,
          editedById: user.id,
        }),
      ),
    ).rejects.toBeInstanceOf(DocumentEditConflictError);
  });
  it('does not expose or mutate archived source-version decisions as current document text', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await database.insertInto('ocr_search').values({ assetId: asset.id, text: 'replacement words' }).execute();
    const row = await sut.create({
      assetId: asset.id,
      key: 'source-version:old:decision:field:total',
      action: DocumentEditAction.Correct,
      value: 'retained-private-total',
      sourceText: null,
      editedById: user.id,
    });
    expect(await sut.getEdits(asset.id)).toEqual([]);
    expect((await sut.search({ ownerId: user.id, query: 'retained-private-total', page: 1, size: 20 })).items).toEqual(
      [],
    );
    await expect(sut.update(row.id, row.revision, { value: 'changed' })).rejects.toBeInstanceOf(
      DocumentEditConflictError,
    );
    await expect(sut.delete(row.id, asset.id, row.revision)).rejects.toBeInstanceOf(DocumentEditConflictError);
    expect(
      (
        await database
          .selectFrom('asset_document_edit')
          .select('value')
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow()
      ).value,
    ).toBe('retained-private-total');
  });
  it('archives prior-source decisions without losing their values or blocking new current decisions', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { sourceReference } = await bindSourceReference(database, asset);
    const row = await sut.create({
      assetId: asset.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'previous-total',
      sourceText: 'old source',
      editedById: user.id,
    });
    expect(await sut.archiveForSourceChange(asset.id, sourceReference)).toBe(1);
    expect(await sut.archiveForSourceChange(asset.id, sourceReference)).toBe(0);
    expect(await sut.getEdits(asset.id)).toEqual([]);
    const archived = await database
      .selectFrom('asset_document_edit')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(archived).toMatchObject({
      key: `source-version:${sourceReference.resourceId}:${row.id}:field:total`,
      value: row.value,
      sourceText: row.sourceText,
      createdAt: row.createdAt,
      revision: row.revision + 1,
    });
    await expect(sut.update(row.id, archived.revision, { value: 'changed' })).rejects.toBeInstanceOf(
      DocumentEditConflictError,
    );
    const current = await sut.create({
      assetId: asset.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'current-total',
      sourceText: 'new source',
      editedById: user.id,
    });
    expect(await sut.getEdits(asset.id)).toEqual([current]);
    expect(await sut.archiveForSourceChange(asset.id, sourceReference)).toBe(1);
    expect(
      await database.selectFrom('asset_document_edit').select('id').where('assetId', '=', asset.id).execute(),
    ).toHaveLength(2);
  });
  it('refuses stale resource identity and rolls archival back with the owning publication transaction', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { sourceReference } = await bindSourceReference(database, asset);
    const row = await sut.create({
      assetId: asset.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'retained-total',
      sourceText: null,
      editedById: user.id,
    });
    for (const changed of [
      { version: 'e'.repeat(64) },
      { sha256: 'e'.repeat(64) },
      { resourceId: '11111111-1111-4111-8111-111111111111' },
    ]) {
      await expect(sut.archiveForSourceChange(asset.id, { ...sourceReference, ...changed })).rejects.toThrow(
        'document_source_changed',
      );
    }
    await expect(
      database.transaction().execute(async (tx) => {
        expect(await new DocumentRepository(tx).archiveForSourceChange(asset.id, sourceReference)).toBe(1);
        throw new Error('synthetic publication rollback');
      }),
    ).rejects.toThrow('synthetic publication rollback');
    expect(await sut.getEdits(asset.id)).toEqual([row]);
  });
  it('does not let an inactive crop suppress original-coordinate document corrections', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await database.insertInto('ocr_search').values({ assetId: asset.id, text: 'source words' }).execute();
    await sut.create({
      assetId: asset.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'retained-total',
      sourceText: null,
      editedById: user.id,
      x1: 0.1,
      y1: 0.1,
      x2: 0.4,
      y2: 0.1,
      x3: 0.4,
      y3: 0.4,
      x4: 0.1,
      y4: 0.4,
    });
    await ctx
      .get(AssetEditRepository)
      .replaceAll(asset.id, [{ action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 50, height: 50 } }]);
    const search = () => sut.search({ ownerId: user.id, query: 'retained-total', page: 1, size: 20 });
    expect((await search()).items).toEqual([]);
    await database.updateTable('asset').set({ isEdited: false }).where('id', '=', asset.id).execute();
    expect((await search()).items.map((item) => item.id)).toEqual([asset.id]);
  });
  it('searches visible OCR and corrections without leaking cropped, Locked, or other owners’ text', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: visible } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: archived } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Archive });
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const { asset: cropped } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: manual } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: empty } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: foreign } = await ctx.newAsset({ ownerId: other.id });

    await database
      .insertInto('ocr_search')
      .values([
        { assetId: visible.id, text: 'invoice' },
        { assetId: archived.id, text: 'invoice' },
        { assetId: locked.id, text: 'invoice' },
        { assetId: manual.id, text: 'invoice' },
        { assetId: empty.id, text: '' },
        { assetId: foreign.id, text: 'invoice' },
      ])
      .execute();

    const region = { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.1, x3: 0.4, y3: 0.4, x4: 0.1, y4: 0.4 };
    const survivingRegion = { x1: 0.6, y1: 0.6, x2: 0.9, y2: 0.6, x3: 0.9, y3: 0.9, x4: 0.6, y4: 0.9 };
    const ocr = ctx.get(OcrRepository);
    await ocr.upsert(
      cropped.id,
      [
        { assetId: cropped.id, text: 'confidential', boxScore: 1, textScore: 1, ...region },
        { assetId: cropped.id, text: 'invoice', boxScore: 1, textScore: 1, ...survivingRegion },
      ],
      'confidential invoice',
    );
    await sut.create({
      assetId: cropped.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'private-total',
      sourceText: 'confidential',
      editedById: owner.id,
      ...region,
    });
    await sut.create({
      assetId: manual.id,
      key: 'field:reference',
      action: DocumentEditAction.Correct,
      value: 'manual-reference',
      sourceText: null,
      editedById: owner.id,
    });
    const search = (query?: string, lockedOwnerId?: string) =>
      sut.search({ ownerId: owner.id, lockedOwnerId, query, page: 1, size: 20 });
    const ids = async (query?: string, lockedOwnerId?: string) =>
      (await search(query, lockedOwnerId)).items.map(({ id }) => id).sort();
    await expect(ids('confidential')).resolves.toEqual([cropped.id]);
    await expect(ids('private-total')).resolves.toEqual([cropped.id]);

    const lines = await ocr.getByAssetId(cropped.id);
    await ctx
      .get(AssetEditRepository)
      .replaceAll(cropped.id, [{ action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 50, height: 50 } }]);
    await ocr.updateOcrVisibilities(
      cropped.id,
      [lines.find(({ text }) => text === 'invoice')!],
      [lines.find(({ text }) => text === 'confidential')!],
    );

    await expect(
      database.selectFrom('ocr_search').select('text').where('assetId', '=', cropped.id).executeTakeFirst(),
    ).resolves.toEqual({ text: 'invoice' });
    await expect(ids()).resolves.toEqual([visible.id, cropped.id, manual.id].sort());
    await expect(ids('invoice')).resolves.toEqual([visible.id, archived.id, cropped.id, manual.id].sort());
    await expect(ids('invoice', owner.id)).resolves.toEqual(
      [visible.id, archived.id, locked.id, cropped.id, manual.id].sort(),
    );
    await expect(ids('confidential')).resolves.toEqual([]);
    await expect(ids('private-total')).resolves.toEqual([]);
    await expect(ids('manual-reference')).resolves.toEqual([manual.id]);
    await expect(search('manual-reference')).resolves.toMatchObject({ total: 1, hasNextPage: false });
  });

  it('keeps one decision per key and rejects stale updates and deletes', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const values = {
      assetId: asset.id,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: '12.00',
      sourceText: null,
      editedById: user.id,
    };
    const first = await sut.create(values);

    await expect(sut.create(values)).rejects.toBeInstanceOf(DocumentEditConflictError);
    const contenders = ['13.00', '14.00'];
    let outcomes!: Promise<PromiseSettledResult<DocumentEdit>[]>;
    await database.transaction().execute(async (trx) => {
      await trx
        .selectFrom('asset_document_edit')
        .select('id')
        .where('id', '=', first.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      outcomes = Promise.allSettled(contenders.map((value) => sut.update(first.id, first.revision, { value })));
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and query like 'update "asset_document_edit"%'
          `.execute(database);
          expect(rows[0].waiting).toBe(2);
        },
        { timeout: 5000 },
      );
    });
    const results = await outcomes;
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const [winner] = await sut.getEdits(asset.id);
    expect(winner).toMatchObject({ id: first.id, revision: first.revision + 1 });
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(DocumentEditConflictError);
        expect(winner.value).not.toBe(contenders[index]);
      } else {
        expect(winner).toMatchObject({ value: result.value.value, revision: result.value.revision });
      }
    }
    await expect(sut.delete(first.id, asset.id, first.revision)).rejects.toBeInstanceOf(DocumentEditConflictError);
    await sut.delete(first.id, asset.id, winner.revision);
    await expect(sut.getEdits(asset.id)).resolves.toEqual([]);
  }, 20_000);
});
