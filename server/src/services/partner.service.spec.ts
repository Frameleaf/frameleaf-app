import { BadRequestException } from '@nestjs/common';
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
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('search', () => {
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

      await expect(sut.update(auth, user2.id, { inTimeline: false })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should update partner', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from().sharedBy(user1).sharedWith(user2).build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.access.partner.checkUpdateAccess.mockResolvedValue(new Set([user2.id]));
      mocks.partner.update.mockResolvedValue(getForPartner(partner));

      await expect(sut.update(auth, user2.id, { inTimeline: true })).resolves.toBeDefined();
      expect(mocks.partner.update).toHaveBeenCalledWith(
        { sharedById: user2.id, sharedWithId: user1.id },
        { inTimeline: true },
      );
    });

    it('should reject a request that sets neither field', async () => {
      const user2 = UserFactory.create();
      const auth = AuthFactory.create();

      await expect(sut.update(auth, user2.id, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.partner.update).not.toHaveBeenCalled();
    });

    it('should reject a request that sets both fields', async () => {
      const user2 = UserFactory.create();
      const auth = AuthFactory.create();

      await expect(sut.update(auth, user2.id, { inTimeline: true, shareLocation: false })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.partner.update).not.toHaveBeenCalled();
    });

    it('should let the sharing user turn location sharing off for one partner', async () => {
      const sharer = UserFactory.create();
      const recipient = UserFactory.create();
      const partner = PartnerFactory.from({ shareLocation: false }).sharedBy(sharer).sharedWith(recipient).build();
      const auth = AuthFactory.create({ id: sharer.id });

      mocks.partner.get.mockResolvedValue(getForPartner(partner));
      mocks.partner.update.mockResolvedValue(getForPartner(partner));

      await expect(sut.update(auth, recipient.id, { shareLocation: false })).resolves.toEqual(
        expect.objectContaining({ id: recipient.id, shareLocation: false }),
      );
      expect(mocks.partner.get).toHaveBeenCalledWith({ sharedById: sharer.id, sharedWithId: recipient.id });
      expect(mocks.partner.update).toHaveBeenCalledWith(
        { sharedById: sharer.id, sharedWithId: recipient.id },
        { shareLocation: false },
      );
      // the recipient-side access check is not what authorizes a sharer setting
      expect(mocks.access.partner.checkUpdateAccess).not.toHaveBeenCalled();
    });

    it('should not let a recipient change location sharing on a library shared with them', async () => {
      const sharer = UserFactory.create();
      const recipient = UserFactory.create();
      const auth = AuthFactory.create({ id: recipient.id });

      // the recipient does not share their own library with the sharer, so no (recipient -> sharer) row exists
      mocks.partner.get.mockResolvedValue(void 0);

      await expect(sut.update(auth, sharer.id, { shareLocation: true })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.partner.get).toHaveBeenCalledWith({ sharedById: recipient.id, sharedWithId: sharer.id });
      expect(mocks.partner.update).not.toHaveBeenCalled();
    });

    it('should report shareLocation alongside inTimeline in partner responses', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const partner = PartnerFactory.from({ inTimeline: true, shareLocation: true })
        .sharedBy(user1)
        .sharedWith(user2)
        .build();
      const auth = AuthFactory.create({ id: user1.id });

      mocks.partner.getAll.mockResolvedValue([getForPartner(partner)]);

      await expect(sut.search(auth, { direction: PartnerDirection.SharedBy })).resolves.toEqual([
        expect.objectContaining({ id: user2.id, inTimeline: true, shareLocation: true }),
      ]);
    });
  });
});
