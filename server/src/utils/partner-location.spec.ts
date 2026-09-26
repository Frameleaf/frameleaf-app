import { vitest } from 'vitest';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import {
  OriginalLocationPolicy,
  applyAlbumLocationPolicy,
  applyPartnerLocationPolicy,
  getLocationHiddenOwnerIdsForView,
  getLocationHiddenPartnerIds,
  getOriginalLocationPolicies,
  getOriginalLocationPolicy,
  hideAssetLocation,
  hideLocation,
} from 'src/utils/partner-location.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
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
    vitest.mocked(repository.getLocationHiddenThroughAlbums).mockResolvedValue(new Set());
    vitest.mocked(repository.getLocationHiddenOwnerIdsForAlbums).mockResolvedValue([]);
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

  describe(getOriginalLocationPolicy.name, () => {
    const me = UserFactory.create();
    const hiding = UserFactory.create();
    const sharing = UserFactory.create();
    const locationHiddenOwnerIds = new Set([hiding.id]);

    it('serves the owner their own original untouched', () => {
      const auth = AuthFactory.create(me);
      for (const purpose of ['download', 'playback'] as const) {
        expect(
          getOriginalLocationPolicy({ auth, ownerId: me.id, locationHiddenOwnerIds: new Set([me.id]), purpose }),
        ).toBe(OriginalLocationPolicy.Serve);
      }
    });

    it('serves a partner who may see locations the original untouched', () => {
      const auth = AuthFactory.create(me);
      expect(
        getOriginalLocationPolicy({ auth, ownerId: sharing.id, locationHiddenOwnerIds, purpose: 'download' }),
      ).toBe(OriginalLocationPolicy.Serve);
    });

    it('removes the location for a partner the owner hides locations from', () => {
      const auth = AuthFactory.create(me);
      for (const purpose of ['download', 'playback'] as const) {
        expect(getOriginalLocationPolicy({ auth, ownerId: hiding.id, locationHiddenOwnerIds, purpose })).toBe(
          OriginalLocationPolicy.RemoveLocation,
        );
      }
    });

    it('serves a shared link that shows metadata the original when its creator may see the location', () => {
      const auth = AuthFactory.from(me).sharedLink({ userId: me.id, showExif: true, allowDownload: true }).build();
      for (const ownerId of [me.id, sharing.id]) {
        expect(getOriginalLocationPolicy({ auth, ownerId, locationHiddenOwnerIds, purpose: 'download' })).toBe(
          OriginalLocationPolicy.Serve,
        );
      }
    });

    it('removes the location through a link whose creator the owner hides locations from (review B1)', () => {
      // a hidden partner linked the owner's asset, or an album holding it, with metadata shown
      const auth = AuthFactory.from(me).sharedLink({ userId: me.id, showExif: true, allowDownload: true }).build();
      for (const purpose of ['download', 'playback'] as const) {
        expect(getOriginalLocationPolicy({ auth, ownerId: hiding.id, locationHiddenOwnerIds, purpose })).toBe(
          OriginalLocationPolicy.RemoveLocation,
        );
      }
    });

    it('refuses downloads through a shared link that hides metadata, even when download is on', () => {
      const auth = AuthFactory.from(me).sharedLink({ showExif: false, allowDownload: true }).build();
      expect(getOriginalLocationPolicy({ auth, ownerId: me.id, locationHiddenOwnerIds, purpose: 'download' })).toBe(
        OriginalLocationPolicy.Refuse,
      );
    });

    it('removes the location when a shared link that hides metadata plays an original', () => {
      const auth = AuthFactory.from(me).sharedLink({ showExif: false }).build();
      expect(getOriginalLocationPolicy({ auth, ownerId: me.id, locationHiddenOwnerIds, purpose: 'playback' })).toBe(
        OriginalLocationPolicy.RemoveLocation,
      );
    });
  });

  describe(getOriginalLocationPolicies.name, () => {
    it('skips the partner lookup when every file belongs to the viewer', async () => {
      const me = UserFactory.create();
      const policyFor = await getOriginalLocationPolicies({
        auth: AuthFactory.create(me),
        assets: [me.id].map((ownerId) => ({ id: ownerId, ownerId })),
        purpose: 'download',
        repository,
      });

      expect(policyFor({ id: me.id, ownerId: me.id })).toBe(OriginalLocationPolicy.Serve);
      expect(repository.getAll).not.toHaveBeenCalled();
    });

    it('skips the partner lookup for a shared link that hides metadata', async () => {
      const policyFor = await getOriginalLocationPolicies({
        auth: AuthFactory.from().sharedLink({ showExif: false }).build(),
        assets: [newUuid()].map((ownerId) => ({ id: ownerId, ownerId })),
        purpose: 'download',
        repository,
      });

      expect(policyFor({ id: newUuid(), ownerId: newUuid() })).toBe(OriginalLocationPolicy.Refuse);
      expect(repository.getAll).not.toHaveBeenCalled();
    });

    it("resolves an album link's assets from the link creator's partner settings", async () => {
      const creator = UserFactory.create();
      const hiding = UserFactory.create();
      const member = UserFactory.create();
      vitest
        .mocked(repository.getAll)
        .mockResolvedValue([
          getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(creator).build()),
        ]);

      const policyFor = await getOriginalLocationPolicies({
        auth: AuthFactory.from(creator).sharedLink({ userId: creator.id, albumId: newUuid(), showExif: true }).build(),
        assets: [creator.id, hiding.id, member.id].map((ownerId) => ({ id: ownerId, ownerId })),
        purpose: 'download',
        repository,
      });

      expect(repository.getAll).toHaveBeenCalledWith(creator.id);
      expect(policyFor({ id: creator.id, ownerId: creator.id })).toBe(OriginalLocationPolicy.Serve);
      expect(policyFor({ id: hiding.id, ownerId: hiding.id })).toBe(OriginalLocationPolicy.RemoveLocation);
      expect(policyFor({ id: member.id, ownerId: member.id })).toBe(OriginalLocationPolicy.Serve);
    });

    it("resolves each owner from the viewer's partner settings", async () => {
      const me = UserFactory.create();
      const hiding = UserFactory.create();
      const sharing = UserFactory.create();
      vitest
        .mocked(repository.getAll)
        .mockResolvedValue([
          getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(me).build()),
          getForPartner(PartnerFactory.from({ shareLocation: true }).sharedBy(sharing).sharedWith(me).build()),
        ]);

      const policyFor = await getOriginalLocationPolicies({
        auth: AuthFactory.create(me),
        assets: [me.id, hiding.id, sharing.id].map((ownerId) => ({ id: ownerId, ownerId })),
        purpose: 'download',
        repository,
      });

      expect(policyFor({ id: me.id, ownerId: me.id })).toBe(OriginalLocationPolicy.Serve);
      expect(policyFor({ id: hiding.id, ownerId: hiding.id })).toBe(OriginalLocationPolicy.RemoveLocation);
      expect(policyFor({ id: sharing.id, ownerId: sharing.id })).toBe(OriginalLocationPolicy.Serve);
      expect(repository.getAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('resharing through an album (FL-54 owner default)', () => {
    it("removes the location from an original reached through a hidden album owner's album", async () => {
      const viewer = UserFactory.create();
      const owner = UserFactory.create();
      vitest.mocked(repository.getAll).mockResolvedValue([]);
      vitest.mocked(repository.getLocationHiddenThroughAlbums).mockResolvedValue(new Set(['reshared']));

      const policyFor = await getOriginalLocationPolicies({
        auth: AuthFactory.create(viewer),
        assets: [
          { id: 'reshared', ownerId: owner.id },
          { id: 'direct', ownerId: owner.id },
          { id: 'mine', ownerId: viewer.id },
        ],
        purpose: 'download',
        repository,
      });

      expect(repository.getLocationHiddenThroughAlbums).toHaveBeenCalledWith(viewer.id, ['reshared', 'direct']);
      expect(policyFor({ id: 'reshared', ownerId: owner.id })).toBe(OriginalLocationPolicy.RemoveLocation);
      expect(policyFor({ id: 'direct', ownerId: owner.id })).toBe(OriginalLocationPolicy.Serve);
      expect(policyFor({ id: 'mine', ownerId: viewer.id })).toBe(OriginalLocationPolicy.Serve);
    });

    it("adds the owners who hide locations from an album's owner to a view of that album", async () => {
      const viewer = UserFactory.create();
      const hidingFromViewer = UserFactory.create();
      const hidingFromAlbumOwner = UserFactory.create();
      vitest
        .mocked(repository.getAll)
        .mockResolvedValue([
          getForPartner(
            PartnerFactory.from({ shareLocation: false }).sharedBy(hidingFromViewer).sharedWith(viewer).build(),
          ),
        ]);
      // the viewer's own items stay visible to them even if they hide locations from the album owner
      vitest
        .mocked(repository.getLocationHiddenOwnerIdsForAlbums)
        .mockResolvedValue([hidingFromAlbumOwner.id, viewer.id]);

      const hidden = await getLocationHiddenOwnerIdsForView({ viewerId: viewer.id, albumIds: ['album-1'], repository });

      expect(repository.getLocationHiddenOwnerIdsForAlbums).toHaveBeenCalledWith(['album-1'], viewer.id);
      expect(hidden).toEqual(new Set([hidingFromViewer.id, hidingFromAlbumOwner.id]));
    });

    it('clears location fields of an asset reached through such an album', async () => {
      const viewer = UserFactory.create();
      const owner = UserFactory.create();
      vitest.mocked(repository.getLocationHiddenThroughAlbums).mockResolvedValue(new Set(['reshared']));

      const [reshared, own] = await applyAlbumLocationPolicy(
        [
          { id: 'reshared', ownerId: owner.id, exifInfo: located },
          { id: 'mine', ownerId: viewer.id, exifInfo: located },
        ],
        { userId: viewer.id, repository },
      );

      expect(repository.getLocationHiddenThroughAlbums).toHaveBeenCalledWith(viewer.id, ['reshared']);
      expect(reshared.exifInfo).toEqual({ latitude: null, longitude: null, city: null, state: null, country: null });
      expect(own.exifInfo).toEqual(located);
    });
  });
});
