import { SharedLinkType, type ServerConfigDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  asUrl,
  handleCreateSharedLink,
  handleUpdateSharedLink,
  SHARED_LINK_SLUG_TAKEN,
} from '$lib/services/shared-link.service';
import { handleError } from '$lib/utils/handle-error';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';

vi.mock(import('$lib/managers/server-config-manager.svelte'), () => ({
  serverConfigManager: {
    value: { externalDomain: 'http://localhost:2283' } as ServerConfigDto,
    init: vi.fn(),
    loadServerConfig: vi.fn(),
  },
}));

vi.mock(import('$lib/utils/handle-error'), async (original) => ({
  ...(await original()),
  handleError: vi.fn(),
}));

describe('SharedLinkService', () => {
  describe('asUrl', () => {
    it('should properly encode characters in slug', () => {
      expect(asUrl(sharedLinkFactory.build({ slug: 'foo/bar' }))).toBe('http://localhost:2283/s/foo%2Fbar');
    });
    it("uses the server's public address when it has one (FL-305)", () => {
      expect(asUrl(sharedLinkFactory.build({ slug: 'foo', url: 'https://photos.example.com/s/foo' }))).toBe(
        'https://photos.example.com/s/foo',
      );
    });
  });
  describe('a custom address already in use (FL-83 AL-26)', () => {
    const slugTaken = () => ({ name: 'HttpError', status: 400, data: { message: SHARED_LINK_SLUG_TAKEN } });

    beforeEach(() => {
      vi.clearAllMocks();
      sdkMock.isHttpError.mockReturnValue(true);
    });

    it('tells the form instead of showing the generic failure when creating', async () => {
      sdkMock.createSharedLink.mockRejectedValue(slugTaken());
      const onSlugTaken = vi.fn();

      await expect(
        handleCreateSharedLink({ type: SharedLinkType.Individual, assetIds: ['a1'], slug: 'taken' }, { onSlugTaken }),
      ).resolves.toBeUndefined();
      expect(onSlugTaken).toHaveBeenCalledTimes(1);
      expect(handleError).not.toHaveBeenCalled();
    });

    it('tells the form instead of showing the generic failure when editing', async () => {
      sdkMock.updateSharedLink.mockRejectedValue(slugTaken());
      const onSlugTaken = vi.fn();

      await expect(handleUpdateSharedLink(sharedLinkFactory.build(), { slug: 'taken' }, { onSlugTaken })).resolves.toBe(
        false,
      );
      expect(onSlugTaken).toHaveBeenCalledTimes(1);
      expect(handleError).not.toHaveBeenCalled();
    });

    it('keeps the generic failure for any other refusal', async () => {
      sdkMock.createSharedLink.mockRejectedValue({ status: 400, data: { message: 'Invalid assetIds' } });
      const onSlugTaken = vi.fn();

      await handleCreateSharedLink({ type: SharedLinkType.Individual, assetIds: ['a1'] }, { onSlugTaken });
      expect(onSlugTaken).not.toHaveBeenCalled();
      expect(handleError).toHaveBeenCalled();
    });
  });
});
