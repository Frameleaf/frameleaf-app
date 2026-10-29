import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetLockReason,
  AssetType,
  IntegrityReport,
  JobStatus,
  MediaOperationKind,
  UserMetadataKey,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { SpeechRepository } from 'src/repositories/speech.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { IntegrityService } from 'src/services/integrity.service.js';
import { SpeechService } from 'src/services/speech.service.js';
import { speechQuery } from 'src/utils/speech.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let repository: SpeechRepository;
let operations: MediaOperationRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  repository = new SpeechRepository(db);
  operations = new MediaOperationRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});
afterEach(async () => {
  await db.deleteFrom('media_operation').execute();
});
const fingerprint = 'a'.repeat(64);
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const auth = factory.auth({ user: { id: user.id } });
  const settings = {
    expectedGeneration: null,
    enabled: true,
    scope: 'library' as const,
    albumIds: [],
    destinationId: randomUUID(),
  };
  const saved = await repository.configure(user.id, settings);
  await repository.setModel(user.id, saved.generation, fingerprint);
  const asset = async (extra = {}) => (await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, ...extra })).asset;
  const search = (query = 'hello', extra = {}) =>
    repository.search(auth, { query, size: 25, ...extra }, speechQuery(query));
  return { ctx, user, auth, settings: { ...settings, expectedGeneration: saved.generation }, asset, search };
};
const claim = () =>
  operations.claimNext({ kinds: [MediaOperationKind.SpeechTranscription], workerId: 'speech-test', leaseMs: 60_000 });
const complete = async (words = ['hello', 'world']) => {
  const held = (await claim())!;
  expect(held).toBeDefined();
  expect(
    await repository.saveChunk(
      held.operation,
      held.claimToken,
      0,
      words.map((text, i) => ({ text, startMs: i * 100, endMs: i * 100 + 90 })),
      'whisper-small',
      'en',
    ),
  ).toBe(true);
  expect(await operations.beginValidation(held.operation.id, held.claimToken, true)).toBe(true);
  expect(await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en')).toBe(true);
  return held;
};

it('completes system IntegrityDeleteReports and invalidates the real speech owners without an empty UUID query', async () => {
  const owners = [await setup(), await setup()];
  const assets = [];
  for (const owner of [owners[0], owners[0], owners[1]]) {
    const asset = await owner.asset();
    assets.push(asset);
    await repository.reconcile(owner.user.id);
    await complete();
    expect((await owner.search()).total).toBeGreaterThan(0);
  }
  const { sut: integrity, ctx } = newMediumService(IntegrityService, {
    database: db,
    real: [AssetRepository, IntegrityRepository],
    mock: [LoggingRepository, EventRepository],
  });
  const websocket = { clientSend: vi.fn() };
  const speech = new SpeechService(
    repository,
    operations,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    { setContext: vi.fn() } as never,
    websocket as never,
  );
  ctx.getMock(EventRepository).emit.mockImplementation(async (name, ...args) => {
    if (name === 'AssetTrashAll') await speech.onAssetTrashAll(args[0] as { userId: string; assetIds: string[] });
  });
  const reports = await Promise.all(
    assets.map(async (asset) => {
      const report = await ctx
        .get(IntegrityRepository)
        .create({ assetId: asset.id, path: asset.originalPath, type: IntegrityReport.MissingFile });
      return { id: report.id, assetId: asset.id, path: asset.originalPath, fileAssetId: null };
    }),
  );
  await db
    .updateTable('speech_settings')
    .set({ cursor: randomUUID(), nextScanAt: new Date(Date.now() + 86_400_000) })
    .where(
      'ownerId',
      'in',
      owners.map(({ user }) => user.id),
    )
    .execute();
  await expect(integrity.handleDeleteIntegrityReports({ reports })).resolves.toBe(JobStatus.Success);
  expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetTrashAll', {
    assetIds: assets.map(({ id }) => id),
    userId: '',
  });
  expect(websocket.clientSend).toHaveBeenCalledTimes(2);
  for (const owner of owners) {
    expect(websocket.clientSend).toHaveBeenCalledWith('on_speech_index_change', owner.user.id);
    expect(await repository.settings(owner.user.id)).toMatchObject({ cursor: null });
    expect((await owner.search()).total).toBe(0);
    await repository.reconcile(owner.user.id);
  }
  expect(
    await db
      .selectFrom('integrity_report')
      .select('id')
      .where(
        'id',
        'in',
        reports.map(({ id }) => id),
      )
      .execute(),
  ).toEqual([]);
  // Trash hides retained transcripts; permanent asset deletion still cascades all stored quotes.
  const ids = assets.map(({ id }) => id);
  expect(await db.selectFrom('speech_transcript').select('assetId').where('assetId', 'in', ids).execute()).toHaveLength(
    3,
  );
  await db.deleteFrom('asset').where('id', 'in', ids).execute();
  for (const table of ['speech_transcript', 'speech_window', 'speech_checkpoint'] as const) {
    expect(await db.selectFrom(table).select('assetId').where('assetId', 'in', ids).execute()).toEqual([]);
  }
  websocket.clientSend.mockClear();
  await speech.onAssetTrashAll({ userId: owners[0].user.id, assetIds: [assets[0].id] });
  expect(websocket.clientSend).toHaveBeenCalledExactlyOnceWith('on_speech_index_change', owners[0].user.id);
  websocket.clientSend.mockClear();
  await expect(speech.onAssetTrashAll({ userId: '', assetIds: ids })).resolves.toBeUndefined();
  expect(websocket.clientSend).not.toHaveBeenCalled();
});

it('keeps staging private, publishes empty success, groups exact phrase hits and pages videos with an exact total', async () => {
  const f = await setup();
  for (let i = 0; i < 4; i++) await f.asset();
  await Promise.all([repository.reconcile(f.user.id), repository.reconcile(f.user.id)]);
  expect(await f.search()).toMatchObject({ total: 0, items: [] });
  await complete();
  await complete();
  await complete();
  await complete([]);
  const first = await f.search('"hello world"', { size: 2 });
  expect(first.total).toBe(3);
  expect(first.items).toHaveLength(2);
  expect(first.items[0].hits).toEqual([{ text: 'hello world', startMs: 0, endMs: 190 }]);
  const next = await f.search('"hello world"', { size: 2, cursor: first.nextCursor });
  expect(next.total).toBe(3);
  expect(next.items).toHaveLength(1);
  expect(next.nextCursor).toBeNull();
  expect(new Set([...first.items, ...next.items].map((i) => i.asset.id)).size).toBe(3);
  await expect(f.search('world', { cursor: first.nextCursor })).rejects.toThrow('Search changed');
  expect((await f.search('"world hello"')).total).toBe(0);
  expect(await repository.status(f.user.id)).toMatchObject({ indexed: 4, pending: 0 });
  await db.deleteFrom('media_operation').execute();
  expect(await repository.status(f.user.id)).toMatchObject({ indexed: 4 });
});

it('enforces live owner, Locked, trash, checksum and scope checks on results and publication', async () => {
  const f = await setup();
  const a = await f.asset();
  await repository.reconcile(f.user.id);
  await complete();
  expect((await f.search()).total).toBe(1);
  await db
    .insertInto('asset_lock')
    .values({ assetId: a.id, reason: AssetLockReason.Marked, lockedBy: f.user.id, previousVisibility: null })
    .execute();
  expect((await f.search()).total).toBe(0);
  await db.deleteFrom('asset_lock').where('assetId', '=', a.id).execute();
  await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', a.id).execute();
  expect((await f.search()).total).toBe(0);
  await db
    .updateTable('asset')
    .set({ deletedAt: null, checksum: Buffer.from('different') })
    .where('id', '=', a.id)
    .execute();
  expect((await f.search()).total).toBe(0);
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await repository.configure(f.user.id, { ...f.settings, enabled: false });
  expect(await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en')).toBe(false);
  expect((await f.search()).total).toBe(0);
});

it('fences purge against stale chunks and publication and never resurrects purged data', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    0,
    [{ text: 'secret', startMs: 0, endMs: 100 }],
    'whisper-small',
    'en',
  );
  await repository.configure(f.user.id, { ...f.settings, enabled: false }, true);
  expect(await repository.saveChunk(held.operation, held.claimToken, 1, [], 'whisper-small', 'en')).toBe(false);
  expect(await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en')).toBe(false);
  expect(await db.selectFrom('speech_transcript').selectAll().where('ownerId', '=', f.user.id).execute()).toEqual([]);
  expect(await repository.settings(f.user.id)).toMatchObject({ enabled: false });
});

it('requires actual album ownership and live membership, not editor access', async () => {
  const f = await setup();
  const { user: other } = await f.ctx.newUser();
  const { album } = await f.ctx.newAlbum({ ownerId: other.id });
  await expect(
    repository.configure(f.user.id, { ...f.settings, scope: 'albums', albumIds: [album.id] }),
  ).rejects.toThrow('albums you own');
  const { album: own } = await f.ctx.newAlbum({ ownerId: f.user.id });
  const a = await f.asset();
  await db.insertInto('album_asset').values({ albumId: own.id, assetId: a.id }).execute();
  const saved = await repository.configure(f.user.id, { ...f.settings, scope: 'albums', albumIds: [own.id] });
  await repository.setModel(f.user.id, saved.generation, fingerprint);
  await repository.reconcile(f.user.id);
  await complete();
  expect((await f.search()).total).toBe(1);
  await db.deleteFrom('album_asset').where('albumId', '=', own.id).where('assetId', '=', a.id).execute();
  expect((await f.search()).total).toBe(0);
});

it('resumes chunk checkpoints with cross-chunk phrases and rejects expired claims', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    0,
    [{ text: 'hello', startMs: 299_900, endMs: 300_000 }],
    'whisper-small',
    'en',
  );
  expect(await repository.checkpoint(held.operation.id)).toMatchObject({ nextChunk: 1 });
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    1,
    [{ text: 'world', startMs: 300_010, endMs: 300_100 }],
    'whisper-small',
    'en',
  );
  await operations.beginValidation(held.operation.id, held.claimToken, true);
  expect(await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en')).toBe(true);
  expect((await f.search('"hello world"')).items[0].hits[0]).toMatchObject({ startMs: 299_900, endMs: 300_100 });
  await f.asset();
  await repository.reconcile(f.user.id);
  const expired = (await claim())!;
  await db
    .updateTable('media_operation')
    .set({ claimExpiresAt: sql<Date>`now()-interval '1 second'` })
    .where('id', '=', expired.operation.id)
    .execute();
  expect(await repository.saveChunk(expired.operation, expired.claimToken, 0, [], 'whisper-small', 'en')).toBe(false);
  expect(await repository.publish(expired.operation, expired.claimToken, 'whisper-small', 'en')).toBe(false);
});

it('CAS rejects a late widening PUT and stale purge after a newer disable', async () => {
  const f = await setup();
  const disabled = await repository.configure(f.user.id, { ...f.settings, enabled: false });
  await expect(repository.configure(f.user.id, f.settings)).rejects.toThrow('Speech settings changed');
  await expect(
    repository.configure(f.user.id, { expectedGeneration: f.settings.expectedGeneration }, true),
  ).rejects.toThrow('Speech settings changed');
  const writes = await Promise.allSettled([
    repository.configure(f.user.id, { ...f.settings, expectedGeneration: disabled.generation, enabled: true }),
    repository.configure(f.user.id, { ...f.settings, expectedGeneration: disabled.generation, enabled: false }),
  ]);
  expect(writes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(writes.filter((r) => r.status === 'rejected')).toHaveLength(1);
});

it('traverses every repeated occurrence beyond 100 windows with no duplicate overlap and rejects old generations', async () => {
  const f = await setup();
  const a = await f.asset();
  await repository.reconcile(f.user.id);
  await complete(Array.from({ length: 7000 }, () => 'hello'));
  let page = await f.search('hello', { assetId: a.id });
  expect(page.items[0].hitsTotal).toBe(7000);
  const seen = new Set<number>();
  // Take the first two pages and a signed server cursor near the tail via real traversal.
  for (let i = 0; i < 350; i++) {
    const item = page.items[0];
    for (const hit of item.hits) {
      expect(seen.has(hit.startMs)).toBe(false);
      seen.add(hit.startMs);
    }
    if (!item.nextHitCursor) break;
    page = await f.search('hello', { assetId: a.id, hitCursor: item.nextHitCursor });
  }
  expect(seen.size).toBe(7000);
  expect(seen.has(699_900)).toBe(true);
  const first = await f.search('hello', { assetId: a.id });
  await repository.configure(f.user.id, { ...f.settings, enabled: true });
  await expect(f.search('hello', { assetId: a.id, hitCursor: first.items[0].nextHitCursor })).rejects.toThrow(
    'Search changed',
  );
}, 120_000);

it('rejects malformed video UUIDs and bounded occurrence cursors with controlled 400 responses', async () => {
  const f = await setup();
  await f.asset();
  await f.asset();
  await repository.reconcile(f.user.id);
  await complete(Array.from({ length: 21 }, () => 'hello'));
  await complete(Array.from({ length: 21 }, () => 'hello'));
  const first = await f.search('hello', { size: 1 });
  const alter = (cursor: string, fields: object) =>
    Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(cursor, 'base64url').toString()),
        ...fields,
      }),
    ).toString('base64url');
  await expect(
    f.search('hello', { size: 1, cursor: alter(first.nextCursor!, { after: '-'.repeat(36) }) }),
  ).rejects.toMatchObject({ status: 400, message: 'Invalid video cursor' });
  const item = first.items[0];
  for (const fields of [
    { transcriptId: '-'.repeat(36) },
    { assetId: '-'.repeat(36) },
    { startMs: -1 },
    { startMs: 1.5 },
    { endMs: Number.MAX_SAFE_INTEGER + 1 },
    { startMs: 3, endMs: 2 },
  ]) {
    await expect(
      f.search('hello', { size: 1, assetId: item.asset.id, hitCursor: alter(item.nextHitCursor!, fields) }),
    ).rejects.toMatchObject({ status: 400, message: 'Invalid occurrence cursor' });
  }
});

it('returns typed stale-cursor conflict after disable for both cursor kinds', async () => {
  const f = await setup();
  await f.asset();
  await f.asset();
  await repository.reconcile(f.user.id);
  await complete(Array.from({ length: 25 }, () => 'hello'));
  await complete();
  const first = await f.search('hello', { size: 1 });
  await repository.configure(f.user.id, { ...f.settings, enabled: false });
  for (const extra of [
    { cursor: first.nextCursor },
    { assetId: first.items[0].asset.id, hitCursor: first.items[0].nextHitCursor ?? first.nextCursor },
  ]) {
    try {
      await f.search('hello', extra);
      throw new Error('Expected conflict');
    } catch (error) {
      expect((error as { getResponse: () => unknown }).getResponse()).toMatchObject({
        statusCode: 409,
        code: 'speech_cursor_stale',
      });
    }
  }
  expect((await f.search()).total).toBe(0);
});

it('rechecks suppression and ownership without trusting captured authentication filters', async () => {
  const f = await setup();
  const a = await f.asset();
  await repository.reconcile(f.user.id);
  await complete();
  const { tag } = await f.ctx.newTag({ userId: f.user.id, value: 'private' });
  await f.ctx.newTagAsset({ tagIds: [tag.id], assetIds: [a.id] });
  await db
    .insertInto('user_metadata')
    .values({
      userId: f.user.id,
      key: UserMetadataKey.Preferences,
      value: { privacy: { suppression: { tagIds: [tag.id], personIds: [], petIds: [], scope: 'owned' } } },
    })
    .execute();
  expect((await f.search()).total).toBe(0);
  expect(await repository.status(f.user.id)).toMatchObject({ indexed: 0 });
  await db.deleteFrom('user_metadata').where('userId', '=', f.user.id).execute();
  expect((await f.search()).total).toBe(1);
  const { user: other } = await f.ctx.newUser();
  await db.updateTable('asset').set({ ownerId: other.id }).where('id', '=', a.id).execute();
  expect((await f.search()).total).toBe(0);
});

it('serializes purge racing publication so no completed or staged text survives', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    0,
    [{ text: 'hello', startMs: 0, endMs: 100 }],
    'whisper-small',
    'en',
  );
  await operations.beginValidation(held.operation.id, held.claimToken, true);
  await Promise.all([
    repository.publish(held.operation, held.claimToken, 'whisper-small', 'en'),
    repository.configure(f.user.id, { expectedGeneration: f.settings.expectedGeneration }, true),
  ]);
  expect((await f.search()).total).toBe(0);
  expect(
    await db.selectFrom('speech_window').selectAll().where('operationId', '=', held.operation.id).execute(),
  ).toEqual([]);
  expect(
    await db.selectFrom('speech_checkpoint').selectAll().where('operationId', '=', held.operation.id).execute(),
  ).toEqual([]);
});

it.each(['chunk', 'publication'] as const)(
  'serializes first preferences insertion against %s in both lock orders',
  async (stage) => {
    const database = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
    for (const writerFirst of [true, false]) {
      const f = await setup();
      const asset = await f.asset();
      const { tag } = await f.ctx.newTag({ userId: f.user.id, value: 'private' });
      await f.ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
      expect(await db.selectFrom('user_metadata').selectAll().where('userId', '=', f.user.id).execute()).toEqual([]);
      await repository.reconcile(f.user.id);
      const held = (await claim())!;
      const save = () =>
        repository.saveChunk(
          held.operation,
          held.claimToken,
          0,
          [{ text: 'hello', startMs: 0, endMs: 100 }],
          'whisper-small',
          'en',
        );
      if (stage === 'publication') {
        expect(await save()).toBe(true);
        await operations.beginValidation(held.operation.id, held.claimToken, true);
      }
      const publish =
        stage === 'chunk' ? save : () => repository.publish(held.operation, held.claimToken, 'whisper-small', 'en');
      const entered = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const source = repository.source.bind(repository);
      const spy = vi.spyOn(repository, 'source').mockImplementation(async (...args) => {
        const result = await source(...args);
        if (!writerFirst) {
          const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(args[2]!);
          entered.resolve(rows[0].pid);
          await release.promise;
        }
        return result;
      });
      const write = () =>
        database.withUserPreferencesLock(f.user.id, async (tx) => {
          await tx
            .insertInto('user_metadata')
            .values({
              userId: f.user.id,
              key: UserMetadataKey.Preferences,
              value: { privacy: { suppression: { tagIds: [tag.id], personIds: [], petIds: [], scope: 'owned' } } },
            })
            .execute();
          if (writerFirst) {
            const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
            entered.resolve(rows[0].pid);
            await release.promise;
          }
        });
      const first = writerFirst ? write() : publish();
      const blocker = await entered.promise;
      const second = writerFirst ? publish() : write();
      try {
        // Observe PostgreSQL's real lock wait, rather than infer serialization from a timer.
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ blocked: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))
          ) AS blocked`.execute(db);
            expect(rows[0].blocked).toBe(true);
          },
          { timeout: 2000 },
        );
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        spy.mockRestore();
      }
      await Promise.all([first, second]);
      expect(await (writerFirst ? second : first)).toBe(!writerFirst);
      expect((await f.search()).total).toBe(0);
      if (stage === 'chunk') {
        // No checkpoint may be created after the privacy writer wins.
        const rows = await db
          .selectFrom('speech_checkpoint')
          .selectAll()
          .where('operationId', '=', held.operation.id)
          .execute();
        expect(rows).toHaveLength(writerFirst ? 0 : 1);
      } else {
        const row = await db
          .selectFrom('speech_transcript')
          .select('completedAt')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow();
        expect(row.completedAt !== null).toBe(!writerFirst);
      }
      await db.deleteFrom('media_operation').execute();
    }
  },
);

it('rejects stale model identities and makes explicit retry create a newly fenced operation', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await operations.fail(
    held.operation.id,
    held.claimToken,
    { errorCode: 'speech_failed', error: 'synthetic' },
    { retry: false },
  );
  await repository.retry(f.user.id, f.settings.expectedGeneration);
  await repository.reconcile(f.user.id);
  const retry = (await claim())!;
  expect(retry.operation.id).not.toBe(held.operation.id);
  expect(await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en')).toBe(false);
  await repository.setModel(f.user.id, f.settings.expectedGeneration, 'b'.repeat(64));
  expect(await repository.saveChunk(retry.operation, retry.claimToken, 0, [], 'whisper-small', 'en')).toBe(false);
});

it('finds smart-quoted phrases and CJK input across ASR word and checkpoint boundaries', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    0,
    [{ text: '北', startMs: 299_900, endMs: 300_000 }],
    'whisper-small',
    'zh',
  );
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    1,
    [
      { text: '京', startMs: 300_010, endMs: 300_100 },
      { text: 'hello', startMs: 300_200, endMs: 300_300 },
      { text: 'world', startMs: 300_400, endMs: 300_500 },
    ],
    'whisper-small',
    'zh',
  );
  await operations.beginValidation(held.operation.id, held.claimToken, true);
  await repository.publish(held.operation, held.claimToken, 'whisper-small', 'zh');
  expect((await f.search('北京')).items[0].hits[0]).toMatchObject({
    text: '北京 hello world',
    startMs: 299_900,
    endMs: 300_100,
  });
  expect((await f.search('京北')).total).toBe(0);
  expect((await f.search('“hello world”')).total).toBe(1);
  expect((await f.search('“world hello”')).total).toBe(0);
});

it('retains late positions beyond PostgreSQL limits and enforces actual UTF-8 lexeme bounds', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  await complete(Array.from({ length: 17_000 }, (_, i) => (i === 16_447 ? 'late' : i === 16_448 ? 'marker' : 'again')));
  expect((await f.search('"late marker"')).items[0].hits[0]).toMatchObject({ startMs: 1_644_700, endMs: 1_644_890 });
  const g = await setup();
  await g.asset();
  await repository.reconcile(g.user.id);
  await complete(['é'.repeat(1023)]);
  expect((await g.search('é'.repeat(1023))).total).toBe(1);
  expect(() => speechQuery('é'.repeat(1024))).toThrow('64 words');
});

it('disables and fences active work after scope ownership is revoked', async () => {
  const f = await setup();
  const { album } = await f.ctx.newAlbum({ ownerId: f.user.id });
  const saved = await repository.configure(f.user.id, { ...f.settings, scope: 'albums', albumIds: [album.id] });
  const asset = await f.asset();
  await db.insertInto('album_asset').values({ albumId: album.id, assetId: asset.id }).execute();
  await repository.setModel(f.user.id, saved.generation, fingerprint);
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await db.deleteFrom('album_user').where('albumId', '=', album.id).execute();
  const disabled = await repository.configure(f.user.id, {
    ...f.settings,
    enabled: false,
    scope: 'albums',
    albumIds: [album.id],
    expectedGeneration: saved.generation,
  });
  expect(disabled.enabled).toBe(false);
  expect(await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en')).toBe(false);
  expect((await operations.getForWorker(held.operation.id))?.status).toBe('cancelling');
  expect(disabled.generation).not.toBe(saved.generation);
  await expect(
    repository.configure(f.user.id, {
      ...f.settings,
      scope: 'albums',
      albumIds: [album.id],
      expectedGeneration: disabled.generation,
    }),
  ).rejects.toThrow('albums you own');
});

it('retries an incomplete transcript after operation retention removes its terminal job', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await operations.fail(
    held.operation.id,
    held.claimToken,
    { errorCode: 'speech_failed', error: 'synthetic' },
    { retry: false },
  );
  await db.deleteFrom('media_operation').where('id', '=', held.operation.id).execute();
  await repository.retry(f.user.id, f.settings.expectedGeneration);
  await repository.reconcile(f.user.id);
  expect((await claim())?.operation.id).toBeDefined();
});

it('rejects occurrence continuation after the completed transcript is replaced', async () => {
  const f = await setup();
  const asset = await f.asset();
  await repository.reconcile(f.user.id);
  await complete(Array.from({ length: 25 }, () => 'hello'));
  const before = (await f.search()).items[0];
  expect(before.nextHitCursor).toBeTruthy();
  await db
    .updateTable('asset')
    .set({ checksum: Buffer.from(randomUUID()) })
    .where('id', '=', asset.id)
    .execute();
  await repository.wake(f.user.id);
  await repository.reconcile(f.user.id);
  await complete(Array.from({ length: 25 }, () => 'hello'));
  await expect(f.search('hello', { assetId: asset.id, hitCursor: before.nextHitCursor })).rejects.toMatchObject({
    response: { code: 'speech_cursor_stale' },
  });
});

it('keeps a boundary phrase when ASR emits standalone punctuation between its words', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const held = (await claim())!;
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    0,
    [
      { text: 'hello', startMs: 0, endMs: 100 },
      ...Array.from({ length: 65 }, (_, i) => ({ text: '.', startMs: 101 + i, endMs: 102 + i })),
    ],
    'whisper-small',
    'en',
  );
  await repository.saveChunk(
    held.operation,
    held.claimToken,
    1,
    [{ text: ' world', startMs: 200, endMs: 300 }],
    'whisper-small',
    'en',
  );
  await operations.beginValidation(held.operation.id, held.claimToken, true);
  await repository.publish(held.operation, held.claimToken, 'whisper-small', 'en');
  expect((await f.search('"hello world"')).total).toBe(1);
});

it('retains a checkpoint and its attempt budget across capacity requeue', async () => {
  const f = await setup();
  await f.asset();
  await repository.reconcile(f.user.id);
  const first = (await claim())!;
  await repository.saveChunk(
    first.operation,
    first.claimToken,
    0,
    [{ text: 'hello', startMs: 0, endMs: 100 }],
    'whisper-small',
    'en',
  );
  expect(
    await operations.requeue(first.operation.id, first.claimToken, {
      delayMs: 0,
      returnAttempt: true,
      requireActiveClaim: true,
    }),
  ).toBe(true);
  await repository.cleanup();
  expect(await repository.checkpoint(first.operation.id)).toMatchObject({ nextChunk: 1 });
  const resumed = (await claim())!;
  expect(resumed.operation.id).toBe(first.operation.id);
  expect(resumed.operation.attempt).toBe(first.operation.attempt);
  expect(await repository.saveChunk(first.operation, first.claimToken, 1, [], 'whisper-small', 'en')).toBe(false);
  await repository.saveChunk(
    resumed.operation,
    resumed.claimToken,
    1,
    [{ text: ' world', startMs: 101, endMs: 200 }],
    'whisper-small',
    'en',
  );
  await operations.beginValidation(resumed.operation.id, resumed.claimToken, true);
  expect(await repository.publish(resumed.operation, resumed.claimToken, 'whisper-small', 'en')).toBe(true);
  expect((await f.search('"hello world"')).total).toBe(1);
});
