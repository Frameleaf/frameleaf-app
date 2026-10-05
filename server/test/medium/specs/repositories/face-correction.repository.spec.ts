import { Kysely, sql } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-57: canonical face correction history and extended merge verdicts. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

it('records explicit decisions with their source face and normalized box', async () => {
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
  // The manual-action caller records history explicitly; low-level recognition writes do not.
  await people.recordFaceCorrections([
    {
      ownerId: user.id,
      actorId: user.id,
      action: 'reassign',
      faceId: moved.id,
      toPersonId: person.personGroupId,
    },
    {
      ownerId: user.id,
      actorId: user.id,
      action: 'remove',
      faceId: removed.id,
      fromPersonId: person.personGroupId,
    },
  ]);

  const { rows } = await sql<{
    faceId: string;
    action: string;
    toPersonId: string | null;
    fromPersonId: string | null;
  }>`
    SELECT "faceId", action, "ownerId", "actorId", "assetChecksum", "toPersonId", "fromPersonId", "boxX1", "boxY2" FROM public.face_correction
    WHERE "assetId" = ${asset.id}::uuid ORDER BY action
  `.execute(db);
  expect(rows).toEqual([
    expect.objectContaining({
      faceId: moved.id,
      action: 'reassign',
      ownerId: user.id,
      actorId: user.id,
      assetChecksum: asset.checksum,
      toPersonId: person.personGroupId,
      boxX1: 0.1,
      boxY2: 0.3,
    }),
    expect.objectContaining({
      faceId: removed.id,
      action: 'remove',
      ownerId: user.id,
      actorId: user.id,
      assetChecksum: asset.checksum,
      fromPersonId: person.personGroupId,
    }),
  ]);
  expect(rows.some(({ faceId }) => faceId === untouched.id)).toBe(false);
  const { items } = await people.getFaceCorrections(user.id, person.personGroupId, { take: 10 });
  expect(items).toHaveLength(2);
  const { user: other } = await ctx.newUser();
  const foreignHistory = await people.getFaceCorrections(other.id, person.personGroupId, { take: 10 });
  expect(foreignHistory.items).toEqual([]);
});

it('refuses an unknown action and a face decision without its photo', async () => {
  const owner = '00000000-0000-4000-8000-000000000001';
  await expect(
    sql`INSERT INTO public.face_correction ("ownerId", "actorId", action, "assetId")
        VALUES (${owner}::uuid, ${owner}::uuid, 'rename', ${owner}::uuid)`.execute(db),
  ).rejects.toThrow();
  await expect(
    sql`INSERT INTO public.face_correction ("ownerId", "actorId", action)
        VALUES (${owner}::uuid, ${owner}::uuid, 'reassign')`.execute(db),
  ).rejects.toThrow();
  await expect(
    sql`INSERT INTO public.face_correction ("ownerId", "actorId", action, "assetId", "boxX1")
        VALUES (${owner}::uuid, ${owner}::uuid, 'remove', ${owner}::uuid, 0.5)`.execute(db),
  ).rejects.toThrow();
});
