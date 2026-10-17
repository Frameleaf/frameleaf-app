import { fireEvent, waitFor } from '@testing-library/svelte';
import domtoimage from 'dom-to-image';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import ProfileImageCropperModal from './ProfileImageCropperModal.svelte';

vi.mock('dom-to-image', () => ({ default: { toBlob: vi.fn() } }));
vi.mock('./profile-image', () => ({ hasTransparentPixels: vi.fn().mockResolvedValue(false) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', getResizeObserverMock());
  authManager.setUser(userAdminFactory.build({ id: 'owner' }));
  authManager.setPreferences(preferencesFactory.build());
  vi.spyOn(authManager, 'refresh').mockResolvedValue(undefined);
});
afterEach(() => {
  authManager.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['current', 'session', 'close'])(
  'uploads the profile crop only in its owning view and session: %s',
  async (change) => {
    const pending = deferredPromise<Blob>();
    vi.mocked(domtoimage.toBlob).mockReturnValueOnce(pending.promise);
    const asset = assetFactory.build({ ownerId: 'owner', thumbhash: null });
    const onClose = vi.fn();
    const view = renderWithTooltips(ProfileImageCropperModal, { asset, onClose });
    await fireEvent.submit(view.getByRole('dialog').querySelector('form')!);
    await waitFor(() => expect(domtoimage.toBlob).toHaveBeenCalled());
    if (change === 'session') {
      authManager.reset();
    } else if (change === 'close') {
      view.unmount();
    }
    pending.resolve(new Blob(['crop'], { type: 'image/png' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (change === 'current') {
      expect(sdkMock.createProfileImage).toHaveBeenCalledWith({
        createProfileImageDto: { file: expect.any(File), assetId: asset.id },
      });
    } else {
      expect(sdkMock.createProfileImage).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    }
  },
);
