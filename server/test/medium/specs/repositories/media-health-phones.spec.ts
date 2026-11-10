import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SyncService } from 'src/services/sync.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const sha1Of = (text: string) => createHash('sha1').update(text).digest();

it('lists and records only the caller’s own open lost originals a phone can match (FL-1337)', async () => {
  const db = await getKyselyDB('media_health_phones');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const lost = async (ownerId: string, name: string, extra: Record<string, unknown> = {}, finding = '') => {
      const checksum = sha1Of(name);
      const { asset } = await ctx.newAsset({
        ownerId,
        originalPath: `/data/upload/${ownerId}/aa/bb/${name}.jpg`,
        originalFileName: `${name}.jpg`,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        ...extra,
      });
      await sql`INSERT INTO asset_health ("assetId", category, status, severity, "originalPath", "originalFileName", evidence, resolution, "checkedAt" ${sql.raw(finding ? ', "' + finding + '"' : '')})
        VALUES (${asset.id}::uuid, 'missing', 'missing', 'critical', ${asset.originalPath}, ${name + '.jpg'}, '{"fixState":"waiting-phone"}', '{}', now() ${sql.raw(finding ? ', now()' : '')})`.execute(
        db,
      );
      return { asset, checksum };
    };
    const mine = await lost(user.id, 'mine');
    const theirs = await lost(other.id, 'theirs');
    const resolved = await lost(user.id, 'resolved', {}, 'resolvedAt');
    const dismissed = await lost(user.id, 'dismissed', {}, 'dismissedAt');
    const trashed = await lost(user.id, 'trashed', { deletedAt: new Date() });
    const hashOfPath = await lost(user.id, 'path', { checksumAlgorithm: ChecksumAlgorithm.sha1Path });
    const locked = await lost(user.id, 'locked');
    await sql`INSERT INTO asset_lock ("assetId", reason) VALUES (${locked.asset.id}::uuid, 'manual')`.execute(db);
    const sut = new MediaHealthRepository(db);

    const page = await sut.listLostOriginals(user.id, 10, 0);
    expect(page.map(({ assetId }) => assetId)).toEqual([mine.asset.id]);
    expect(page[0].checksum).toEqual(mine.checksum);
    await expect(sut.listLostOriginals(other.id, 10, 0)).resolves.toHaveLength(1);
    await expect(sut.listLostOriginals(user.id, 10, 1)).resolves.toEqual([]);

    const everyChecksum = [mine, theirs, resolved, dismissed, trashed, hashOfPath, locked].map(
      ({ checksum }) => checksum,
    );
    const found = await sut.findLostOriginals(user.id, everyChecksum);
    expect(found.map(({ assetId }) => assetId)).toEqual([mine.asset.id]);

    const [{ healthId }] = found;
    await sut.recordPhoneReports([
      {
        healthId,
        assetId: mine.asset.id,
        settle: true,
        steps: [
          { step: 'checked-on-phone', outcome: 'not-found', facts: { device: 'iPhone', session: 's1' } },
          { step: 'asked-phones', outcome: 'not-found' },
        ],
      },
    ]);
    const steps = await sut.listSteps(healthId);
    expect(steps.map(({ step, outcome }) => `${step}/${outcome}`)).toEqual([
      'checked-on-phone/not-found',
      'asked-phones/not-found',
    ]);
    const [phoneStep] = await sut.listPhoneSteps([healthId]);
    expect(phoneStep).toMatchObject({ step: 'checked-on-phone', facts: { session: 's1' } });
    const row = await db
      .selectFrom('asset_health')
      .select('evidence')
      .where('id', '=', healthId)
      .executeTakeFirstOrThrow();
    expect(row.evidence).toMatchObject({ fixState: 'missing' });

    // a finding resolved meanwhile gets nothing
    await sql`UPDATE asset_health SET "resolvedAt"=now() WHERE id=${healthId}::uuid`.execute(db);
    await sut.recordPhoneReports([
      { healthId, assetId: mine.asset.id, settle: true, steps: [{ step: 'checked-on-phone', outcome: 'not-found' }] },
    ]);
    await expect(sut.listSteps(healthId)).resolves.toHaveLength(2);
  } finally {
    await db.destroy();
  }
});

it('writes the put-back history with the resolve, and nothing for a problem already resolved (FL-1337)', async () => {
  const db = await getKyselyDB('media_health_put_back_steps');
  const { ctx } = newMediumService(SyncService, { database: db, real: [], mock: [LoggingRepository] });
  try {
    const { user } = await ctx.newUser();
    const bytes = Buffer.from('a photo a phone sent back');
    const sha1 = createHash('sha1').update(bytes).digest();
    const sha256 = createHash('sha256').update(bytes).digest();
    const lostPath = `/data/upload/${user.id}/aa/bb/IMG_1.jpg`;
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      originalPath: lostPath,
      checksum: sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });
    await sql`INSERT INTO asset_health ("assetId", category, status, severity, "originalPath", "originalFileName", evidence, resolution, "checkedAt")
      VALUES (${asset.id}::uuid, 'missing', 'missing', 'critical', ${lostPath}, 'IMG_1.jpg', '{"fixState":"waiting-phone","autoRepairDeclined":true}', '{}', now())`.execute(
      db,
    );
    const sut = new PhysicalFileRepository(db);
    const restore = (to: string) =>
      sut.restoreLostOriginal({
        assetId: asset.id,
        expectedOriginalPath: lostPath,
        originalPath: to,
        sha1,
        sha256,
        sizeInBytes: bytes.length,
        reason: 'restored_by_upload',
        finding: {
          evidence: { fixState: 'found-again' },
          steps: [
            { step: 'asked-phones', outcome: 'ok', facts: { device: 'iPhone' } },
            { step: 'put-back', outcome: 'ok' },
          ],
        },
      });

    await expect(restore(`/data/upload/${user.id}/cc/dd/upload.jpg`)).resolves.toBe(true);

    const health = new MediaHealthRepository(db);
    const finding = await db
      .selectFrom('asset_health')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(finding).toMatchObject({
      status: 'relinked',
      evidence: {
        fixState: 'found-again',
        autoRepairDeclined: true,
        reason: 'restored_by_upload',
        previousPath: lostPath,
      },
    });
    expect(finding.resolvedAt).not.toBeNull();
    const steps = await health.listSteps(finding.id);
    expect(steps.map(({ step, outcome, facts, undo }) => ({ step, outcome, facts, undo }))).toEqual([
      { step: 'asked-phones', outcome: 'ok', facts: { device: 'iPhone' }, undo: null },
      { step: 'put-back', outcome: 'ok', facts: {}, undo: null },
    ]);

    // the same upload again finds nothing to resolve: no further history
    await sql`UPDATE asset SET "originalPath"=${lostPath} WHERE id=${asset.id}::uuid`.execute(db);
    await expect(restore(`/data/upload/${user.id}/ee/ff/second.jpg`)).resolves.toBe(true);
    await expect(health.listSteps(finding.id)).resolves.toHaveLength(2);
  } finally {
    await db.destroy();
  }
});
