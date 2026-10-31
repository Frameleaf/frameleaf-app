import { type Kysely } from 'kysely';
import { type PhotographyBrand, PhotographyBrandSchema, type StoredShoot } from 'src/dtos/photography-workspace.dto.js';
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

it('merges legacy shoot writes and brand writes without erasing either and enforces cross-section CAS', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const sut = new PhotographyWorkspaceRepository(db);
  const brand: PhotographyBrand = PhotographyBrandSchema.parse({
    name: 'North Studio',
    tagline: '',
    email: '',
    phone: '',
    logoInitials: 'NS',
    logoAssetId: null,
    color: '#577059',
    background: '#f5f3ed',
    textColor: '#263329',
    font: 'editorial',
    watermarkColor: '#ffffff',
    watermarkOpacity: 45,
    watermarkPosition: 'bottom-right',
    watermarkSize: 6,
  });
  const shoot: StoredShoot = {
    id: newUuid(),
    albumId: album.id,
    name: 'Portrait',
    client: 'Jamie',
    type: 'Portrait',
    date: '2026-09-30',
    stage: 'Imported',
  };
  const first = await sut.saveBrand(user.id, brand, null);
  expect((await sut.get(user.id))?.value).toEqual({ shoots: [], brand });
  expect(await sut.get(other.id)).toBeUndefined();
  const second = await sut.save(user.id, [shoot], first!.updateId, [album.id]);
  expect((await sut.get(user.id))?.value).toEqual({ shoots: [shoot], brand });
  const third = await sut.saveBrand(user.id, { ...brand, name: 'Renamed studio' }, second!.updateId);
  expect((await sut.get(user.id))?.value).toEqual({ shoots: [shoot], brand: { ...brand, name: 'Renamed studio' } });
  expect(await sut.saveBrand(other.id, brand, third!.updateId)).toBeUndefined();
  expect(await sut.saveBrand(user.id, brand, null)).toBeUndefined();
  const attempts = await Promise.all([
    sut.saveBrand(user.id, { ...brand, name: 'Concurrent' }, third!.updateId),
    sut.save(user.id, [{ ...shoot, client: 'Updated client' }], third!.updateId, [album.id]),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  const value = (await sut.get(user.id))!.value;
  expect(value.shoots).toHaveLength(1);
  expect(value.brand).toBeDefined();
  expect(await sut.saveBrand(user.id, brand, third!.updateId)).toBeUndefined();
  await db.deleteFrom('user').where('id', '=', user.id).execute();
  expect(await sut.get(user.id)).toBeUndefined();
});
