import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { expectCanonicalTables, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

/** Studio feature storage shares the canonical database and preserves account/session isolation. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

afterAll(async () => db?.destroy());

it('installs Studio feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, [
    'render_worker_session_capability',
    'studio_workspace_layout',
    'studio_generated_resource',
    'studio_project_import',
    'studio_hdr_intermediate',
  ]);
});

it('binds what a render worker session proved to that session (FL-95)', async () => {
  const sut = new RenderWorkerRepository(db);
  const worker = await sut.createWorker({
    name: `fixture-${randomUUID()}`,
    destination: MediaOperationDestination.Lan,
    kinds: [MediaOperationKind.StudioExport],
    enrolmentSecret: randomBytes(32),
    engineDigest: 'sha256:fixture-engine',
    conformanceMaxAgeMs: 60_000,
    maxConcurrentOperations: 1,
    maxWallClockMs: null,
    maxOutputBytes: null,
    gpuMemoryBytes: null,
    createdBy: null,
  });
  const session = await sut.createSession({
    workerId: worker.id,
    token: randomBytes(32),
    scopes: [MediaOperationKind.StudioExport],
    gpuMemoryBytes: null,
    engineDigest: 'sha256:fixture-engine',
    conformanceReportedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  const sessionId = session.id;
  await expect(sut.getSessionCapabilities(sessionId)).resolves.toBeUndefined();

  await sut.recordSessionCapabilities(sessionId, {
    codecs: ['hevc_nvenc', String.raw`weird "name"\x`],
    formats: ['mp4'],
  });
  await expect(sut.getSessionCapabilities(sessionId)).resolves.toEqual({
    codecs: ['hevc_nvenc', String.raw`weird "name"\x`],
    formats: ['mp4'],
  });
  const other = await sut.createSession({
    workerId: worker.id,
    token: randomBytes(32),
    scopes: [MediaOperationKind.StudioExport],
    gpuMemoryBytes: null,
    engineDigest: 'sha256:fixture-engine',
    conformanceReportedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  await expect(sut.getSessionCapabilities(other.id)).resolves.toBeUndefined();
  await sut.recordSessionCapabilities(other.id, { codecs: ['av1'], formats: ['webm'] });
  await sut.recordSessionCapabilities(sessionId, { codecs: ['h264'], formats: ['mp4'] });
  await expect(sut.getSessionCapabilities(sessionId)).resolves.toEqual({ codecs: ['h264'], formats: ['mp4'] });
  await expect(sut.getSessionCapabilities(other.id)).resolves.toEqual({ codecs: ['av1'], formats: ['webm'] });
});

it("keeps each account's workspace layout byte for byte and removes it with the account (FL-91)", async () => {
  const sut = new StudioProjectRepository(db);
  const ada = (await seedCanonicalUser(db)).id;
  const grace = (await seedCanonicalUser(db)).id;
  const layout = { panels: { bin: { open: true, width: 280 } }, zoom: 1.5, future: [null, { nested: 'kept' }] };

  await expect(sut.getWorkspace(ada)).resolves.toBeUndefined();
  await sut.saveWorkspace(ada, layout, 'rev-1');
  await sut.saveWorkspace(grace, { panels: {} }, 'rev-1');
  await sut.saveWorkspace(ada, { ...layout, zoom: 2 }, 'rev-2');

  await expect(sut.getWorkspace(ada)).resolves.toEqual(
    expect.objectContaining({ layout: { ...layout, zoom: 2 }, engineRevision: 'rev-2' }),
  );
  await expect(sut.getWorkspace(grace)).resolves.toEqual(
    expect.objectContaining({ layout: { panels: {} }, engineRevision: 'rev-1' }),
  );
  await sut.deleteWorkspace(ada);
  await expect(sut.getWorkspace(ada)).resolves.toBeUndefined();
  await expect(sut.getWorkspace(grace)).resolves.toEqual(expect.objectContaining({ layout: { panels: {} } }));
});
