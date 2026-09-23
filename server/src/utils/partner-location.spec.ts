import { vitest } from 'vitest';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import {
  applyPartnerLocationPolicy,
  getLocationHiddenPartnerIds,
  hideAssetLocation,
  hideLocation,
} from 'src/utils/partner-location.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { getForPartner } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { automock } from 'test/utils.js';

const located = { latitude: 42, longitude: 69, city: 'Calgary', state: 'Alberta', country: 'Canada' };

describe('partner location policy', () => {
  let repository: PartnerRepository;

  beforeEach(() => {
    repository = automock(PartnerRepository) as unknown as PartnerRepository;
  });

  describe(getLocationHiddenPartnerIds.name, () => {
    it('lists only sharers who turned location sharing off for the viewer', async () => {
      const me = UserFactory.create();
      const hiding = UserFactory.create();
      const sharing = UserFactory.create();
      const recipient = UserFactory.create();
      vitest.mocked(repository.getAll).mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(me).build()),
        getForPartner(PartnerFactory.from({ shareLocation: true }).sharedBy(sharing).sharedWith(me).build()),
        // my own setting towards someone else never hides anything from me
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(me).sharedWith(recipient).build()),
      ]);

      await expect(getLocationHiddenPartnerIds({ userId: me.id, repository })).resolves.toEqual(new Set([hiding.id]));
      expect(repository.getAll).toHaveBeenCalledWith(me.id);
    });

    it('never hides a user from themselves', async () => {
      const me = UserFactory.create();
      vitest
        .mocked(repository.getAll)
        .mockResolvedValue([
          getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(me).sharedWith(me).build()),
        ]);

      await expect(getLocationHiddenPartnerIds({ userId: me.id, repository })).resolves.toEqual(new Set());
    });
  });

  describe(hideLocation.name, () => {
    it('clears every location field and keeps the rest', () => {
      expect(hideLocation({ ...located, make: 'Canon' })).toEqual({
        latitude: null,
        longitude: null,
        city: null,
        state: null,
        country: null,
        make: 'Canon',
      });
    });
  });

  describe(hideAssetLocation.name, () => {
    it('leaves assets without EXIF untouched', () => {
      const asset = { id: newUuid(), exifInfo: undefined };
      expect(hideAssetLocation(asset)).toBe(asset);
    });
  });

  describe(applyPartnerLocationPolicy.name, () => {
    it("skips the lookup when every located asset is the viewer's own", async () => {
      const me = newUuid();
      const assets = [
        { ownerId: me, exifInfo: located },
        { ownerId: newUuid(), exifInfo: undefined },
      ];

      await expect(applyPartnerLocationPolicy(assets, { userId: me, repository })).resolves.toBe(assets);
      expect(repository.getAll).not.toHaveBeenCalled();
    });

    it("hides locations on a hiding partner's assets only", async () => {
      const me = UserFactory.create();
      const hiding = UserFactory.create();
      const sharing = UserFactory.create();
      vitest
        .mocked(repository.getAll)
        .mockResolvedValue([
          getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(me).build()),
          getForPartner(PartnerFactory.from({ shareLocation: true }).sharedBy(sharing).sharedWith(me).build()),
        ]);
      const assets = [
        { ownerId: me.id, exifInfo: located },
        { ownerId: hiding.id, exifInfo: { ...located, make: 'Canon' } },
        { ownerId: sharing.id, exifInfo: located },
      ];

      const result = await applyPartnerLocationPolicy(assets, { userId: me.id, repository });

      expect(result[0].exifInfo).toEqual(located);
      expect(result[1].exifInfo).toEqual({
        latitude: null,
        longitude: null,
        city: null,
        state: null,
        country: null,
        make: 'Canon',
      });
      expect(result[2].exifInfo).toEqual(located);
      // input is never mutated
      expect(assets[1].exifInfo.city).toBe('Calgary');
    });
  });
});
