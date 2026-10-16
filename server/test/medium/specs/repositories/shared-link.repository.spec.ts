import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { SharedLinkType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

describe('shared-link owner authentication', () => {
  it.each(['key', 'slug'] as const)(
    'refuses a soft-deleted owner through %s and permits their restored account',
    async (kind) => {
      const { ctx, sut } = newMediumService(AuthService, {
        database,
        real: [SharedLinkRepository],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const key = randomBytes(50);
      const slug = `fixture-${user.id}`;
      await ctx.get(SharedLinkRepository).create({
        userId: user.id,
        allowUpload: false,
        key,
        slug,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });
      const authenticate = () =>
        kind === 'key' ? sut.validateSharedLinkKey(key.toString('base64url')) : sut.validateSharedLinkSlug(slug);
      await expect(authenticate()).resolves.toMatchObject({ user: { id: user.id } });
      await database.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();
      await expect(authenticate()).rejects.toBeInstanceOf(UnauthorizedException);
      await database.updateTable('user').set({ deletedAt: null }).where('id', '=', user.id).execute();
      await expect(authenticate()).resolves.toMatchObject({ user: { id: user.id } });
    },
  );
});
