import { CompiledQuery, sql } from 'kysely';
import { MediaHealthCategory, MediaHealthSeverity, MediaHealthStatus } from 'src/enum.js';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { SyncService } from 'src/services/sync.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

it('writes a lost original problem once, shaped like a file check made it, and leaves an existing one alone', async () => {
  const db = await getKyselyDB('media_health_import_problems');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const sut = new MediaHealthRepository(db);
    const lostPath = (name: string) => `/target/library/${user.id}/${name}`;
    const moved = (await ctx.newAsset({ ownerId: user.id, originalPath: lostPath('moved.jpg') })).asset;
    const plain = (await ctx.newAsset({ ownerId: user.id, originalPath: lostPath('plain.jpg') })).asset;
    const known = (await ctx.newAsset({ ownerId: user.id, originalPath: lostPath('known.jpg') })).asset;
    const byCheck = (await ctx.newAsset({ ownerId: user.id, originalPath: lostPath('check.jpg') })).asset;
    for (const asset of [moved, plain, known, byCheck]) {
      await sql`UPDATE asset SET "originalFileName"=${asset.originalPath.split('/').pop()!} WHERE id=${asset.id}::uuid`.execute(
        db,
      );
    }
    // a problem the person already had open, and one the file check made, with the fields scanAsset writes
    const checkFields = {
      category: MediaHealthCategory.Missing,
      status: MediaHealthStatus.Missing,
      severity: MediaHealthSeverity.Critical,
      evidence: { reason: 'source_file_missing_or_unreadable' },
      resolution: { autoRelinkable: false },
      checkedAt: new Date(),
    };
    await sut.upsertFinding({
      ...checkFields,
      assetId: known.id,
      originalPath: known.originalPath,
      originalFileName: 'known.jpg',
      runId: null,
    });
    const made = await sut.upsertFinding({
      ...checkFields,
      assetId: byCheck.id,
      originalPath: byCheck.originalPath,
      originalFileName: 'check.jpg',
      runId: null,
      steps: [{ step: 'not-on-drive', outcome: 'failed', facts: {} }],
    });

    const destination: ImportDatabase = {
      query: async (statement, parameters = []) =>
        (await db.executeQuery(CompiledQuery.raw(statement, parameters as unknown[]))).rows as never,
      transaction: (body) => body(destination),
    };
    const source: ImportDatabase = {
      query: (statement) =>
        Promise.resolve(
          statement.includes('to_regclass')
            ? [{ present: true }]
            : [{ entityId: moved.id, newPath: `/source/library/${user.id}/2021/07/moved.jpg` }],
        ),
      transaction: (body) => body(source),
    };
    const importer = new ImmichImportService(destination, source, {
      version: '3.2.4',
      sourceId: 'source-library',
      writersStopped: true,
      mediaRoots: [{ source: '/source', target: '/target' }],
    });
    const lost = (importer as unknown as { lostOriginals: Map<string, unknown> }).lostOriginals;
    for (const asset of [moved, plain, known]) {
      lost.set(asset.id, { reason: 'missing', immichPath: asset.originalPath.replace('/target', '/source') });
    }
    const record = () =>
      (importer as unknown as { recordLostOriginalProblems(): Promise<void> }).recordLostOriginalProblems();

    await record();
    await record();

    const count = async (table: string) =>
      Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db)).rows[0].n);
    // moved + plain are new, known and the check's were there before; the second run added nothing
    expect(await count('asset_health')).toBe(4);
    expect(await count('asset_health_step')).toBe(2 + 1 + 1);

    const stepsOf = async (assetId: string) => {
      const [finding] = await sut.getFindingsForAsset(assetId);
      return (await sut.listSteps(finding.id)).map(({ step, outcome, facts }) => ({ step, outcome, facts }));
    };
    expect(await stepsOf(moved.id)).toEqual([
      {
        step: 'imported',
        outcome: 'failed',
        facts: { source: 'Immich', sourcePath: 'moved.jpg', intendedPath: '2021/07/moved.jpg' },
      },
      { step: 'looked-where-moving', outcome: 'not-found', facts: { folder: '2021/07', name: 'moved.jpg' } },
    ]);
    expect(await stepsOf(plain.id)).toEqual([
      { step: 'imported', outcome: 'failed', facts: { source: 'Immich', sourcePath: 'plain.jpg' } },
    ]);
    // the finding that was already there gets no steps
    expect(await stepsOf(known.id)).toEqual([]);

    // it reads like the check's finding: same fields, the import's own marks as extra evidence
    const [imported] = await sut.getFindingsForAsset(plain.id);
    expect(imported).toMatchObject({
      category: made!.category,
      status: made!.status,
      severity: made!.severity,
      runId: made!.runId,
      resolution: made!.resolution,
      originalPath: plain.originalPath,
      originalFileName: 'plain.jpg',
      dismissedAt: null,
      resolvedAt: null,
      evidence: { ...(made!.evidence as object), source: 'import', lostReason: 'missing' },
    });
    expect(imported.evidence).not.toHaveProperty('fixState');

    const needs = await sut.listFileProblems({ tab: 'needs', ownerId: user.id, privacy: {}, take: 50, skip: 0 });
    expect(needs.map(({ assetId }) => assetId).sort()).toEqual([moved.id, plain.id, known.id, byCheck.id].sort());
    const row = needs.find(({ assetId }) => assetId === plain.id);
    expect(row).toMatchObject({ category: made!.category, status: made!.status });
  } finally {
    await db.destroy();
  }
});
