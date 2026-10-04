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

  const { rows } = await sql<{
    faceId: string;
    action: string;
    toPersonId: string | null;
    fromPersonId: string | null;
  }>`
    SELECT "faceId", action, "toPersonId", "fromPersonId", "boxX1", "boxY2" FROM public.face_correction
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
