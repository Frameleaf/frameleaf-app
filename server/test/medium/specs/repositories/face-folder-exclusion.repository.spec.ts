import { Kysely } from 'kysely';
import { AssetFileType, SourceType } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  return { ctx, people: ctx.get(PersonRepository), jobs: ctx.get(AssetJobRepository) };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

afterAll(async () => {
  await database?.destroy();
});

// FL-934: folders an owner leaves out of face recognition
describe('face folder exclusions', () => {
  const photo = async (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, originalPath: string) => {
    const { asset } = await ctx.newAsset({ ownerId, originalPath });
    await ctx.newJobStatus({ assetId: asset.id, facesRecognizedAt: null });
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/p/${asset.id}.jpg` });
    return asset;
  };

  it('leaves photos in an excluded folder of their own owner out of face detection, and nothing else', async () => {
    const { ctx, people, jobs } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    const inside = await photo(ctx, owner.id, '/photos/scan/a.jpg');
    const nested = await photo(ctx, owner.id, '/photos/scan/2001/b.jpg');
    const sibling = await photo(ctx, owner.id, '/photos/scans/c.jpg');
    const elsewhere = await photo(ctx, owner.id, '/photos/d.jpg');
    // a partner's copy at the same path follows its own owner, who left nothing out
    const partners = await photo(ctx, partner.id, '/photos/scan/a.jpg');

    await people.createFaceFolderExclusion(owner.id, '/photos/scan/');

    const queued = async (force?: boolean) =>
      (await jobs.selectionForDetectFacesJob(force).execute()).map(({ id }) => id);
    for (const force of [false, true, undefined]) {
      const ids = await queued(force);
      expect(ids).not.toContain(inside.id);
      expect(ids).not.toContain(nested.id);
      expect(ids).toEqual(expect.arrayContaining([sibling.id, elsewhere.id, partners.id]));
    }
    expect(await jobs.hasFacesToDetect(owner.id)).toBe(true);

    expect((await jobs.getForDetectFacesJob(inside.id))?.isFaceFolderExcluded).toBe(true);
    expect((await jobs.getForDetectFacesJob(sibling.id))?.isFaceFolderExcluded).toBe(false);
    expect((await jobs.getForDetectFacesJob(partners.id))?.isFaceFolderExcluded).toBe(false);
    expect(await people.getFaceFolderExcludedAssetIds([inside.id, nested.id, sibling.id, partners.id])).toEqual(
      new Set([inside.id, nested.id]),
    );

    // marked done so nothing waits for them; the owner's other photos still wait
    await people.markFaceFolderExcludedDetected(owner.id);
    const status = await ctx.database
      .selectFrom('asset_job_status')
      .select(['assetId', 'facesRecognizedAt'])
      .where('assetId', 'in', [inside.id, nested.id, sibling.id, partners.id])
      .execute();
    const done = new Set(status.filter((row) => row.facesRecognizedAt !== null).map((row) => row.assetId));
    expect(done).toEqual(new Set([inside.id, nested.id]));

    // the same folder twice is one exclusion
    const again = await people.createFaceFolderExclusion(owner.id, '/photos/scan/');
    expect(await people.getFaceFolderExclusions(owner.id)).toEqual([again]);
    expect(await people.getFaceFolderExclusions(partner.id)).toEqual([]);

    // taken back in, the folder waits for faces again and is offered for detection
    await expect(people.deleteFaceFolderExclusion(partner.id, again.id)).resolves.toBeUndefined();
    await expect(people.deleteFaceFolderExclusion(owner.id, again.id)).resolves.toMatchObject({ id: again.id });
    await people.resetFaceFolderDetected(owner.id, '/photos/scan/');
    const offered = (await jobs.selectionForFaceFolderDetection(owner.id, '/photos/scan/').execute()).map(
      ({ id }) => id,
    );
    expect(new Set(offered)).toEqual(new Set([inside.id, nested.id]));
  });

  it('keeps a subfolder that is still left out when its parent is taken back in', async () => {
    const { ctx, people, jobs } = setup();
    const { user: owner } = await ctx.newUser();
    const top = await photo(ctx, owner.id, '/library/a.jpg');
    const kept = await photo(ctx, owner.id, '/library/private/b.jpg');
    const parent = await people.createFaceFolderExclusion(owner.id, '/library/');
    await people.createFaceFolderExclusion(owner.id, '/library/private/');
    await people.markFaceFolderExcludedDetected(owner.id);

    await people.deleteFaceFolderExclusion(owner.id, parent.id);
    await people.resetFaceFolderDetected(owner.id, '/library/');

    const offered = (await jobs.selectionForFaceFolderDetection(owner.id, '/library/').execute()).map(({ id }) => id);
    expect(offered).toEqual([top.id]);
    const status = await ctx.database
      .selectFrom('asset_job_status')
      .select('facesRecognizedAt')
      .where('assetId', '=', kept.id)
      .executeTakeFirstOrThrow();
    expect(status.facesRecognizedAt).not.toBeNull();
  });

  it('previews and removes only the faces no one confirmed', async () => {
    const { ctx, people } = setup();
    const { user: owner } = await ctx.newUser();
    const inside = await photo(ctx, owner.id, '/photos/scan/a.jpg');
    const outside = await photo(ctx, owner.id, '/photos/scans/b.jpg');
    const { person: named } = await ctx.newPerson({ ownerId: owner.id, name: 'Ada' });
    const { person: unnamed } = await ctx.newPerson({ ownerId: owner.id, name: '' });

    const { assetFace: machine } = await ctx.newAssetFace({ assetId: inside.id });
    const { assetFace: machineUnnamed } = await ctx.newAssetFace({
      assetId: inside.id,
      personGroupId: unnamed.personGroupId,
    });
    const { assetFace: onNamed } = await ctx.newAssetFace({ assetId: inside.id, personGroupId: named.personGroupId });
    const { assetFace: manual } = await ctx.newAssetFace({ assetId: inside.id, sourceType: SourceType.Manual });
    const { assetFace: corrected } = await ctx.newAssetFace({
      assetId: inside.id,
      personGroupId: unnamed.personGroupId,
    });
    await ctx.database
      .updateTable('asset_face')
      .set({ correctedAt: new Date() })
      .where('id', '=', corrected.id)
      .execute();
    const { assetFace: notAFace } = await ctx.newAssetFace({ assetId: inside.id, deletedAt: new Date() });
    const { assetFace: sibling } = await ctx.newAssetFace({ assetId: outside.id });
    await ctx.database
      .updateTable('person')
      .set({ faceAssetId: machineUnnamed.id })
      .where('personGroupId', '=', unnamed.personGroupId)
      .execute();

    await expect(people.getFaceFolderPreview(owner.id, '/photos/scan/')).resolves.toEqual({
      assetCount: 1,
      removableFaceCount: 2,
      keptFaceCount: 3,
    });
    await expect(people.getFaceFolderPreview(owner.id, '/nothing/here/')).resolves.toEqual({
      assetCount: 0,
      removableFaceCount: 0,
      keptFaceCount: 0,
    });

    const removed = await people.removeUnconfirmedFolderFaces(owner.id, '/photos/scan/');
    expect(removed).toEqual({
      faceCount: 2,
      assetIds: [inside.id],
      featured: [{ ownerId: owner.id, personGroupId: unnamed.personGroupId }],
    });
    const left = await ctx.database.selectFrom('asset_face').select('id').execute();
    const ids = new Set(left.map(({ id }) => id));
    for (const face of [onNamed, manual, corrected, notAFace, sibling]) {
      expect(ids.has(face.id)).toBe(true);
    }
    for (const face of [machine, machineUnnamed]) {
      expect(ids.has(face.id)).toBe(false);
    }
  });
});
