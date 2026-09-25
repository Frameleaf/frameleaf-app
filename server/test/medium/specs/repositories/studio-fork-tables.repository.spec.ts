import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as capabilities from 'src/fork-schema/migrations/0000000000181-RenderWorkerSessionCapabilities.js';
import * as workspace from 'src/fork-schema/migrations/0000000000182-StudioWorkspaceLayout.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Fork tables 181 (FL-95 render worker session capabilities) and 182 (FL-91 Studio workspace
 * layout): they match the private catalog, roll back without touching the official catalog, and
 * store what the repositories write.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});

const catalog = manifest as unknown as Record<string, Array<{ identity: string }>>;

describe.each([
  ['immich_fork.render_worker_session_capability', capabilities],
  ['immich_fork.studio_workspace_layout', workspace],
])('%s', (table, migration) => {
  const owned = (entry: { identity: string }) => entry.identity === table || entry.identity.startsWith(`${table}.`);

  it('matches the private catalog and rolls back without modifying the official catalog', async () => {
    const before = await getCatalogEvidence(db);
    for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
      expect(before[kind].filter((entry) => owned(entry))).toEqual(catalog[kind].filter((entry) => owned(entry)));
    }
    expect(before.tables.filter((entry) => owned(entry))).toHaveLength(1);

    await migration.down(db);
    await migration.up(db);
    const after = await getCatalogEvidence(db);
    for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
      expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
        before[kind].filter((entry) => entry.identity.startsWith('public.')),
      );
    }
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
