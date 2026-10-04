import { ForbiddenException } from '@nestjs/common';
import { type Kysely } from 'kysely';
import type { StoredShoot } from 'src/dtos/photography-workspace.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('persists isolated shoot records and lets only one concurrent CAS save win', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const sut = new PhotographyWorkspaceRepository(db);
  const shoot: StoredShoot = {
    id: newUuid(),
    albumId: album.id,
    name: 'Portrait',
    client: 'Jamie',
    type: 'Portrait',
    date: '2026-09-30',
    stage: 'Imported',
  };
  const created = await sut.save(user.id, [shoot], null, [album.id]);
  expect(created).toBeDefined();
  expect((await sut.get(user.id))?.value).toEqual({ shoots: [shoot] });
  expect(await sut.get(other.id)).toBeUndefined();
  await expect(sut.save(other.id, [shoot], null, [album.id])).rejects.toBeInstanceOf(ForbiddenException);
  const attempts = await Promise.all([
    sut.save(user.id, [{ ...shoot, client: 'One' }], created!.updateId, [album.id]),
    sut.save(user.id, [{ ...shoot, client: 'Two' }], created!.updateId, [album.id]),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect((await sut.get(user.id))?.updateId).not.toBe(created!.updateId);
  expect(await sut.save(user.id, [shoot], null, [album.id])).toBeUndefined();
  await db.deleteFrom('user').where('id', '=', user.id).execute();
  expect(await sut.get(user.id)).toBeUndefined();
});
