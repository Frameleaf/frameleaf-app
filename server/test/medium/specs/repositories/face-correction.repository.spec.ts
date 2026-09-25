import { Kysely, sql } from 'kysely';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000175-FaceCorrectionHistory.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-57: the face correction history (fork migration 0000000000175) and the extended merge verdicts. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const isOurs = (entry: { identity: string }) =>
  entry.identity.startsWith('immich_fork.face_correction') ||
  entry.identity.startsWith('immich_fork.person_merge_verdict');

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isOurs(entry))).toEqual(
      (manifest as unknown as Record<string, Array<{ identity: string }>>)[kind].filter((entry) => isOurs(entry)),
    );
  }

  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
    expect(after[kind].filter((entry) => isOurs(entry))).toEqual(before[kind].filter((entry) => isOurs(entry)));
  }
});

it('records the decisions made before the history existed', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const people = ctx.get(PersonRepository);
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Ada' });
  const box = {
    imageWidth: 100,
    imageHeight: 200,
    boundingBoxX1: 10,
    boundingBoxY1: 20,
    boundingBoxX2: 30,
    boundingBoxY2: 60,
  };
  const { assetFace: moved } = await ctx.newAssetFace({ assetId: asset.id, ...box });
  const { assetFace: removed } = await ctx.newAssetFace({
    assetId: asset.id,
    personGroupId: person.personGroupId,
    ...box,
  });
  const { assetFace: untouched } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
  await people.reassignFace(moved.id, person.personGroupId);
  await people.softDeleteAssetFaces(removed.id);

  await migration.down(db);
  await migration.up(db);

  const { rows } = await sql<{
    faceId: string;
    action: string;
    toPersonId: string | null;
    fromPersonId: string | null;
  }>`
    SELECT "faceId", action, "toPersonId", "fromPersonId", "boxX1", "boxY2" FROM immich_fork.face_correction
    WHERE "assetId" = ${asset.id}::uuid ORDER BY action
  `.execute(db);
  expect(rows).toEqual([
    expect.objectContaining({
      faceId: moved.id,
      action: 'reassign',
      toPersonId: person.personGroupId,
      boxX1: 0.1,
      boxY2: 0.3,
    }),
    expect.objectContaining({ faceId: removed.id, action: 'remove', fromPersonId: person.personGroupId }),
  ]);
  expect(rows.some(({ faceId }) => faceId === untouched.id)).toBe(false);
  const { items } = await people.getFaceCorrections(user.id, person.personGroupId, { take: 10 });
  expect(items).toHaveLength(2);
});

it('refuses an unknown action and a face decision without its photo', async () => {
  const owner = '00000000-0000-4000-8000-000000000001';
  await expect(
    sql`INSERT INTO immich_fork.face_correction ("ownerId", "actorId", action, "assetId")
        VALUES (${owner}::uuid, ${owner}::uuid, 'rename', ${owner}::uuid)`.execute(db),
  ).rejects.toThrow();
  await expect(
    sql`INSERT INTO immich_fork.face_correction ("ownerId", "actorId", action)
        VALUES (${owner}::uuid, ${owner}::uuid, 'reassign')`.execute(db),
  ).rejects.toThrow();
  await expect(
    sql`INSERT INTO immich_fork.face_correction ("ownerId", "actorId", action, "assetId", "boxX1")
        VALUES (${owner}::uuid, ${owner}::uuid, 'remove', ${owner}::uuid, 0.5)`.execute(db),
  ).rejects.toThrow();
});
