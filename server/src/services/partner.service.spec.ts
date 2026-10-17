import { BadRequestException } from '@nestjs/common';
import { PushEventType } from 'src/enum.js';
import { PartnerBackfillState } from 'src/repositories/partner-origin.repository.js';
import { PartnerDirection } from 'src/repositories/partner.repository.js';
import { PartnerService } from 'src/services/partner.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { getForPartner } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(PartnerService.name, () => {
  let sut: PartnerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PartnerService));
    mocks.partnerOrigin.getBackfill.mockResolvedValue(undefined);
    mocks.user.getForPinCode.mockResolvedValue({ pinCode: null, password: null });
    mocks.asset.getStatistics.mockResolvedValue({ IMAGE: 0, VIDEO: 0, AUDIO: 0, OTHER: 0 } as never);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('search', () => {
    it('shows the copy progress of the libraries shared each way (FL-326)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const sharedWithUser2 = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });
      mocks.partner.getAll.mockResolvedValue([getForPartner(sharedWithUser2)]);
      mocks.partnerOrigin.getBackfill.mockResolvedValue({
        sharedById: user1.id,
        sharedWithId: user2.id,
        state: PartnerBackfillState.Running,
        cursor: null,
        total: 3200,
        done: 1240,
      });

      const [partner] = await sut.search(auth, { direction: PartnerDirection.SharedBy });

      expect(mocks.partnerOrigin.getBackfill).toHaveBeenCalledWith(user1.id, user2.id);
      expect(partner).toMatchObject({ id: user2.id, backfill: { state: 'running', total: 3200, done: 1240 } });
    });

    it('reports no progress for a partnership that was never copied', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const sharedWithUser1 = PartnerFactory.from().sharedBy(user2).sharedWith(user1).build();
      mocks.partner.getAll.mockResolvedValue([getForPartner(sharedWithUser1)]);

      const [partner] = await sut.search(AuthFactory.create({ id: user1.id }), {
        direction: PartnerDirection.SharedWith,
      });

      expect(mocks.partnerOrigin.getBackfill).toHaveBeenCalledWith(user2.id, user1.id);
      expect(partner.backfill).toBeNull();
    });

    it("should return a list of partners with whom I've shared my library", async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const sharedWithUser2 = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const sharedWithUser1 = PartnerFactory.from().sharedBy(user2).sharedWith(user1).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.getAll.mockResolvedValue([getForPartner(sharedWithUser1), getForPartner(sharedWithUser2)]);

      await expect(sut.search(auth, { direction: PartnerDirection.SharedBy })).resolves.toBeDefined();
      expect(mocks.partner.getAll).toHaveBeenCalledWith(user1.id);
    });

    it('should return a list of partners who have shared their libraries with me', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const sharedWithUser2 = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const sharedWithUser1 = PartnerFactory.from().sharedBy(user2).sharedWith(user1).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.getAll.mockResolvedValue([getForPartner(sharedWithUser1), getForPartner(sharedWithUser2)]);
      await expect(sut.search(auth, { direction: PartnerDirection.SharedWith })).resolves.toBeDefined();
      expect(mocks.partner.getAll).toHaveBeenCalledWith(user1.id);
    });
  });

  it.each(['pin', 'locked'] as const)(
    'requires elevation before partner backfill when the account has %s content',
    async (kind) => {
      if (kind === 'pin') mocks.user.getForPinCode.mockResolvedValue({ pinCode: 'hashed', password: null });
      else mocks.asset.getStatistics.mockResolvedValue({ IMAGE: 1 } as never);
      await expect(sut.create(AuthFactory.create(), { sharedWithId: UserFactory.create().id })).rejects.toThrow(
        'Unlock your session',
      );
      expect(mocks.partner.create).not.toHaveBeenCalled();
    },
  );

  describe('create', () => {
    it('should create a new partner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(void 0);
      mocks.user.get.mockResolvedValue(user2);
      mocks.partner.create.mockResolvedValue(getForPartner(partner));

      await expect(sut.create(auth, { sharedWithId: user2.id })).resolves.toBeDefined();

      expect(mocks.partner.create).toHaveBeenCalledWith({
        sharedById: partner.sharedById,
        sharedWithId: partner.sharedWithId,
      });
    });

    it('tells the partner by push that they gained access (FL-228)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      mocks.partner.get.mockResolvedValue(void 0);
      mocks.user.get.mockResolvedValue(user2);
      mocks.partner.create.mockResolvedValue(getForPartner(partner));

      const auth = AuthFactory.create({ id: user1.id });
      await sut.create(auth, { sharedWithId: user2.id });

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.AccessChanged,
          userIds: [user2.id],
          data: { partnerId: user1.id, change: 'partner-added' },
          systemTemplate: { version: 1, key: 'partner-added', args: { senderName: auth.user.name } },
        }),
      );
    });

    it('should throw an error when the partner already exists', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      await expect(sut.create(auth, { sharedWithId: user2.id })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.partner.create).not.toHaveBeenCalled();
    });

    it('should throw an error when sharedWithId does not resolve to an existing (non-deleted) user', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(void 0);
      mocks.user.get.mockResolvedValue(void 0);

      await expect(sut.create(auth, { sharedWithId: user2.id })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.partner.create).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should remove a partner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      await sut.remove(auth, user2.id);

      expect(mocks.partner.remove).toHaveBeenCalledWith({ sharedById: user1.id, sharedWithId: user2.id });
    });

    it('tells both people at once so open pages drop what they loaded (FL-54)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      await sut.remove(AuthFactory.create({ id: user1.id }), user2.id);

      const payload = { sharedById: user1.id, sharedWithId: user2.id };
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('PartnerRevokeV1', user2.id, payload);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('PartnerRevokeV1', user1.id, payload);
    });

    it('tells the former partner by push that their access ended (FL-228)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      const auth = AuthFactory.create({ id: user1.id });
      await sut.remove(auth, user2.id);

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.AccessChanged,
          userIds: [user2.id],
          data: { partnerId: user1.id, change: 'partner-removed' },
          systemTemplate: { version: 1, key: 'partner-removed', args: { senderName: auth.user.name } },
        }),
      );
    });

    it('should throw an error when the partner does not exist', async () => {
      const user2 = UserFactory.create();
      const auth = AuthFactory.create();

      mocks.partner.get.mockResolvedValue(void 0);

      await expect(sut.remove(auth, user2.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.partner.remove).not.toHaveBeenCalled();
      expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('should require access', async () => {
      const user2 = UserFactory.create();
      const auth = AuthFactory.create();

      await expect(sut.update(auth, user2.id, {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers the partner without changing anything: a partnership has no settings left (FL-326)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user2).sharedWith(user1).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.access.partner.checkUpdateAccess.mockResolvedValue(new Set([user2.id]));
      mocks.partner.get.mockResolvedValue(getForPartner(partner));

      const response = await sut.update(auth, user2.id, {});
      expect(response).toEqual(expect.objectContaining({ id: user2.id }));
      expect(response).not.toHaveProperty('inTimeline');
      expect(response).not.toHaveProperty('shareLocation');
    });
  });
});
