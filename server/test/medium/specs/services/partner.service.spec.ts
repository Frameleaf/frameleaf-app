import { Kysely } from 'kysely';
import { JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PartnerDirection, PartnerRepository } from 'src/repositories/partner.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { PartnerService } from 'src/services/partner.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(PartnerService, {
    database: db || defaultDatabase,
    // a library with a PIN or locked items is shared only from an unlocked session, read from the real tables
    real: [AccessRepository, AssetRepository, PartnerOriginRepository, PartnerRepository, UserRepository],
    // FL-54: removing a partner tells both people's open pages; FL-228: and pushes the access change;
    // FL-326: a new partnership queues its backfill
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  services.ctx.getMock(JobRepository).queue.mockResolvedValue();
  return services;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PartnerService.name, () => {
  describe('create', () => {
    it('should share with a new partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();

      await expect(sut.create(factory.auth({ user }), { sharedWithId: partner.id })).resolves.toEqual(
        expect.objectContaining({ id: partner.id }),
      );
    });

    it('starts copying the library to the new partner, with no settings to choose (FL-326)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const auth = factory.auth({ user });

      const response = await sut.create(auth, { sharedWithId: partner.id });
      expect(response).not.toHaveProperty('shareLocation');
      expect(response).not.toHaveProperty('inTimeline');
      await expect(ctx.get(PartnerOriginRepository).getBackfill(user.id, partner.id)).resolves.toMatchObject({
        state: 'pending',
      });
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.PartnerBackfill,
        data: { sharedById: user.id, sharedWithId: partner.id },
      });
    });

    it('should not share with a partner that is already shared with', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });

      await expect(sut.create(factory.auth({ user }), { sharedWithId: partner.id })).rejects.toThrow(
        'Partner already exists',
      );
    });

    it('should not share with an unknown user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await expect(sut.create(factory.auth({ user }), { sharedWithId: newUuid() })).rejects.toThrow('Invalid user');
    });
  });

  describe('search', () => {
    it('should return partners shared by the user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });

      await expect(sut.search(factory.auth({ user }), { direction: PartnerDirection.SharedBy })).resolves.toEqual([
        expect.objectContaining({ id: partner.id }),
      ]);
    });

    it('should return partners that share with the user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await expect(sut.search(factory.auth({ user }), { direction: PartnerDirection.SharedWith })).resolves.toEqual([
        expect.objectContaining({ id: partner.id }),
      ]);
    });
  });

  describe('update', () => {
    it('should update a partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });

      await expect(sut.update(factory.auth({ user }), partner.id, {})).resolves.toEqual(
        expect.objectContaining({ id: partner.id }),
      );
    });

    it('should not update a partner that did not share with the user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: other.id });

      await expect(sut.update(factory.auth({ user }), partner.id, {})).rejects.toThrow(
        'Not found or no partner.update access',
      );
    });
  });

  describe('remove', () => {
    it('should remove a partner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });

      await expect(sut.remove(factory.auth({ user }), partner.id)).resolves.toBeUndefined();
      await expect(sut.search(factory.auth({ user }), { direction: PartnerDirection.SharedBy })).resolves.toEqual([]);
    });

    it('should throw when the partner does not exist', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      await expect(sut.remove(factory.auth({ user }), newUuid())).rejects.toThrow('Partner not found');
    });
  });
});
