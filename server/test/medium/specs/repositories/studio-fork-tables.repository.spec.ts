import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Fork tables 181 (FL-95 render worker session capabilities) and 182 (FL-91 Studio workspace
 * layout) and 207 (FL-111 generated media): they match the private catalog, roll back without touching the official catalog, and
 * store what the repositories write.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const catalog = manifest as unknown as Record<string, Array<{ identity: string }>>;

describe.each([
  ['public.render_worker_session_capability', capabilities],
  ['public.studio_workspace_layout', workspace],
  ['public.studio_generated_resource', generated],
  ['public.studio_project_import', imports],
  ['public.studio_hdr_intermediate', hdrIntermediates],
])('%s', (table, migration) => {
  const owned = (entry: { identity: string }) => entry.identity === table || entry.identity.startsWith(`${table}.`);

  it('installs feature tables in the real canonical baseline', async () => {
    await expectCanonicalTables(db, [
      'render_worker_session_capability',
      'studio_workspace_layout',
      'studio_generated_resource',
      'studio_project_import',
      'studio_hdr_intermediate',
    ]);
  });
});

it('binds what a render worker session proved to that session (FL-95)', async () => {
  const sut = new RenderWorkerRepository(db);
  const sessionId = randomUUID();
  await expect(sut.getSessionCapabilities(sessionId)).resolves.toBeUndefined();

  await sut.recordSessionCapabilities(sessionId, {
    codecs: ['hevc_nvenc', String.raw`weird "name"\x`],
    formats: ['mp4'],
  });
  await expect(sut.getSessionCapabilities(sessionId)).resolves.toEqual({
    codecs: ['hevc_nvenc', String.raw`weird "name"\x`],
    formats: ['mp4'],
  });
});

it("keeps each account's workspace layout byte for byte and removes it with the account (FL-91)", async () => {
  const sut = new StudioProjectRepository(db);
  const ada = randomUUID();
  const grace = randomUUID();
  const layout = { panels: { bin: { open: true, width: 280 } }, zoom: 1.5, future: [null, { nested: 'kept' }] };

  await expect(sut.getWorkspace(ada)).resolves.toBeUndefined();
  await sut.saveWorkspace(ada, layout, 'rev-1');
  await sut.saveWorkspace(grace, { panels: {} }, 'rev-1');
  await sut.saveWorkspace(ada, { ...layout, zoom: 2 }, 'rev-2');

  await expect(sut.getWorkspace(ada)).resolves.toEqual(
    expect.objectContaining({ layout: { ...layout, zoom: 2 }, engineRevision: 'rev-2' }),
  );
  await sut.deleteWorkspace(ada);
  await expect(sut.getWorkspace(ada)).resolves.toBeUndefined();
  await expect(sut.getWorkspace(grace)).resolves.toEqual(expect.objectContaining({ layout: { panels: {} } }));
});
