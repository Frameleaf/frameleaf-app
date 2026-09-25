import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000171-UserPreferenceHistory.js';
import { USER_PREFERENCE_HISTORY_LIMIT, UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-71 (CC-10): an account's own preference history, a fork-owned table. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});

const isHistory = (entry: { identity: string }) => entry.identity.startsWith('immich_fork.user_preference_history');

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isHistory(entry))).toEqual(
      (manifest as unknown as Record<string, Array<{ identity: string }>>)[kind].filter((entry) => isHistory(entry)),
    );
  }
  expect(before.tables.filter((entry) => isHistory(entry))).toHaveLength(1);

  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
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
    SELECT count(*)::int AS count FROM immich_fork.user_preference_history WHERE "userId" = ${ada}::uuid
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
    sql`INSERT INTO immich_fork.user_preference_history ("userId", changes) VALUES (${randomUUID()}::uuid, '{}'::jsonb)`.execute(
      db,
    ),
  ).rejects.toThrow();
});

it('forgets a deleted account’s history and leaves everyone else’s, and writes nothing while the fork schema is read-only', async () => {
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

  await sql`UPDATE immich_fork.state SET phase='inactive' WHERE id=1`.execute(db);
  try {
    await sut.addPreferenceHistory({ userId: gone, deviceLabel: null, changes: [change], omittedChanges: 0 });
    await sut.deletePreferenceHistory(kept);
    await expect(sut.getPreferenceHistory(gone)).resolves.toEqual([]);
    await expect(sut.getPreferenceHistory(kept)).resolves.toHaveLength(1);
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});
