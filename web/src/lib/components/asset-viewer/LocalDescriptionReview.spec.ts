import {
  getAssetInfo,
  getEnrichmentOptions,
  previewEnrichment,
  updateAsset,
  MlDestinationKind,
  EnrichmentPreviewStatus,
} from '@frameleaf/sdk';
import type { AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LocalDescriptionReview from './LocalDescriptionReview.svelte';

const assetFixture = (): AssetResponseDto =>
  ({
    id: 'asset-a',
    checksum: 'original-checksum',
    exifInfo: { description: 'Original' },
  }) as AssetResponseDto;

const session = vi.hoisted(() => ({ current: true }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { captureSession: () => () => session.current },
}));
vi.mock('@frameleaf/sdk', async () => ({
  ...(await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk')),
  getAssetInfo: vi.fn(),
  getEnrichmentOptions: vi.fn(),
  previewEnrichment: vi.fn(),
  updateAsset: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  session.current = true;
  addMessages('en', en);
  vi.mocked(getEnrichmentOptions).mockResolvedValue({
    destinations: [{ id: 'local', kind: MlDestinationKind.Local, enrichment: { admitted: true } }],
  } as Awaited<ReturnType<typeof getEnrichmentOptions>>);
});

it('keeps a local suggestion separate until the owner reviews, edits and applies it', async () => {
  const asset = assetFixture();
  vi.mocked(previewEnrichment).mockResolvedValue({
    destinationId: 'local',
    cloud: false,
    modelName: 'qualified-local-model',
    samples: [{ assetId: asset.id, status: EnrichmentPreviewStatus.Success, candidate: 'Draft' }],
  } as Awaited<ReturnType<typeof previewEnrichment>>);
  vi.mocked(getAssetInfo).mockResolvedValue(asset);
  const refresh = vi.fn();
  render(LocalDescriptionReview, { asset, onAssetRefresh: refresh });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview local description' }));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Draft'));
  expect(updateAsset).not.toHaveBeenCalled();
  expect(previewEnrichment).toHaveBeenCalledWith({
    enrichmentPreviewRequestDto: {
      assetIds: [asset.id],
      destinationId: 'local',
      localOnly: true,
      fallbackModelName: '',
    },
  });
  await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Reviewed text' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Apply description' }));
  await waitFor(() =>
    expect(updateAsset).toHaveBeenCalledWith({
      id: asset.id,
      updateAssetDto: { description: 'Reviewed text' },
    }),
  );
});

it('refuses a changed original or description before a write', async () => {
  const asset = assetFixture();
  vi.mocked(previewEnrichment).mockResolvedValue({
    destinationId: 'local',
    cloud: false,
    modelName: 'qualified',
    samples: [{ assetId: asset.id, status: EnrichmentPreviewStatus.Success, candidate: 'Draft' }],
  } as Awaited<ReturnType<typeof previewEnrichment>>);
  vi.mocked(getAssetInfo).mockResolvedValue({ ...asset, checksum: 'replacement' });
  render(LocalDescriptionReview, { asset });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview local description' }));
  await screen.findByRole('textbox');
  await fireEvent.click(screen.getByRole('button', { name: 'Apply description' }));
  await screen.findByRole('alert');
  expect(updateAsset).not.toHaveBeenCalled();
});

it('refuses ambiguous local destinations before sending media for preview', async () => {
  vi.mocked(getEnrichmentOptions).mockResolvedValue({ destinations: [] } as unknown as Awaited<
    ReturnType<typeof getEnrichmentOptions>
  >);
  render(LocalDescriptionReview, { asset: assetFixture() });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview local description' }));
  await screen.findByRole('alert');
  expect(previewEnrichment).not.toHaveBeenCalled();
});
