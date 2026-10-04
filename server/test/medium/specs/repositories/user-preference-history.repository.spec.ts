import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { USER_PREFERENCE_HISTORY_LIMIT, UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-71 (CC-10): an account's own preference history, a fork-owned table. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, [
    'user_preference_history',
    'recipient_group',
    'studio_workspace_layout',
    'memory_show_less',
    'memory_curation',
    'face_correction',
    'person_merge_verdict',
    'pet_recognition_run',
  ]);
});

it("keeps each account's own history, newest first, within its limit", async () => {
  const sut = new UserRepository(db);
  const ada = randomUUID();
  const grace = randomUUID();

  for (let index = 0; index < USER_PREFERENCE_HISTORY_LIMIT + 3; index++) {
    await sut.addPreferenceHistory({
      userId: ada,
      deviceLabel: 'macOS · Web',
      changes: [{ path: 'memories.enabled', before: 'true', after: String(index) }],
      omittedChanges: 0,
    });
  }
  await sut.addPreferenceHistory({
    userId: grace,
    deviceLabel: null,
    changes: [{ path: 'privacy.suppression', before: null, after: null, protected: true }],
    omittedChanges: 2,
  });

  const history = await sut.getPreferenceHistory(ada);
  expect(history).toHaveLength(USER_PREFERENCE_HISTORY_LIMIT);
  expect(history[0]).toEqual(
    expect.objectContaining({
      deviceLabel: 'macOS · Web',
      changes: [{ path: 'memories.enabled', before: 'true', after: String(USER_PREFERENCE_HISTORY_LIMIT + 2) }],
      omittedChanges: 0,
    }),
  );
  const { rows } = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM public.user_preference_history WHERE "userId" = ${ada}::uuid
  `.execute(db);
  expect(rows[0].count).toBe(USER_PREFERENCE_HISTORY_LIMIT);

  await expect(sut.getPreferenceHistory(grace)).resolves.toEqual([
    expect.objectContaining({
      deviceLabel: null,
      changes: [{ path: 'privacy.suppression', before: null, after: null, protected: true }],
      omittedChanges: 2,
    }),
  ]);
  await expect(sut.getPreferenceHistory(randomUUID())).resolves.toEqual([]);
});

it('refuses changes that are not a list', async () => {
  await expect(
    sql`INSERT INTO public.user_preference_history ("userId", changes) VALUES (${randomUUID()}::uuid, '{}'::jsonb)`.execute(
      db,
    ),
  ).rejects.toThrow();
});

it('forgets a deleted account’s history and leaves everyone else’s,', async () => {
  const sut = new UserRepository(db);
  const gone = randomUUID();
  const kept = randomUUID();
  const change = { path: 'tags.enabled', before: 'false', after: 'true' };
  for (const userId of [gone, kept]) {
    await sut.addPreferenceHistory({ userId, deviceLabel: null, changes: [change], omittedChanges: 0 });
  }

  await sut.deletePreferenceHistory(gone);

  await expect(sut.getPreferenceHistory(gone)).resolves.toEqual([]);
  await expect(sut.getPreferenceHistory(kept)).resolves.toHaveLength(1);
});

it('sweeps fork rows of accounts that no longer exist, only while the fork schema is writable', async () => {
  const sut = new UserRepository(db);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user: kept } = await ctx.newUser();
  const removed = randomUUID();
  const change = { path: 'tags.enabled', before: 'false', after: 'true' };
  for (const userId of [kept.id, removed]) {
    await sut.addPreferenceHistory({ userId, deviceLabel: null, changes: [change], omittedChanges: 0 });
  }
  const orphanGroup = await sql<{ id: string }>`
    INSERT INTO public.recipient_group ("ownerId", name, "userIds") VALUES (${removed}::uuid, 'Gone', '{}')
    RETURNING id::text AS id
  `.execute(db);
  const keptGroup = await sql<{ id: string }>`
    INSERT INTO public.recipient_group ("ownerId", name, "userIds")
    VALUES (${kept.id}::uuid, 'Family', ARRAY[${kept.id}::uuid, ${removed}::uuid])
    RETURNING id::text AS id
  `.execute(db);
  // FL-91: Studio workspace layouts of a removed and a kept account.
  for (const userId of [removed, kept.id]) {
    await sql`
      INSERT INTO public.studio_workspace_layout ("userId", layout, "engineRevision")
      VALUES (${userId}::uuid, '{"zoom":1}'::jsonb, 'rev')
    `.execute(db);
  }

  // FL-62: a removed account's memory show-less rules and memory curation go too; the kept account's stay.
  for (const userId of [kept.id, removed]) {
    await sql`
      INSERT INTO public.memory_show_less ("userId", kind, value) VALUES (${userId}::uuid, 'date', '09-25')
    `.execute(db);
    await sql`
      INSERT INTO public.memory_curation ("memoryId", "ownerId", title)
      VALUES (${randomUUID()}::uuid, ${userId}::uuid, 'Summer')
    `.execute(db);
  }

  const swept = await sut.sweepRemovedAccountForkRows();
  expect(swept?.preferenceHistory).toBeGreaterThanOrEqual(1);
  expect(swept?.recipientGroups).toBeGreaterThanOrEqual(1);
  expect(swept?.memoryShowLess).toBeGreaterThanOrEqual(1);
  expect(swept?.memoryCurations).toBeGreaterThanOrEqual(1);
  const memoryRows = await sql<{ table: string; userId: string }>`
    SELECT 'show_less' AS table, "userId"::text AS "userId" FROM public.memory_show_less
    WHERE "userId" IN (${kept.id}::uuid, ${removed}::uuid)
    UNION ALL
    SELECT 'curation', "ownerId"::text FROM public.memory_curation
    WHERE "ownerId" IN (${kept.id}::uuid, ${removed}::uuid)
    ORDER BY 1
  `.execute(db);
  expect(memoryRows.rows).toEqual([
    { table: 'curation', userId: kept.id },
    { table: 'show_less', userId: kept.id },
  ]);
  expect(swept?.workspaceLayouts).toBeGreaterThanOrEqual(1);
  const layouts = await sql<{ userId: string }>`
    SELECT "userId"::text AS "userId" FROM public.studio_workspace_layout
    WHERE "userId" IN (${removed}::uuid, ${kept.id}::uuid)
  `.execute(db);
  expect(layouts.rows).toEqual([{ userId: kept.id }]);
  await expect(sut.getPreferenceHistory(removed)).resolves.toEqual([]);
  await expect(sut.getPreferenceHistory(kept.id)).resolves.toHaveLength(1);

  const groups = await sql<{ id: string; userIds: string[] }>`
    SELECT id::text AS id, "userIds"::text[] AS "userIds" FROM public.recipient_group
    WHERE id IN (${orphanGroup.rows[0].id}::uuid, ${keptGroup.rows[0].id}::uuid)
  `.execute(db);
  expect(groups.rows).toEqual([{ id: keptGroup.rows[0].id, userIds: [kept.id] }]);
});

// FL-57/FL-58: a removed account's face correction history, merge-suggestion answers and pet
// recognition run are swept with its other fork rows; a kept account's stay.
it('sweeps the people and pets fork rows of removed accounts', async () => {
  const sut = new UserRepository(db);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user: kept } = await ctx.newUser();
  const removed = randomUUID();
  const [low, high] = [randomUUID(), randomUUID()].toSorted();
  for (const ownerId of [kept.id, removed]) {
    await sql`
      INSERT INTO public.face_correction ("ownerId", "actorId", action) VALUES (${ownerId}::uuid, ${ownerId}::uuid, 'merge')
    `.execute(db);
    await sql`
      INSERT INTO public.person_merge_verdict ("ownerId", "personId", "suggestionId", verdict)
      VALUES (${ownerId}::uuid, ${low}::uuid, ${high}::uuid, 'different')
    `.execute(db);
    await sql`INSERT INTO public.pet_recognition_run ("ownerId") VALUES (${ownerId}::uuid)`.execute(db);
  }

  const swept = await sut.sweepRemovedAccountForkRows();
  expect(swept?.peopleAndPets).toBe(3);

  for (const table of ['face_correction', 'person_merge_verdict', 'pet_recognition_run']) {
    const { rows } = await sql<{ ownerId: string }>`
      SELECT "ownerId"::text AS "ownerId" FROM ${sql.table(`public.${table}`)}
      WHERE "ownerId" IN (${kept.id}::uuid, ${removed}::uuid)
    `.execute(db);
    expect(rows, table).toEqual([{ ownerId: kept.id }]);
  }
});
