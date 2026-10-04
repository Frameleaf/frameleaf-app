import {
  OriginalLocationPolicy,
  getOriginalLocationPolicies,
  getOriginalLocationPolicy,
  hideLocation,
} from 'src/utils/partner-location.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newUuid } from 'test/small.factory.js';

const located = { latitude: 42, longitude: 69, city: 'Calgary', state: 'Alberta', country: 'Canada' };

describe('original location policy', () => {
  const me = UserFactory.create();
  const partner = UserFactory.create();

  describe(hideLocation.name, () => {
    it('clears every location field and keeps the rest', () => {
      expect(hideLocation({ ...located, description: 'kept' })).toEqual({
        latitude: null,
        longitude: null,
        city: null,
        state: null,
        country: null,
        description: 'kept',
      });
    });
  });

  describe(getOriginalLocationPolicy.name, () => {
    it("serves every signed-in viewer the original untouched, whoever's it is (FL-326)", () => {
      const auth = AuthFactory.create(me);
      for (const purpose of ['download', 'playback'] as const) {
        expect(getOriginalLocationPolicy({ auth, purpose })).toBe(OriginalLocationPolicy.Serve);
      }
    });

    it('serves a shared link that shows metadata the original untouched', () => {
      const auth = AuthFactory.from(me).sharedLink({ userId: me.id, showExif: true, allowDownload: true }).build();
      expect(getOriginalLocationPolicy({ auth, purpose: 'download' })).toBe(OriginalLocationPolicy.Serve);
    });

    it('refuses downloads through a shared link that hides metadata, even when download is on', () => {
      const auth = AuthFactory.from(me).sharedLink({ showExif: false, allowDownload: true }).build();
      expect(getOriginalLocationPolicy({ auth, purpose: 'download' })).toBe(OriginalLocationPolicy.Refuse);
    });

    it('removes the location when a shared link that hides metadata plays an original', () => {
      const auth = AuthFactory.from(me).sharedLink({ showExif: false }).build();
      expect(getOriginalLocationPolicy({ auth, purpose: 'playback' })).toBe(OriginalLocationPolicy.RemoveLocation);
    });
  });

  describe(getOriginalLocationPolicies.name, () => {
    it('applies one policy to every file of the request', () => {
      const auth = AuthFactory.from(me).sharedLink({ showExif: false }).build();
      const assets = [
        { id: newUuid(), ownerId: me.id },
        { id: newUuid(), ownerId: partner.id },
      ];
      const policyFor = getOriginalLocationPolicies({ auth, assets, purpose: 'playback' });
      expect(assets.map((asset) => policyFor(asset))).toEqual([
        OriginalLocationPolicy.RemoveLocation,
        OriginalLocationPolicy.RemoveLocation,
      ]);
    });
  });
});
