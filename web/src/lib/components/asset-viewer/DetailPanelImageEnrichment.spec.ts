import {
  AssetImageEnrichmentAction,
  AssetTypeEnum,
  getAssetImageEnrichment,
  getAssetInfo,
  isHttpError,
  Status2 as DescriptionStatus,
  Status3 as NsfwStatus,
  updateAssetImageEnrichment,
  type AssetImageEnrichmentResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import DetailPanelImageEnrichment from './DetailPanelImageEnrichment.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getAssetImageEnrichment: vi.fn(),
    getAssetInfo: vi.fn(),
    isHttpError: vi.fn(),
    updateAssetImageEnrichment: vi.fn(),
  };
});

const enrichmentFactory = (assetId: string, effectiveIsNsfw: boolean): AssetImageEnrichmentResponseDto => ({
  assetId,
  description: {
    status: DescriptionStatus.Missing,
    appliedDescription: false,
    appliedTags: false,
  },
  nsfwDetection: {
    status: NsfwStatus.Success,
    effectiveIsNsfw,
    isNsfw: effectiveIsNsfw,
    score: effectiveIsNsfw ? 1 : 0,
    labels: {
      nsfw: effectiveIsNsfw ? 1 : 0,
      normal: effectiveIsNsfw ? 0 : 1,
    },
    appliedTags: false,
  },
});

afterEach(() => vi.clearAllMocks());

describe('DetailPanelImageEnrichment', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removes an asset from the current view when marking it NSFW hides it from the session', async () => {
    const asset = assetFactory.build({ type: AssetTypeEnum.Image });
    const onAssetSuppressed = vi.fn();
    const hiddenAssetError = { status: 400, data: { statusCode: 400 } };

    vi.mocked(getAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, false));
    vi.mocked(updateAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, true));
    vi.mocked(getAssetInfo).mockRejectedValue(hiddenAssetError);
    vi.mocked(isHttpError).mockImplementation((error) => error === hiddenAssetError);

    renderWithTooltips(DetailPanelImageEnrichment, {
      asset,
      isOwner: true,
      isAdmin: true,
      onAssetSuppressed,
    });

    await fireEvent.click(await screen.findByRole('button', { name: 'mark_nsfw' }));

    await waitFor(() =>
      expect(updateAssetImageEnrichment).toHaveBeenCalledWith({
        id: asset.id,
        assetImageEnrichmentActionRequestDto: { action: AssetImageEnrichmentAction.MarkNsfw },
      }),
    );
    await waitFor(() =>
      expect(getAssetInfo).toHaveBeenCalledWith(
        { id: asset.id },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(onAssetSuppressed).toHaveBeenCalledWith(asset);
  });
});

it.each(['lock', 'account', 'dispose'] as const)('drops an enrichment refresh callback after %s', async (change) => {
  const asset = assetFactory.build({ type: AssetTypeEnum.Image });
  const onAssetRefresh = vi.fn();
  vi.mocked(getAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, false));
  vi.mocked(updateAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, false));
  let resolve!: (value: typeof asset) => void;
  vi.mocked(getAssetInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = renderWithTooltips(DetailPanelImageEnrichment, { asset, isOwner: true, isAdmin: true, onAssetRefresh });
  await fireEvent.click(await screen.findByRole('button', { name: 'mark_nsfw' }));
  await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
  if (change === 'lock') {
    eventManager.emit('SessionLocked');
  } else if (change === 'account') {
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
  } else {
    view.unmount();
  }
  resolve(asset);
  await new Promise((done) => setTimeout(done, 0));
  expect(onAssetRefresh).not.toHaveBeenCalled();
});

it.each(['lock', 'account', 'dispose'] as const)(
  'does not start a refresh after a pending enrichment mutation crosses %s',
  async (change) => {
    const asset = assetFactory.build({ type: AssetTypeEnum.Image });
    vi.mocked(getAssetImageEnrichment).mockResolvedValue(enrichmentFactory(asset.id, false));
    let resolve!: (value: AssetImageEnrichmentResponseDto) => void;
    vi.mocked(updateAssetImageEnrichment).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onAssetRefresh = vi.fn();
    const onAssetSuppressed = vi.fn();
    const view = renderWithTooltips(DetailPanelImageEnrichment, {
      asset,
      isOwner: true,
      isAdmin: true,
      onAssetRefresh,
      onAssetSuppressed,
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'mark_nsfw' }));
    if (change === 'lock') {
      eventManager.emit('SessionLocked');
    } else if (change === 'account') {
      eventManager.emit('AuthUserLoaded', userAdminFactory.build());
    } else {
      view.unmount();
    }
    resolve(enrichmentFactory(asset.id, true));
    await new Promise((done) => setTimeout(done, 0));
    expect(getAssetInfo).not.toHaveBeenCalled();
    expect(onAssetRefresh).not.toHaveBeenCalled();
    expect(onAssetSuppressed).not.toHaveBeenCalled();
  },
);

it('resets the action UI on asset replacement without an older completion clearing the newer action', async () => {
  const first = assetFactory.build({ type: AssetTypeEnum.Image });
  const second = assetFactory.build({ type: AssetTypeEnum.Image });
  vi.mocked(getAssetImageEnrichment).mockImplementation(({ id }) => Promise.resolve(enrichmentFactory(id, false)));
  const resolvers: Array<(value: AssetImageEnrichmentResponseDto) => void> = [];
  vi.mocked(updateAssetImageEnrichment).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  vi.mocked(getAssetInfo).mockResolvedValue(second);
  const componentProps = { asset: first, isOwner: true, isAdmin: true };
  const view = render(TestWrapper, { component: DetailPanelImageEnrichment, componentProps });
  await fireEvent.click(await screen.findByRole('button', { name: 'mark_nsfw' }));
  const button = screen.getByRole('button', { name: 'mark_nsfw' });
  expect(button).toBeDisabled();
  await view.rerender({ component: DetailPanelImageEnrichment, componentProps: { ...componentProps, asset: second } });
  await waitFor(() => expect(button).not.toBeDisabled());
  await fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(updateAssetImageEnrichment).toHaveBeenCalledTimes(2);
  resolvers[0](enrichmentFactory(first.id, true));
  await new Promise((done) => setTimeout(done, 0));
  expect(button).toBeDisabled();
  expect(getAssetInfo).not.toHaveBeenCalled();
  resolvers[1](enrichmentFactory(second.id, true));
  await waitFor(() => expect(button).not.toBeDisabled());
  expect(getAssetInfo).toHaveBeenCalledWith({ id: second.id }, expect.anything());
});
